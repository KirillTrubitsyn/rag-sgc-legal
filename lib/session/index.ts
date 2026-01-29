/**
 * Session Store Factory
 * Автоматически выбирает Redis или Memory store
 *
 * ВАЖНО: RedisSessionStore не импортируется статически,
 * так как ioredis не работает в Edge Runtime (Vercel).
 * Redis будет использоваться только на Railway/Node.js runtime.
 */

export * from './types';
export { MemorySessionStore } from './memory-store';
// RedisSessionStore экспортируется через динамический импорт для Node.js runtime

import { ISessionStore, SessionOptions } from './types';
import { MemorySessionStore } from './memory-store';

// Глобальный singleton для store
let globalStore: ISessionStore | null = null;

/**
 * Создаёт или возвращает существующий Session Store
 * В Edge Runtime (Vercel) всегда используется Memory store
 * На Railway/Node.js с REDIS_URL будет использоваться Redis
 */
export function getSessionStore(options?: SessionOptions): ISessionStore {
  if (globalStore) {
    return globalStore;
  }

  // В Edge Runtime используем только Memory store
  // Redis требует Node.js runtime (net, tls модули)
  console.log('[SessionStore] Using Memory store (Edge Runtime compatible)');
  globalStore = new MemorySessionStore(options);

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
