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
[Первое предложение: "Данный вопрос регулируется [название документа/документов]." или "[Тема] регулируется [название документа]."]

[Далее — РАЗВЁРНУТЫЙ ответ на вопрос пользователя. Если просят пошаговый план или инструкцию — дай ПОЛНУЮ пошаговую инструкцию с нумерованными этапами, сроками, ответственными и конкретными действиями. Не экономь место — у нас контекст 2 млн токенов. Пользователь должен получить готовую для работы инструкцию, а не краткую справку.]

[Для пошаговых планов используй формат:
**Этап 1. Название этапа**
- Действие 1 (срок: X дней, ответственный: кто)
- Действие 2
- ...

**Этап 2. Название этапа**
- ...
]

## Ссылки на документы
> «Полная цитата из документа без сокращений»
> — п. X.X, Название документа

> «Вторая цитата»
> — п. Y.Y, Название документа

[Приводи 2-4 ключевые цитаты. Каждый пункт упоминай только ОДИН раз — если из одного пункта нужно процитировать несколько частей, объедини их в одну цитату.]

ВАЖНО:
- ПЕРВОЕ предложение ответа ВСЕГДА указывает документ-основание
- Отвечай РАЗВЁРНУТО — давай готовые к применению инструкции
- Если просят план/порядок/процедуру — описывай ВСЕ этапы подробно
- Указывай конкретные сроки, суммы, ответственных
- Не дублируй одинаковые пункты в цитатах
- Цитаты должны быть ПОЛНЫМИ, без сокращений

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
