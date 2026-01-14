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

    // Подготовка сообщений для API
    const apiMessages = messages.map((m: any) => ({
      role: m.role,
      content: m.content,
    }));

    console.log('Calling xAI API directly with grok-4-1-fast-reasoning...');

    // Прямой вызов xAI Chat API (без AI SDK)
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-4-1-fast-reasoning',
        messages: [
          { role: 'system', content: legalSystemPrompt },
          ...apiMessages,
        ],
        stream: true,
      }),
    });

    console.log('xAI API response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('xAI API error:', errorText);
      return new Response(
        JSON.stringify({ error: 'xAI API error', details: errorText }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log('Streaming response from xAI...');

    // Возвращаем stream напрямую
    return new Response(response.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

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
