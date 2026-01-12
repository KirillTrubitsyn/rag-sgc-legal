import { createOpenAI } from '@ai-sdk/openai';
import type { CoreTool } from 'ai';

// Создание xAI клиента
const xai = createOpenAI({
  apiKey: process.env.XAI_API_KEY || '',
  baseURL: 'https://api.x.ai/v1',
});

// Grok модель
export const grokModel = xai('grok-4.1-fast');

// Типы для collections_search tool
export interface CollectionsSearchParams {
  query: string;
  collection_ids?: string[];
  top_k?: number;
}

export interface CollectionsSearchResult {
  documents: Array<{
    id: string;
    content: string;
    metadata?: Record<string, any>;
    score?: number;
  }>;
}

// Collections Search Tool
export const collectionsSearchTool = {
  type: 'function' as const,
  function: {
    name: 'collections_search',
    description: 'Searches through SGC legal documents using hybrid search',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string' as const,
          description: 'Search query for finding relevant documents',
        },
        collection_ids: {
          type: 'array' as const,
          items: {
            type: 'string' as const,
          },
          description: 'Array of collection IDs to search in (e.g., ["Standards and Regulations"])',
        },
        top_k: {
          type: 'number' as const,
          description: 'Number of top results to return',
          default: 5,
        },
      },
      required: ['query'] as const,
    },
  },
};

// System prompt для юридического ассистента
export const legalSystemPrompt = `Вы — юридический ассистент для работы с нормативными документами и стандартами СГК (Сибирская генерирующая компания).

КОНТЕКСТ:
СГК — российская энергетическая компания (угольные электростанции, субхолдинг Сибкур).
Коллекция: "Standards and Regulations"

ПРАВИЛА:
1. Всегда цитируйте конкретные пункты, статьи, разделы
2. Если информация не найдена — явно указывайте
3. Не делайте выводов без подтверждения документами
4. Используйте collections_search для поиска
5. Формат ссылок: [Название документа, раздел X.X]
6. Приоритет: федеральные законы > корпоративные стандарты

ФОРМАТ ОТВЕТА:
- Прямой ответ
- Цитаты из документов
- Источники (документ, раздел, страница)
- Дополнительный контекст

Отвечайте профессионально, кратко и точно.`;

// Экспорт xAI клиента для прямого использования
export { xai };
