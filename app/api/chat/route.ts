import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGrokClient, legalSystemPrompt, collectionsSearchTool } from '@/lib/grok-client';

export const runtime = 'edge';
export const maxDuration = 60;

export async function POST(req: Request) {
  console.log('=== Chat API called ===');

  try {
    const { messages } = await req.json();
    console.log('Messages received:', messages.length);

    const apiKey = process.env.XAI_API_KEY;
    const collectionId = process.env.COLLECTION_ID;

    console.log('ENV check:', {
      hasApiKey: !!apiKey,
      apiKeyLength: apiKey?.length,
      hasCollectionId: !!collectionId,
    });

    if (!apiKey || !collectionId) {
      const missing = [];
      if (!apiKey) missing.push('XAI_API_KEY');
      if (!collectionId) missing.push('COLLECTION_ID');
      console.error(`Missing env vars: ${missing.join(', ')}`);
      return new Response(
        JSON.stringify({ error: `Missing: ${missing.join(', ')}` }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Создаем xAI клиент В МОМЕНТ ЗАПРОСА
    const xai = createOpenAI({
      apiKey: apiKey,
      baseURL: 'https://api.x.ai/v1',
    });

    const grokClient = createGrokClient({
      apiKey: apiKey,
      collectionId: collectionId,
    });

    console.log('Creating streamText with model: grok-4-1-fast-reasoning');

    // Streaming с AI SDK
    const result = streamText({
      model: xai('grok-4-1-fast-reasoning'),
      system: legalSystemPrompt,
      messages,
      maxSteps: 5,
      tools: {
        collections_search: {
          description: collectionsSearchTool.description,
          parameters: collectionsSearchTool.parameters,
          execute: async ({ query, top_k = 5 }: { query: string; top_k?: number }) => {
            console.log('Tool called: collections_search, query:', query);
            const results = await grokClient.search(query, { topK: top_k });
            return { results };
          },
        },
      },
    });

    console.log('Returning AI SDK stream response');
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
