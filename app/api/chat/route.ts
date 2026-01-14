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
      console.error('Missing env vars. apiKey:', !!apiKey, 'collectionId:', !!collectionId);
      return new Response(
        JSON.stringify({ error: 'Missing env vars' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log('Using collection ID:', collectionId);

    // Формируем input для Responses API
    const input = messages.map((m: any) => ({
      role: m.role,
      content: m.content,
    }));

    const requestBody = {
      model: 'grok-4-1-fast',
      system: legalSystemPrompt,
      input: input,
      tools: [
        {
          type: 'file_search',
          vector_store_ids: [collectionId],
          max_num_results: 10,
        }
      ],
      stream: true,
    };

    console.log('Request body (without input):', JSON.stringify({ ...requestBody, input: '[...]' }));
    console.log('Calling xAI Responses API...');

    const response = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
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

    // Трансформируем xAI Responses SSE в формат AI SDK
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let chunkCount = 0;
    let buffer = '';
    let rawSampleLogged = false;

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });

        if (!rawSampleLogged) {
          console.log('RAW DATA:', text.substring(0, 500));
          rawSampleLogged = true;
        }

        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();

          if (trimmedLine && chunkCount < 5) {
            console.log('LINE:', trimmedLine.substring(0, 300));
          }

          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6).trim();

            if (data === '[DONE]') {
              console.log('Stream done, total chunks:', chunkCount);
              controller.enqueue(encoder.encode('d:{"finishReason":"stop"}\n'));
              return;
            }

            try {
              const json = JSON.parse(data);

              // Responses API format - может быть разный в зависимости от типа события
              // Ищем текстовый контент в разных возможных местах
              let textContent = '';

              // Для streaming events типа response.output_text.delta
              if (json.type === 'response.output_text.delta') {
                textContent = json.delta || '';
              }
              // Для response.content.delta (OpenAI-compatible format)
              else if (json.type === 'response.content.delta') {
                textContent = json.delta?.text || json.delta?.content || '';
              }
              // Для стандартного chat completion format
              else if (json.choices?.[0]?.delta?.content) {
                textContent = json.choices[0].delta.content;
              }
              // Для output array
              else if (json.output) {
                const textOutput = json.output.find((o: any) => o.type === 'text');
                if (textOutput?.text) {
                  textContent = textOutput.text;
                }
              }

              if (textContent) {
                chunkCount++;
                if (chunkCount <= 5) {
                  console.log('Chunk', chunkCount, ':', textContent.substring(0, 100));
                }
                controller.enqueue(encoder.encode(`0:${JSON.stringify(textContent)}\n`));
              }
            } catch (e) {
              console.log('JSON parse error for line:', trimmedLine.substring(0, 100));
            }
          }
        }
      },
      flush(controller) {
        if (buffer.trim()) {
          const trimmedLine = buffer.trim();
          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6).trim();
            if (data !== '[DONE]') {
              try {
                const json = JSON.parse(data);
                let textContent = '';

                if (json.type === 'response.output_text.delta') {
                  textContent = json.delta || '';
                } else if (json.choices?.[0]?.delta?.content) {
                  textContent = json.choices[0].delta.content;
                }

                if (textContent) {
                  controller.enqueue(encoder.encode(`0:${JSON.stringify(textContent)}\n`));
                }
              } catch (e) {
                // ignore
              }
            }
          }
        }
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
