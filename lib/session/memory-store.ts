/**
 * In-Memory Session Store
 * Работает сразу без внешних зависимостей
 * Подходит для development и небольших нагрузок
 */

import {
  ISessionStore,
  SessionData,
  SessionOptions,
  DocumentContext,
  CollectionContext,
  AddDocumentResult,
  DEFAULT_SESSION_OPTIONS,
  estimateTokens,
} from './types';

export class MemorySessionStore implements ISessionStore {
  private sessions: Map<string, SessionData> = new Map();
  private options: Required<SessionOptions>;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options?: SessionOptions) {
    this.options = { ...DEFAULT_SESSION_OPTIONS, ...options };

    // Автоматическая очистка устаревших сессий каждые 5 минут
    this.cleanupInterval = setInterval(() => {
      this.cleanup().catch(console.error);
    }, 5 * 60 * 1000);
  }

  async createSession(sessionId: string, options?: SessionOptions): Promise<SessionData> {
    const now = Date.now();
    const session: SessionData = {
      sessionId,
      collections: new Map(),
      createdAt: now,
      lastAccessedAt: now,
      totalTokensEstimate: 0,
    };

    this.sessions.set(sessionId, session);
    console.log(`[MemoryStore] Created session ${sessionId}`);
    return session;
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return null;
    }

    // Проверяем TTL
    const ageMs = Date.now() - session.lastAccessedAt;
    if (ageMs > this.options.ttlSeconds * 1000) {
      console.log(`[MemoryStore] Session ${sessionId} expired (age: ${Math.round(ageMs / 1000)}s)`);
      this.sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  async hasSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    return session !== null;
  }

  async addDocuments(
    sessionId: string,
    collectionKey: string,
    collectionId: string,
    documents: DocumentContext[],
    searchQuery: string
  ): Promise<AddDocumentResult> {
    let session = await this.getSession(sessionId);

    if (!session) {
      // Автоматически создаём сессию если её нет
      session = await this.createSession(sessionId);
    }

    // Обновляем время доступа
    session.lastAccessedAt = Date.now();

    // Получаем или создаём контекст коллекции
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

    // Добавляем документы, избегая дубликатов
    let addedCount = 0;
    let tokensAdded = 0;

    for (const doc of documents) {
      // Проверяем лимит документов на коллекцию
      if (collectionContext.documents.length >= this.options.maxDocumentsPerCollection) {
        console.log(`[MemoryStore] Collection ${collectionKey} reached max documents limit`);
        break;
      }

      // Проверяем дубликат по fileId
      const exists = collectionContext.documents.some(d => d.fileId === doc.fileId);
      if (exists) {
        continue;
      }

      // Проверяем лимит токенов
      const docTokens = estimateTokens(doc.content);
      if (session.totalTokensEstimate + docTokens > this.options.maxTotalTokens) {
        console.log(`[MemoryStore] Session ${sessionId} reached max tokens limit`);
        break;
      }

      collectionContext.documents.push(doc);
      session.totalTokensEstimate += docTokens;
      tokensAdded += docTokens;
      addedCount++;
    }

    console.log(`[MemoryStore] Added ${addedCount} documents to ${collectionKey} (${tokensAdded} tokens)`);

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
    return session.collections.get(collectionKey) || null;
  }

  async getAllDocuments(sessionId: string): Promise<DocumentContext[]> {
    const session = await this.getSession(sessionId);
    if (!session) return [];

    session.lastAccessedAt = Date.now();

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
      // Вычитаем токены удаляемых документов
      for (const doc of context.documents) {
        session.totalTokensEstimate -= estimateTokens(doc.content);
      }
      session.collections.delete(collectionKey);
    }

    console.log(`[MemoryStore] Cleared collection ${collectionKey} from session ${sessionId}`);
  }

  async clearSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    session.collections.clear();
    session.totalTokensEstimate = 0;
    session.lastAccessedAt = Date.now();

    console.log(`[MemoryStore] Cleared session ${sessionId}`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    console.log(`[MemoryStore] Deleted session ${sessionId}`);
  }

  async touchSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session) {
      session.lastAccessedAt = Date.now();
    }
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
    const now = Date.now();
    const ttlMs = this.options.ttlSeconds * 1000;
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastAccessedAt > ttlMs) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[MemoryStore] Cleaned up ${cleaned} expired sessions`);
    }

    return cleaned;
  }

  // Для graceful shutdown
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
  }

  // Статистика для мониторинга
  getStoreStats(): { totalSessions: number; totalDocuments: number; totalTokens: number } {
    let totalDocuments = 0;
    let totalTokens = 0;

    for (const session of this.sessions.values()) {
      totalTokens += session.totalTokensEstimate;
      for (const context of session.collections.values()) {
        totalDocuments += context.documents.length;
      }
    }

    return {
      totalSessions: this.sessions.size,
      totalDocuments,
      totalTokens,
    };
  }
}
