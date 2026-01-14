import { streamText } from 'ai';
import { grokModel, legalSystemPrompt, collectionsSearchTool } from '@/lib/xai-client';

export const runtime = 'edge';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    // Получаем messages из request body
    const { messages } = await req.json();

    // Проверяем наличие обязательных переменных окружения
    const xaiApiKey = process.env.XAI_API_KEY;
    const collectionId = process.env.COLLECTION_ID;

    const missingEnvVars: string[] = [];
    if (!xaiApiKey) missingEnvVars.push('XAI_API_KEY');
    if (!collectionId) missingEnvVars.push('COLLECTION_ID');

    if (missingEnvVars.length > 0) {
      const missingList = missingEnvVars.join(', ');
      console.error(
        `Missing required environment variables: ${missingList}\n` +
        'To fix this:\n' +
        '1. Create a .env.local file in the project root\n' +
        '2. Add:\n' +
        '   XAI_API_KEY=your_xai_api_key_here\n' +
        '   COLLECTION_ID=your_collection_id_here\n' +
        '3. Get your API key from https://console.x.ai\n' +
        '4. Get your Collection ID from https://console.x.ai/collections\n' +
        '5. Restart the dev server'
      );
      return new Response(
        JSON.stringify({
          error: `Missing environment variables: ${missingList}`,
          message: 'Please configure required environment variables in your .env.local file',
          details: {
            XAI_API_KEY: xaiApiKey ? '✓ Set' : '✗ Missing - get from https://console.x.ai',
            COLLECTION_ID: collectionId ? '✓ Set' : '✗ Missing - get from https://console.x.ai/collections'
          }
        }),
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
            collection_ids = [collectionId!],
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
