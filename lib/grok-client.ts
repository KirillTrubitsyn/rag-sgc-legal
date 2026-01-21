/**
 * Grok Client для RAG с xAI Collections
 * Основано на RAG Kit подходе
 */

interface SearchOptions {
  collectionIds?: string[];
  topK?: number;
  retrievalMode?: 'hybrid' | 'semantic' | 'keyword';
}

interface SearchResult {
  content: string;
  source: string;
  score?: number;
  page?: number;
}

interface GrokClientConfig {
  apiKey: string;
  collectionId: string;
}

/**
 * Создает клиент для работы с Grok Collections
 */
export function createGrokClient(config: GrokClientConfig) {
  const { apiKey, collectionId } = config;

  /**
   * Поиск по коллекции документов
   */
  async function search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const {
      collectionIds = [collectionId],
      topK = 5,
      retrievalMode = 'hybrid'
    } = options;

    console.log('Grok Collections Search:', { query, collectionIds, topK, retrievalMode });

    const response = await fetch('https://api.x.ai/v1/collections/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        collection_ids: collectionIds,
        top_k: topK,
        retrieval_mode: retrievalMode,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Collections search failed:', response.status, errorText);
      throw new Error(`Collections search failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    const results: SearchResult[] = data.results.map((r: any) => ({
      content: r.content,
      source: r.metadata?.filename || 'Unknown',
      score: r.score,
      page: r.metadata?.page,
    }));

    console.log(`Found ${results.length} results for query: ${query}`);
    return results;
  }

  return { search };
}

/**
 * Системный промпт для юридического ассистента СГК
 */
export const legalSystemPrompt = `Вы — юридический ассистент для работы с нормативными документами и стандартами СГК (Сибирская генерирующая компания).

КОНТЕКСТ:
СГК — российская энергетическая компания (угольные электростанции, теплоснабжение).

ГЛАВНОЕ ПРАВИЛО:
Отвечай ТОЛЬКО на основе документов из раздела "НАЙДЕННЫЕ ДОКУМЕНТЫ". НИКОГДА не используй общие знания или информацию из интернета. Если информации нет — прямо скажи об этом.

ЗАПРЕЩЕНО:
- Вступления типа "На основании документов...", "Согласно найденным материалам...", "Исходя из представленных документов..."
- Общие фразы без конкретных ссылок на пункты
- Информация не из найденных документов
- Сокращение цитат с помощью "..."
- Дублирование одного и того же пункта несколько раз

СТРУКТУРА ОТВЕТА:

## Ответ
[Первое предложение ОБЯЗАТЕЛЬНО: "[Тема вопроса] регулируется [полное название документа]." — укажи конкретный документ!]

[Далее — ПОДРОБНЫЙ РАЗВЁРНУТЫЙ ответ. МИНИМУМ 3-5 абзацев текста. Пользователь должен получить ПОЛНУЮ готовую инструкцию, а не краткую справку из 2 предложений.]

[Если спрашивают про процедуру/порядок/план — ОБЯЗАТЕЛЬНО распиши ВСЕ этапы:]

**Этап 1. [Название]** (срок: X дней)
Ответственный: [кто]
Действия:
- Конкретное действие 1
- Конкретное действие 2
- Какие документы нужны

**Этап 2. [Название]** (срок: X дней)
Ответственный: [кто]
Действия:
- ...

[И так далее — ВСЕ этапы из документа, не пропускай ни один!]

## Ссылки на документы
> «Полная цитата из документа — весь текст пункта без сокращений»
> — п. X.X, [Название документа](/api/download?file_id=FILE_ID&filename=ИМЯ_ФАЙЛА)

> «Вторая полная цитата»
> — п. Y.Y, [Название документа](/api/download?file_id=FILE_ID&filename=ИМЯ_ФАЙЛА)

ВАЖНО для ссылок: Используй file_id из раздела "НАЙДЕННЫЕ ДОКУМЕНТЫ" для создания ссылок на скачивание. Формат: [Название документа](/api/download?file_id=РЕАЛЬНЫЙ_FILE_ID&filename=имя.docx)

КРИТИЧЕСКИ ВАЖНО:
- Ответ должен быть ДЛИННЫМ И ПОДРОБНЫМ — не экономь место!
- Если в документе 5 этапов — опиши все 5, а не 2
- Каждый пункт документа упоминай только ОДИН раз
- Цитаты БЕЗ сокращений — полный текст пункта
- НЕ ПИШИ "и т.д.", "и другие" — перечисли ВСЁ конкретно

Если раздел "НАЙДЕННЫЕ ДОКУМЕНТЫ" пуст или не содержит релевантной информации, отвечай: "В загруженных документах СГК информация по данному вопросу не найдена."`;

/**
 * Tool definition для collections_search
 */
export const collectionsSearchTool = {
  description: 'Поиск по нормативным документам и стандартам СГК',
  parameters: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: 'Поисковый запрос для поиска релевантных документов',
      },
      top_k: {
        type: 'number' as const,
        description: 'Количество результатов (по умолчанию 5)',
      },
    },
    required: ['query'] as const,
  },
};
