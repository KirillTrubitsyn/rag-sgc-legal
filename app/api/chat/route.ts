import { legalSystemPrompt } from '@/lib/grok-client';

export const runtime = 'edge';
export const maxDuration = 60;

// Функция поиска по коллекции
async function searchCollection(query: string, apiKey: string, collectionId: string): Promise<string> {
  console.log('Searching collection for:', query);

  try {
    const response = await fetch('https://api.x.ai/v1/collections/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        collection_ids: [collectionId],
        top_k: 10,
        retrieval_mode: 'hybrid',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Collection search failed:', response.status, errorText);
      return '';
    }

    const data = await response.json();
    console.log('Search returned', data.results?.length || 0, 'results');

    if (!data.results || data.results.length === 0) {
      return '';
    }

    // Форматируем результаты поиска
    const formattedResults = data.results.map((r: any, i: number) => {
      const source = r.metadata?.filename || 'Документ';
      const page = r.metadata?.page ? `, стр. ${r.metadata.page}` : '';
      return `[${i + 1}] ${source}${page}:\n${r.content}`;
    }).join('\n\n---\n\n');

    return formattedResults;
  } catch (error) {
    console.error('Search error:', error);
    return '';
  }
}

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

    // Получаем последнее сообщение пользователя для поиска
    const lastUserMessage = messages.filter((m: any) => m.role === 'user').pop();
    const searchQuery = lastUserMessage?.content || '';

    // Выполняем поиск по коллекции
    const searchResults = await searchCollection(searchQuery, apiKey, collectionId);
    console.log('Search results length:', searchResults.length);

    // Формируем контекст с результатами поиска
    const contextSection = searchResults
      ? `\n\nНАЙДЕННЫЕ ДОКУМЕНТЫ:\n${searchResults}\n\nИспользуйте информацию из найденных документов для ответа.`
      : '\n\nДокументы не найдены. Сообщите пользователю, что по данному запросу релевантных документов не найдено.';

    const systemPromptWithContext = legalSystemPrompt + contextSection;

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
          { role: 'system', content: systemPromptWithContext },
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
    let buffer = ''; // Буфер для неполных строк между чанками

    let rawSampleLogged = false;

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });

        // Логируем сырые данные чтобы понять формат
        if (!rawSampleLogged) {
          console.log('RAW DATA:', text.substring(0, 500));
          rawSampleLogged = true;
        }

        // Добавляем новый текст к буферу и разбиваем на строки
        buffer += text;
        const lines = buffer.split('\n');

        // Последняя строка может быть неполной - сохраняем её в буфер
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();

          // Логируем каждую строку для отладки
          if (trimmedLine && chunkCount < 2) {
            console.log('LINE:', trimmedLine.substring(0, 200));
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
              console.log('JSON parse error for line:', trimmedLine.substring(0, 100));
            }
          }
        }
      },
      flush(controller) {
        // Обрабатываем оставшиеся данные в буфере
        if (buffer.trim()) {
          const trimmedLine = buffer.trim();
          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6).trim();
            if (data !== '[DONE]') {
              try {
                const json = JSON.parse(data);
                const content = json.choices?.[0]?.delta?.content;
                const reasoningContent = json.choices?.[0]?.delta?.reasoning_content;
                const textToSend = content || reasoningContent;
                if (textToSend) {
                  controller.enqueue(encoder.encode(`0:${JSON.stringify(textToSend)}\n`));
                }
              } catch (e) {
                // Невалидный JSON в конце - пропускаем
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
