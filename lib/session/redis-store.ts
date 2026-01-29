/**
 * Redis Session Store
 * Production-ready решение для масштабируемого кэширования
 * Поддерживает несколько инстансов приложения
 */

import {
  ISessionStore,
  SessionData,
  SessionOptions,
  DocumentContext,
  CollectionContext,
  AddDocumentResult,
  SerializedSessionData,
  DEFAULT_SESSION_OPTIONS,
  estimateTokens,
} from './types';

// Динамический импорт Redis чтобы не ломать билд без Redis
let Redis: any = null;

async function getRedisClient(url: string): Promise<any> {
  if (!Redis) {
    try {
      const ioredis = await import('ioredis');
      Redis = ioredis.default;
    } catch (e) {
      throw new Error('Redis client (ioredis) not installed. Run: npm install ioredis');
    }
  }
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    lazyConnect: true,
  });
}

export class RedisSessionStore implements ISessionStore {
  private client: any = null;
  private options: Required<SessionOptions>;
  private keyPrefix: string = 'sgc:session:';
  private connected: boolean = false;
  private redisUrl: string;

  constructor(redisUrl: string, options?: SessionOptions) {
    this.redisUrl = redisUrl;
    this.options = { ...DEFAULT_SESSION_OPTIONS, ...options };
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.client) return;

    this.client = await getRedisClient(this.redisUrl);
    await this.client.connect();
    this.connected = true;
    console.log('[RedisStore] Connected to Redis');
  }

  private getKey(sessionId: string): string {
    return `${this.keyPrefix}${sessionId}`;
  }

  private serialize(session: SessionData): string {
    const serialized: SerializedSessionData = {
      sessionId: session.sessionId,
      collections: Object.fromEntries(session.collections),
      createdAt: session.createdAt,
      lastAccessedAt: session.lastAccessedAt,
      totalTokensEstimate: session.totalTokensEstimate,
    };
    return JSON.stringify(serialized);
  }

  private deserialize(data: string): SessionData {
    const parsed: SerializedSessionData = JSON.parse(data);
    return {
      sessionId: parsed.sessionId,
      collections: new Map(Object.entries(parsed.collections)),
      createdAt: parsed.createdAt,
      lastAccessedAt: parsed.lastAccessedAt,
      totalTokensEstimate: parsed.totalTokensEstimate,
    };
  }

  async createSession(sessionId: string, options?: SessionOptions): Promise<SessionData> {
    await this.ensureConnected();

    const now = Date.now();
    const session: SessionData = {
      sessionId,
      collections: new Map(),
      createdAt: now,
      lastAccessedAt: now,
      totalTokensEstimate: 0,
    };

    const key = this.getKey(sessionId);
    await this.client.setex(key, this.options.ttlSeconds, this.serialize(session));

    console.log(`[RedisStore] Created session ${sessionId}`);
    return session;
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    await this.ensureConnected();

    const key = this.getKey(sessionId);
    const data = await this.client.get(key);

    if (!data) {
      return null;
    }

    try {
      return this.deserialize(data);
    } catch (e) {
      console.error(`[RedisStore] Failed to deserialize session ${sessionId}:`, e);
      await this.client.del(key);
      return null;
    }
  }

  async hasSession(sessionId: string): Promise<boolean> {
    await this.ensureConnected();
    const key = this.getKey(sessionId);
    const exists = await this.client.exists(key);
    return exists === 1;
  }

  private async saveSession(session: SessionData): Promise<void> {
    const key = this.getKey(session.sessionId);
    await this.client.setex(key, this.options.ttlSeconds, this.serialize(session));
  }

  async addDocuments(
    sessionId: string,
    collectionKey: string,
    collectionId: string,
    documents: DocumentContext[],
    searchQuery: string
  ): Promise<AddDocumentResult> {
    await this.ensureConnected();

    let session = await this.getSession(sessionId);

    if (!session) {
      session = await this.createSession(sessionId);
    }

    session.lastAccessedAt = Date.now();

    let collectionContext = session.collections.get(collectionKey);

    if (!collectionContext) {
      collectionContext = {
        collectionKey,
        collectionId,
        documents: [],
        searchQuery,
        loadedAt: Date.now(),
      };
      session.collections.set(collectionKey, collectionContext);
    }

    let addedCount = 0;
    let tokensAdded = 0;

    for (const doc of documents) {
      if (collectionContext.documents.length >= this.options.maxDocumentsPerCollection) {
        console.log(`[RedisStore] Collection ${collectionKey} reached max documents limit`);
        break;
      }

      const exists = collectionContext.documents.some(d => d.fileId === doc.fileId);
      if (exists) {
        continue;
      }

      const docTokens = estimateTokens(doc.content);
      if (session.totalTokensEstimate + docTokens > this.options.maxTotalTokens) {
        console.log(`[RedisStore] Session ${sessionId} reached max tokens limit`);
        break;
      }

      collectionContext.documents.push(doc);
      session.totalTokensEstimate += docTokens;
      tokensAdded += docTokens;
      addedCount++;
    }

    await this.saveSession(session);

    console.log(`[RedisStore] Added ${addedCount} documents to ${collectionKey} (${tokensAdded} tokens)`);

    return {
      success: true,
      documentAdded: addedCount > 0,
      currentTokens: session.totalTokensEstimate,
    };
  }

  async getCollectionContext(sessionId: string, collectionKey: string): Promise<CollectionContext | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    session.lastAccessedAt = Date.now();
    await this.saveSession(session);

    return session.collections.get(collectionKey) || null;
  }

  async getAllDocuments(sessionId: string): Promise<DocumentContext[]> {
    const session = await this.getSession(sessionId);
    if (!session) return [];

    session.lastAccessedAt = Date.now();
    await this.saveSession(session);

    const allDocs: DocumentContext[] = [];
    for (const context of session.collections.values()) {
      allDocs.push(...context.documents);
    }

    return allDocs;
  }

  async getFormattedContext(sessionId: string): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) return '';

    session.lastAccessedAt = Date.now();
    await this.saveSession(session);

    const parts: string[] = [];

    for (const [collectionKey, context] of session.collections) {
      if (context.documents.length === 0) continue;

      parts.push(`\n=== КОЛЛЕКЦИЯ: ${collectionKey.toUpperCase()} ===`);
      parts.push(`Запрос: ${context.searchQuery}`);
      parts.push(`Документов: ${context.documents.length}\n`);

      for (let i = 0; i < context.documents.length; i++) {
        const doc = context.documents[i];
        const encodedFilename = encodeURIComponent(doc.fileName);
        const downloadUrl = `/api/download?file_id=${doc.fileId}&filename=${encodedFilename}`;

        parts.push(`--- ДОКУМЕНТ ${i + 1}: ${doc.fileName} ---`);
        parts.push(`Релевантность: ${doc.score.toFixed(3)}`);
        parts.push(`Источник: ${doc.source === 'full' ? 'полный текст' : 'чанки'}`);
        parts.push(`Ссылка: [Скачать](${downloadUrl})`);
        parts.push(`\n${doc.content}\n`);
        parts.push(`--- КОНЕЦ ДОКУМЕНТА ${i + 1} ---\n`);
      }
    }

    return parts.join('\n');
  }

  async clearCollectionContext(sessionId: string, collectionKey: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    const context = session.collections.get(collectionKey);
    if (context) {
      for (const doc of context.documents) {
        session.totalTokensEstimate -= estimateTokens(doc.content);
      }
      session.collections.delete(collectionKey);
      await this.saveSession(session);
    }

    console.log(`[RedisStore] Cleared collection ${collectionKey} from session ${sessionId}`);
  }

  async clearSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    session.collections.clear();
    session.totalTokensEstimate = 0;
    session.lastAccessedAt = Date.now();
    await this.saveSession(session);

    console.log(`[RedisStore] Cleared session ${sessionId}`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureConnected();
    const key = this.getKey(sessionId);
    await this.client.del(key);
    console.log(`[RedisStore] Deleted session ${sessionId}`);
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.ensureConnected();
    const key = this.getKey(sessionId);
    // Просто обновляем TTL
    await this.client.expire(key, this.options.ttlSeconds);
  }

  async getSessionStats(sessionId: string): Promise<{
    collectionsCount: number;
    documentsCount: number;
    totalTokens: number;
    ageSeconds: number;
  } | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    let documentsCount = 0;
    for (const context of session.collections.values()) {
      documentsCount += context.documents.length;
    }

    return {
      collectionsCount: session.collections.size,
      documentsCount,
      totalTokens: session.totalTokensEstimate,
      ageSeconds: Math.round((Date.now() - session.createdAt) / 1000),
    };
  }

  async cleanup(): Promise<number> {
    // Redis автоматически удаляет ключи по TTL
    // Этот метод для совместимости с интерфейсом
    return 0;
  }

  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.quit();
      this.connected = false;
      console.log('[RedisStore] Disconnected from Redis');
    }
  }
}
