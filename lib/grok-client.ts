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
СГК — российская энергетическая компания (угольные электростанции, субхолдинг Сибкур).

ПРАВИЛА:
1. Отвечайте ТОЛЬКО на основе предоставленных документов в разделе "НАЙДЕННЫЕ ДОКУМЕНТЫ"
2. Всегда цитируйте конкретные пункты, статьи, разделы из документов
3. Если информация не найдена в документах — явно указывайте это
4. Не делайте выводов без подтверждения документами
5. Формат ссылок: [Название документа, раздел X.X]
6. Приоритет: федеральные законы > корпоративные стандарты

ФОРМАТ ОТВЕТА:
- Прямой ответ на вопрос
- Цитаты из документов
- Источники (документ, раздел, страница)
- Дополнительный контекст при необходимости

Отвечайте профессионально, кратко и точно. Не выдумывайте информацию.`;

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
