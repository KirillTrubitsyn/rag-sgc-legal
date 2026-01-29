# Инструкция по развёртыванию на Railway

## Оглавление

1. [Создание проекта на Railway](#1-создание-проекта-на-railway)
2. [Подключение Redis](#2-подключение-redis)
3. [Настройка переменных окружения](#3-настройка-переменных-окружения)
4. [Изменения в коде](#4-изменения-в-коде)
5. [Деплой](#5-деплой)
6. [Проверка работы](#6-проверка-работы)
7. [Мониторинг и логи](#7-мониторинг-и-логи)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Создание проекта на Railway

### 1.1 Регистрация

1. Перейдите на [railway.app](https://railway.app/)
2. Нажмите **"Login"** → войдите через GitHub
3. Подтвердите доступ к репозиториям

### 1.2 Создание нового проекта

1. На дашборде нажмите **"New Project"**
2. Выберите **"Deploy from GitHub repo"**
3. Найдите репозиторий `rag-sgc-legal`
4. Нажмите **"Deploy Now"**

### 1.3 Настройка сервиса

После создания проекта:

1. Кликните на созданный сервис
2. Перейдите в **Settings**
3. В разделе **Build**:
   - Build Command: `npm run build`
   - Start Command: `npm start`
4. В разделе **Networking**:
   - Нажмите **"Generate Domain"** для получения публичного URL

---

## 2. Подключение Redis

### Вариант A: Railway Redis (рекомендуется)

1. В проекте нажмите **"New"** → **"Database"** → **"Add Redis"**
2. Railway автоматически создаст Redis инстанс
3. Переменная `REDIS_URL` будет автоматически добавлена

### Вариант B: Upstash Redis (бесплатный tier)

1. Зарегистрируйтесь на [upstash.com](https://upstash.com/)
2. Создайте новую Redis базу данных
3. Скопируйте **Redis URL** (формат: `redis://default:xxx@xxx.upstash.io:6379`)
4. Добавьте в Railway как переменную окружения `REDIS_URL`

### Вариант C: Redis Cloud

1. Зарегистрируйтесь на [redis.com/cloud](https://redis.com/cloud/)
2. Создайте бесплатную базу данных (30MB)
3. Скопируйте connection string
4. Добавьте в Railway как `REDIS_URL`

---

## 3. Настройка переменных окружения

### 3.1 Откройте настройки переменных

1. В Railway кликните на сервис приложения
2. Перейдите во вкладку **"Variables"**

### 3.2 Добавьте обязательные переменные

| Переменная | Описание | Пример |
|------------|----------|--------|
| `XAI_API_KEY` | API ключ xAI/Grok | `xai-xxx...` |
| `REDIS_URL` | URL Redis сервера | `redis://...` (автоматически если Railway Redis) |
| `NODE_ENV` | Режим работы | `production` |

### 3.3 Добавьте ID коллекций

| Переменная | Описание |
|------------|----------|
| `POA_COLLECTION_ID` | ID коллекции доверенностей |
| `ARTICLES_OF_ASSOCIATION_COLLECTION_ID` | ID коллекции уставов |
| `CONTRACT_FORMS_COLLECTION_ID` | ID коллекции форм договоров |
| `STANDARDS_AND_REGULATIONS_COLLECTION_ID` | ID коллекции стандартов |

### 3.4 Как добавить переменную

1. Нажмите **"New Variable"**
2. Введите имя (например: `XAI_API_KEY`)
3. Введите значение
4. Нажмите **"Add"**
5. Railway автоматически передеплоит приложение

---

## 4. Изменения в коде

### 4.1 Убрать Edge Runtime

Откройте файл `app/api/chat/route.ts` и **удалите или закомментируйте**:

```typescript
// УДАЛИТЬ эти строки:
export const runtime = 'edge';
export const maxDuration = 60;
```

Также в `app/api/session/route.ts`:

```typescript
// УДАЛИТЬ:
export const runtime = 'edge';
```

### 4.2 Включить Redis в Session Store

Откройте файл `lib/session/index.ts` и замените содержимое:

```typescript
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
```

### 4.3 Установить зависимости

Убедитесь, что `ioredis` установлен:

```bash
npm install ioredis
```

### 4.4 Закоммитить изменения

```bash
git add .
git commit -m "feat: Enable Redis session store for Railway deployment"
git push origin main
```

---

## 5. Деплой

### 5.1 Автоматический деплой

Railway автоматически деплоит при push в main ветку.

### 5.2 Ручной деплой

1. В Railway откройте сервис
2. Перейдите в **Deployments**
3. Нажмите **"Deploy"** → **"Deploy Now"**

### 5.3 Проверка статуса

1. Следите за логами в разделе **"Deployments"**
2. Дождитесь статуса **"Success"**
3. Откройте сгенерированный URL

---

## 6. Проверка работы

### 6.1 Проверить Redis подключение

Откройте логи приложения в Railway и найдите:

```
[SessionStore] Using Redis store
[RedisStore] Connected to Redis
```

### 6.2 Проверить API сессий

```bash
# Замените YOUR_DOMAIN на ваш Railway домен
curl "https://YOUR_DOMAIN.railway.app/api/session"
```

Ожидаемый ответ:
```json
{
  "sessionId": "sess_xxx",
  "isNew": true
}
```

### 6.3 Проверить чат

1. Откройте приложение в браузере
2. Задайте вопрос
3. Проверьте что в header появился индикатор "X док. в контексте"
4. Задайте follow-up вопрос
5. Убедитесь что контекст сохранился

### 6.4 Проверить Redis через CLI

Если используете Railway Redis:

1. В Railway кликните на Redis сервис
2. Перейдите в **"Connect"**
3. Скопируйте команду подключения
4. Выполните:

```bash
redis-cli -u $REDIS_URL

# Проверить ключи сессий
KEYS sgc:session:*

# Посмотреть TTL сессии
TTL sgc:session:sess_xxx
```

---

## 7. Мониторинг и логи

### 7.1 Логи приложения

1. В Railway откройте сервис
2. Перейдите в **"Deployments"**
3. Кликните на активный деплой
4. Смотрите логи в реальном времени

### 7.2 Метрики

Railway показывает:
- CPU usage
- Memory usage
- Network traffic

### 7.3 Алерты

1. Перейдите в **Settings** → **Alerts**
2. Настройте уведомления о падениях

---

## 8. Troubleshooting

### Проблема: Redis не подключается

**Симптомы:**
```
[SessionStore] Using Memory store
```

**Решения:**
1. Проверьте что переменная `REDIS_URL` установлена
2. Проверьте формат URL: `redis://user:password@host:port`
3. Убедитесь что Redis сервис запущен

### Проблема: Ошибка "Module not found: net"

**Причина:** Код запускается в Edge Runtime

**Решение:** Удалите `export const runtime = 'edge'` из route файлов

### Проблема: Сессии быстро истекают

**Решение:** Увеличьте TTL в `lib/session/types.ts`:

```typescript
export const DEFAULT_SESSION_OPTIONS = {
  ttlSeconds: 60 * 60,  // 1 час вместо 30 минут
  // ...
};
```

### Проблема: Превышен лимит памяти

**Симптомы:** Приложение падает с OOM

**Решения:**
1. Уменьшите `maxTotalTokens` в настройках
2. Уменьшите `maxDocumentsPerCollection`
3. Апгрейдните план Railway

### Проблема: Медленные ответы

**Возможные причины:**
1. Холодный старт Redis подключения
2. Большие документы в кэше

**Решения:**
1. Используйте connection pooling в Redis
2. Включите сжатие документов

---

## Дополнительно: Настройка CI/CD

### GitHub Actions для автодеплоя

Создайте `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Railway

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Install Railway CLI
        run: npm install -g @railway/cli

      - name: Deploy
        run: railway up
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
```

### Получение RAILWAY_TOKEN

1. В Railway перейдите в **Account Settings**
2. Создайте новый токен в разделе **Tokens**
3. Добавьте в GitHub Secrets репозитория

---

## Контакты для поддержки

- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- xAI Docs: https://docs.x.ai

---

*Последнее обновление: Январь 2026*
