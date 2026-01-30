# Техническая архитектура RAG-SGC-Legal

## Обзор системы

RAG-SGC-Legal — юридический ассистент для поиска и анализа нормативных документов СГК. Система использует архитектуру RAG (Retrieval-Augmented Generation) с интеллектуальной классификацией запросов и множественными коллекциями документов.

```
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND (Browser)                       │
│     ChatInterface.tsx + UploadButtons + Vercel AI SDK       │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP POST /api/chat, /api/upload
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              BACKEND (Next.js Node.js Runtime)              │
│   Query Classifier → Collection Search → LLM → Streaming    │
└────────────────────────┬────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
┌─────────────────┐ ┌─────────────┐ ┌─────────────┐
│    xAI API      │ │ OpenAI API  │ │   Redis     │
│ Collections +   │ │ Gemini OCR  │ │  Sessions   │
│ Grok 4.1 Fast   │ │             │ │ (optional)  │
└─────────────────┘ └─────────────┘ └─────────────┘
```

---

## Технологический стек

### Frontend
| Технология | Версия | Назначение |
|------------|--------|------------|
| React | 19.0.0 | UI-библиотека |
| Next.js | 15.1.4 | Фреймворк (App Router) |
| TypeScript | 5.7.2 | Типизация |
| Tailwind CSS | 3.4.17 | Стилизация |
| Vercel AI SDK | 4.0.0 | Управление чатом, streaming |
| react-markdown | 10.1.0 | Рендеринг Markdown |
| lucide-react | 0.469.0 | Иконки |
| next-pwa | 5.6.0 | PWA поддержка |

### Backend
| Технология | Версия | Назначение |
|------------|--------|------------|
| Next.js Runtime | 15.1.4 | Серверная логика (Node.js) |
| @ai-sdk/xai | 3.0.23 | Интеграция с xAI Grok |
| @ai-sdk/openai | 1.0.0 | OpenAI для Gemini OCR |
| ioredis | 5.9.2 | Redis для сессий |
| sharp | 0.34.5 | Обработка изображений |
| docx | 9.5.1 | Генерация DOCX документов |
| xlsx | 0.18.5 | Работа с Excel файлами |
| mammoth | 1.11.0 | Парсинг DOCX/DOCM документов |

---

## Структура проекта

```
rag-sgc-legal/
├── app/
│   ├── api/
│   │   ├── chat/route.ts             # Главный API чата с RAG
│   │   ├── session/route.ts          # Управление сессиями
│   │   ├── upload/route.ts           # Загрузка файлов и OCR
│   │   ├── download/route.ts         # Скачивание документов
│   │   ├── test-xai/route.ts         # Тестирование xAI
│   │   ├── debug-collection/route.ts # Отладка коллекций
│   │   ├── debug-quotes/route.ts     # Отладка цитат
│   │   └── test-download/route.ts    # Тестирование скачивания
│   ├── components/
│   │   └── chat/
│   │       ├── ChatInterface.tsx     # Главный UI компонент (~800 строк)
│   │       ├── UploadButtons.tsx     # Кнопки загрузки файлов/фото/голоса
│   │       ├── FilePreview.tsx       # Предпросмотр документов
│   │       └── PhotoPreview.tsx      # Галерея фотографий
│   ├── globals.css                   # Глобальные стили
│   ├── layout.tsx                    # Root layout (PWA, metadata)
│   └── page.tsx                      # Главная страница
├── lib/
│   ├── grok-client.ts                # RAG конфигурация и системные промпты
│   ├── collections-config.ts         # Конфигурация 4 коллекций
│   ├── query-classifier.ts           # LLM-классификатор запросов
│   ├── response-parser.ts            # Парсинг структурированных ответов
│   ├── docx-generator.ts             # Экспорт в DOCX
│   ├── file-types.ts                 # Типы файлов и константы
│   ├── session/
│   │   ├── types.ts                  # Интерфейсы сессий
│   │   ├── index.ts                  # Публичный API сессий
│   │   ├── redis-store.ts            # Redis хранилище
│   │   └── memory-store.ts           # In-memory хранилище
│   └── utils.ts                      # Утилиты (cn function)
├── public/
│   ├── manifest.json                 # PWA манифест
│   ├── favicon.svg                   # Иконка (SVG)
│   ├── icon-192.png, icon-512.png    # Иконки PWA
│   └── sgc*.png                      # Логотипы СГК
├── scripts/
│   └── generate-icons.js             # Генерация иконок
├── .env.example                      # Пример переменных окружения
├── next.config.js                    # Next.js + PWA конфигурация
├── tailwind.config.js                # Tailwind с брендовыми цветами
└── tsconfig.json                     # TypeScript конфигурация
```

---

## Коллекции документов

Система работает с 4 коллекциями документов xAI:

| Коллекция | ID переменной | Назначение | Приоритет |
|-----------|---------------|------------|-----------|
| **poa** | `POA_COLLECTION_ID` | Доверенности | 10 (высший) |
| **contractForms** | `CONTRACT_FORMS_COLLECTION_ID` | Шаблоны договоров | 5 |
| **articlesOfAssociation** | `ARTICLES_OF_ASSOCIATION_COLLECTION_ID` | Уставы организаций | 5 |
| **standardsAndRegulations** | `STANDARDS_AND_REGULATIONS_COLLECTION_ID` | Стандарты и регламенты | 1 |

**Конфигурация каждой коллекции включает:**
- `keywords` — ключевые слова для автоматического определения
- `displayName`, `description` — отображаемое имя и описание
- `maxTokensPerDoc` — лимит токенов на документ
- `maxSearchResults` — максимум результатов поиска
- `useFullContent` — использовать полное содержимое документа
- `useFileAttachment` — прикреплять файл к запросу

---

## Компоненты системы

### 1. ChatInterface (Frontend)

**Файл:** `app/components/chat/ChatInterface.tsx`

Главный React-компонент UI чата (~800 строк).

**Функциональность:**
- Streaming ответы через `useChat` hook (Vercel AI SDK)
- Отображение структурированных ответов:
  - Блок ответа с markdown-форматированием
  - Цитаты с указанием источников
  - Карточки найденных документов (toolInvocations)
  - Правовое обоснование
- Модальное окно для таблиц
- Экспорт ответа в DOCX
- Очистка чата и переход к документу

**Состояние:**
```typescript
const {
  messages,         // История сообщений
  input,            // Текущий ввод
  handleInputChange,// Обработчик ввода
  handleSubmit,     // Отправка сообщения
  isLoading,        // Индикатор загрузки
  error             // Ошибки
} = useChat({ api: '/api/chat' });
```

### 2. UploadButtons (Frontend)

**Файл:** `app/components/chat/UploadButtons.tsx`

Компонент для загрузки контента:
- **FileButton** — загрузка документов (PDF, DOCX, DOCM, TXT, XLSX)
- **CameraButton** — захват фотографий с камеры
- **VoiceButton** — голосовой ввод (опционально)

### 3. Chat API (Backend)

**Файл:** `app/api/chat/route.ts`

Главный endpoint обработки запросов (~1200 строк).

**Конфигурация:**
```typescript
export const maxDuration = 120; // Максимум 120 секунд
```

**Логика обработки:**
1. Парсинг входящих сообщений и извлечение контекста
2. Классификация запроса через `query-classifier.ts`
3. Определение целевой коллекции документов
4. Поиск через xAI Collections Search API
5. Формирование контекста RAG с найденными документами
6. Вызов Grok 4.1 Fast с потоковым ответом
7. Трансформация SSE → формат Vercel AI SDK
8. Сохранение контекста в сессию

### 4. Upload API (Backend)

**Файл:** `app/api/upload/route.ts`

Обработка загружаемых файлов:
- **Документы:** парсинг через Mammoth (DOCX), XLSX
- **Фотографии:** OCR через Gemini 3 Flash Preview
- **Ответ:** извлечённый текст для добавления в контекст

### 5. Session API (Backend)

**Файл:** `app/api/session/route.ts`

Управление сессиями пользователей:
- `GET` — получение данных сессии
- `DELETE` — очистка сессии

### 6. Query Classifier

**Файл:** `lib/query-classifier.ts`

LLM-классификатор для определения целевой коллекции:
```typescript
async function classifyQueryWithLLM(
  query: string,
  context?: string
): Promise<ClassificationResult>
```

Анализирует запрос и возвращает:
- Целевую коллекцию
- Режим поиска (hybrid/semantic/keyword)
- Уровень уверенности

### 7. Response Parser

**Файл:** `lib/response-parser.ts`

Парсинг структурированных ответов LLM:
```typescript
interface ParsedResponse {
  answer: string;           // Основной ответ
  quotes: QuoteItem[];      // Цитаты
  legalBasis: LegalBasisItem[]; // Правовое обоснование
  sources: string[];        // Источники
}
```

### 8. DOCX Generator

**Файл:** `lib/docx-generator.ts`

Экспорт ответов в Word документы:
- Стиль: Правовое заключение
- Шрифт: Times New Roman, 11pt
- Структура: заголовок, ответ, цитаты, источники

### 9. Session Store

**Файлы:** `lib/session/`

Система управления сессиями:
- **Redis Store** — production (при наличии REDIS_URL)
- **Memory Store** — development fallback
- **TTL:** 30 минут
- **Лимиты:** 10 документов/коллекцию, 1.5M токенов/сессию

---

## Поток данных RAG

### Последовательность обработки запроса

```
User Input: "Какие полномочия по доверенности №123?"
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ 1. ChatInterface отправляет POST /api/chat    │
│    Body: { messages: [...], sessionId: "..." }│
└───────────────────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ 2. Query Classifier анализирует запрос        │
│    → Определяет коллекцию: "poa"              │
│    → Режим поиска: "hybrid"                   │
└───────────────────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ 3. xAI Collections Search API                 │
│    POST https://api.x.ai/v1/collections/search│
│    collection_id: POA_COLLECTION_ID           │
│    retrieval_mode: "hybrid"                   │
│    max_num_results: 20                        │
└───────────────────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ 4. Форматирование результатов поиска          │
│    [1] Доверенность №123 (score: 0.95)        │
│    Полномочия: подписание договоров...        │
└───────────────────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ 5. Формирование System Prompt                 │
│    getSystemPromptForCollection("poa")        │
│    + НАЙДЕННЫЕ ДОКУМЕНТЫ                      │
└───────────────────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ 6. xAI Chat Completions (streaming)           │
│    POST https://api.x.ai/v1/chat/completions  │
│    model: "grok-4.1-fast"                     │
│    stream: true                               │
└───────────────────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ 7. Response Parser извлекает структуру        │
│    → Ответ, Цитаты, Правовое обоснование      │
└───────────────────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ 8. Stream Transform: SSE → AI SDK format      │
│    ChatInterface обновляет UI                 │
└───────────────────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ 9. Session Store сохраняет контекст           │
│    Документы доступны для follow-up вопросов  │
└───────────────────────────────────────────────┘
```

---

## API Endpoints

### Основные endpoints

| Endpoint | Метод | Назначение |
|----------|-------|------------|
| `/api/chat` | POST | Основной чат с RAG поиском |
| `/api/session` | GET, DELETE | Управление сессиями |
| `/api/upload` | POST | Загрузка файлов и OCR |
| `/api/download` | GET | Скачивание документов |

### Отладочные endpoints

| Endpoint | Метод | Назначение |
|----------|-------|------------|
| `/api/test-xai` | GET | Тестирование подключения xAI |
| `/api/debug-collection` | GET | Отладка коллекций |
| `/api/debug-quotes` | GET | Отладка цитат |
| `/api/test-download` | GET | Тестирование скачивания |

---

## API интеграции

### xAI Collections Search

**Endpoint:** `POST https://api.x.ai/v1/collections/{collection_id}/search`

**Request:**
```json
{
  "query": "поисковый запрос",
  "retrieval_mode": "hybrid",
  "max_num_results": 20
}
```

**Response:**
```json
{
  "results": [
    {
      "content": "текст из документа",
      "metadata": {
        "file_name": "document.pdf",
        "title": "Название"
      },
      "score": 0.95
    }
  ]
}
```

### xAI Chat Completions

**Endpoint:** `POST https://api.x.ai/v1/chat/completions`

**Request:**
```json
{
  "model": "grok-4.1-fast",
  "messages": [
    { "role": "system", "content": "промпт с контекстом" },
    { "role": "user", "content": "вопрос" }
  ],
  "stream": true
}
```

### xAI Management API

**Endpoint:** `GET https://api.x.ai/v1/files/{file_id}/content`

Используется для скачивания исходных документов.

### OpenAI (Gemini OCR)

**Модель:** `gemini-3-flash-preview`

Используется для распознавания текста на фотографиях.

---

## Системные промпты

Система использует контекстно-зависимые промпты:

| Промпт | Файл | Назначение |
|--------|------|------------|
| `legalSystemPrompt` | grok-client.ts | Базовый юридический промпт |
| `poaSystemPrompt` | grok-client.ts | Работа с доверенностями |
| `uploadedDocumentSystemPrompt` | grok-client.ts | Анализ загруженных документов |
| `getSystemPromptForCollection()` | grok-client.ts | Динамический выбор по коллекции |

**Правила ответов:**
1. Отвечает **ТОЛЬКО** на основе найденных документов
2. **НЕ** использует внешние знания
3. Цитирует конкретные пункты и разделы
4. Указывает источники (название документа, раздел)
5. При отсутствии информации — сообщает об этом

**Формат ответов:**
```markdown
## Ответ

[Основной ответ на вопрос]

## Цитаты из документов

1. **Раздел:** *«Цитата»* (Источник: документ, раздел)

## Правовое обоснование

[Анализ и выводы]
```

---

## Переменные окружения

| Переменная | Обязательная | Описание |
|------------|--------------|----------|
| `XAI_API_KEY` | Да | API ключ xAI |
| `STANDARDS_AND_REGULATIONS_COLLECTION_ID` | Да | ID коллекции стандартов |
| `POA_COLLECTION_ID` | Да | ID коллекции доверенностей |
| `CONTRACT_FORMS_COLLECTION_ID` | Да | ID коллекции договоров |
| `ARTICLES_OF_ASSOCIATION_COLLECTION_ID` | Да | ID коллекции уставов |
| `XAI_BASE_URL` | Нет | Base URL API (по умолчанию https://api.x.ai/v1) |
| `XAI_MANAGEMENT_API_KEY` | Нет | Ключ для Management API |
| `REDIS_URL` | Нет | URL Redis для сессий |
| `NODE_ENV` | Нет | Окружение (development/production) |

**Пример `.env.local`:**
```env
XAI_API_KEY=xai-xxxxxxxxxxxxxxxxxxxx
STANDARDS_AND_REGULATIONS_COLLECTION_ID=col-xxxxxxxxxxxxxxxxxxxx
POA_COLLECTION_ID=col-xxxxxxxxxxxxxxxxxxxx
CONTRACT_FORMS_COLLECTION_ID=col-xxxxxxxxxxxxxxxxxxxx
ARTICLES_OF_ASSOCIATION_COLLECTION_ID=col-xxxxxxxxxxxxxxxxxxxx
REDIS_URL=redis://localhost:6379
```

---

## Производительность

| Параметр | Значение |
|----------|----------|
| Runtime | Node.js (Next.js) |
| Максимальная длительность запроса | 120 секунд |
| Количество результатов поиска | до 20 на коллекцию |
| Streaming | SSE (Server-Sent Events) |
| Кэширование сессий | Redis / In-memory |
| TTL сессии | 30 минут |
| Лимит токенов на сессию | 1.5M |

---

## PWA конфигурация

**Файл:** `public/manifest.json`

```json
{
  "name": "Юридическая служба СГК",
  "short_name": "ЮС СГК",
  "start_url": "/",
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#0a1520",
  "theme_color": "#1e3a5f"
}
```

**Особенности:**
- Standalone режим (без браузерного UI)
- Портретная ориентация
- Брендовые цвета СГК
- Иконки 192x192 и 512x512
- Service Worker (через next-pwa)

---

## Брендовые цвета

```css
/* SGC Palette */
--sgc-blue-900: #0a1520   /* Темный фон */
--sgc-blue-700: #0f2035   /* Карточки */
--sgc-blue-500: #1e3a5f   /* Акценты */
--sgc-orange-500: #f7941d /* Основной оранжевый */
--sgc-orange-600: #e8850a /* Темный оранжевый */
```

---

## Обработка ошибок

| Ситуация | Поведение |
|----------|-----------|
| Ошибка поиска документов | Продолжение без контекста |
| Ошибка API xAI | JSON с полем `error`, retry |
| Невалидный JSON в stream | Пропуск, продолжение потока |
| Отсутствие API ключа | HTTP 500 с описанием |
| Ошибка OCR | Возврат ошибки загрузки |
| Превышение лимита токенов | Урезание контекста |
| Redis недоступен | Fallback на in-memory store |

---

## Функциональные возможности

### RAG система
- **Гибридный поиск** (hybrid, semantic, keyword режимы)
- **4 коллекции документов** с автоматическим выбором
- **LLM-классификация** запросов
- **Контекстный поиск** с учётом истории сессии

### Чат с Grok
- **Streaming ответы** в реальном времени
- **Структурированные ответы** с блоками
- **Tool invocations** — отображение найденных документов
- **Контекст сессии** — кэширование между запросами

### Загрузка файлов
- **Документы:** PDF, DOCX, DOCM, TXT, XLSX
- **Изображения:** JPG, PNG, WebP, GIF
- **OCR** через Gemini 3 Flash для фотографий
- **Парсинг таблиц** из Excel

### Экспорт
- **DOCX** — структурированное правовое заключение
- **Скачивание** исходных документов из коллекций

### Сессии
- **Генерация Session ID** на клиенте
- **Redis хранилище** (production)
- **In-memory fallback** (development)
- **Автоматическая очистка** по TTL

---

## Запуск и развертывание

### Локальная разработка

```bash
# Установка зависимостей
npm install

# Копирование переменных окружения
cp .env.example .env.local
# Заполнить все переменные

# Запуск dev-сервера
npm run dev
```

### Production сборка

```bash
# Сборка
npm run build

# Запуск
npm start
```

### Деплой на Railway/Vercel

1. Подключить репозиторий
2. Настроить Environment Variables:
   - `XAI_API_KEY`
   - `*_COLLECTION_ID` (4 переменные)
   - `REDIS_URL` (опционально)
3. Deploy

---

## Диаграмма компонентов

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │               ChatInterface.tsx                      │   │
│  │  ┌───────────┐  ┌──────────────┐  ┌────────────┐   │   │
│  │  │  Header   │  │  Messages    │  │   Input    │   │   │
│  │  │  (Logo)   │  │  Area        │  │   Area     │   │   │
│  │  └───────────┘  └──────────────┘  └────────────┘   │   │
│  │                        │                            │   │
│  │        ┌───────────────┼───────────────┐           │   │
│  │        ▼               ▼               ▼           │   │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────┐     │   │
│  │  │ToolCards │  │ UploadButtons│  │ useChat()│     │   │
│  │  │(Documents)│  │ (File/Photo) │  │ AI SDK   │     │   │
│  │  └──────────┘  └──────────────┘  └────┬─────┘     │   │
│  └───────────────────────────────────────┼───────────┘   │
│                                          │                │
└──────────────────────────────────────────┼────────────────┘
                                           │ POST /api/*
                                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Next.js Node.js Runtime                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   route.ts (chat)                    │   │
│  │  ┌─────────────┐  ┌────────────┐  ┌─────────────┐  │   │
│  │  │ Parse       │→ │ Classify   │→ │ Search      │  │   │
│  │  │ Messages    │  │ Query      │  │ Collections │  │   │
│  │  └─────────────┘  └────────────┘  └─────────────┘  │   │
│  │                                          │          │   │
│  │  ┌─────────────┐  ┌────────────┐         │          │   │
│  │  │ Transform   │← │ Call Grok  │←────────┘          │   │
│  │  │ Stream      │  │ Streaming  │                    │   │
│  │  └─────────────┘  └────────────┘                    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ grok-client  │  │ query-       │  │ collections- │      │
│  │ .ts          │  │ classifier.ts│  │ config.ts    │      │
│  │ (Prompts)    │  │ (LLM Class.) │  │ (4 colls)    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ response-    │  │ docx-        │  │ session/     │      │
│  │ parser.ts    │  │ generator.ts │  │ (Redis/Mem)  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                             │
└───────────────────────────┬─────────────────────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│    xAI API      │ │   OpenAI API    │ │     Redis       │
├─────────────────┤ ├─────────────────┤ ├─────────────────┤
│ Collections     │ │ Gemini 3 Flash  │ │ Session Store   │
│ Search API      │ │ (OCR)           │ │ - TTL: 30min    │
│                 │ │                 │ │ - Max 1.5M tok  │
│ Chat Completions│ │                 │ │                 │
│ grok-4.1-fast   │ │                 │ │                 │
│ grok-2-beta     │ │                 │ │                 │
│                 │ │                 │ │                 │
│ Management API  │ │                 │ │                 │
│ (File download) │ │                 │ │                 │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## Контакты и поддержка

Для вопросов по архитектуре обращайтесь в ИТ-отдел СГК.
