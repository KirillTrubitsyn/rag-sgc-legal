# xAI Grok API - Исследование Endpoints для Скачивания Документов

## Результаты тестирования

### Статус: Требуется валидный API ключ

Предоставленный `XAI_MANAGEMENT_API_KEY` не прошел валидацию:
```
{"code":"Client specified an invalid argument","error":"Incorrect API key provided: xa***62. You can obtain an API key from https://console.x.ai."}
```

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
```bash
curl -X POST "https://api.x.ai/v1/documents/search" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "ваш поисковый запрос",
    "collection_ids": ["'$COLLECTION_ID'"],
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

## Что нужно сделать

### 1. Получить валидный API ключ
- Зайти на https://console.x.ai
- Создать API Key (не Management Key!)
- Убедиться что ключ имеет права на:
  - Collections: read
  - Files: read, download
  - Documents: search

### 2. Обновить .env.local
```env
XAI_API_KEY=xai-ваш-валидный-api-ключ
COLLECTION_ID=ваш-collection-id
XAI_BASE_URL=https://api.x.ai/v1
```

### 3. Протестировать
```bash
# Проверить ключ
curl -X GET "https://api.x.ai/v1/api-key" \
  -H "Authorization: Bearer $XAI_API_KEY"

# Получить коллекции
curl -X GET "https://api.x.ai/v1/collections" \
  -H "Authorization: Bearer $XAI_API_KEY"
```

---

## Источники

- [xAI API Overview](https://docs.x.ai/docs/overview)
- [Collections API Reference](https://docs.x.ai/docs/collections-api)
- [Using Collections via API](https://docs.x.ai/docs/guides/using-collections/api)
- [Files Overview](https://docs.x.ai/docs/guides/files)
- [xAI Python SDK](https://github.com/xai-org/xai-sdk-python)
- [llms.txt with all endpoints](https://docs.x.ai/llms.txt)
