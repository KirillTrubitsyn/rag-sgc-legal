# Система кэширования документов в сессиях

Документация по системе серверного кэширования контекста документов между запросами в чате.

## Содержание

1. [Обзор системы](#обзор-системы)
2. [Архитектура](#архитектура)
3. [Типы данных](#типы-данных)
4. [Memory Store](#memory-store)
5. [Redis Store](#redis-store)
6. [API сессий](#api-сессий)
7. [Интеграция с чатом](#интеграция-с-чатом)
8. [Конфигурация](#конфигурация)
9. [Примеры использования](#примеры-использования)

---

## Обзор системы

### Проблема

При работе с RAG-системой документы загружаются заново при каждом запросе, что приводит к:
- Потере контекста после 2-3 вопросов
- Неэффективному использованию токенов LLM
- Повторным запросам к базе данных

### Решение

Серверное кэширование документов в сессиях позволяет:
- Сохранять загруженные документы между запросами
- Эффективно использовать контекстное окно LLM (до 2М токенов у Grok 4.1)
- Уменьшить нагрузку на базу данных
- Обеспечить непрерывность диалога

### Как это работает

```
┌──────────────────────────────────────────────────────────────────┐
│                         КЛИЕНТ                                   │
│  ┌──────────────────┐    ┌──────────────────┐                   │
│  │  ChatInterface   │───▶│   sessionId      │                   │
│  │  (React)         │    │   (localStorage) │                   │
│  └──────────────────┘    └──────────────────┘                   │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                         СЕРВЕР                                   │
│  ┌──────────────────┐    ┌──────────────────┐                   │
│  │  /api/chat       │───▶│  Session Store   │                   │
│  │  route.ts        │    │  (Memory/Redis)  │                   │
│  └──────────────────┘    └──────────────────┘                   │
│           │                       │                              │
│           ▼                       ▼                              │
│  ┌──────────────────┐    ┌──────────────────┐                   │
│  │  Vector DB       │    │  Кэшированные    │                   │
│  │  (поиск)         │    │  документы       │                   │
│  └──────────────────┘    └──────────────────┘                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Архитектура

### Структура файлов

```
lib/session/
├── types.ts         # Интерфейсы и типы данных
├── memory-store.ts  # In-memory реализация
├── redis-store.ts   # Redis реализация
└── index.ts         # Фабрика и утилиты

app/api/
├── session/
│   └── route.ts     # API управления сессиями
└── chat/
    └── route.ts     # Интеграция с чатом
```

### Выбор хранилища

| Хранилище | Когда использовать | Особенности |
|-----------|-------------------|-------------|
| **Memory Store** | Development, Vercel Edge | Работает без зависимостей, данные в памяти процесса |
| **Redis Store** | Production, Railway | Персистентность, масштабируемость, несколько инстансов |

---

## Типы данных

### DocumentContext

Контекст одного документа:

```typescript
interface DocumentContext {
  fileId: string;        // Уникальный ID файла
  fileName: string;      // Имя файла
  content: string;       // Полный текст документа
  collectionKey: string; // Ключ коллекции (poa, contractForms, etc.)
  score: number;         // Релевантность при поиске (0-1)
  loadedAt: number;      // Timestamp загрузки
  source: 'full' | 'chunks'; // Как был загружен
}
```

### CollectionContext

Контекст коллекции в сессии:

```typescript
interface CollectionContext {
  collectionKey: string;      // Ключ коллекции
  collectionId: string;       // ID коллекции в Vector DB
  documents: DocumentContext[]; // Массив документов
  searchQuery: string;        // Запрос, по которому найдены
  loadedAt: number;           // Когда загружена
}
```

### SessionData

Полные данные сессии:

```typescript
interface SessionData {
  sessionId: string;                           // Уникальный ID сессии
  collections: Map<string, CollectionContext>; // Коллекции
  createdAt: number;                           // Когда создана
  lastAccessedAt: number;                      // Последний доступ
  totalTokensEstimate: number;                 // Оценка токенов
}
```

### SessionOptions

Опции конфигурации:

```typescript
interface SessionOptions {
  ttlSeconds?: number;              // Время жизни (по умолчанию 30 мин)
  maxDocumentsPerCollection?: number; // Макс. документов на коллекцию (10)
  maxTotalTokens?: number;          // Макс. токенов (1.5М)
}
```

---

## Memory Store

In-memory реализация для development и Edge Runtime.

### Особенности

- Работает без внешних зависимостей
- Данные хранятся в памяти процесса
- Автоматическая очистка устаревших сессий каждые 5 минут
- Совместим с Vercel Edge Runtime

### Инициализация

```typescript
import { MemorySessionStore } from '@/lib/session/memory-store';

const store = new MemorySessionStore({
  ttlSeconds: 30 * 60,        // 30 минут
  maxDocumentsPerCollection: 10,
  maxTotalTokens: 1_500_000,
});
```

### Основные методы

```typescript
// Создание сессии
const session = await store.createSession('sess_abc123');

// Добавление документов
const result = await store.addDocuments(
  'sess_abc123',
  'poa',              // ключ коллекции
  'collection_id',    // ID в Vector DB
  documents,          // массив DocumentContext
  'доверенность'      // поисковый запрос
);

// Получение контекста коллекции
const context = await store.getCollectionContext('sess_abc123', 'poa');

// Получение форматированного контекста для LLM
const formatted = await store.getFormattedContext('sess_abc123');

// Статистика сессии
const stats = await store.getSessionStats('sess_abc123');
// { collectionsCount: 2, documentsCount: 5, totalTokens: 50000, ageSeconds: 120 }
```

### Мониторинг

```typescript
// Общая статистика хранилища
const storeStats = store.getStoreStats();
// { totalSessions: 10, totalDocuments: 50, totalTokens: 500000 }
```

---

## Redis Store

Production-ready реализация для масштабируемого кэширования.

### Особенности

- Персистентность данных между перезапусками
- Поддержка нескольких инстансов приложения
- Автоматическое TTL через Redis SETEX
- Требует Node.js Runtime (не работает в Edge)

### Установка

```bash
npm install ioredis
```

### Инициализация

```typescript
import { RedisSessionStore } from '@/lib/session/redis-store';

const store = new RedisSessionStore(
  process.env.REDIS_URL!, // redis://user:password@host:port
  {
    ttlSeconds: 30 * 60,
    maxDocumentsPerCollection: 10,
    maxTotalTokens: 1_500_000,
  }
);
```

### Структура ключей в Redis

```
sgc:session:{sessionId} -> JSON строка с SessionData
TTL: 1800 секунд (30 минут)
```

### Подключение Redis

Для включения Redis необходимо:

1. Установить переменную окружения `REDIS_URL`
2. Изменить `lib/session/index.ts`:

```typescript
import { RedisSessionStore } from './redis-store';

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
```

3. Убрать `export const runtime = 'edge'` из `app/api/chat/route.ts`

---

## API сессий

### Endpoints

#### GET /api/session

Получение информации о сессии или создание новой.

**Без параметров - создание новой сессии:**
```bash
curl -X GET /api/session
```

**Ответ:**
```json
{
  "sessionId": "sess_lw1234_abc567",
  "isNew": true
}
```

**С sessionId - получение статистики:**
```bash
curl -X GET "/api/session?sessionId=sess_lw1234_abc567"
```

**Ответ:**
```json
{
  "sessionId": "sess_lw1234_abc567",
  "exists": true,
  "collectionsCount": 2,
  "documentsCount": 5,
  "totalTokens": 50000,
  "ageSeconds": 120
}
```

#### POST /api/session

Создание новой сессии.

```bash
curl -X POST /api/session
```

**Ответ:**
```json
{
  "sessionId": "sess_lw5678_xyz890",
  "message": "Session created"
}
```

#### DELETE /api/session

Очистка или удаление сессии.

**Очистка (сохраняет сессию, удаляет документы):**
```bash
curl -X DELETE "/api/session?sessionId=sess_xxx&action=clear"
```

**Полное удаление:**
```bash
curl -X DELETE "/api/session?sessionId=sess_xxx&action=delete"
```

---

## Интеграция с чатом

### Клиентская часть (ChatInterface.tsx)

```typescript
// Состояние sessionId
const [sessionId, setSessionId] = useState<string | null>(() => {
  if (typeof window !== 'undefined') {
    return sessionStorage.getItem('chatSessionId');
  }
  return null;
});

// Использование useChat с sessionId
const { messages, ... } = useChat({
  api: '/api/chat',
  body: {
    sessionId, // Передаём sessionId в каждый запрос
  },
  onResponse: async (response) => {
    // Получаем sessionId из заголовка ответа
    const serverSessionId = response.headers.get('X-Session-Id');
    if (serverSessionId && serverSessionId !== sessionId) {
      setSessionId(serverSessionId);
      sessionStorage.setItem('chatSessionId', serverSessionId);
    }
  },
});

// Новый диалог - очистка сессии
const handleNewQuery = async () => {
  if (sessionId) {
    await fetch(`/api/session?sessionId=${sessionId}&action=clear`, {
      method: 'DELETE',
    });
  }
};
```

### Серверная часть (chat/route.ts)

```typescript
export async function POST(req: Request) {
  const { messages, sessionId: clientSessionId } = await req.json();

  // Получаем или создаём sessionId
  const sessionId = clientSessionId && isValidSessionId(clientSessionId)
    ? clientSessionId
    : generateSessionId();

  const sessionStore = getSessionStore();

  // Проверяем кэш для каждой коллекции
  const cachedContext = await sessionStore.getCollectionContext(
    sessionId,
    collectionKey
  );

  if (cachedContext && cachedContext.documents.length > 0) {
    // Используем кэшированные документы
    console.log(`[Chat] Using cached context for ${collectionKey}`);
  } else {
    // Загружаем и кэшируем новые документы
    const results = await searchWithFullContent(query, collection);

    await sessionStore.addDocuments(
      sessionId,
      collectionKey,
      collectionId,
      results.map(r => ({
        fileId: r.fileId,
        fileName: r.fileName,
        content: r.content,
        collectionKey,
        score: r.score,
        loadedAt: Date.now(),
        source: r.source,
      })),
      query
    );
  }

  // Возвращаем ответ с X-Session-Id
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Session-Id': sessionId,
    },
  });
}
```

---

## Конфигурация

### Параметры по умолчанию

```typescript
const DEFAULT_SESSION_OPTIONS = {
  ttlSeconds: 30 * 60,           // 30 минут
  maxDocumentsPerCollection: 10, // До 10 документов на коллекцию
  maxTotalTokens: 1_500_000,     // 1.5М токенов (запас для Grok 2М)
};
```

### Расчёт токенов

Для русского текста используется приблизительный расчёт:

```typescript
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3); // ~3 символа на токен
}
```

### Переменные окружения

| Переменная | Описание | Пример |
|------------|----------|--------|
| `REDIS_URL` | URL подключения к Redis | `redis://default:password@host:6379` |

---

## Примеры использования

### Пример 1: Получение статистики сессии

```typescript
const response = await fetch(`/api/session?sessionId=${sessionId}`);
const stats = await response.json();

console.log(`Документов в кэше: ${stats.documentsCount}`);
console.log(`Токенов: ${stats.totalTokens}`);
console.log(`Возраст сессии: ${stats.ageSeconds} сек`);
```

### Пример 2: Отображение индикатора кэша в UI

```tsx
{sessionStats && sessionStats.documentsCount > 0 && (
  <div className="cache-indicator">
    В кэше: {sessionStats.documentsCount} док.
    (~{Math.round(sessionStats.totalTokens / 1000)}K токенов)
  </div>
)}
```

### Пример 3: Очистка при смене темы разговора

```typescript
const handleNewTopic = async () => {
  if (sessionId) {
    await fetch(`/api/session?sessionId=${sessionId}&action=clear`, {
      method: 'DELETE',
    });
    // Кэш очищен, следующий запрос загрузит новые документы
  }
};
```

### Пример 4: Программное добавление документов

```typescript
const store = getSessionStore();

await store.addDocuments(
  sessionId,
  'customCollection',
  'collection_id_123',
  [{
    fileId: 'doc_1',
    fileName: 'document.pdf',
    content: 'Текст документа...',
    collectionKey: 'customCollection',
    score: 1.0,
    loadedAt: Date.now(),
    source: 'full',
  }],
  'поисковый запрос'
);
```

---

## Рекомендации

### Для разработки

1. Используйте Memory Store - не требует Redis
2. Логи в консоли показывают все операции с сессиями
3. Сессии автоматически очищаются при перезапуске сервера

### Для production

1. Используйте Redis Store для масштабируемости
2. Настройте TTL в соответствии с ожидаемой длительностью диалогов
3. Мониторьте использование памяти Redis
4. Рассмотрите Upstash Redis для serverless окружений

### Оптимизация

1. Загружайте полные документы, а не чанки - они лучше для контекста
2. Ограничивайте количество документов на коллекцию
3. Очищайте сессию при смене темы разговора
4. Используйте `maxTotalTokens` для контроля размера контекста

---

## Troubleshooting

### Документы не кэшируются

1. Проверьте, что `sessionId` передаётся в запросе
2. Убедитесь, что сессия не истекла (TTL 30 минут)
3. Проверьте логи сервера на ошибки

### Redis не подключается

1. Проверьте `REDIS_URL` переменную окружения
2. Убедитесь, что Redis доступен с сервера
3. Проверьте, что используется Node.js runtime, а не Edge

### Слишком много токенов

1. Уменьшите `maxDocumentsPerCollection`
2. Уменьшите `maxTotalTokens`
3. Очищайте сессию чаще
