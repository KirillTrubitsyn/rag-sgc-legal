import { legalSystemPrompt, poaSystemPrompt, getSystemPromptForCollection } from '@/lib/grok-client';
import {
  detectCollection,
  isListAllQuery,
  getCollectionId,
  getCollectionConfig,
  COLLECTIONS_CONFIG
} from '@/lib/collections-config';

export const runtime = 'edge';
export const maxDuration = 60;

// Результат определения запроса
interface QueryAnalysis {
  collectionKey: string;      // Ключ коллекции (poa, general, contractForms, etc.)
  isListAll: boolean;         // Запрос на полный список документов
  collectionId: string;       // ID коллекции из env
  systemPrompt: string;       // Системный промпт для коллекции
}

// Анализ запроса пользователя и определение коллекции
function analyzeQuery(messages: any[]): QueryAnalysis | null {
  // Получаем последние 3 сообщения пользователя для анализа контекста
  const userMessages = messages
    .filter((m: any) => m.role === 'user')
    .slice(-3);

  const combinedText = userMessages.map((m: any) => m.content).join(' ');

  // Определяем коллекцию по ключевым словам
  const collectionKey = detectCollection(combinedText);

  // Проверяем, запрашивает ли пользователь полный список
  const isListAll = isListAllQuery(combinedText);

  // Получаем ID коллекции из переменных окружения
  let collectionId = getCollectionId(collectionKey);

  // Если коллекция не найдена, используем general
  if (!collectionId) {
    console.log(`Collection ${collectionKey} not configured, falling back to general`);
    collectionId = getCollectionId('general');
  }

  if (!collectionId) {
    return null;
  }

  // Получаем системный промпт для коллекции
  const systemPrompt = getSystemPromptForCollection(collectionKey);

  return {
    collectionKey,
    isListAll,
    collectionId,
    systemPrompt,
  };
}

// Функция поиска по коллекции через правильный endpoint
async function searchCollection(query: string, apiKey: string, collectionId: string): Promise<string> {
  console.log('=== Collection Search ===');
  console.log('Query:', query);
  console.log('Collection ID:', collectionId);

  try {
    // Правильная структура запроса для xAI Documents Search API
    // Увеличено до 30 результатов для полноты цитат (по замечаниям тестировщиков)
    const requestBody = {
      query: query,
      source: {
        collection_ids: [collectionId]
      },
      retrieval_mode: {
        type: 'hybrid'
      },
      max_num_results: 30,
      top_k: 30
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
    console.log('Search response keys:', Object.keys(data));
    console.log('Search response preview:', JSON.stringify(data).substring(0, 1500));

    // xAI возвращает результаты в поле "matches"
    const results = data.matches || data.results || [];
    console.log('Search returned', results.length, 'results');

    if (results.length === 0) {
      console.log('No results found in search response');
      return '';
    }

    // Логируем первый результат для отладки
    if (results[0]) {
      console.log('First result keys:', Object.keys(results[0]));
      console.log('First result fields:', JSON.stringify(results[0].fields || {}).substring(0, 500));
    }

    // Форматируем результаты поиска с file_id для скачивания
    const formattedResults = results.map((r: any, i: number) => {
      // Контент в chunk_content
      const content = r.chunk_content || r.content || r.text || '';
      // Название файла в fields
      const fileName = r.fields?.file_name || r.fields?.name || r.fields?.title || r.name || 'Документ';
      const score = r.score ? r.score.toFixed(3) : '';
      // file_id для ссылки на скачивание
      const fileId = r.file_id || '';

      return `[${i + 1}] ${fileName} (релевантность: ${score}, file_id: ${fileId}):\n${content}`;
    }).join('\n\n---\n\n');

    return formattedResults;
  } catch (error) {
    console.error('Search error:', error);
    return '';
  }
}

// Функция получения ПОЛНОГО списка всех документов из коллекции
async function getAllDocuments(apiKey: string, collectionId: string): Promise<string> {
  console.log('=== Get All Documents ===');
  console.log('Collection ID:', collectionId);

  try {
    // Используем endpoint для получения списка документов в коллекции
    // API поддерживает пагинацию, поэтому делаем запросы пока есть документы
    let allDocuments: any[] = [];
    let cursor: string | null = null;
    const limit = 100; // Максимальное количество документов за один запрос

    do {
      const url = new URL(`https://api.x.ai/v1/collections/${collectionId}/documents`);
      url.searchParams.set('limit', limit.toString());
      if (cursor) {
        url.searchParams.set('starting_after', cursor);
      }

      console.log('Fetching documents:', url.toString());

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      console.log('Documents list response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Documents list failed:', response.status, errorText);
        return '';
      }

      const data = await response.json();
      console.log('Documents response keys:', Object.keys(data));

      // xAI возвращает документы в поле "data" или "documents"
      const documents = data.data || data.documents || [];
      console.log('Fetched', documents.length, 'documents in this batch');

      if (documents.length === 0) {
        break;
      }

      allDocuments = allDocuments.concat(documents);

      // Проверяем, есть ли ещё документы для загрузки
      // xAI использует has_more или проверку количества возвращённых документов
      const hasMore = data.has_more || (documents.length === limit);
      if (hasMore && documents.length > 0) {
        // Используем ID последнего документа как курсор
        cursor = documents[documents.length - 1].id || documents[documents.length - 1].file_id;
      } else {
        cursor = null;
      }

    } while (cursor);

    console.log('Total documents fetched:', allDocuments.length);

    if (allDocuments.length === 0) {
      console.log('No documents found in collection');
      return '';
    }

    // Логируем первый документ для отладки
    if (allDocuments[0]) {
      console.log('First document keys:', Object.keys(allDocuments[0]));
      console.log('First document preview:', JSON.stringify(allDocuments[0]).substring(0, 500));
    }

    // Форматируем список документов
    const formattedResults = allDocuments.map((doc: any, i: number) => {
      const fileName = doc.name || doc.file_name || doc.filename || doc.fields?.file_name || 'Документ';
      const fileId = doc.file_id || doc.id || '';
      const createdAt = doc.created_at ? new Date(doc.created_at * 1000).toLocaleDateString('ru-RU') : '';
      const size = doc.size ? `${(doc.size / 1024 / 1024).toFixed(2)} MB` : '';

      return `[${i + 1}] ${fileName} (file_id: ${fileId}${createdAt ? `, загружен: ${createdAt}` : ''}${size ? `, размер: ${size}` : ''})`;
    }).join('\n');

    // Добавляем итоговую информацию
    const summary = `\n\nВСЕГО ДОКУМЕНТОВ В БАЗЕ: ${allDocuments.length}`;

    return formattedResults + summary;
  } catch (error) {
    console.error('Get all documents error:', error);
    return '';
  }
}

// Функция формирования поискового запроса с учетом контекста диалога
function buildContextualSearchQuery(messages: any[], maxMessages: number = 3): string {
  // Получаем последние N сообщений пользователя для учета контекста
  const userMessages = messages
    .filter((m: any) => m.role === 'user')
    .slice(-maxMessages);

  if (userMessages.length === 0) {
    return '';
  }

  // Если только одно сообщение - возвращаем его
  if (userMessages.length === 1) {
    return userMessages[0].content;
  }

  // Объединяем сообщения с указанием контекста
  // Последнее сообщение имеет приоритет, предыдущие дают контекст
  const contextMessages = userMessages.slice(0, -1).map((m: any) => m.content).join(' ');
  const currentQuestion = userMessages[userMessages.length - 1].content;

  // Формируем запрос: контекст + текущий вопрос (с большим весом на текущий)
  const combinedQuery = `${currentQuestion} (контекст: ${contextMessages})`;

  console.log('Contextual search query built from', userMessages.length, 'messages');

  return combinedQuery;
}

export async function POST(req: Request) {
  console.log('=== Chat API called ===');

  try {
    const { messages } = await req.json();
    console.log('Messages received:', messages.length);

    const apiKey = process.env.XAI_API_KEY;

    if (!apiKey) {
      console.error('Missing XAI_API_KEY');
      return new Response(
        JSON.stringify({ error: 'Missing API key' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Анализируем запрос и определяем коллекцию
    const queryAnalysis = analyzeQuery(messages);

    if (!queryAnalysis) {
      console.error('No collection configured');
      return new Response(
        JSON.stringify({ error: 'No collection configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { collectionKey, isListAll, collectionId, systemPrompt } = queryAnalysis;
    const collectionConfig = getCollectionConfig(collectionKey);

    console.log('Query analysis:', {
      collectionKey,
      collectionName: collectionConfig?.displayName,
      isListAll,
      collectionId
    });

    // Получаем документы - либо полный список, либо через поиск
    let documentResults: string;
    let contextSection: string;

    if (isListAll) {
      // Для запросов о полном списке - получаем ВСЕ документы из коллекции
      console.log('Fetching ALL documents from collection...');
      documentResults = await getAllDocuments(apiKey, collectionId);
      console.log('All documents results length:', documentResults.length);

      const collectionName = collectionConfig?.displayName || 'документов';
      contextSection = documentResults
        ? `\n\nПОЛНЫЙ СПИСОК ДОКУМЕНТОВ В БАЗЕ (${collectionName}):\n${documentResults}\n\nЭто ПОЛНЫЙ список всех документов в базе данных "${collectionName}". Пользователь просит информацию обо ВСЕХ документах - используй весь список для ответа. Сформируй красивую таблицу со всеми документами.`
        : `\n\nВ базе данных "${collectionName}" нет документов.`;
    } else {
      // Для обычных запросов - используем поиск
      const searchQuery = buildContextualSearchQuery(messages, 3);
      documentResults = await searchCollection(searchQuery, apiKey, collectionId);
      console.log('Search results length:', documentResults.length);

      contextSection = documentResults
        ? `\n\nНАЙДЕННЫЕ ДОКУМЕНТЫ:\n${documentResults}\n\nИспользуйте информацию из найденных документов для ответа.`
        : '\n\nПоиск по документам не вернул результатов.';
    }

    const systemPromptWithContext = systemPrompt + contextSection;

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
