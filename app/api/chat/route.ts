import { streamText } from 'ai';
import { grokModel, legalSystemPrompt, collectionsSearchTool } from '@/lib/xai-client';

export const runtime = 'edge';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    // Получаем messages из request body
    const { messages } = await req.json();

    // Получаем COLLECTION_ID из переменных окружения
    const collectionId = process.env.COLLECTION_ID;

    // Проверяем наличие COLLECTION_ID
    if (!collectionId) {
      console.error('COLLECTION_ID is not set in environment variables');
      return new Response(
        JSON.stringify({ error: 'COLLECTION_ID is not configured' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Создаем streaming ответ с помощью streamText
    const result = streamText({
      model: grokModel,
      system: legalSystemPrompt,
      messages,
      maxSteps: 5,
      tools: {
        collections_search: {
          description: collectionsSearchTool.function.description,
          parameters: collectionsSearchTool.function.parameters,
          execute: async ({
            query,
            collection_ids = [collectionId],
            top_k = 5
          }: {
            query: string;
            collection_ids?: string[];
            top_k?: number;
          }) => {
            try {
              console.log('Searching collections:', { query, collection_ids, top_k });

              // Делаем POST запрос к xAI Collections Search API
              const response = await fetch('https://api.x.ai/v1/collections/search', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  query,
                  collection_ids,
                  top_k,
                  retrieval_mode: 'hybrid',
                }),
              });

              if (!response.ok) {
                const errorText = await response.text();
                console.error('Collections search failed:', response.status, errorText);
                throw new Error(`Collections search failed: ${response.status} ${errorText}`);
              }

              const data = await response.json();

              // Форматируем результаты
              const results = data.results.map((r: any) => ({
                content: r.content,
                source: r.metadata?.filename || 'Unknown',
                score: r.score,
                page: r.metadata?.page,
              }));

              console.log(`Found ${results.length} results for query: ${query}`);

              return { results };
            } catch (error) {
              console.error('Error in collections_search execute:', error);
              throw error;
            }
          },
        },
      },
    });

    // Возвращаем streaming ответ
    return result.toDataStreamResponse();
  } catch (error) {
    console.error('Error in chat API route:', error);
    return new Response(
      JSON.stringify({
        error: 'An error occurred while processing your request',
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
