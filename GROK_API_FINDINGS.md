# xAI Grok API - Исследование Endpoints для Скачивания Документов

## Текущая конфигурация (Vercel)

```env
XAI_API_KEY=xai-tumX5RkNkrYLl...5X
XAI_MANAGEMENT_API_KEY=xai-token-fNxHvkZHrCb3FVQ0Bg1xRh...62
COLLECTION_ID=collection_c49af888-b405-4fc2-98fd-33b06b36cee8
```

### Примечание по тестированию
Тестирование из sandbox-окружения ограничено (SSL/network issues).
Рекомендуется тестировать локально или через Vercel deployment.

---

## Найденные API Endpoints

### Базовые URL
| Назначение | URL |
|------------|-----|
| REST API (чат, файлы, коллекции) | `https://api.x.ai` |
| Management API (ключи, биллинг) | `https://management-api.x.ai/v1/` |

### Типы ключей xAI
1. **API Key** - для работы с чатом, файлами, коллекциями (`api.x.ai`)
2. **Management API Key** - для управления ключами, биллинга (`management-api.x.ai`)

---

## Endpoints для работы с документами

### 1. Коллекции

| Метод | Endpoint | Описание |
|-------|----------|----------|
| `GET` | `/v1/collections` | Список всех коллекций |
| `POST` | `/v1/collections` | Создать коллекцию |
| `GET` | `/v1/collections/{collection_id}` | Получить информацию о коллекции |
| `PUT` | `/v1/collections/{collection_id}` | Обновить коллекцию |
| `DELETE` | `/v1/collections/{collection_id}` | Удалить коллекцию |

### 2. Документы в коллекциях

| Метод | Endpoint | Описание |
|-------|----------|----------|
| `GET` | `/v1/collections/{collection_id}/documents` | Список документов в коллекции |
| `POST` | `/v1/collections/{collection_id}/documents/{file_id}` | Добавить документ в коллекцию |
| `GET` | `/v1/collections/{collection_id}/documents/{file_id}` | Получить метаданные документа |
| `PATCH` | `/v1/collections/{collection_id}/documents/{file_id}` | Обновить документ |
| `DELETE` | `/v1/collections/{collection_id}/documents/{file_id}` | Удалить документ |
| `GET` | `/v1/collections/{collection_id}/documents:batchGet` | Batch получение документов |

### 3. Файлы (ключевые для скачивания)

| Метод | Endpoint | Описание |
|-------|----------|----------|
| `GET` | `/v1/files` | Список всех файлов |
| `POST` | `/v1/files` | Загрузить файл |
| `GET` | `/v1/files/{file_id}` | Информация о файле |
| `PUT` | `/v1/files/{file_id}` | Обновить файл |
| `DELETE` | `/v1/files/{file_id}` | Удалить файл |
| **`POST`** | **`/v1/files:download`** | **⬇️ СКАЧАТЬ ФАЙЛ** |

### 4. Поиск

| Метод | Endpoint | Описание |
|-------|----------|----------|
| `POST` | `/v1/documents/search` | Поиск по документам |

---

## Как скачать документ

### Шаг 1: Поиск документа

**ВАЖНО:** Формат запроса требует `source` объект!

```bash
curl -X POST "https://api.x.ai/v1/documents/search" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "ваш поисковый запрос",
    "source": {
      "collection_ids": ["'"$COLLECTION_ID"'"]
    },
    "top_k": 10,
    "retrieval_mode": "hybrid"
  }'
```

Ответ содержит `file_id` для каждого найденного документа.

### Шаг 2: Получить информацию о файле
```bash
curl -X GET "https://api.x.ai/v1/files/{file_id}" \
  -H "Authorization: Bearer $XAI_API_KEY"
```

### Шаг 3: Скачать файл
```bash
curl -X POST "https://api.x.ai/v1/files:download" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"file_id": "FILE_ID_HERE"}' \
  -o document.pdf
```

---

## Связь document_id, file_id и collection_id

```
collection (коллекция)
    └── document (документ в коллекции, имеет file_id)
            └── file (сам файл, хранится отдельно)
```

- `collection_id` - ID коллекции (группа документов)
- `file_id` - ID файла в системе файлов xAI
- В результатах поиска документ возвращается с `file_id`

---

## Структура ответа поиска (ожидаемая)

```json
{
  "results": [
    {
      "file_id": "file_abc123",
      "collection_id": "col_xyz789",
      "content": "...",
      "score": 0.95,
      "metadata": {
        "filename": "document.pdf",
        "created_at": "2025-01-01T00:00:00Z"
      }
    }
  ]
}
```

---

## Следующие шаги

### 1. Проверить ключи (локально или на Vercel)
```bash
# Проверить API ключ
curl -X GET "https://api.x.ai/v1/api-key" \
  -H "Authorization: Bearer $XAI_API_KEY"

# Получить список коллекций
curl -X GET "https://api.x.ai/v1/collections" \
  -H "Authorization: Bearer $XAI_API_KEY"

# Поиск в коллекции
curl -X POST "https://api.x.ai/v1/documents/search" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "ГОСТ",
    "source": {"collection_ids": ["collection_c49af888-b405-4fc2-98fd-33b06b36cee8"]},
    "top_k": 3
  }'
```

### 2. Имплементировать в приложении
После успешного тестирования - добавить endpoint `/api/download` который:
1. Получает `file_id` из результатов поиска
2. Вызывает `POST /v1/files:download`
3. Возвращает файл пользователю

### 3. Если нужен Management API
Management API (`management-api.x.ai`) требует отдельный Management Key.
Создать его можно в xAI Console → API Keys → Create Management Key.

---

## Источники

- [xAI API Overview](https://docs.x.ai/docs/overview)
- [Collections API Reference](https://docs.x.ai/docs/collections-api)
- [Using Collections via API](https://docs.x.ai/docs/guides/using-collections/api)
- [Files Overview](https://docs.x.ai/docs/guides/files)
- [xAI Python SDK](https://github.com/xai-org/xai-sdk-python)
- [llms.txt with all endpoints](https://docs.x.ai/llms.txt)
