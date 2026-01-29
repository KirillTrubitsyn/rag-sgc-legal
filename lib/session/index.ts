/**
 * Session Store Factory
 * Автоматически выбирает Redis или Memory store
 */

export * from './types';
export { MemorySessionStore } from './memory-store';
export { RedisSessionStore } from './redis-store';

import { ISessionStore, SessionOptions } from './types';
import { MemorySessionStore } from './memory-store';
import { RedisSessionStore } from './redis-store';

// Глобальный singleton для store
let globalStore: ISessionStore | null = null;

/**
 * Создаёт или возвращает существующий Session Store
 * Использует Redis если есть REDIS_URL, иначе Memory
 */
export function getSessionStore(options?: SessionOptions): ISessionStore {
  if (globalStore) {
    return globalStore;
  }

  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    console.log('[SessionStore] Using Redis store');
    globalStore = new RedisSessionStore(redisUrl, options);
  } else {
    console.log('[SessionStore] Using Memory store');
    globalStore = new MemorySessionStore(options);
  }

  return globalStore;
}

/**
 * Генерирует уникальный ID сессии
 */
export function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `sess_${timestamp}_${random}`;
}

/**
 * Валидирует формат session ID
 */
export function isValidSessionId(sessionId: string): boolean {
  return typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    sessionId.length < 100 &&
    /^[a-zA-Z0-9_-]+$/.test(sessionId);
}
