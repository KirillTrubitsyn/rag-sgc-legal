import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGrokClient, legalSystemPrompt, collectionsSearchTool } from '@/lib/grok-client';

export const runtime = 'edge';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();

    // Получаем env переменные в момент запроса (не при загрузке модуля!)
    const apiKey = process.env.XAI_API_KEY;
    const collectionId = process.env.COLLECTION_ID;

    // Валидация
    if (!apiKey || !collectionId) {
      const missing = [];
      if (!apiKey) missing.push('XAI_API_KEY');
      if (!collectionId) missing.push('COLLECTION_ID');

      console.error(`Missing env vars: ${missing.join(', ')}`);
      return new Response(
        JSON.stringify({
          error: `Missing: ${missing.join(', ')}`,
          help: 'Add these to Vercel Environment Variables and redeploy'
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Создаем клиенты В МОМЕНТ ЗАПРОСА с актуальными ключами
    const xai = createOpenAI({
      apiKey: apiKey,
      baseURL: 'https://api.x.ai/v1',
    });

    const grokClient = createGrokClient({
      apiKey: apiKey,
      collectionId: collectionId,
    });

    // Streaming ответ
    const result = streamText({
      model: xai('grok-4.1-fast'),
      system: legalSystemPrompt,
      messages,
      maxSteps: 5,
      tools: {
        collections_search: {
          description: collectionsSearchTool.description,
          parameters: collectionsSearchTool.parameters,
          execute: async ({ query, top_k = 5 }: { query: string; top_k?: number }) => {
            const results = await grokClient.search(query, { topK: top_k });
            return { results };
          },
        },
      },
    });

    return result.toDataStreamResponse();
  } catch (error) {
    console.error('Chat API error:', error);
    return new Response(
      JSON.stringify({
        error: 'Request failed',
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
