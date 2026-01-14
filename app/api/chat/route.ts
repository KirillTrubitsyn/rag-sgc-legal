import { legalSystemPrompt } from '@/lib/grok-client';

export const runtime = 'edge';
export const maxDuration = 60;

export async function POST(req: Request) {
  console.log('=== Chat API called ===');

  try {
    const { messages } = await req.json();
    console.log('Messages received:', messages.length);

    const apiKey = process.env.XAI_API_KEY;
    const collectionId = process.env.COLLECTION_ID;

    if (!apiKey || !collectionId) {
      return new Response(
        JSON.stringify({ error: 'Missing env vars' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const apiMessages = messages.map((m: any) => ({
      role: m.role,
      content: m.content,
    }));

    console.log('Calling xAI API with grok-4-1-fast-reasoning...');

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

    console.log('xAI response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('xAI API error:', errorText);
      return new Response(
        JSON.stringify({ error: 'xAI API error', details: errorText }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Трансформируем xAI SSE в формат AI SDK
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let chunkCount = 0;

    let rawSampleLogged = false;

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });

        // Логируем сырые данные чтобы понять формат
        if (!rawSampleLogged) {
          console.log('RAW DATA:', text.substring(0, 500));
          rawSampleLogged = true;
        }

        const lines = text.split('\n');

        for (const line of lines) {
          // Логируем каждую строку для отладки
          if (line.trim() && chunkCount < 2) {
            console.log('LINE:', line.substring(0, 200));
          }

          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();

            if (data === '[DONE]') {
              console.log('Stream done, total chunks:', chunkCount);
              controller.enqueue(encoder.encode('d:{"finishReason":"stop"}\n'));
              return;
            }

            try {
              const json = JSON.parse(data);

              // Обычный контент
              const content = json.choices?.[0]?.delta?.content;
              // Reasoning контент (для reasoning моделей)
              const reasoningContent = json.choices?.[0]?.delta?.reasoning_content;

              const textToSend = content || reasoningContent;

              if (textToSend) {
                chunkCount++;
                if (chunkCount <= 3) {
                  console.log('Chunk', chunkCount, ':', textToSend.substring(0, 50));
                }
                controller.enqueue(encoder.encode(`0:${JSON.stringify(textToSend)}\n`));
              }
            } catch (e) {
              // Невалидный JSON - пропускаем
            }
          }
        }
      },
      flush(controller) {
        console.log('Stream flush, sending finish');
        controller.enqueue(encoder.encode('d:{"finishReason":"stop"}\n'));
      }
    });

    return new Response(response.body?.pipeThrough(transformStream), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });

  } catch (error) {
    console.error('Chat API error:', error);
    return new Response(
      JSON.stringify({ error: 'Request failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
