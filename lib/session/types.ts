/**
 * Session Store Types
 * Система кэширования контекста документов между запросами
 */

// Контекст одного документа
export interface DocumentContext {
  fileId: string;
  fileName: string;
  content: string;           // Полный текст документа
  collectionKey: string;     // Ключ коллекции
  score: number;             // Релевантность при поиске
  loadedAt: number;          // Timestamp загрузки
  source: 'full' | 'chunks'; // Как был загружен (полный текст или чанки)
}

// Контекст коллекции в сессии
export interface CollectionContext {
  collectionKey: string;
  collectionId: string;
  documents: DocumentContext[];
  searchQuery: string;       // Запрос, по которому найдены документы
  loadedAt: number;
}

// Данные сессии
export interface SessionData {
  sessionId: string;
  collections: Map<string, CollectionContext>;  // collectionKey -> context
  createdAt: number;
  lastAccessedAt: number;
  totalTokensEstimate: number;  // Примерная оценка токенов в контексте
}

// Сериализованная версия для Redis
export interface SerializedSessionData {
  sessionId: string;
  collections: Record<string, CollectionContext>;
  createdAt: number;
  lastAccessedAt: number;
  totalTokensEstimate: number;
}

// Опции для создания/обновления сессии
export interface SessionOptions {
  ttlSeconds?: number;        // Время жизни сессии (по умолчанию 30 минут)
  maxDocumentsPerCollection?: number;  // Макс. документов на коллекцию
  maxTotalTokens?: number;    // Макс. токенов в контексте
}

// Результат добавления документа
export interface AddDocumentResult {
  success: boolean;
  documentAdded: boolean;
  reason?: string;
  currentTokens: number;
}

// Интерфейс Session Store
export interface ISessionStore {
  // Создать новую сессию
  createSession(sessionId: string, options?: SessionOptions): Promise<SessionData>;

  // Получить сессию
  getSession(sessionId: string): Promise<SessionData | null>;

  // Проверить существование сессии
  hasSession(sessionId: string): Promise<boolean>;

  // Добавить документы в контекст коллекции
  addDocuments(
    sessionId: string,
    collectionKey: string,
    collectionId: string,
    documents: DocumentContext[],
    searchQuery: string
  ): Promise<AddDocumentResult>;

  // Получить контекст коллекции
  getCollectionContext(sessionId: string, collectionKey: string): Promise<CollectionContext | null>;

  // Получить все документы из всех коллекций
  getAllDocuments(sessionId: string): Promise<DocumentContext[]>;

  // Получить форматированный контекст для LLM
  getFormattedContext(sessionId: string): Promise<string>;

  // Очистить контекст коллекции
  clearCollectionContext(sessionId: string, collectionKey: string): Promise<void>;

  // Очистить всю сессию
  clearSession(sessionId: string): Promise<void>;

  // Удалить сессию
  deleteSession(sessionId: string): Promise<void>;

  // Обновить время последнего доступа
  touchSession(sessionId: string): Promise<void>;

  // Получить статистику сессии
  getSessionStats(sessionId: string): Promise<{
    collectionsCount: number;
    documentsCount: number;
    totalTokens: number;
    ageSeconds: number;
  } | null>;

  // Очистить устаревшие сессии (для memory store)
  cleanup(): Promise<number>;
}

// Константы по умолчанию
export const DEFAULT_SESSION_OPTIONS: Required<SessionOptions> = {
  ttlSeconds: 30 * 60,           // 30 минут
  maxDocumentsPerCollection: 10,  // До 10 документов на коллекцию
  maxTotalTokens: 1_500_000,      // 1.5М токенов (с запасом для Grok 2М)
};

// Примерный расчёт токенов (4 символа ≈ 1 токен для русского текста)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);  // Для русского текста ~3 символа на токен
}
