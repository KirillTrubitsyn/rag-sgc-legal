import { legalSystemPrompt, poaSystemPrompt, uploadedDocumentSystemPrompt, getSystemPromptForCollection } from '@/lib/grok-client';
import {
  detectCollection,
  isListAllQuery,
  getCollectionId,
  getCollectionConfig,
  getAvailableCollectionsList,
  COLLECTIONS_CONFIG
} from '@/lib/collections-config';
import { classifyQueryWithLLM, type ClassificationResult } from '@/lib/query-classifier';

export const runtime = 'edge';
export const maxDuration = 60;

// Результат определения запроса
interface QueryAnalysis {
  collectionKey: string | null;      // Ключ коллекции (poa, standardsAndRegulations, contractForms, etc.) или null если не определена
  isListAll: boolean;                // Запрос на полный список документов
  collectionId: string | null;       // ID коллекции из env или null
  systemPrompt: string;              // Системный промпт для коллекции
  needsClarification: boolean;       // Требуется уточнение от пользователя
  clarificationQuestion?: string;    // Уточняющий вопрос от LLM (если needsClarification=true)
  classificationReasoning?: string;  // Объяснение выбора коллекции (для отладки)
}

// Проверка, содержит ли сообщение загруженные документы
function hasUploadedDocuments(messages: any[]): boolean {
  // Проверяем ВСЮ историю сообщений на наличие загруженных документов
  // Это позволяет задавать follow-up вопросы по ранее загруженному документу
  const userMessages = messages.filter((m: any) => m.role === 'user');

  for (const message of userMessages) {
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);

    if (content.includes('[ЗАГРУЖЕННЫЕ ДОКУМЕНТЫ ДЛЯ АНАЛИЗА]')) {
      console.log('hasUploadedDocuments: found document in message history');
      return true;
    }
  }

  console.log('hasUploadedDocuments: no uploaded documents in history');
  return false;
}

// Анализ запроса пользователя и определение коллекции с помощью LLM
async function analyzeQueryWithLLM(messages: any[], apiKey: string): Promise<QueryAnalysis> {
  const userMessages = messages.filter((m: any) => m.role === 'user');
  const lastMessage = userMessages[userMessages.length - 1]?.content || '';

  // Проверяем, запрашивает ли пользователь полный список
  const isListAll = isListAllQuery(lastMessage);

  // Собираем контекст диалога (последние 2-3 сообщения для понимания темы)
  let conversationContext = '';
  if (messages.length > 1) {
    // Берём последние сообщения для контекста (но не более 3 пар user/assistant)
    const recentMessages = messages.slice(-6);
    conversationContext = recentMessages
      .filter((m: any) => m.role === 'user' || m.role === 'assistant')
      .slice(0, -1) // Исключаем последнее (текущее) сообщение
      .map((m: any) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content.substring(0, 500)}${m.content.length > 500 ? '...' : ''}`)
      .join('\n');
  }

  // Используем LLM для интеллектуальной классификации запроса
  console.log('Classifying query with LLM...', { hasContext: !!conversationContext });
  const classification = await classifyQueryWithLLM(lastMessage, apiKey, conversationContext || undefined);

  console.log('LLM Classification result:', {
    collection: classification.collectionKey,
    confidence: classification.confidence,
    reasoning: classification.reasoning,
    needsClarification: classification.needsClarification
  });

  // Если LLM не уверен или требуется уточнение
  if (classification.needsClarification || !classification.collectionKey) {
    console.log('Clarification needed based on LLM analysis');
    return {
      collectionKey: null,
      isListAll,
      collectionId: null,
      systemPrompt: '',
      needsClarification: true,
      clarificationQuestion: classification.clarificationQuestion,
      classificationReasoning: classification.reasoning,
    };
  }

  // Получаем ID коллекции из переменных окружения
  const collectionId = getCollectionId(classification.collectionKey);

  // Если коллекция найдена LLM, но не настроена в env
  if (!collectionId) {
    console.log(`Collection ${classification.collectionKey} not configured in environment`);
    return {
      collectionKey: classification.collectionKey,
      isListAll,
      collectionId: null,
      systemPrompt: '',
      needsClarification: true,
      classificationReasoning: classification.reasoning,
    };
  }

  // Получаем системный промпт для коллекции
  const systemPrompt = getSystemPromptForCollection(classification.collectionKey);

  return {
    collectionKey: classification.collectionKey,
    isListAll,
    collectionId,
    systemPrompt,
    needsClarification: false,
    classificationReasoning: classification.reasoning,
  };
}

// Быстрый анализ по ключевым словам (fallback или для простых случаев)
function analyzeQueryFast(messages: any[]): QueryAnalysis {
  const userMessages = messages.filter((m: any) => m.role === 'user');
  const lastMessage = userMessages[userMessages.length - 1]?.content || '';
  const isListAll = isListAllQuery(lastMessage);
  const collectionKey = detectCollection(lastMessage);

  if (collectionKey === null) {
    return {
      collectionKey: null,
      isListAll,
      collectionId: null,
      systemPrompt: '',
      needsClarification: true,
    };
  }

  const collectionId = getCollectionId(collectionKey);
  if (!collectionId) {
    return {
      collectionKey,
      isListAll,
      collectionId: null,
      systemPrompt: '',
      needsClarification: true,
    };
  }

  const systemPrompt = getSystemPromptForCollection(collectionKey);
  return {
    collectionKey,
    isListAll,
    collectionId,
    systemPrompt,
    needsClarification: false,
  };
}

// Лимит контекста - xAI API имеет ограничение на размер HTTP запроса
// 300K символов (~75K токенов) - безопасный лимит для API
const MAX_CONTEXT_SIZE = 300000;

// Функция для ограничения размера контекста
function truncateContextIfNeeded(context: string, maxSize: number = MAX_CONTEXT_SIZE): { text: string; wasTruncated: boolean } {
  if (context.length <= maxSize) {
    return { text: context, wasTruncated: false };
  }

  console.warn(`Context size ${context.length} exceeds limit ${maxSize}, truncating...`);

  // Находим место для обрезки - предпочитаем обрезать на границе документа
  const truncateAt = context.lastIndexOf('\n---', maxSize);

  if (truncateAt > maxSize * 0.7) {
    return {
      text: context.substring(0, truncateAt) + '\n\n[... Часть текста не показана. Задайте более конкретный вопрос. ...]',
      wasTruncated: true
    };
  } else {
    return {
      text: context.substring(0, maxSize) + '\n\n[... Текст обрезан. Задайте более конкретный вопрос. ...]',
      wasTruncated: true
    };
  }
}

// Функция получения ВСЕХ чанков документа по file_id
async function getAllChunksForDocument(
  apiKey: string,
  collectionId: string,
  fileId: string,
  fileName: string
): Promise<string[]> {
  const chunks: string[] = [];

  try {
    // Поиск всех чанков документа по имени файла
    // Используем имя файла как запрос, чтобы получить все его чанки
    const response = await fetch('https://api.x.ai/v1/documents/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: fileName, // Ищем по имени файла
        source: { collection_ids: [collectionId] },
        retrieval_mode: { type: 'keyword' }, // Keyword для точного совпадения
        max_num_results: 50,
        top_k: 50
      }),
    });

    if (!response.ok) return chunks;

    const data = await response.json();
    const results = data.matches || data.results || [];

    // Фильтруем только чанки от нужного file_id
    for (const r of results) {
      if (r.file_id === fileId) {
        const content = r.chunk_content || r.content || r.text || '';
        if (content && !chunks.includes(content)) {
          chunks.push(content);
        }
      }
    }

    console.log(`Found ${chunks.length} chunks for file ${fileId}`);
  } catch (error) {
    console.error(`Error fetching chunks for ${fileId}:`, error);
  }

  return chunks;
}

// Функция поиска по коллекции через правильный endpoint
// С загрузкой ВСЕХ чанков найденных документов для полного контекста
async function searchCollection(query: string, apiKey: string, collectionId: string, maxResults: number = 15): Promise<string> {
  console.log('=== Collection Search ===');
  console.log('Query:', query);
  console.log('Collection ID:', collectionId);
  console.log('Max results:', maxResults);

  try {
    // ШАГ 1: Первоначальный поиск по запросу
    const requestBody = {
      query: query,
      source: {
        collection_ids: [collectionId]
      },
      retrieval_mode: {
        type: 'hybrid'
      },
      max_num_results: maxResults,
      top_k: maxResults
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

    const results = data.matches || data.results || [];
    console.log('Search returned', results.length, 'results');

    if (results.length === 0) {
      console.log('No results found in search response');
      return '';
    }

    // ШАГ 2: Собираем уникальные file_id и их метаданные
    const uniqueFiles = new Map<string, { fileName: string; score: number; initialChunks: string[] }>();

    for (const r of results) {
      const fileId = r.file_id || '';
      const fileName = r.fields?.file_name || r.fields?.name || r.fields?.title || r.name || 'Документ';
      const content = r.chunk_content || r.content || r.text || '';
      const score = r.score || 0;

      if (fileId) {
        if (!uniqueFiles.has(fileId)) {
          uniqueFiles.set(fileId, { fileName, score, initialChunks: [] });
        }
        const file = uniqueFiles.get(fileId)!;
        if (content && !file.initialChunks.includes(content)) {
          file.initialChunks.push(content);
        }
      }
    }

    console.log(`Found ${uniqueFiles.size} unique documents`);

    // ШАГ 3: Используем чанки из результатов поиска (без дополнительных запросов для скорости)
    const enrichedDocuments = Array.from(uniqueFiles.entries()).map(([fileId, meta]) => {
      return {
        fileId,
        fileName: meta.fileName,
        score: meta.score,
        // Используем чанки из результатов поиска
        fullContent: meta.initialChunks.join('\n\n')
      };
    });

    // ШАГ 4: Форматируем результаты с полным контекстом документов
    // Извлекаем метаданные из текста для помощи AI
    const formattedResultsArray = await Promise.all(enrichedDocuments.map(async (doc, i) => {
      const encodedFilename = encodeURIComponent(doc.fileName);
      const downloadUrl = doc.fileId ? `/api/download?file_id=${doc.fileId}&filename=${encodedFilename}` : '';
      const markdownLink = downloadUrl ? `[Скачать](${downloadUrl})` : '';

      // Извлекаем метаданные из содержимого документа (чанки)
      let extractedMeta = extractPoaFieldsFromContent(doc.fullContent);
      // Также пробуем извлечь из имени файла
      const filenameMeta = extractPoaFieldsFromFilename(doc.fileName);

      // Объединяем метаданные (контент имеет приоритет)
      let fio = extractedMeta.fio !== 'Не указано' ? extractedMeta.fio : filenameMeta.fio;
      let poaNumber = extractedMeta.poaNumber !== 'Не указано' ? extractedMeta.poaNumber : filenameMeta.poaNumber;
      let issueDate = extractedMeta.issueDate !== 'Не указано' ? extractedMeta.issueDate : filenameMeta.issueDate;
      let validUntil = extractedMeta.validUntil !== 'Не указано' ? extractedMeta.validUntil : filenameMeta.validUntil;

      // FALLBACK: Если дата выдачи не найдена, пробуем загрузить полный текст файла через Files API
      // Это помогает, когда заголовок документа (с датой) не попал в поисковые чанки
      if (issueDate === 'Не указано' && doc.fileId) {
        console.log(`Дата не найдена в чанках для ${doc.fileName}, пробуем Files API...`);
        const fullFileContent = await getFullDocumentContent(apiKey, doc.fileId);
        if (fullFileContent && fullFileContent.length > 0) {
          const fullMeta = extractPoaFieldsFromContent(fullFileContent);
          if (fullMeta.issueDate !== 'Не указано') {
            issueDate = fullMeta.issueDate;
            console.log(`Дата найдена через Files API: ${issueDate}`);
          }
          // Также обновляем другие поля если они не были найдены
          if (fio === 'Не указано' && fullMeta.fio !== 'Не указано') fio = fullMeta.fio;
          if (poaNumber === 'Не указано' && fullMeta.poaNumber !== 'Не указано') poaNumber = fullMeta.poaNumber;
          if (validUntil === 'Не указано' && fullMeta.validUntil !== 'Не указано') validUntil = fullMeta.validUntil;
        }
      }

      // Формируем блок с извлечёнными метаданными
      const metadataBlock = `
=== ИЗВЛЕЧЁННЫЕ МЕТАДАННЫЕ ===
ФИО: ${fio}
Номер доверенности: ${poaNumber}
Дата выдачи: ${issueDate}
Срок действия до: ${validUntil}
=== КОНЕЦ МЕТАДАННЫХ ===`;

      return `[${i + 1}] ${doc.fileName} (релевантность: ${doc.score.toFixed(3)})\nСсылка на скачивание: ${markdownLink}\n${metadataBlock}\n\n=== ПОЛНЫЙ ТЕКСТ ДОКУМЕНТА ===\n${doc.fullContent}\n=== КОНЕЦ ДОКУМЕНТА ===`;
    }));
    const formattedResults = formattedResultsArray.join('\n\n---\n\n');

    console.log('Formatted results length:', formattedResults.length);
    return formattedResults;
  } catch (error) {
    console.error('Search error:', error);
    return '';
  }
}

// Функция получения полного текста документа через Files API
async function getFullDocumentContent(apiKey: string, fileId: string): Promise<string> {
  if (!fileId) {
    console.log('getFullDocumentContent: No fileId provided');
    return '';
  }

  try {
    const response = await fetch(`https://api.x.ai/v1/files/${fileId}/content`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.log(`Files content API error for ${fileId}: status=${response.status}, error=${errorText.substring(0, 200)}`);
      return '';
    }

    const content = await response.text();
    console.log(`Downloaded full content for ${fileId}: ${content.length} chars`);
    return content;
  } catch (error) {
    console.error(`Files content API exception for ${fileId}:`, error);
    return '';
  }
}

// Интерфейс для результата поиска с полным контентом
interface FullContentSearchResult {
  fileId: string;
  fileName: string;
  content: string;
  score: number;
}

// Функция поиска с получением полного текста документов
// Используется для коллекций с небольшими документами (useFullContent: true)
async function searchWithFullContent(
  query: string,
  apiKey: string,
  collectionId: string
): Promise<string> {
  console.log('=== Search With Full Content ===');
  console.log('Query:', query);
  console.log('Collection ID:', collectionId);

  try {
    // ШАГ 1: Обычный поиск для определения релевантных документов
    const requestBody = {
      query: query,
      source: {
        collection_ids: [collectionId]
      },
      retrieval_mode: {
        type: 'hybrid'
      },
      max_num_results: 10,
      top_k: 10
    };

    const response = await fetch('https://api.x.ai/v1/documents/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Search failed:', response.status, errorText);
      return '';
    }

    const data = await response.json();
    const results = data.matches || data.results || [];
    console.log('Initial search returned', results.length, 'results');

    if (results.length === 0) {
      return '';
    }

    // ШАГ 2: Получаем уникальные file_id и их метаданные
    const uniqueFiles = new Map<string, { fileName: string; score: number }>();

    for (const result of results) {
      const fileId = result.file_id || '';
      if (fileId && !uniqueFiles.has(fileId)) {
        uniqueFiles.set(fileId, {
          fileName: result.fields?.file_name || result.fields?.name || 'Документ',
          score: result.score || 0
        });
      }
    }

    console.log('Unique files to download:', uniqueFiles.size);

    // ШАГ 3: Скачиваем полный текст каждого уникального документа
    const fullContentResults: FullContentSearchResult[] = await Promise.all(
      Array.from(uniqueFiles.entries()).map(async ([fileId, meta]) => {
        const content = await getFullDocumentContent(apiKey, fileId);
        return {
          fileId,
          fileName: meta.fileName,
          content,
          score: meta.score
        };
      })
    );

    // Фильтруем документы без контента
    const validResults = fullContentResults.filter(r => r.content.length > 0);
    console.log('Documents with content:', validResults.length);

    // ШАГ 4: Форматируем результаты с полным текстом и готовой ссылкой
    const formattedResults = validResults.map((r, i) => {
      // Создаём готовую markdown-ссылку с закодированным URL
      const encodedFilename = encodeURIComponent(r.fileName);
      const downloadUrl = r.fileId ? `/api/download?file_id=${r.fileId}&filename=${encodedFilename}` : '';
      const markdownLink = downloadUrl ? `[Скачать](${downloadUrl})` : '';

      return `[${i + 1}] ${r.fileName} (релевантность: ${r.score.toFixed(3)})\nСсылка на скачивание: ${markdownLink}\n\n=== ПОЛНЫЙ ТЕКСТ ДОКУМЕНТА ===\n${r.content}\n=== КОНЕЦ ДОКУМЕНТА ===`;
    }).join('\n\n---\n\n');

    console.log('Formatted results length:', formattedResults.length);
    return formattedResults;

  } catch (error) {
    console.error('Search with full content error:', error);
    return '';
  }
}

/**
 * Функция для работы с Responses API с прикреплением файла
 * Используется для больших документов (уставы) - передаёт PDF напрямую в Grok
 * @returns объект с результатом или null если нужно использовать обычный поиск
 */
async function chatWithFileAttachment(
  query: string,
  apiKey: string,
  collectionId: string,
  systemPrompt: string,
  messages: any[]
): Promise<Response | null> {
  console.log('=== Chat With File Attachment ===');
  console.log('Query:', query);
  console.log('Collection ID:', collectionId);

  try {
    // ШАГ 1: Поиск для определения релевантного документа
    const searchResponse = await fetch('https://api.x.ai/v1/documents/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: query,
        source: { collection_ids: [collectionId] },
        retrieval_mode: { type: 'hybrid' },
        max_num_results: 5,
        top_k: 5
      }),
    });

    if (!searchResponse.ok) {
      console.error('Search failed:', searchResponse.status);
      return null;
    }

    const searchData = await searchResponse.json();
    const results = searchData.matches || searchData.results || [];

    if (results.length === 0) {
      console.log('No documents found');
      return null;
    }

    // ШАГ 2: Получаем file_id первого (наиболее релевантного) документа
    const firstResult = results[0];
    const fileId = firstResult.file_id;
    const fileName = firstResult.fields?.file_name || firstResult.fields?.name || 'Документ';

    if (!fileId) {
      console.log('No file_id in search result');
      return null;
    }

    console.log(`Found document: ${fileName} (${fileId})`);

    // Создаём ссылку на скачивание
    const encodedFilename = encodeURIComponent(fileName);
    const downloadUrl = `/api/download?file_id=${fileId}&filename=${encodedFilename}`;
    const markdownLink = `[Скачать](${downloadUrl})`;

    // ШАГ 3: Отправляем запрос в Responses API с прикреплённым файлом
    const userMessages = messages.filter((m: any) => m.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || query;

    const responsesRequestBody = {
      model: 'grok-4-1-fast',
      stream: true,
      input: [
        {
          role: 'system',
          content: systemPrompt + `\n\nДокумент для анализа: ${fileName}\nСсылка на скачивание: ${markdownLink}`
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: lastUserMessage
            },
            {
              type: 'input_file',
              file_id: fileId
            }
          ]
        }
      ]
    };

    console.log('Sending Responses API request with file attachment...');
    console.log('Request body:', JSON.stringify(responsesRequestBody, null, 2).substring(0, 1000));

    const response = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(responsesRequestBody),
    });

    console.log('Responses API response status:', response.status);
    console.log('Responses API response headers:', JSON.stringify(Object.fromEntries(response.headers.entries())));

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Responses API error:', response.status, errorText);
      // Возвращаем null чтобы использовать fallback на обычный поиск
      return null;
    }

    console.log('Responses API success, returning stream response...');
    return response;

  } catch (error) {
    console.error('Chat with file attachment error:', error);
    return null;
  }
}

// Функция определения запрошенных полей таблицы из запроса пользователя
function detectRequestedTableFields(query: string): {
  fields: string[];
  instruction: string;
} {
  const lowerQuery = query.toLowerCase();
  const allFields = ['№', 'Файл', 'ФИО', 'Номер', 'Дата выдачи', 'Действует до', 'Скачать'];
  const requestedFields: string[] = ['№']; // № всегда включаем

  // Проверяем, какие поля запрошены
  const fieldMappings: { keywords: string[]; field: string }[] = [
    { keywords: ['фио', 'фамили', 'имя', 'имен', 'сотрудник', 'кто'], field: 'ФИО' },
    { keywords: ['номер', 'номера', '№ довер'], field: 'Номер' },
    { keywords: ['дат', 'выдач', 'выдан', 'когда выдан'], field: 'Дата выдачи' },
    { keywords: ['срок', 'действ', 'до какого', 'истека', 'оконч', 'заканчива'], field: 'Действует до' },
    { keywords: ['файл', 'документ', 'название'], field: 'Файл' },
    { keywords: ['скача', 'ссылк', 'загруз', 'download'], field: 'Скачать' },
  ];

  let hasSpecificRequest = false;

  for (const mapping of fieldMappings) {
    if (mapping.keywords.some(kw => lowerQuery.includes(kw))) {
      if (!requestedFields.includes(mapping.field)) {
        requestedFields.push(mapping.field);
      }
      hasSpecificRequest = true;
    }
  }

  // Если нет конкретных запросов или запрос общий — показываем все поля
  if (!hasSpecificRequest || lowerQuery.includes('все поля') || lowerQuery.includes('полную таблицу') || lowerQuery.includes('всю информацию')) {
    return {
      fields: allFields,
      instruction: 'Покажи ВСЕ доступные поля в таблице.'
    };
  }

  // Всегда добавляем ссылку на скачивание
  if (!requestedFields.includes('Скачать')) {
    requestedFields.push('Скачать');
  }

  // Сортируем поля в правильном порядке
  const orderedFields = allFields.filter(f => requestedFields.includes(f));

  return {
    fields: orderedFields,
    instruction: `Пользователь запросил ТОЛЬКО следующие поля: ${orderedFields.join(', ')}. Покажи ТОЛЬКО эти колонки в таблице, НЕ добавляй другие.`
  };
}

// Словари для парсинга дат прописью
const RUSSIAN_NUMBERS: Record<string, number> = {
  // Единицы (1-9)
  'первое': 1, 'первого': 1, 'второе': 2, 'второго': 2, 'третье': 3, 'третьего': 3,
  'четвертое': 4, 'четвертого': 4, 'пятое': 5, 'пятого': 5, 'шестое': 6, 'шестого': 6,
  'седьмое': 7, 'седьмого': 7, 'восьмое': 8, 'восьмого': 8, 'девятое': 9, 'девятого': 9,
  // Десятки (10-19)
  'десятое': 10, 'десятого': 10, 'одиннадцатое': 11, 'одиннадцатого': 11,
  'двенадцатое': 12, 'двенадцатого': 12, 'тринадцатое': 13, 'тринадцатого': 13,
  'четырнадцатое': 14, 'четырнадцатого': 14, 'пятнадцатое': 15, 'пятнадцатого': 15,
  'шестнадцатое': 16, 'шестнадцатого': 16, 'семнадцатое': 17, 'семнадцатого': 17,
  'восемнадцатое': 18, 'восемнадцатого': 18, 'девятнадцатое': 19, 'девятнадцатого': 19,
  // Двадцать и тридцать (для составных чисел 21-31)
  'двадцатое': 20, 'двадцатого': 20, 'двадцать': 20,
  'тридцатое': 30, 'тридцатого': 30, 'тридцать': 30,
  'тридцать первое': 31, 'тридцать первого': 31,
};

const RUSSIAN_MONTHS: Record<string, string> = {
  'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
  'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
  'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
};

const RUSSIAN_YEARS: Record<string, number> = {
  'двадцать первого': 2021, 'двадцать второго': 2022, 'двадцать третьего': 2023,
  'двадцать четвертого': 2024, 'двадцать пятого': 2025, 'двадцать шестого': 2026,
  'двадцать седьмого': 2027, 'двадцать восьмого': 2028, 'двадцать девятого': 2029,
  'тридцатого': 2030, 'тридцать первого': 2031, 'тридцать второго': 2032,
  'тридцать третьего': 2033, 'тридцать четвертого': 2034, 'тридцать пятого': 2035,
};

// Дополнительные числа для года (единицы)
const RUSSIAN_YEAR_UNITS: Record<string, number> = {
  'первого': 1, 'второго': 2, 'третьего': 3, 'четвертого': 4, 'пятого': 5,
  'шестого': 6, 'седьмого': 7, 'восьмого': 8, 'девятого': 9,
};

/**
 * Парсит дату, написанную прописью на русском языке
 * Например: "двадцать четвертое июня две тысячи двадцать пятого года"
 */
function parseRussianTextDate(text: string): string | null {
  const lowerText = text.toLowerCase();

  // Ищем паттерн: [число] [месяц] две тысячи [год] года
  const datePattern = /([а-яё]+(?:\s+[а-яё]+)?)\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+две\s+тысячи\s+([а-яё]+(?:\s+[а-яё]+)?)\s+года/i;

  const match = lowerText.match(datePattern);
  if (!match) return null;

  const [, dayText, monthText, yearText] = match;

  // Парсим день
  let day = 0;
  const dayWords = dayText.trim().split(/\s+/);
  for (const word of dayWords) {
    if (RUSSIAN_NUMBERS[word]) {
      day += RUSSIAN_NUMBERS[word];
    }
  }
  if (day === 0 || day > 31) return null;

  // Парсим месяц
  const month = RUSSIAN_MONTHS[monthText.toLowerCase()];
  if (!month) return null;

  // Парсим год (две тысячи + X)
  let year = 2000;
  const yearKey = yearText.trim().toLowerCase();
  if (RUSSIAN_YEARS[yearKey]) {
    year = RUSSIAN_YEARS[yearKey];
  } else {
    // Пробуем парсить по словам: "двадцать седьмого" -> 20 + 7 = 27
    const yearWords = yearKey.split(/\s+/);
    for (const word of yearWords) {
      if (RUSSIAN_NUMBERS[word]) {
        year += RUSSIAN_NUMBERS[word];
      } else if (RUSSIAN_YEAR_UNITS[word]) {
        year += RUSSIAN_YEAR_UNITS[word];
      }
    }
  }

  if (year < 2020 || year > 2050) return null;

  return `${day.toString().padStart(2, '0')}.${month}.${year}`;
}

// Функция извлечения полей доверенности из названия файла
// Ожидаемые форматы: "КГ-24-127 (Мажирин О.Е.) от 01.01.2024 до 31.12.2024.pdf"
function extractPoaFieldsFromFilename(filename: string): {
  fio: string;
  poaNumber: string;
  issueDate: string;
  validUntil: string;
} {
  const result = {
    fio: 'Не указано',
    poaNumber: 'Не указано',
    issueDate: 'Не указано',
    validUntil: 'Не указано'
  };

  if (!filename || filename === 'Документ') {
    return result;
  }

  // Извлекаем ФИО из скобок: (Мажирин О.Е.) или (Иванов Иван Иванович)
  const fioInBrackets = filename.match(/\(([А-ЯЁа-яё][А-ЯЁа-яё\s.]+)\)/);
  if (fioInBrackets && fioInBrackets[1]) {
    result.fio = fioInBrackets[1].trim();
  } else {
    // Пробуем найти ФИО без скобок после номера: "КГ-24-127 Мажирин О.Е..pdf"
    const fioAfterNumber = filename.match(/[А-ЯЁ]{2,}-\d{2,}-\d+\s+([А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.[А-ЯЁ]\.?)/);
    if (fioAfterNumber && fioAfterNumber[1]) {
      result.fio = fioAfterNumber[1].trim();
    }
  }

  // Извлекаем номер доверенности
  // Формат: КГ-24-127, ТГК-13-2024-001, СГК-24/123 и т.п.
  const poaNumberMatch = filename.match(/([А-ЯЁ]{2,}-\d{2,}-\d+(?:[-\/]\d+)?)/i);
  if (poaNumberMatch && poaNumberMatch[1]) {
    result.poaNumber = poaNumberMatch[1].toUpperCase();
  } else {
    // Пробуем найти простой номер: "№123" или "123-2024"
    const simpleNumber = filename.match(/№?\s*(\d+[-\/]?\d*)/);
    if (simpleNumber && simpleNumber[1]) {
      result.poaNumber = simpleNumber[1];
    }
  }

  // Извлекаем дату выдачи: "от 01.01.2024", "от 01-01-2024", "выдана 01.01.2024"
  const issueDateMatch = filename.match(/(?:от|выдан[аы]?)\s*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i);
  if (issueDateMatch && issueDateMatch[1]) {
    result.issueDate = issueDateMatch[1].replace(/[-\/]/g, '.');
  }

  // Извлекаем срок действия: "до 31.12.2024", "по 31.12.2024", "действует до 31.12.2024"
  const validUntilMatch = filename.match(/(?:до|по|действ[а-я]*\s*до)\s*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i);
  if (validUntilMatch && validUntilMatch[1]) {
    result.validUntil = validUntilMatch[1].replace(/[-\/]/g, '.');
  }

  // Если нет явных дат, пробуем найти диапазон дат: "01.01.2024-31.12.2024"
  if (result.issueDate === 'Не указано' && result.validUntil === 'Не указано') {
    const dateRangeMatch = filename.match(/(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})\s*[-–—]\s*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/);
    if (dateRangeMatch) {
      result.issueDate = dateRangeMatch[1].replace(/[-\/]/g, '.');
      result.validUntil = dateRangeMatch[2].replace(/[-\/]/g, '.');
    }
  }

  return result;
}

// Функция получения информации о файле через Files API
async function getFileInfo(apiKey: string, fileId: string): Promise<{ filename: string; createdAt: string; allFields: any } | null> {
  if (!fileId) {
    console.log('getFileInfo: No fileId provided');
    return null;
  }

  try {
    const response = await fetch(`https://api.x.ai/v1/files/${fileId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.log(`Files API error for ${fileId}: status=${response.status}, error=${errorText.substring(0, 200)}`);
      return null;
    }

    const data = await response.json();

    // Логируем первые несколько ответов для диагностики
    console.log(`Files API response for ${fileId}:`, JSON.stringify(data, null, 2).substring(0, 500));

    // Пробуем все возможные поля с названием файла
    // Проверяем как прямые поля, так и вложенные в metadata/fields
    const filename = data.filename || data.name || data.original_filename ||
                     data.file_name || data.title ||
                     data.metadata?.filename || data.metadata?.name || data.metadata?.file_name ||
                     data.fields?.filename || data.fields?.name || data.fields?.file_name ||
                     null;

    // Обрабатываем дату создания - может быть в разных форматах
    let createdAt = '';
    if (data.created_at) {
      // Проверяем, это timestamp в секундах или миллисекундах
      const timestamp = data.created_at > 1e12 ? data.created_at : data.created_at * 1000;
      createdAt = new Date(timestamp).toLocaleDateString('ru-RU');
    } else if (data.metadata?.created_at) {
      const timestamp = data.metadata.created_at > 1e12 ? data.metadata.created_at : data.metadata.created_at * 1000;
      createdAt = new Date(timestamp).toLocaleDateString('ru-RU');
    }

    return { filename, createdAt, allFields: data };
  } catch (error) {
    console.error(`Files API exception for ${fileId}:`, error);
    return null;
  }
}

// Функция извлечения метаданных доверенности из текста
function extractPoaFieldsFromContent(content: string): {
  fio: string;
  poaNumber: string;
  issueDate: string;
  validUntil: string;
} {
  const result = {
    fio: 'Не указано',
    poaNumber: 'Не указано',
    issueDate: 'Не указано',
    validUntil: 'Не указано'
  };

  if (!content) return result;

  // Нормализуем текст для лучшего поиска
  const normalizedContent = content.replace(/\s+/g, ' ');

  // Извлекаем ФИО - ищем паттерны типа "Иванов Иван Иванович", "Иванов И.И."
  // Слова, которые НЕ могут быть частью ФИО (организации, должности, юридические термины)
  const nonNameWords = /федеральн|государствен|предприяти|учреждени|организаци|компани|общество|ассоциаци|министерств|управлени|департамент|комитет|агентств|служб[аы]|ООО|ОАО|ЗАО|ПАО|генеральн|директор|президент|председател|акционерн|муниципальн|унитарн|бюджетн|казённ|автономн/i;

  const fioPatterns = [
    // Самый точный паттерн: ФИО в родительном падеже после "уполномочивает:" с паспортом
    /уполномочива(?:ет|ю)[:\s]*\n?\s*([А-ЯЁ][а-яё]+а?\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:ича|овича|евича|овну|евну|ича))\s*,?\s*паспорт/i,
    // ФИО в родительном падеже после "уполномочивает" (Рябцева Сергея Владимировича)
    /уполномочива(?:ет|ю)[:\s]*\n?\s*([А-ЯЁ][а-яё]+а\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:ича|овича|евича|овну|евну))/i,
    // Полное ФИО после "уполномочивает" (более широкий захват)
    /(?:уполномочива(?:ет|ю)|доверя(?:ет|ю))[:\s]*\n?\s*([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+)/i,
    // ФИО с паспортом (надёжный признак человека)
    /([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+)\s*,?\s*паспорт/i,
    /(?:представител[а-яё]*|гражданин[а-яё]*)[:\s]+([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+)/i,
    // Сокращённое ФИО: Иванов И.И. или Иванов И. И.
    /(?:на\s+имя|выдана|представител[а-яё]*)[:\s]*([А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.)/i,
    /(?:уполномочива|доверя)[^\n]{0,30}?([А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.)/i,
  ];
  for (const pattern of fioPatterns) {
    const match = normalizedContent.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].trim();
      // Проверяем, что это не название организации или должность
      if (!nonNameWords.test(candidate)) {
        result.fio = candidate;
        break;
      }
    }
  }

  // Извлекаем номер доверенности - более строгие паттерны
  const numberPatterns = [
    // Самый точный: ДОВЕРЕННОСТЬ № КГ-24/103 или ДОВЕРЕННОСТЬ №КГ-24-103
    /ДОВЕРЕННОСТЬ\s*№\s*([А-ЯЁA-Z]{2,5}[-\s]?\d{2}[-\/]\d+)/i,
    // Доверенность № с буквенно-цифровым номером
    /доверенност[ьи]?\s*№\s*([А-ЯЁA-Z]{2,5}[-\/]?\d{2,4}[-\/]\d+)/i,
    // Номер в формате КГ-24/103, КГ-24-127
    /№\s*([А-ЯЁA-Z]{2,5}[-\/]\d{2,4}[-\/]\d+)/i,
    // Стандартные форматы без слеша: КГ-24-127, ТГК-13-2024-001
    /доверенност[ьи]?\s*№?\s*([А-ЯЁA-Z]{2,5}-\d{2,4}-\d+)/i,
    /№\s*([А-ЯЁA-Z]{2,5}-\d{2,4}-\d+)/i,
  ];
  for (const pattern of numberPatterns) {
    const match = normalizedContent.match(pattern);
    if (match && match[1]) {
      const num = match[1].trim().toUpperCase().replace(/\s+/g, '-');
      // Проверяем, что номер содержит буквы И цифры (исключает чисто числовые пункты типа "147-")
      if (/[А-ЯЁA-Z]/.test(num) && /\d/.test(num) && num.length >= 5) {
        result.poaNumber = num;
        break;
      }
    }
  }

  // Извлекаем даты - СНАЧАЛА ищем срок действия с контекстом "сроком до/по"
  // Это более специфичный паттерн, который точно указывает на срок действия

  // Паттерн 1: Полностью прописью (двадцать восьмое февраля две тысячи двадцать седьмого года)
  const validUntilTextPattern = /(?:сроком?\s+|действ[а-яё]*\s+|выдан[аы]?\s+)?(?:до|по)\s+([а-яё]+(?:\s+[а-яё]+)?(?:\s+[а-яё]+)?)\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+две\s+тысячи\s+([а-яё]+(?:\s+[а-яё]+)?)\s+года/gi;
  let validUntilMatch;
  let foundValidUntil: string | null = null;
  while ((validUntilMatch = validUntilTextPattern.exec(normalizedContent)) !== null) {
    const fullDateText = `${validUntilMatch[1]} ${validUntilMatch[2]} две тысячи ${validUntilMatch[3]} года`;
    const parsed = parseRussianTextDate(fullDateText);
    if (parsed) {
      foundValidUntil = parsed;
      result.validUntil = parsed;
      break;
    }
  }

  // Паттерн 2: Смешанный формат - число цифрами (до 28 февраля 2027 года)
  if (!foundValidUntil) {
    const validUntilMixedPattern = /(?:сроком?\s+|действ[а-яё]*\s+)?(?:до|по)\s+(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})\s*(?:года?|г\.?)?/gi;
    let mixedMatch;
    while ((mixedMatch = validUntilMixedPattern.exec(normalizedContent)) !== null) {
      const day = mixedMatch[1].padStart(2, '0');
      const monthMap: Record<string, string> = {
        'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
        'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
        'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
      };
      const month = monthMap[mixedMatch[2].toLowerCase()];
      const year = mixedMatch[3];
      if (month) {
        foundValidUntil = `${day}.${month}.${year}`;
        result.validUntil = foundValidUntil;
        break;
      }
    }
  }

  // Теперь ищем ВСЕ даты прописью для определения даты выдачи
  const textDatePattern = /([а-яё]+(?:\s+[а-яё]+)?)\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+две\s+тысячи\s+([а-яё]+(?:\s+[а-яё]+)?)\s+года/gi;
  const textDates: string[] = [];
  let textDateMatch;
  while ((textDateMatch = textDatePattern.exec(normalizedContent)) !== null) {
    const parsed = parseRussianTextDate(textDateMatch[0]);
    if (parsed && !textDates.includes(parsed)) {
      textDates.push(parsed);
    }
  }

  // Дополнительно ищем даты в смешанном формате (14 марта 2024 года)
  const mixedDatePattern = /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})\s*(?:года?|г\.?)?/gi;
  let mixedDateMatch;
  const monthMap: Record<string, string> = {
    'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
    'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
    'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
  };
  while ((mixedDateMatch = mixedDatePattern.exec(normalizedContent)) !== null) {
    const day = mixedDateMatch[1].padStart(2, '0');
    const month = monthMap[mixedDateMatch[2].toLowerCase()];
    const year = mixedDateMatch[3];
    const yearNum = parseInt(year, 10);
    // Пропускаем даты вне диапазона 2020-2050 (скорее всего паспортные данные или даты рождения)
    if (yearNum < 2020 || yearNum > 2050) continue;
    if (month) {
      const dateStr = `${day}.${month}.${year}`;
      if (!textDates.includes(dateStr)) {
        textDates.push(dateStr);
      }
    }
  }

  // Ищем даты в формате с кавычками: «28» февраля 2024 г.
  const quotedDatePattern = /[«"„](\d{1,2})[»""]\s*(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})\s*(?:года?|г\.?)?/gi;
  let quotedDateMatch;
  while ((quotedDateMatch = quotedDatePattern.exec(normalizedContent)) !== null) {
    const day = quotedDateMatch[1].padStart(2, '0');
    const month = monthMap[quotedDateMatch[2].toLowerCase()];
    const year = quotedDateMatch[3];
    const yearNum = parseInt(year, 10);
    // Пропускаем даты вне диапазона 2020-2050
    if (yearNum < 2020 || yearNum > 2050) continue;
    if (month) {
      const dateStr = `${day}.${month}.${year}`;
      if (!textDates.includes(dateStr)) {
        textDates.push(dateStr);
      }
    }
  }

  // Ищем даты после названия города: г. Кемерово, 28 февраля 2024 г.
  const cityDatePattern = /(?:г\.|город)\s*[А-ЯЁа-яё]+[,\s]+(\d{1,2})\s*(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})\s*(?:года?|г\.?)?/gi;
  let cityDateMatch;
  while ((cityDateMatch = cityDatePattern.exec(normalizedContent)) !== null) {
    const day = cityDateMatch[1].padStart(2, '0');
    const month = monthMap[cityDateMatch[2].toLowerCase()];
    const year = cityDateMatch[3];
    const yearNum = parseInt(year, 10);
    // Пропускаем даты вне диапазона 2020-2050
    if (yearNum < 2020 || yearNum > 2050) continue;
    if (month) {
      const dateStr = `${day}.${month}.${year}`;
      if (!textDates.includes(dateStr)) {
        // Дата после города — скорее всего дата выдачи, добавляем в начало списка
        textDates.unshift(dateStr);
      }
    }
  }

  // Ищем даты прописью после названия города: "город Кемерово Кемеровская область – Кузбасс, первое марта две тысячи двадцать четвертого года"
  // Используем более гибкий паттерн, который допускает любой текст между городом и датой
  const cityTextDatePattern = /(?:г\.|город)\s+[А-ЯЁ][а-яё]+(?:[^а-яё\d]+[А-ЯЁа-яё]+)*[,\s]+([а-яё]+(?:\s+[а-яё]+)?)\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+две\s+тысячи\s+([а-яё]+(?:\s+[а-яё]+)?)\s+года/gi;
  let cityTextDateMatch;
  while ((cityTextDateMatch = cityTextDatePattern.exec(normalizedContent)) !== null) {
    // Парсим полную дату из матча
    const fullDateText = `${cityTextDateMatch[1]} ${cityTextDateMatch[2]} две тысячи ${cityTextDateMatch[3]} года`;
    const parsedDate = parseRussianTextDate(fullDateText);
    if (parsedDate && !textDates.includes(parsedDate)) {
      // Дата после города — скорее всего дата выдачи, добавляем в начало списка
      textDates.unshift(parsedDate);
    }
  }

  // Дата выдачи - это обычно первая дата в документе, которая НЕ является сроком действия
  // И должна быть РАНЬШЕ срока действия
  if (textDates.length > 0) {
    // Функция для сравнения дат в формате DD.MM.YYYY
    const parseDate = (dateStr: string): Date | null => {
      const parts = dateStr.split('.');
      if (parts.length !== 3) return null;
      return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
    };

    // Ищем дату выдачи среди найденных дат
    for (const date of textDates) {
      // Пропускаем дату, которую уже определили как срок действия
      if (date === foundValidUntil) continue;

      // Если срок действия найден, проверяем что дата выдачи раньше
      if (foundValidUntil) {
        const issueD = parseDate(date);
        const validD = parseDate(foundValidUntil);
        if (issueD && validD && issueD < validD) {
          result.issueDate = date;
          break;
        }
      } else {
        // Если срок действия не найден, берем первую дату как дату выдачи
        result.issueDate = date;
        break;
      }
    }

    // Если дата выдачи всё ещё не найдена, но есть даты - пробуем взять самую раннюю
    if (result.issueDate === 'Не указано' && textDates.length > 0) {
      const sortedDates = [...textDates].sort((a, b) => {
        const dateA = parseDate(a);
        const dateB = parseDate(b);
        if (!dateA || !dateB) return 0;
        return dateA.getTime() - dateB.getTime();
      });
      // Самая ранняя дата - дата выдачи (если она не совпадает со сроком действия)
      if (sortedDates[0] !== foundValidUntil) {
        result.issueDate = sortedDates[0];
      } else if (sortedDates.length > 1) {
        result.issueDate = sortedDates[1];
      }
    }

    // Если срок действия не был найден контекстным поиском,
    // пробуем взять последнюю (самую позднюю) дату
    if (result.validUntil === 'Не указано' && textDates.length > 1) {
      const sortedDates = [...textDates].sort((a, b) => {
        const dateA = parseDate(a);
        const dateB = parseDate(b);
        if (!dateA || !dateB) return 0;
        return dateA.getTime() - dateB.getTime();
      });
      const lastDate = sortedDates[sortedDates.length - 1];
      if (lastDate !== result.issueDate) {
        result.validUntil = lastDate;
      }
    }
  }

  // Если даты прописью не найдены, пробуем цифровые форматы
  if (result.issueDate === 'Не указано') {
    const issueDatePatterns = [
      // "от 01.01.2024", "от «01» января 2024"
      /(?:от|выдан[аы]?)\s*[«"„]?(\d{1,2})[.\-\/\s»"]+(\d{1,2}|\w+)[.\-\/\s]+(\d{2,4})/i,
      // Дата после города: "г. Кемерово 28.02.2024", "город Москва, 01.01.2024"
      /(?:г\.|город)\s*[А-ЯЁа-яё]+[,\s]+(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/i,
      // Дата с кавычками: «28».02.2024 или «28» 02 2024
      /[«"„](\d{1,2})[»""][.\-\/\s]*(\d{1,2})[.\-\/\s]*(\d{4})/i,
      // Прямой формат даты в начале
      /^[«"„]?(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/m,
      // "дата выдачи: 01.01.2024"
      /(?:дата\s*(?:выдачи|составления|оформления))[:\s]*(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/i,
      // Простой формат даты dd.mm.yyyy
      /(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})\s*(?:года?|г\.?)?/,
    ];
    for (const pattern of issueDatePatterns) {
      const match = normalizedContent.match(pattern);
      if (match) {
        const day = match[1].padStart(2, '0');
        let month = match[2];
        const yearStr = match[3].length === 2 ? '20' + match[3] : match[3];
        const yearNum = parseInt(yearStr, 10);

        // Пропускаем даты вне диапазона 2020-2050 (скорее всего паспортные данные или даты рождения)
        if (yearNum < 2020 || yearNum > 2050) continue;

        const monthMap: Record<string, string> = {
          'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
          'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
          'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
        };
        if (monthMap[month.toLowerCase()]) {
          month = monthMap[month.toLowerCase()];
        } else {
          month = month.padStart(2, '0');
        }

        result.issueDate = `${day}.${month}.${yearStr}`;
        break;
      }
    }
  }

  // Если срок действия всё ещё не найден, пробуем цифровые форматы
  if (result.validUntil === 'Не указано') {
    const validUntilPatterns = [
      // "сроком по [дата прописью]" - специальный паттерн
      /сроком?\s+по\s+([а-яё\s]+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)[а-яё\s]+года)/i,
      // "действует до 31.12.2024", "срок действия до 31.12.2024"
      /(?:действ[а-яё]*|срок[а-яё]*\s*действ[а-яё]*)[:\s]*(?:до|по)\s*[«"„]?(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/i,
      // "по 31.12.2024", "до 31.12.2024"
      /(?:по|до)\s*[«"„]?(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})[»""']?\s*(?:года?|г\.?)?/i,
    ];

    for (const pattern of validUntilPatterns) {
      const match = normalizedContent.match(pattern);
      if (match) {
        // Проверяем, это дата прописью или цифрами
        if (match[1] && !match[2]) {
          // Дата прописью в группе 1
          const parsed = parseRussianTextDate(match[1]);
          if (parsed && parsed !== result.issueDate) {
            result.validUntil = parsed;
            break;
          }
        } else if (match[1] && match[2] && match[3]) {
          // Цифровая дата
          const day = match[1].padStart(2, '0');
          let month = match[2];
          const year = match[3].length === 2 ? '20' + match[3] : match[3];

          const monthMap: Record<string, string> = {
            'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
            'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
            'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
          };
          if (monthMap[month.toLowerCase()]) {
            month = monthMap[month.toLowerCase()];
          } else if (/^\d+$/.test(month)) {
            month = month.padStart(2, '0');
          } else {
            continue;
          }

          const candidateDate = `${day}.${month}.${year}`;
          if (candidateDate !== result.issueDate) {
            result.validUntil = candidateDate;
            break;
          }
        }
      }
    }
  }

  return result;
}

// Функция поиска и извлечения данных из всех документов коллекции
async function searchAllDocumentsContent(apiKey: string, collectionId: string): Promise<Map<string, {
  fio: string;
  poaNumber: string;
  issueDate: string;
  validUntil: string;
}>> {
  const resultsMap = new Map();

  try {
    // Используем правильный endpoint /v1/documents/search с правильным форматом запроса
    const response = await fetch('https://api.x.ai/v1/documents/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'доверенность уполномочивает представлять интересы подписывать',
        source: {
          collection_ids: [collectionId]
        },
        retrieval_mode: {
          type: 'hybrid'
        },
        max_num_results: 100,
        top_k: 100, // Получаем максимум результатов
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Search all documents failed:', response.status, errorText);
      return resultsMap;
    }

    const data = await response.json();
    // API может возвращать результаты в "matches" или "results"
    const results = data.matches || data.results || [];
    console.log(`Content search returned ${results.length} results`);

    // Логируем первый результат для отладки
    if (results[0]) {
      console.log('=== CONTENT SEARCH RESULT DEBUG ===');
      console.log('First search result keys:', Object.keys(results[0]));
      console.log('First search result:', JSON.stringify(results[0], null, 2).substring(0, 1000));
      console.log('=== END CONTENT SEARCH DEBUG ===');
    }

    // Обрабатываем каждый результат
    for (const result of results) {
      // Пробуем разные варианты получения file_id
      // API может возвращать file_id в разных полях
      const fileId = result.file_id || result.metadata?.file_id || result.document_id || result.id || '';
      const content = result.chunk_content || result.content || result.text || '';

      if (fileId && content) {
        const extracted = extractPoaFieldsFromContent(content);

        // Сохраняем только если есть хотя бы одно полезное поле
        if (extracted.fio !== 'Не указано' || extracted.poaNumber !== 'Не указано') {
          // Если уже есть данные для этого файла, объединяем
          const existing = resultsMap.get(fileId);
          if (existing) {
            if (existing.fio === 'Не указано' && extracted.fio !== 'Не указано') {
              existing.fio = extracted.fio;
            }
            if (existing.poaNumber === 'Не указано' && extracted.poaNumber !== 'Не указано') {
              existing.poaNumber = extracted.poaNumber;
            }
            if (existing.issueDate === 'Не указано' && extracted.issueDate !== 'Не указано') {
              existing.issueDate = extracted.issueDate;
            }
            if (existing.validUntil === 'Не указано' && extracted.validUntil !== 'Не указано') {
              existing.validUntil = extracted.validUntil;
            }
          } else {
            resultsMap.set(fileId, extracted);
          }
        }
      }
    }

    console.log(`Extracted data for ${resultsMap.size} unique documents from content search`);
    return resultsMap;
  } catch (error) {
    console.error('Search all documents content error:', error);
    return resultsMap;
  }
}

// Быстрая функция получения списка документов БЕЗ загрузки контента
// Используется для больших документов (уставы) чтобы избежать таймаутов
// Поисковые запросы для разных типов коллекций
const COLLECTION_SEARCH_QUERIES: Record<string, string> = {
  articlesOfAssociation: 'устав общество положение документ организация',
  contractForms: 'договор форма шаблон образец соглашение акт',
  standardsAndRegulations: 'документ положение стандарт регламент инструкция порядок',
};

async function getDocumentsListFast(apiKey: string, collectionId: string, collectionKey?: string): Promise<string> {
  console.log('=== Get Documents List (Fast mode) ===');
  console.log('Collection ID:', collectionId, 'Collection Key:', collectionKey);

  try {
    // ШАГ 1: Получаем ВСЕ документы через list API (с пагинацией)
    let documents: any[] = [];
    let cursor: string | null = null;
    const limit = 100;

    do {
      const url = new URL(`https://api.x.ai/v1/collections/${collectionId}/documents`);
      url.searchParams.set('limit', limit.toString());
      if (cursor) {
        url.searchParams.set('starting_after', cursor);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error('Documents list failed:', response.status);
        break;
      }

      const data = await response.json();
      const batch = data.data || data.documents || [];

      if (batch.length === 0) break;

      // Логируем структуру первого документа для отладки
      if (documents.length === 0 && batch.length > 0) {
        console.log('=== LIST API FIRST DOC ===');
        console.log('Doc keys:', Object.keys(batch[0]));
        console.log('Doc sample:', JSON.stringify(batch[0], null, 2).substring(0, 1000));
        console.log('file_id:', batch[0].file_id);
        console.log('id:', batch[0].id);
        console.log('name:', batch[0].name);
        console.log('file_name:', batch[0].file_name);
        console.log('=== END LIST API ===');
      }

      documents = documents.concat(batch);

      // Продолжаем пагинацию если есть ещё документы
      const hasMore = data.has_more || (batch.length === limit);
      if (hasMore && batch.length > 0) {
        const lastDoc = batch[batch.length - 1];
        // List API возвращает file_id во вложенной структуре file_metadata
        cursor = lastDoc.file_metadata?.file_id || lastDoc.file_id || lastDoc.id;
      } else {
        cursor = null;
      }
    } while (cursor);

    if (documents.length === 0) {
      return '';
    }

    console.log(`Found ${documents.length} documents from list API (with pagination)`);

    // ШАГ 2: Получаем названия файлов через ОДИН поисковый запрос
    // Search API возвращает file_name в результатах
    const fileNamesByFileId = new Map<string, string>();

    // Выбираем подходящий поисковый запрос для коллекции
    const searchQuery = COLLECTION_SEARCH_QUERIES[collectionKey || ''] || COLLECTION_SEARCH_QUERIES.standardsAndRegulations;
    console.log('Using search query:', searchQuery);

    const searchResponse = await fetch('https://api.x.ai/v1/documents/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: searchQuery,
        source: { collection_ids: [collectionId] },
        retrieval_mode: { type: 'hybrid' },
        max_num_results: 100,
        top_k: 100,
      }),
    });

    if (searchResponse.ok) {
      const searchData = await searchResponse.json();
      const results = searchData.matches || searchData.results || [];
      console.log(`Search returned ${results.length} results`);

      // Логируем первый результат для отладки
      if (results.length > 0) {
        console.log('First search result keys:', Object.keys(results[0]));
        console.log('First result sample:', JSON.stringify(results[0], null, 2).substring(0, 500));
      }

      for (const result of results) {
        const fileId = result.file_id || '';
        const fileName = result.fields?.file_name || result.fields?.name || result.name || '';
        if (fileId && fileName && !fileNamesByFileId.has(fileId)) {
          fileNamesByFileId.set(fileId, fileName);
        }
      }
      console.log(`Found filenames for ${fileNamesByFileId.size} documents`);
    }

    // ШАГ 2.5: Для документов без имён - получаем через Files API (батчами по 5)
    const docsNeedingNames: string[] = [];
    for (const doc of documents) {
      // List API возвращает данные во вложенной структуре file_metadata
      const fileId = doc.file_metadata?.file_id || doc.file_id || doc.id || '';
      const hasNameFromList = doc.file_metadata?.name || doc.file_name || doc.name || doc.title;
      const hasNameFromSearch = fileNamesByFileId.has(fileId);
      if (fileId && !hasNameFromList && !hasNameFromSearch) {
        docsNeedingNames.push(fileId);
      }
    }

    if (docsNeedingNames.length > 0) {
      console.log(`Fetching names for ${docsNeedingNames.length} docs via Files API`);
      const BATCH_SIZE = 5;
      for (let i = 0; i < docsNeedingNames.length; i += BATCH_SIZE) {
        const batch = docsNeedingNames.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(fileId => getFileInfo(apiKey, fileId))
        );
        for (let j = 0; j < batch.length; j++) {
          const info = results[j];
          if (info?.filename) {
            fileNamesByFileId.set(batch[j], info.filename);
          }
        }
      }
      console.log(`After Files API: ${fileNamesByFileId.size} docs have names`);
    }

    // ШАГ 3: Обогащаем документы названиями
    const enrichedDocs = documents.map((doc: any, index: number) => {
      // List API возвращает данные во вложенной структуре file_metadata
      const fileId = doc.file_metadata?.file_id || doc.file_id || doc.id || '';
      // Пробуем получить имя из list API (file_metadata.name), затем из search
      let fileName = doc.file_metadata?.name || doc.file_name || doc.name || doc.title || '';
      if (!fileName && fileId) {
        fileName = fileNamesByFileId.get(fileId) || '';
      }

      // Логируем для отладки
      if (index < 3) {
        console.log(`Doc ${index}: fileId=${fileId}, fileName from list=${doc.file_metadata?.name || doc.file_name || doc.name || 'none'}, fileName from search=${fileNamesByFileId.get(fileId) || 'none'}`);
      }

      // Убираем расширение файла для красивого отображения названия
      const displayName = fileName
        ? fileName.replace(/\.(pdf|docx?|xlsx?|txt|rtf)$/i, '')
        : 'Документ';

      return { fileId, fileName: fileName || 'Документ', displayName };
    });

    // Форматируем список документов только с названиями и ссылками
    const formattedDocs = enrichedDocs.map((doc: { fileId: string; fileName: string; displayName: string }, index: number) => {
      const encodedFilename = encodeURIComponent(doc.fileName);
      const downloadUrl = doc.fileId ? `/api/download?file_id=${doc.fileId}&filename=${encodedFilename}` : '';
      const markdownLink = downloadUrl ? `[Скачать](${downloadUrl})` : '';

      return `### ${index + 1}. ${doc.displayName}

Ссылка на скачивание: ${markdownLink}

---`;
    });

    return formattedDocs.join('\n\n');
  } catch (error) {
    console.error('Error in getDocumentsListFast:', error);
    return '';
  }
}

// Быстрая версия для доверенностей - извлекает метаданные только из названий файлов
// без выполнения множества поисковых запросов (которые вызывают timeout)
async function getDocumentsListFastPOA(apiKey: string, collectionId: string): Promise<string> {
  console.log('=== Get Documents List Fast (POA mode) ===');
  console.log('Collection ID:', collectionId);

  try {
    // Получаем список документов (с пагинацией)
    let allDocuments: any[] = [];
    let cursor: string | null = null;
    const limit = 100;

    do {
      const url = new URL(`https://api.x.ai/v1/collections/${collectionId}/documents`);
      url.searchParams.set('limit', limit.toString());
      if (cursor) {
        url.searchParams.set('starting_after', cursor);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error('Documents list failed:', response.status);
        break;
      }

      const data = await response.json();
      const documents = data.data || data.documents || [];

      if (documents.length === 0) break;

      allDocuments = allDocuments.concat(documents);

      const hasMore = data.has_more || (documents.length === limit);
      if (hasMore && documents.length > 0) {
        const lastDoc = documents[documents.length - 1];
        // List API возвращает file_id во вложенной структуре file_metadata
        cursor = lastDoc.file_metadata?.file_id || lastDoc.file_id || lastDoc.id;
      } else {
        cursor = null;
      }
    } while (cursor);

    if (allDocuments.length === 0) {
      return '';
    }

    console.log(`Found ${allDocuments.length} documents from list API`);

    // ШАГ 2: Получаем названия файлов И чанки через НЕСКОЛЬКО поисковых запросов
    // для обеспечения максимального покрытия всех документов
    const fileNamesByFileId = new Map<string, string>();
    const contentChunksByFileId = new Map<string, string[]>();

    // Используем несколько разных запросов для лучшего покрытия
    const searchQueries = [
      'доверенность уполномочивает представлять интересы',
      'настоящей доверенностью уполномочиваю',
      'срок действия доверенности',
      'подпись доверенность полномочия',
    ];

    for (const query of searchQueries) {
      try {
        const searchResponse = await fetch('https://api.x.ai/v1/documents/search', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query,
            source: { collection_ids: [collectionId] },
            retrieval_mode: { type: 'hybrid' },
            max_num_results: 100,
            top_k: 100,
          }),
        });

        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          const results = searchData.matches || searchData.results || [];
          console.log(`Search query "${query.substring(0, 30)}..." returned ${results.length} results`);

          for (const result of results) {
            const fileId = result.file_id || '';
            const fileName = result.fields?.file_name || result.fields?.name || result.name || '';
            const chunkContent = result.chunk_content || result.content || result.text || '';

            if (fileId) {
              if (fileName && !fileNamesByFileId.has(fileId)) {
                fileNamesByFileId.set(fileId, fileName);
              }
              // Сохраняем чанки для извлечения дат
              if (chunkContent) {
                if (!contentChunksByFileId.has(fileId)) {
                  contentChunksByFileId.set(fileId, []);
                }
                // Добавляем чанк только если его еще нет (избегаем дубликатов)
                const existingChunks = contentChunksByFileId.get(fileId)!;
                if (!existingChunks.includes(chunkContent)) {
                  existingChunks.push(chunkContent);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error(`Search query "${query}" failed:`, err);
      }
    }

    console.log(`After multiple searches: Found filenames for ${fileNamesByFileId.size} POA documents`);
    console.log(`After multiple searches: Found content chunks for ${contentChunksByFileId.size} POA documents`);

    // ШАГ 2.3: Для документов без контента - делаем индивидуальный поиск по file_id
    const allFileIds = new Set(allDocuments.map((doc: any) =>
      doc.file_metadata?.file_id || doc.file_id || doc.id || ''
    ).filter(Boolean));

    const docsWithoutContent = [...allFileIds].filter(id => !contentChunksByFileId.has(id));
    console.log(`Documents without content: ${docsWithoutContent.length} of ${allFileIds.size}`);

    if (docsWithoutContent.length > 0 && docsWithoutContent.length <= 20) {
      // Для небольшого количества документов без контента - делаем индивидуальные запросы
      console.log(`Fetching content for ${docsWithoutContent.length} documents individually...`);
      const BATCH_SIZE = 5;
      for (let i = 0; i < docsWithoutContent.length; i += BATCH_SIZE) {
        const batch = docsWithoutContent.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (fileId) => {
          try {
            // Пробуем найти любой контент для этого файла
            const searchResponse = await fetch('https://api.x.ai/v1/documents/search', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                query: 'доверенность',
                source: { collection_ids: [collectionId], file_ids: [fileId] },
                retrieval_mode: { type: 'hybrid' },
                max_num_results: 5,
                top_k: 5,
              }),
            });

            if (searchResponse.ok) {
              const searchData = await searchResponse.json();
              const results = searchData.matches || searchData.results || [];
              if (results.length > 0) {
                for (const result of results) {
                  const chunkContent = result.chunk_content || result.content || result.text || '';
                  const fileName = result.fields?.file_name || result.fields?.name || result.name || '';

                  if (fileName && !fileNamesByFileId.has(fileId)) {
                    fileNamesByFileId.set(fileId, fileName);
                  }
                  if (chunkContent) {
                    if (!contentChunksByFileId.has(fileId)) {
                      contentChunksByFileId.set(fileId, []);
                    }
                    contentChunksByFileId.get(fileId)!.push(chunkContent);
                  }
                }
              }
            }
          } catch (err) {
            console.error(`Individual search for file ${fileId} failed:`, err);
          }
        }));
      }
      console.log(`After individual searches: ${contentChunksByFileId.size} documents have content`);
    }

    // ШАГ 2.5: Для документов без имён - получаем через Files API (батчами по 5)
    // Собираем file_id документов, для которых нет имён
    const docsNeedingNames: string[] = [];
    for (const doc of allDocuments) {
      // List API возвращает данные во вложенной структуре file_metadata
      const fileId = doc.file_metadata?.file_id || doc.file_id || doc.id || '';
      const hasNameFromList = doc.file_metadata?.name || doc.file_name || doc.name || doc.title;
      const hasNameFromSearch = fileNamesByFileId.has(fileId);
      if (fileId && !hasNameFromList && !hasNameFromSearch) {
        docsNeedingNames.push(fileId);
      }
    }

    if (docsNeedingNames.length > 0) {
      console.log(`Fetching names for ${docsNeedingNames.length} POA docs via Files API`);
      const BATCH_SIZE = 5;
      for (let i = 0; i < docsNeedingNames.length; i += BATCH_SIZE) {
        const batch = docsNeedingNames.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(fileId => getFileInfo(apiKey, fileId))
        );
        for (let j = 0; j < batch.length; j++) {
          const info = results[j];
          if (info?.filename) {
            fileNamesByFileId.set(batch[j], info.filename);
          }
        }
      }
      console.log(`After Files API: ${fileNamesByFileId.size} POA docs have names`);
    }

    // ШАГ 3: Обогащаем документы названиями и метаданными из содержимого
    const enrichedDocs = allDocuments.map((doc: any, index: number) => {
      // List API возвращает данные во вложенной структуре file_metadata
      const fileId = doc.file_metadata?.file_id || doc.file_id || doc.id || '';
      let fileName = doc.file_metadata?.name || doc.file_name || doc.name || doc.title || '';
      if (!fileName && fileId) {
        fileName = fileNamesByFileId.get(fileId) || '';
      }

      if (index < 3) {
        console.log(`POA Doc ${index}: fileId=${fileId}, fileName=${fileName || 'none'}`);
      }

      // Извлекаем метаданные из названия файла
      const filenameMeta = extractPoaFieldsFromFilename(fileName);

      // Извлекаем метаданные из содержимого документа (чанков)
      const chunks = contentChunksByFileId.get(fileId);
      let contentMeta = { fio: 'Не указано', poaNumber: 'Не указано', issueDate: 'Не указано', validUntil: 'Не указано' };
      if (chunks && chunks.length > 0) {
        const combinedContent = chunks.join('\n\n');
        contentMeta = extractPoaFieldsFromContent(combinedContent);
      }

      // Объединяем метаданные: контент имеет приоритет над названием файла
      const fio = contentMeta.fio !== 'Не указано' ? contentMeta.fio : filenameMeta.fio;
      const poaNumber = contentMeta.poaNumber !== 'Не указано' ? contentMeta.poaNumber : filenameMeta.poaNumber;
      const issueDate = contentMeta.issueDate !== 'Не указано' ? contentMeta.issueDate : filenameMeta.issueDate;
      const validUntil = contentMeta.validUntil !== 'Не указано' ? contentMeta.validUntil : filenameMeta.validUntil;

      return { fileId, fileName: fileName || 'Документ', fio, poaNumber, issueDate, validUntil };
    });

    // ШАГ 3.5: Для документов с неполными метаданными - делаем целевые поиски
    // Это особенно важно для больших документов (20+ страниц)
    const docsNeedingMoreData = enrichedDocs.filter(doc =>
      doc.fio === 'Не указано' || doc.poaNumber === 'Не указано' ||
      doc.issueDate === 'Не указано' || doc.validUntil === 'Не указано'
    );

    if (docsNeedingMoreData.length > 0) {
      console.log(`Found ${docsNeedingMoreData.length} docs with incomplete metadata, fetching targeted chunks...`);

      const BATCH_SIZE = 3;
      for (let i = 0; i < docsNeedingMoreData.length; i += BATCH_SIZE) {
        const batch = docsNeedingMoreData.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (doc) => {
          const targetedChunks: string[] = [];

          // Поиск 1: Первая страница с номером и ФИО
          if (doc.fio === 'Не указано' || doc.poaNumber === 'Не указано' || doc.issueDate === 'Не указано') {
            try {
              const searchResponse = await fetch('https://api.x.ai/v1/documents/search', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  query: 'ДОВЕРЕННОСТЬ № настоящей доверенностью уполномочивает',
                  source: { collection_ids: [collectionId], file_ids: [doc.fileId] },
                  retrieval_mode: { type: 'hybrid' },
                  max_num_results: 3,
                  top_k: 3,
                }),
              });

              if (searchResponse.ok) {
                const data = await searchResponse.json();
                const results = data.matches || data.results || [];
                for (const result of results) {
                  const content = result.chunk_content || result.content || result.text || '';
                  if (content) targetedChunks.push(content);
                }
              }
            } catch (err) {
              console.error(`Targeted search 1 failed for ${doc.fileId}:`, err);
            }
          }

          // Поиск 2: Срок действия
          if (doc.validUntil === 'Не указано') {
            try {
              const searchResponse = await fetch('https://api.x.ai/v1/documents/search', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  query: 'доверенность выдана сроком по до года включительно',
                  source: { collection_ids: [collectionId], file_ids: [doc.fileId] },
                  retrieval_mode: { type: 'hybrid' },
                  max_num_results: 3,
                  top_k: 3,
                }),
              });

              if (searchResponse.ok) {
                const data = await searchResponse.json();
                const results = data.matches || data.results || [];
                for (const result of results) {
                  const content = result.chunk_content || result.content || result.text || '';
                  if (content) targetedChunks.push(content);
                }
              }
            } catch (err) {
              console.error(`Targeted search 2 failed for ${doc.fileId}:`, err);
            }
          }

          // Извлекаем метаданные из целевых чанков
          if (targetedChunks.length > 0) {
            const combinedContent = targetedChunks.join('\n\n');
            const newMeta = extractPoaFieldsFromContent(combinedContent);

            // Обновляем только пустые поля
            if (doc.fio === 'Не указано' && newMeta.fio !== 'Не указано') {
              doc.fio = newMeta.fio;
            }
            if (doc.poaNumber === 'Не указано' && newMeta.poaNumber !== 'Не указано') {
              doc.poaNumber = newMeta.poaNumber;
            }
            if (doc.issueDate === 'Не указано' && newMeta.issueDate !== 'Не указано') {
              doc.issueDate = newMeta.issueDate;
            }
            if (doc.validUntil === 'Не указано' && newMeta.validUntil !== 'Не указано') {
              doc.validUntil = newMeta.validUntil;
            }

            console.log(`Updated metadata for ${doc.fileName}: FIO=${doc.fio}, number=${doc.poaNumber}, issue=${doc.issueDate}, valid=${doc.validUntil}`);
          }
        }));
      }
    }

    console.log(`Enriched ${enrichedDocs.length} POA documents`);

    // Форматируем в формате, который ожидает система для POA
    const formattedResults = enrichedDocs.map((doc, i) => {
      const encodedFilename = encodeURIComponent(doc.fileName);
      const downloadUrl = doc.fileId
        ? `/api/download?file_id=${doc.fileId}&filename=${encodedFilename}`
        : '';
      const markdownLink = downloadUrl ? `[Скачать](${downloadUrl})` : 'Нет ссылки';

      return `[${i + 1}] Файл: ${doc.fileName} | ФИО: ${doc.fio} | Номер: ${doc.poaNumber} | Дата выдачи: ${doc.issueDate} | Действует до: ${doc.validUntil} | Скачать: ${markdownLink}`;
    }).join('\n');

    const summary = `\n\nВСЕГО ДОКУМЕНТОВ В БАЗЕ: ${enrichedDocs.length}`;
    return formattedResults + summary;

  } catch (error) {
    console.error('Error in getDocumentsListFastPOA:', error);
    return '';
  }
}

// Функция получения ПОЛНОГО списка всех документов из коллекции
// Сначала получаем ВСЕ документы через list API, потом ищем контент для метаданных
async function getAllDocuments(apiKey: string, collectionId: string): Promise<string> {
  console.log('=== Get All Documents ===');
  console.log('Collection ID:', collectionId);

  try {
    // ШАГ 1: Получаем ВСЕ документы через list API (гарантирует полный список)
    let allDocuments: any[] = [];
    let cursor: string | null = null;
    const limit = 100;

    do {
      const url = new URL(`https://api.x.ai/v1/collections/${collectionId}/documents`);
      url.searchParams.set('limit', limit.toString());
      if (cursor) {
        url.searchParams.set('starting_after', cursor);
      }

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.error('Documents list failed:', response.status);
        break;
      }

      const data = await response.json();
      const documents = data.data || data.documents || [];

      if (documents.length === 0) break;

      // Логируем структуру первого документа для отладки
      if (allDocuments.length === 0 && documents.length > 0) {
        console.log('=== LIST API RESPONSE ===');
        console.log('Response keys:', Object.keys(data));
        console.log('Documents count:', documents.length);
        console.log('First document keys:', Object.keys(documents[0]));
        console.log('First document:', JSON.stringify(documents[0], null, 2).substring(0, 1500));
        console.log('=== END LIST API RESPONSE ===');
      }

      allDocuments = allDocuments.concat(documents);

      const hasMore = data.has_more || (documents.length === limit);
      if (hasMore && documents.length > 0) {
        const lastDoc = documents[documents.length - 1];
        cursor = lastDoc.file_id || lastDoc.id;
      } else {
        cursor = null;
      }
    } while (cursor);

    console.log(`List API returned ${allDocuments.length} documents`);

    // ШАГ 2: Собираем контент через поиск для извлечения метаданных
    // Расширенный список запросов для поиска дат и метаданных
    const searchQueries = [
      'доверенность',
      'уполномочивает представлять интересы',
      'настоящей доверенностью',
      // Запросы для поиска дат прописью - срок действия
      'сроком по года включительно',
      'две тысячи двадцать года',
      'по января две тысячи',
      'по февраля две тысячи',
      'по марта две тысячи',
      'по апреля две тысячи',
      'по мая две тысячи',
      'по июня две тысячи',
      'по июля две тысячи',
      'по августа две тысячи',
      'по сентября две тысячи',
      'по октября две тысячи',
      'по ноября две тысячи',
      'по декабря две тысячи',
      // Альтернативные запросы с "до" вместо "по"
      'до января две тысячи',
      'до февраля две тысячи',
      'до марта две тысячи',
      'до апреля две тысячи',
      'до мая две тысячи',
      'до июня две тысячи',
      'до июля две тысячи',
      'до августа две тысячи',
      'до сентября две тысячи',
      'до октября две тысячи',
      'до ноября две тысячи',
      'до декабря две тысячи',
      // Дополнительные запросы для дат выдачи
      'года выдана доверенность',
      'настоящая доверенность выдана',
      // Запросы для дат выдачи прописью - по месяцам
      'января две тысячи двадцать',
      'февраля две тысячи двадцать',
      'марта две тысячи двадцать',
      'апреля две тысячи двадцать',
      'мая две тысячи двадцать',
      'июня две тысячи двадцать',
      'июля две тысячи двадцать',
      'августа две тысячи двадцать',
      'сентября две тысячи двадцать',
      'октября две тысячи двадцать',
      'ноября две тысячи двадцать',
      'декабря две тысячи двадцать',
      // Общие запросы для поиска любых дат
      'года город',
      'года настоящая доверенность',
      // Запросы для поиска начала документа с датой выдачи
      'город Кемерово',
      'город Москва',
      'город Красноярск',
      'г. Кемерово',
      'г. Москва',
      'г. Красноярск',
      // Дата с кавычками
      'февраля года доверенность',
      'марта года доверенность',
      'января года доверенность',
      // Дата полностью прописью - для начала документа
      'первое марта две тысячи',
      'второе марта две тысячи',
      'третье марта две тысячи',
      'первое февраля две тысячи',
      'первое января две тысячи',
      'первое апреля две тысячи',
      // Кузбасс - специфичный запрос для Кемеровских доверенностей
      'Кемеровская область Кузбасс',
      'область Кузбасс',
    ];

    // Map для хранения контента по file_id
    const contentByFileId = new Map<string, string[]>();
    // Map для хранения имен файлов из результатов поиска
    const fileNamesByFileId = new Map<string, string>();

    for (const query of searchQueries) {
      const response = await fetch('https://api.x.ai/v1/documents/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: query,
          source: { collection_ids: [collectionId] },
          retrieval_mode: { type: 'hybrid' },
          max_num_results: 100,
          top_k: 100,
        }),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const results = data.matches || data.results || [];

      // Логируем первый результат первого поиска для отладки
      if (query === 'доверенность' && results.length > 0) {
        console.log('=== SEARCH API FIRST RESULT ===');
        console.log('Result keys:', Object.keys(results[0]));
        console.log('Result fields:', results[0].fields ? Object.keys(results[0].fields) : 'no fields');
        console.log('Result sample:', JSON.stringify(results[0], null, 2).substring(0, 1500));
        console.log('=== END SEARCH RESULT ===');
      }

      for (const result of results) {
        const fileId = result.file_id || '';
        const content = result.chunk_content || result.content || result.text || '';
        // Сохраняем имя файла из результатов поиска
        const fileName = result.fields?.file_name || result.fields?.name || result.name || '';

        if (fileId) {
          // Сохраняем имя файла если его ещё нет
          if (fileName && !fileNamesByFileId.has(fileId)) {
            fileNamesByFileId.set(fileId, fileName);
          }

          // Сохраняем контент
          if (content) {
            if (!contentByFileId.has(fileId)) {
              contentByFileId.set(fileId, []);
            }
            const chunks = contentByFileId.get(fileId)!;
            if (!chunks.includes(content)) {
              chunks.push(content);
            }
          }
        }
      }
    }

    console.log(`Search collected content for ${contentByFileId.size} documents`);
    console.log(`Search collected file names for ${fileNamesByFileId.size} documents`);

    // Логируем примеры найденных имён файлов
    if (fileNamesByFileId.size > 0) {
      const sampleNames = Array.from(fileNamesByFileId.entries()).slice(0, 3);
      console.log('Sample file names from search:', sampleNames);
    }

    // Если list API вернул документы без имён, но search нашёл file_id - используем search как источник
    // Также добавляем документы из search которых нет в list (только если есть имя файла)
    const listFileIds = new Set(allDocuments.map((d: any) => d.file_id || d.id).filter(Boolean));
    const searchFileIds = new Set([...contentByFileId.keys(), ...fileNamesByFileId.keys()]);

    // Добавляем документы из search которых нет в list, ТОЛЬКО если у них есть имя файла
    let addedFromSearch = 0;
    for (const fileId of searchFileIds) {
      if (!listFileIds.has(fileId)) {
        // Добавляем только если есть имя файла из search
        const fileName = fileNamesByFileId.get(fileId);
        if (fileName) {
          allDocuments.push({ file_id: fileId, name: fileName });
          console.log(`Added document from search: ${fileId} (${fileName})`);
          addedFromSearch++;
        } else {
          console.log(`Skipped document from search (no filename): ${fileId}`);
        }
      }
    }
    console.log(`Total documents after merge: ${allDocuments.length} (list: ${listFileIds.size}, added from search: ${addedFromSearch})`);

    // ШАГ 3: Обогащаем ВСЕ документы данными из поиска и Files API
    const enrichedDocuments = await Promise.all(
      allDocuments.map(async (doc: any, index: number) => {
        const fileId = doc.file_id || doc.id || '';

        // Получаем имя файла из разных источников
        let fileName = doc.name || doc.file_name || doc.filename ||
                       doc.fields?.file_name || doc.metadata?.file_name || '';

        // Если нет имени - пробуем из результатов поиска
        if (!fileName && fileId) {
          fileName = fileNamesByFileId.get(fileId) || '';
        }

        // ВСЕГДА пробуем Files API для получения имени если его нет
        if (!fileName && fileId) {
          const fileInfo = await getFileInfo(apiKey, fileId);
          if (fileInfo?.filename) {
            fileName = fileInfo.filename;
          }
          // Логируем для отладки первых 3 документов
          if (index < 3) {
            console.log(`Files API for doc ${index}:`, fileInfo ? JSON.stringify(fileInfo.allFields).substring(0, 300) : 'null');
          }
        }

        // Логируем для отладки
        if (index < 3) {
          console.log(`Doc ${index}: fileId=${fileId}, fileName=${fileName || 'EMPTY'}, fromSearch=${fileNamesByFileId.has(fileId)}`);
        }

        // Извлекаем поля из названия файла
        let { fio, poaNumber, issueDate, validUntil } = extractPoaFieldsFromFilename(fileName);

        // Извлекаем данные из контента (если есть)
        const chunks = contentByFileId.get(fileId) || [];

        // ВАЖНО: Объединяем ВСЕ чанки в один текст для полного анализа
        // Это критично для длинных документов на несколько страниц
        if (chunks.length > 0) {
          const fullContent = chunks.join('\n\n');
          const contentFields = extractPoaFieldsFromContent(fullContent);

          if (fio === 'Не указано' && contentFields.fio !== 'Не указано') {
            fio = contentFields.fio;
          }
          if (poaNumber === 'Не указано' && contentFields.poaNumber !== 'Не указано') {
            poaNumber = contentFields.poaNumber;
          }
          if (issueDate === 'Не указано' && contentFields.issueDate !== 'Не указано') {
            issueDate = contentFields.issueDate;
          }
          if (validUntil === 'Не указано' && contentFields.validUntil !== 'Не указано') {
            validUntil = contentFields.validUntil;
          }

          // Если всё ещё не нашли - пробуем каждый чанк отдельно (fallback)
          if (issueDate === 'Не указано' || validUntil === 'Не указано') {
            for (const chunkContent of chunks) {
              const chunkFields = extractPoaFieldsFromContent(chunkContent);

              if (issueDate === 'Не указано' && chunkFields.issueDate !== 'Не указано') {
                issueDate = chunkFields.issueDate;
              }
              if (validUntil === 'Не указано' && chunkFields.validUntil !== 'Не указано') {
                validUntil = chunkFields.validUntil;
              }
            }
          }
        }

        if (index < 3) {
          console.log(`Document ${index}:`, { fileId, fileName, chunksCount: chunks.length, fio, poaNumber, issueDate, validUntil });
        }

        return { fileName: fileName || 'Документ', fileId, fio, poaNumber, issueDate, validUntil };
      })
    );

    // Фильтруем полностью пустые документы (без имени файла и без данных)
    const filteredDocuments = enrichedDocuments.filter((doc) => {
      const hasRealFileName = doc.fileName && doc.fileName !== 'Документ';
      const hasAnyData = doc.fio !== 'Не указано' ||
                         doc.poaNumber !== 'Не указано' ||
                         doc.issueDate !== 'Не указано' ||
                         doc.validUntil !== 'Не указано';

      // Оставляем документ если есть реальное имя файла ИЛИ хотя бы одно поле данных
      return hasRealFileName || hasAnyData;
    });

    console.log(`Filtered documents: ${filteredDocuments.length} (removed ${enrichedDocuments.length - filteredDocuments.length} empty)`);

    // Форматируем результаты
    // ВАЖНО: Создаём готовую markdown-ссылку с закодированным URL
    // чтобы AI могла просто скопировать её в таблицу без модификации
    const formattedResults = filteredDocuments.map((doc, i) => {
      const encodedFilename = encodeURIComponent(doc.fileName);
      const downloadUrl = doc.fileId
        ? `/api/download?file_id=${doc.fileId}&filename=${encodedFilename}`
        : '';
      // Готовая markdown-ссылка для копирования в таблицу
      const markdownLink = downloadUrl ? `[Скачать](${downloadUrl})` : 'Нет ссылки';

      return `[${i + 1}] Файл: ${doc.fileName} | ФИО: ${doc.fio} | Номер: ${doc.poaNumber} | Дата выдачи: ${doc.issueDate} | Действует до: ${doc.validUntil} | Скачать: ${markdownLink}`;
    }).join('\n');

    console.log('=== FORMATTED DOCUMENTS PREVIEW ===');
    console.log(formattedResults.split('\n').slice(0, 3).join('\n'));
    console.log('=== END PREVIEW ===');

    const summary = `\n\nВСЕГО ДОКУМЕНТОВ В БАЗЕ: ${filteredDocuments.length}`;
    return formattedResults + summary;

  } catch (error) {
    console.error('Get all documents error:', error);
    return '';
  }
}

// Fallback функция для получения документов через list endpoint
async function getAllDocumentsViaList(apiKey: string, collectionId: string): Promise<string> {
  console.log('=== Fallback: Get All Documents via List ===');

  try {
    let allDocuments: any[] = [];
    let cursor: string | null = null;
    const limit = 100;

    do {
      const url = new URL(`https://api.x.ai/v1/collections/${collectionId}/documents`);
      url.searchParams.set('limit', limit.toString());
      if (cursor) {
        url.searchParams.set('starting_after', cursor);
      }

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.error('Documents list failed:', response.status);
        return '';
      }

      const data = await response.json();
      const documents = data.data || data.documents || [];

      if (documents.length === 0) break;

      // Логируем структуру первого документа для отладки
      if (allDocuments.length === 0 && documents[0]) {
        console.log('=== LIST DOCUMENT STRUCTURE ===');
        console.log('Document:', JSON.stringify(documents[0], null, 2));
        console.log('=== END ===');
      }

      allDocuments = allDocuments.concat(documents);

      const hasMore = data.has_more || (documents.length === limit);
      if (hasMore && documents.length > 0) {
        const lastDoc = documents[documents.length - 1];
        cursor = lastDoc.file_id || lastDoc.id;
      } else {
        cursor = null;
      }
    } while (cursor);

    if (allDocuments.length === 0) {
      return '';
    }

    // Обогащаем документы
    const enrichedDocuments = await Promise.all(
      allDocuments.map(async (doc: any, index: number) => {
        // В list API файл может быть представлен по-разному
        // Проверяем все возможные поля для file_id
        const fileId = doc.file_id || doc.id || '';

        // Получаем имя файла
        let fileName = doc.name || doc.file_name || doc.filename ||
                       doc.fields?.file_name || doc.metadata?.file_name || '';

        // Если нет имени, получаем через Files API
        if (!fileName && fileId) {
          const fileInfo = await getFileInfo(apiKey, fileId);
          if (fileInfo?.filename) {
            fileName = fileInfo.filename;
          }
        }

        // Извлекаем метаданные
        let { fio, poaNumber, issueDate, validUntil } = extractPoaFieldsFromFilename(fileName);

        return {
          fileName: fileName || 'Документ',
          fileId,
          fio,
          poaNumber,
          issueDate,
          validUntil
        };
      })
    );

    // Фильтруем полностью пустые документы (без имени файла и без данных)
    const filteredDocuments = enrichedDocuments.filter((doc) => {
      const hasRealFileName = doc.fileName && doc.fileName !== 'Документ';
      const hasAnyData = doc.fio !== 'Не указано' ||
                         doc.poaNumber !== 'Не указано' ||
                         doc.issueDate !== 'Не указано' ||
                         doc.validUntil !== 'Не указано';

      return hasRealFileName || hasAnyData;
    });

    console.log(`Filtered documents: ${filteredDocuments.length} (removed ${enrichedDocuments.length - filteredDocuments.length} empty)`);

    // Форматируем результаты
    // ВАЖНО: Создаём готовую markdown-ссылку с закодированным URL
    // чтобы AI могла просто скопировать её в таблицу без модификации
    const formattedResults = filteredDocuments.map((doc, i) => {
      const encodedFilename = encodeURIComponent(doc.fileName);
      const downloadUrl = doc.fileId
        ? `/api/download?file_id=${doc.fileId}&filename=${encodedFilename}`
        : '';
      // Готовая markdown-ссылка для копирования в таблицу
      const markdownLink = downloadUrl ? `[Скачать](${downloadUrl})` : 'Нет ссылки';

      return `[${i + 1}] Файл: ${doc.fileName} | ФИО: ${doc.fio} | Номер: ${doc.poaNumber} | Дата выдачи: ${doc.issueDate} | Действует до: ${doc.validUntil} | Скачать: ${markdownLink}`;
    }).join('\n');

    const summary = `\n\nВСЕГО ДОКУМЕНТОВ В БАЗЕ: ${filteredDocuments.length}`;
    return formattedResults + summary;

  } catch (error) {
    console.error('Get all documents via list error:', error);
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

// Функция для создания streaming response
/**
 * Создаёт streaming response из Responses API (для file attachments)
 * Responses API возвращает данные в формате SSE
 */
function createResponsesStreamResponse(response: Response): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let chunkCount = 0;
  let buffer = '';
  let totalBytesReceived = 0;
  let currentEventType = '';

  console.log('=== Starting Responses API stream processing ===');

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      totalBytesReceived += chunk.byteLength;
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      console.log(`Received chunk: ${chunk.byteLength} bytes, total: ${totalBytesReceived}, lines: ${lines.length}`);

      for (const line of lines) {
        const trimmedLine = line.trim();

        // Логируем каждую непустую строку
        if (trimmedLine) {
          console.log('SSE line:', trimmedLine.substring(0, 300));
        }

        // Отслеживаем тип события
        if (trimmedLine.startsWith('event: ')) {
          currentEventType = trimmedLine.slice(7).trim();
          console.log('Event type:', currentEventType);
          continue;
        }

        if (trimmedLine.startsWith('data: ')) {
          const data = trimmedLine.slice(6).trim();

          if (data === '[DONE]') {
            console.log('Stream [DONE], total chunks extracted:', chunkCount);
            controller.enqueue(encoder.encode('d:{"finishReason":"stop"}\n'));
            return;
          }

          try {
            const json = JSON.parse(data);
            const eventType = json.type || currentEventType || 'unknown';
            console.log(`JSON event: ${eventType}, keys: ${Object.keys(json).join(',')}`);

            // Извлекаем текст из разных форматов ответа
            let content = null;

            // Формат 1: xAI/OpenAI Responses API - response.output_text.delta
            if (json.type === 'response.output_text.delta' && json.delta) {
              content = json.delta;
              console.log('Format: response.output_text.delta');
            }
            // Формат 2: Anthropic-style - content_block_delta
            else if (json.type === 'content_block_delta' && json.delta?.text) {
              content = json.delta.text;
              console.log('Format: content_block_delta');
            }
            // Формат 3: Chat Completions streaming - choices[].delta.content
            else if (json.choices?.[0]?.delta?.content !== undefined) {
              content = json.choices[0].delta.content;
              console.log('Format: chat.completion.chunk');
            }
            // Формат 4: Прямой delta.content
            else if (json.delta?.content) {
              content = json.delta.content;
              console.log('Format: delta.content');
            }
            // Формат 5: output_text.text напрямую
            else if (json.output_text?.text) {
              content = json.output_text.text;
              console.log('Format: output_text.text');
            }
            // Формат 6: text напрямую в delta
            else if (json.delta?.text) {
              content = json.delta.text;
              console.log('Format: delta.text');
            }
            // Формат 7: content напрямую
            else if (typeof json.content === 'string') {
              content = json.content;
              console.log('Format: direct content');
            }
            // Формат 8: text напрямую
            else if (typeof json.text === 'string') {
              content = json.text;
              console.log('Format: direct text');
            }

            if (content !== null && content !== undefined && content !== '') {
              chunkCount++;
              controller.enqueue(encoder.encode(`0:${JSON.stringify(content)}\n`));
              if (chunkCount <= 3 || chunkCount % 50 === 0) {
                console.log(`Chunk ${chunkCount}: "${String(content).substring(0, 50)}..."`);
              }
            } else if (!['response.created', 'response.in_progress', 'response.output_item.added',
                        'response.content_part.added', 'response.output_text.done',
                        'response.content_part.done', 'response.output_item.done',
                        'response.completed', 'response.done'].includes(json.type)) {
              // Логируем неизвестные события с контентом
              console.log('Unknown event with data:', JSON.stringify(json).substring(0, 200));
            }
          } catch (e) {
            console.log('JSON parse error for data:', data.substring(0, 100), e);
          }
        }
      }
    },
    flush(controller) {
      console.log(`Stream flush. Buffer remaining: "${buffer.substring(0, 100)}", total bytes: ${totalBytesReceived}`);
      if (buffer.trim()) {
        const trimmedLine = buffer.trim();
        if (trimmedLine.startsWith('data: ')) {
          const data = trimmedLine.slice(6).trim();
          if (data !== '[DONE]') {
            try {
              const json = JSON.parse(data);
              let content = null;

              if (json.type === 'response.output_text.delta' && json.delta) {
                content = json.delta;
              } else if (json.choices?.[0]?.delta?.content !== undefined) {
                content = json.choices[0].delta.content;
              } else if (json.delta?.content) {
                content = json.delta.content;
              } else if (json.delta?.text) {
                content = json.delta.text;
              }

              if (content) {
                chunkCount++;
                controller.enqueue(encoder.encode(`0:${JSON.stringify(content)}\n`));
              }
            } catch (e) {
              // ignore
            }
          }
        }
      }
      console.log(`=== Stream complete. Total chunks: ${chunkCount}, bytes: ${totalBytesReceived} ===`);
      controller.enqueue(encoder.encode('d:{"finishReason":"stop"}\n'));
    }
  });

  return new Response(response.body?.pipeThrough(transformStream), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

function createStreamResponse(response: Response): Response {
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

    // СНАЧАЛА проверяем загруженные документы - если есть, пропускаем маршрутизацию
    const isUploadedDocumentRequest = hasUploadedDocuments(messages);

    if (isUploadedDocumentRequest) {
      console.log('Using uploaded document mode with knowledge base search');

      // Извлекаем текст загруженного документа для поиска
      // Ищем сообщение с маркером документа (может быть не последним при follow-up вопросах)
      const userMessages = messages.filter((m: any) => m.role === 'user');
      const documentMessage = userMessages.find((m: any) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return content.includes('[ЗАГРУЖЕННЫЕ ДОКУМЕНТЫ ДЛЯ АНАЛИЗА]');
      });
      const uploadedContent = documentMessage?.content || '';

      // Извлекаем ключевые данные для поиска по базе знаний
      let knowledgeBaseContext = '';

      // Проверяем, похож ли документ на доверенность
      const isPoaDocument = /доверенност|уполномоч|полномочи/i.test(uploadedContent);

      if (isPoaDocument) {
        console.log('Uploaded document looks like a POA - searching knowledge base');

        // Извлекаем номер доверенности и ФИО для поиска
        const poaNumberMatch = uploadedContent.match(/(?:доверенност[ьи]?\s*)?№?\s*([А-ЯA-Z]{1,4}[-\s]?\d{1,4}[-/]?\d{0,4})/i);
        const fioMatch = uploadedContent.match(/(?:уполномочивает|доверяет|представител[ья])\s+([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/i);

        const searchTerms = [];
        if (poaNumberMatch) searchTerms.push(poaNumberMatch[1]);
        if (fioMatch) searchTerms.push(fioMatch[1]);

        // Получаем ID коллекции доверенностей
        const poaCollectionId = process.env.POA_COLLECTION_ID;

        if (poaCollectionId && searchTerms.length > 0) {
          const searchQuery = searchTerms.join(' ');
          console.log('Searching POA collection for:', searchQuery);

          try {
            const searchResults = await searchCollection(searchQuery, apiKey, poaCollectionId, 5);
            if (searchResults) {
              knowledgeBaseContext = `\n\n=== РЕЗУЛЬТАТЫ ПОИСКА В БАЗЕ ДОВЕРЕННОСТЕЙ ===\n${searchResults}\n=== КОНЕЦ РЕЗУЛЬТАТОВ ПОИСКА ===`;
              console.log('Found matching documents in knowledge base');
            }
          } catch (e) {
            console.error('Error searching knowledge base:', e);
          }
        }
      }

      // Для загруженных документов используем специальный промпт
      const systemPromptWithContext = uploadedDocumentSystemPrompt +
        '\n\nАнализируй документы из раздела [ЗАГРУЖЕННЫЕ ДОКУМЕНТЫ ДЛЯ АНАЛИЗА] в истории диалога. Документ может быть в любом из предыдущих сообщений пользователя - используй его для ответа на все вопросы в этом диалоге.' +
        (knowledgeBaseContext ? `\n\nЕсли пользователь спрашивает, есть ли документ в базе — сравни загруженный документ с результатами поиска ниже. Если номер доверенности или ФИО совпадают — документ ЕСТЬ в базе.${knowledgeBaseContext}` : '');

      const apiMessages = messages.map((m: any) => ({
        role: m.role,
        content: m.content,
      }));

      console.log('Calling xAI Chat API for uploaded documents...');

      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'grok-4-1-fast',
          messages: [
            { role: 'system', content: systemPromptWithContext },
            ...apiMessages,
          ],
          stream: true,
          temperature: 0, // Предотвращает галлюцинации при анализе загруженных документов
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('xAI API error (uploaded docs):', response.status, errorText);

        // Обработка различных ошибок API с понятными сообщениями
        let userFriendlyMessage = 'Произошла ошибка при обращении к AI сервису.';

        if (response.status === 413) {
          userFriendlyMessage = 'Загруженный документ слишком большой для обработки. Попробуйте загрузить документ меньшего размера или разбить его на части.';
        } else if (response.status === 429) {
          userFriendlyMessage = 'Слишком много запросов. Пожалуйста, подождите немного и повторите попытку.';
        } else if (response.status === 401 || response.status === 403) {
          userFriendlyMessage = 'Ошибка авторизации. Пожалуйста, обратитесь к администратору.';
        } else if (response.status === 503 || response.status === 502) {
          userFriendlyMessage = 'AI сервис временно недоступен. Пожалуйста, повторите попытку позже.';
        }

        return new Response(
          JSON.stringify({ error: userFriendlyMessage }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Используем общую трансформацию потока
      return createStreamResponse(response);
    }

    // Если нет загруженных документов - выполняем маршрутизацию по коллекциям
    const queryAnalysis = await analyzeQueryWithLLM(messages, apiKey);

    // Проверяем, требуется ли уточнение от пользователя
    if (queryAnalysis.needsClarification) {
      console.log('Clarification needed - LLM analysis:', queryAnalysis.classificationReasoning);

      // Используем уточняющий вопрос от LLM или стандартный
      let clarificationMessage: string;
      if (queryAnalysis.clarificationQuestion) {
        // LLM сформулировал уточняющий вопрос
        clarificationMessage = queryAnalysis.clarificationQuestion;
      } else {
        // Fallback на стандартное сообщение
        const availableCollections = getAvailableCollectionsList();
        clarificationMessage = `Не удалось определить, к какой категории документов относится ваш запрос.\n\nУ меня есть следующие коллекции документов:\n${availableCollections}\n\nПожалуйста, уточните, из какой коллекции вы хотите получить информацию.`;
      }

      // Создаём потоковый ответ в формате Vercel AI SDK
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // Формат Vercel AI SDK: 0:JSON_STRING\n для текста, d:{"finishReason":"stop"}\n для завершения
          controller.enqueue(encoder.encode(`0:${JSON.stringify(clarificationMessage)}\n`));
          controller.enqueue(encoder.encode('d:{"finishReason":"stop"}\n'));
          controller.close();
        }
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
        },
      });
    }

    const { collectionKey, isListAll, collectionId, systemPrompt } = queryAnalysis;

    // После проверки needsClarification выше, collectionId гарантированно не null
    if (!collectionId || !collectionKey) {
      console.error('Unexpected: collectionId or collectionKey is null after clarification check');
      return new Response(
        JSON.stringify({ error: 'Внутренняя ошибка конфигурации коллекций' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const collectionConfig = getCollectionConfig(collectionKey);

    console.log('Query analysis:', {
      collectionKey,
      collectionName: collectionConfig?.displayName,
      isListAll,
      collectionId,
      useFullContent: collectionConfig?.useFullContent ?? false
    });

    // Получаем документы - либо полный список, либо через поиск
    let documentResults: string;
    let contextSection: string;

if (isListAll) {
      // Для запросов о полном списке - получаем документы из коллекции
      console.log('Fetching documents from collection...');

      const collectionName = collectionConfig?.displayName || 'документов';
      const useFullContent = collectionConfig?.useFullContent ?? false;

      // Для коллекций с большими документами (уставы и др.) используем быструю функцию
      // Для POA используем оптимизированную быструю функцию с метаданными из названий файлов
      if (collectionKey === 'poa') {
        // Для доверенностей - быстрая загрузка с метаданными из названий файлов
        documentResults = await getDocumentsListFastPOA(apiKey, collectionId);
        console.log('Fast POA documents results length:', documentResults.length);

        const lastUserMessage = messages.filter((m: any) => m.role === 'user').pop()?.content || '';
        const { fields, instruction } = detectRequestedTableFields(lastUserMessage);
        console.log('Requested table fields:', fields);

        // Подсчитываем количество документов для явной инструкции
        const docCount = (documentResults.match(/^\[\d+\]/gm) || []).length;
        console.log(`POA document count from formatted results: ${docCount}`);

        contextSection = documentResults
          ? `\n\nПОЛНЫЙ СПИСОК ДОКУМЕНТОВ В БАЗЕ (${collectionName}):\n${documentResults}\n\n` +
            `КРИТИЧЕСКИ ВАЖНО: В списке выше ровно ${docCount} документов. ` +
            `Твоя таблица ОБЯЗАНА содержать ровно ${docCount} строк (не считая заголовка)! ` +
            `Просто преобразуй КАЖДУЮ строку [N] в строку таблицы.\n\n` +
            `ИНСТРУКЦИЯ ПО КОЛОНКАМ ТАБЛИЦЫ: ${instruction}\n` +
            `Доступные колонки: № | Файл | ФИО | Номер | Дата выдачи | Действует до | Скачать\n` +
            `Запрошенные колонки: ${fields.join(' | ')}\n\n` +
            `ВАЖНО ПРО ССЫЛКИ: Поле "Скачать:" уже содержит ГОТОВУЮ markdown-ссылку [Скачать](URL). КОПИРУЙ её в таблицу ДОСЛОВНО, без изменений!`
          : `\n\nВ базе данных "${collectionName}" нет документов.`;
      } else {
        // Для других коллекций (уставы, формы договоров) - быстрая загрузка только списка
        documentResults = await getDocumentsListFast(apiKey, collectionId, collectionKey);
        console.log('Fast documents list length:', documentResults.length);

        contextSection = documentResults
          ? `\n\nСПИСОК ДОКУМЕНТОВ В БАЗЕ (${collectionName}):\n${documentResults}\n\nЭто список всех документов в базе данных "${collectionName}". Для каждого документа указано название и ссылка на скачивание.`
          : `\n\nВ базе данных "${collectionName}" нет документов.`;
      }
    } else {
      // Для обычных запросов - используем поиск
      const searchQuery = buildContextualSearchQuery(messages, 3);

      // Проверяем, нужно ли использовать Responses API с прикреплением файла
      // Это позволяет Grok работать с полным PDF документом
      const useFileAttachment = collectionConfig?.useFileAttachment ?? false;

      if (useFileAttachment) {
        console.log(`Trying Responses API with file attachment for ${collectionKey}...`);
        const fileResponse = await chatWithFileAttachment(
          searchQuery,
          apiKey,
          collectionId,
          systemPrompt,
          messages
        );

        if (fileResponse) {
          console.log('Using Responses API response');
          // Трансформируем поток из Responses API в формат Chat Completions
          return createResponsesStreamResponse(fileResponse);
        }

        console.log('Responses API failed, falling back to chunk search...');
      }

      // Проверяем, нужно ли использовать полный текст документов
      const useFullContent = collectionConfig?.useFullContent ?? false;

      if (useFullContent) {
        // Для коллекций с небольшими документами (доверенности и т.п.)
        // скачиваем полный текст вместо чанков
        console.log('Using full content mode for collection:', collectionKey);
        documentResults = await searchWithFullContent(searchQuery, apiKey, collectionId);
        console.log('Full content search results length:', documentResults.length);

        contextSection = documentResults
          ? `\n\nНАЙДЕННЫЕ ДОКУМЕНТЫ (ПОЛНЫЙ ТЕКСТ):\n${documentResults}\n\nВАЖНО: Выше представлен ПОЛНЫЙ текст каждого найденного документа. Используйте всю информацию из документов для точного и полного ответа.`
          : '\n\nПоиск по документам не вернул результатов.';
      } else {
        // Для коллекций с большими документами - используем чанки (как раньше)
        const maxResults = collectionConfig?.maxSearchResults ?? 15;
        documentResults = await searchCollection(searchQuery, apiKey, collectionId, maxResults);
        console.log('Chunk search results length:', documentResults.length);

        contextSection = documentResults
          ? `\n\nНАЙДЕННЫЕ ДОКУМЕНТЫ:\n${documentResults}\n\nИспользуйте информацию из найденных документов для ответа.`
          : '\n\nПоиск по документам не вернул результатов.';
      }
    }

    // Логируем размер контекста для отладки
    console.log('Context section size:', contextSection.length, 'characters');

    // Grok 4.1 поддерживает 2M токенов - лимит не нужен
    const { text: truncatedContext } = truncateContextIfNeeded(contextSection);

    const systemPromptWithContext = systemPrompt + truncatedContext;
    console.log('Total system prompt size:', systemPromptWithContext.length, 'characters');

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
        model: 'grok-4-1-fast',
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
      console.error('xAI API error:', response.status, errorText);

      // Обработка различных ошибок API с понятными сообщениями
      let userFriendlyMessage = 'Произошла ошибка при обращении к AI сервису.';

      if (response.status === 413) {
        userFriendlyMessage = 'Запрос слишком большой. Попробуйте сформулировать запрос более конкретно или уточнить имя/номер документа.';
      } else if (response.status === 429) {
        userFriendlyMessage = 'Слишком много запросов. Пожалуйста, подождите немного и повторите попытку.';
      } else if (response.status === 401 || response.status === 403) {
        userFriendlyMessage = 'Ошибка авторизации. Пожалуйста, обратитесь к администратору.';
      } else if (response.status === 503 || response.status === 502) {
        userFriendlyMessage = 'AI сервис временно недоступен. Пожалуйста, повторите попытку позже.';
      }

      return new Response(
        JSON.stringify({ error: userFriendlyMessage }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return createStreamResponse(response);

  } catch (error) {
    console.error('Chat API error:', error);
    return new Response(
      JSON.stringify({ error: 'Request failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
