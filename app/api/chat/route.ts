import { legalSystemPrompt } from '@/lib/grok-client';

export const runtime = 'edge';
export const maxDuration = 60;

// Функция поиска по коллекции через правильный endpoint
async function searchCollection(query: string, apiKey: string, collectionId: string): Promise<string> {
  console.log('=== Collection Search ===');
  console.log('Query:', query);
  console.log('Collection ID:', collectionId);

  try {
    // Правильная структура запроса для xAI Documents Search API
    const requestBody = {
      query: query,
      source: {
        collection_ids: [collectionId]
      },
      retrieval_mode: {
        type: 'hybrid'
      },
      max_num_results: 20,
      top_k: 20
    };

    console.log('Search request:', JSON.stringify(requestBody));

    const response = await fetch('https://api.x.ai/v1/documents/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    console.log('Search response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Collection search failed:', response.status, errorText);
      return '';
    }

    const data = await response.json();
    console.log('Search response:', JSON.stringify(data).substring(0, 1000));

    // Обрабатываем различные форматы ответа
    const results = data.results || data.documents || data.matches || data.chunks || data.data || [];
    console.log('Search returned', results.length, 'results');

    if (results.length === 0) {
      return '';
    }

    // Форматируем результаты поиска
    const formattedResults = results.map((r: any, i: number) => {
      // Получаем контент из разных возможных полей
      const content = r.chunk_content || r.content || r.text || '';
      // Получаем название файла из разных возможных полей
      const fileName = r.fields?.file_name || r.fields?.name || r.file_name || r.name || 'Документ';
      const score = r.score || r.relevance_score || '';

      return `[${i + 1}] ${fileName} (score: ${score}):\n${content}`;
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
      console.error('Missing env vars. apiKey:', !!apiKey, 'collectionId:', !!collectionId);
      return new Response(
        JSON.stringify({ error: 'Missing env vars' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log('Using collection ID:', collectionId);

    // Получаем последнее сообщение пользователя для поиска
    const lastUserMessage = messages.filter((m: any) => m.role === 'user').pop();
    const searchQuery = lastUserMessage?.content || '';

    // Выполняем поиск по коллекции
    const searchResults = await searchCollection(searchQuery, apiKey, collectionId);
    console.log('Search results length:', searchResults.length);

    // Формируем контекст с результатами поиска
    const contextSection = searchResults
      ? `\n\nНАЙДЕННЫЕ ДОКУМЕНТЫ:\n${searchResults}\n\nИспользуйте информацию из найденных документов для ответа.`
      : '\n\nПоиск по документам не вернул результатов.';

    const systemPromptWithContext = legalSystemPrompt + contextSection;

    const apiMessages = messages.map((m: any) => ({
      role: m.role,
      content: m.content,
    }));

    console.log('Calling xAI Chat API...');

    // Используем обычный Chat Completions API
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-3-fast',
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
    let buffer = '';

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });

        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();

          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6).trim();

            if (data === '[DONE]') {
              console.log('Stream done, total chunks:', chunkCount);
              controller.enqueue(encoder.encode('d:{"finishReason":"stop"}\n'));
              return;
            }

            try {
              const json = JSON.parse(data);
              const content = json.choices?.[0]?.delta?.content;

              if (content) {
                chunkCount++;
                controller.enqueue(encoder.encode(`0:${JSON.stringify(content)}\n`));
              }
            } catch (e) {
              // Skip invalid JSON
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
                const content = json.choices?.[0]?.delta?.content;
                if (content) {
                  controller.enqueue(encoder.encode(`0:${JSON.stringify(content)}\n`));
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
