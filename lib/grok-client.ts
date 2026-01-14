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

ПРАВИЛА РАБОТЫ:
1. Отвечайте ТОЛЬКО на основе документов из раздела "НАЙДЕННЫЕ ДОКУМЕНТЫ"
2. НИКОГДА не используйте общие знания или информацию из интернета
3. Всегда цитируйте конкретные пункты и разделы из документов
4. Указывайте источник: название документа, раздел
5. Если в найденных документах нет информации по вопросу — так и скажите

ФОРМАТ ОТВЕТА:
- Прямой ответ на вопрос (на основе документов)
- Цитаты из документов
- Источники

Если раздел "НАЙДЕННЫЕ ДОКУМЕНТЫ" пуст или не содержит релевантной информации, отвечайте: "К сожалению, в загруженных документах СГК информация по вашему запросу не найдена."`;

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
