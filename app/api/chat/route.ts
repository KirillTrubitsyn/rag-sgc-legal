import { legalSystemPrompt, poaSystemPrompt, uploadedDocumentSystemPrompt, getSystemPromptForCollection } from '@/lib/grok-client';
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

// Проверка, содержит ли сообщение загруженные документы
function hasUploadedDocuments(messages: any[]): boolean {
  const lastUserMessage = messages.filter((m: any) => m.role === 'user').pop();
  if (!lastUserMessage) return false;
  return lastUserMessage.content.includes('[ЗАГРУЖЕННЫЕ ДОКУМЕНТЫ ДЛЯ АНАЛИЗА]');
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
  const fioPatterns = [
    // Полное ФИО: Иванов Иван Иванович
    /(?:уполномочива(?:ет|ю)|доверя(?:ет|ю)|настоящей\s+доверенностью)[^\n]{0,50}?([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+)/i,
    /(?:представител[а-яё]*|гражданин[а-яё]*|лицо)[:\s]+([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+)/i,
    /([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+)(?:\s*,?\s*(?:паспорт|дата\s+рождения|проживающ|зарегистрир))/i,
    // Сокращённое ФИО: Иванов И.И. или Иванов И. И.
    /(?:на\s+имя|выдана|представител[а-яё]*)[:\s]*([А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.)/i,
    /(?:уполномочива|доверя)[^\n]{0,30}?([А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.)/i,
    // Любое полное ФИО в тексте (три слова с заглавной буквы подряд)
    /\b([А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ][а-яё]{2,})\b/,
  ];
  for (const pattern of fioPatterns) {
    const match = normalizedContent.match(pattern);
    if (match && match[1]) {
      // Проверяем, что это не название организации
      const candidate = match[1].trim();
      if (!/(ООО|ОАО|ЗАО|ПАО|АО|компани|организаци|общество)/i.test(candidate)) {
        result.fio = candidate;
        break;
      }
    }
  }

  // Извлекаем номер доверенности - более гибкие паттерны
  const numberPatterns = [
    // Стандартные форматы: КГ-24-127, ТГК-13-2024-001
    /доверенност[ьи]?\s*№?\s*([А-ЯЁA-Z]{1,5}[-\s]?\d{2,4}[-\s]?\d+)/i,
    /№\s*([А-ЯЁA-Z]{1,5}[-\s]?\d{2,4}[-\s]?\d+)/i,
    // Номер с префиксом
    /(?:номер|рег\.?\s*№|per\.?\s*№|№)[:\s]*([А-ЯЁA-Z0-9][\w\-\/]{3,})/i,
    // Простой номер после слова "доверенность"
    /доверенност[ьи]?\s+([А-ЯЁA-Z0-9\-\/]{4,})/i,
    // Номер в формате 123/2024
    /№\s*(\d+\/\d{4})/i,
  ];
  for (const pattern of numberPatterns) {
    const match = normalizedContent.match(pattern);
    if (match && match[1] && match[1].length > 3) {
      result.poaNumber = match[1].trim().toUpperCase().replace(/\s+/g, '-');
      break;
    }
  }

  // Извлекаем дату выдачи - более гибкие паттерны
  const issueDatePatterns = [
    // "от 01.01.2024", "от «01» января 2024"
    /(?:от|выдан[аы]?)\s*[«"„]?(\d{1,2})[.\-\/\s»"]+(\d{1,2}|\w+)[.\-\/\s]+(\d{2,4})/i,
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
      // Формируем дату
      const day = match[1].padStart(2, '0');
      let month = match[2];
      const year = match[3].length === 2 ? '20' + match[3] : match[3];

      // Если месяц текстовый, конвертируем
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

      result.issueDate = `${day}.${month}.${year}`;
      break;
    }
  }

  // Извлекаем срок действия - более гибкие паттерны
  const validUntilPatterns = [
    // "действует до 31.12.2024", "срок действия до 31.12.2024"
    /(?:действ[а-яё]*|срок[а-яё]*\s*действ[а-яё]*)[:\s]*(?:до|по)\s*[«"„]?(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/i,
    // "по 31.12.2024", "до 31.12.2024"
    /(?:по|до)\s*[«"„]?(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})[»""']?\s*(?:года?|г\.?)?/i,
    // "до «31» декабря 2024"
    /(?:до|по)\s*[«"„]?(\d{1,2})[»""'\s]+(\w+)\s+(\d{4})/i,
    // Последняя дата в документе (обычно это дата окончания)
    /(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})\s*(?:года?|г\.?)?\s*$/,
  ];
  for (const pattern of validUntilPatterns) {
    const match = normalizedContent.match(pattern);
    if (match && match[1] && match[2] && match[3]) {
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
        continue; // Не удалось распознать месяц
      }

      // Проверяем что это не та же дата что и дата выдачи
      const candidateDate = `${day}.${month}.${year}`;
      if (candidateDate !== result.issueDate) {
        result.validUntil = candidateDate;
        break;
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

// Функция получения ПОЛНОГО списка всех документов из коллекции
// Использует поисковый API вместо списка документов, так как поиск гарантированно возвращает file_id
async function getAllDocuments(apiKey: string, collectionId: string): Promise<string> {
  console.log('=== Get All Documents via Search ===');
  console.log('Collection ID:', collectionId);

  try {
    // Используем поисковый API с разными запросами для получения разных частей документов
    // Это помогает собрать больше информации (даты могут быть в разных частях)
    const searchQueries = [
      'доверенность',
      'уполномочивает представлять интересы',
      'право подписи договор акт',
      'срок действия до по', // Запрос для поиска дат окончания
      'от выдана дата', // Запрос для поиска дат выдачи
    ];

    // Структура для хранения всех chunks по file_id
    const allChunks = new Map<string, { chunks: string[]; result: any }>();

    for (const query of searchQueries) {
      console.log(`Searching with query: "${query}"`);

      const response = await fetch('https://api.x.ai/v1/documents/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: query,
          source: {
            collection_ids: [collectionId]
          },
          retrieval_mode: {
            type: 'hybrid'
          },
          max_num_results: 100,
          top_k: 100,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Search failed for "${query}":`, response.status, errorText);
        continue;
      }

      const data = await response.json();
      const results = data.matches || data.results || [];
      console.log(`Search "${query}" returned ${results.length} results`);

      // Собираем ВСЕ chunks для каждого документа
      for (const result of results) {
        const fileId = result.file_id || '';
        const content = result.chunk_content || result.content || result.text || '';

        if (fileId) {
          if (!allChunks.has(fileId)) {
            allChunks.set(fileId, { chunks: [], result });
          }
          // Добавляем chunk если он уникальный
          const existing = allChunks.get(fileId)!;
          if (content && !existing.chunks.includes(content)) {
            existing.chunks.push(content);
          }
        }
      }
    }

    console.log(`Total unique documents found: ${allChunks.size}`);

    if (allChunks.size === 0) {
      console.log('No documents found in collection via search');
      // Fallback: попробуем получить документы через list endpoint
      return await getAllDocumentsViaList(apiKey, collectionId);
    }

    // Логируем первый результат для отладки
    const firstEntry = Array.from(allChunks.entries())[0];
    if (firstEntry) {
      const [fileId, data] = firstEntry;
      console.log('=== SEARCH RESULT STRUCTURE DEBUG ===');
      console.log('file_id:', fileId);
      console.log('Total chunks for this document:', data.chunks.length);
      console.log('First chunk preview:', data.chunks[0]?.substring(0, 200));
      console.log('Result keys:', Object.keys(data.result));
      console.log('fields:', JSON.stringify(data.result.fields, null, 2));
      console.log('=== END DEBUG ===');
    }

    // Обогащаем документы метаданными, используя ВСЕ chunks
    const enrichedDocuments = await Promise.all(
      Array.from(allChunks.entries()).map(async ([fileId, data], index) => {
        const { chunks, result } = data;

        // Получаем имя файла из разных источников
        let fileName = result.fields?.file_name || result.fields?.name ||
                       result.metadata?.file_name || result.metadata?.name ||
                       result.name || '';

        // Если имя не найдено, запрашиваем через Files API
        if (!fileName && fileId) {
          const fileInfo = await getFileInfo(apiKey, fileId);
          if (fileInfo?.filename) {
            fileName = fileInfo.filename;
          }
        }

        // Извлекаем поля из названия файла
        let { fio, poaNumber, issueDate, validUntil } = extractPoaFieldsFromFilename(fileName);

        // Извлекаем данные из ВСЕХ chunks документа
        // Это важно, так как даты могут быть в разных частях документа
        for (const chunkContent of chunks) {
          if (chunkContent) {
            const contentFields = extractPoaFieldsFromContent(chunkContent);

            // Обновляем только если нашли новые данные
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
          }
        }

        if (index < 3) {
          console.log(`Document ${index}:`, {
            fileId,
            fileName,
            chunksCount: chunks.length,
            fio,
            poaNumber,
            issueDate,
            validUntil
          });
        }

        return {
          fileName: fileName || 'Документ',
          fileId,
          fio,
          poaNumber,
          issueDate,
          validUntil,
          score: result.score
        };
      })
    );

    // Форматируем список документов
    const formattedResults = enrichedDocuments.map((doc, i) => {
      // ВАЖНО: Ссылка генерируется только если есть file_id
      const downloadLink = `/api/download?file_id=${doc.fileId}&filename=${encodeURIComponent(doc.fileName)}`;

      return `[${i + 1}] Файл: ${doc.fileName} | ФИО: ${doc.fio} | Номер: ${doc.poaNumber} | Дата выдачи: ${doc.issueDate} | Действует до: ${doc.validUntil} | file_id: ${doc.fileId} | Ссылка: ${downloadLink}`;
    }).join('\n');

    // Логируем первые 3 документа
    console.log('=== FORMATTED DOCUMENTS PREVIEW ===');
    console.log(formattedResults.split('\n').slice(0, 3).join('\n'));
    console.log('=== END PREVIEW ===');

    const summary = `\n\nВСЕГО ДОКУМЕНТОВ В БАЗЕ: ${enrichedDocuments.length}`;
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

    // Форматируем результаты
    const formattedResults = enrichedDocuments.map((doc, i) => {
      const downloadLink = doc.fileId
        ? `/api/download?file_id=${doc.fileId}&filename=${encodeURIComponent(doc.fileName)}`
        : '';

      return `[${i + 1}] Файл: ${doc.fileName} | ФИО: ${doc.fio} | Номер: ${doc.poaNumber} | Дата выдачи: ${doc.issueDate} | Действует до: ${doc.validUntil} | file_id: ${doc.fileId || 'отсутствует'} | Ссылка: ${downloadLink}`;
    }).join('\n');

    const summary = `\n\nВСЕГО ДОКУМЕНТОВ В БАЗЕ: ${enrichedDocuments.length}`;
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

    // Анализируем запрос и определяем коллекцию
    const queryAnalysis = analyzeQuery(messages);

// Проверяем загруженные документы в первую очередь
    const isUploadedDocumentRequest = hasUploadedDocuments(messages);

    if (isUploadedDocumentRequest) {
      console.log('Using uploaded document mode - no collection search');

      // Для загруженных документов используем специальный промпт
      const systemPromptWithContext = uploadedDocumentSystemPrompt +
        '\n\nАнализируй документы из раздела [ЗАГРУЖЕННЫЕ ДОКУМЕНТЫ ДЛЯ АНАЛИЗА] в сообщении пользователя.';

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
          model: 'grok-3-fast',
          messages: [
            { role: 'system', content: systemPromptWithContext },
            ...apiMessages,
          ],
          stream: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('xAI API error:', errorText);
        return new Response(
          JSON.stringify({ error: 'xAI API error', details: errorText }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Используем общую трансформацию потока
      return createStreamResponse(response);
    }

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

      // Определяем, какие поля запросил пользователь
      const lastUserMessage = messages.filter((m: any) => m.role === 'user').pop()?.content || '';
      const { fields, instruction } = detectRequestedTableFields(lastUserMessage);
      console.log('Requested table fields:', fields);

      const collectionName = collectionConfig?.displayName || 'документов';
      contextSection = documentResults
        ? `\n\nПОЛНЫЙ СПИСОК ДОКУМЕНТОВ В БАЗЕ (${collectionName}):\n${documentResults}\n\nЭто ПОЛНЫЙ список всех документов в базе данных "${collectionName}". Пользователь просит информацию обо ВСЕХ документах - используй весь список для ответа.\n\nИНСТРУКЦИЯ ПО КОЛОНКАМ ТАБЛИЦЫ: ${instruction}\nДоступные колонки: № | Файл | ФИО | Номер | Дата выдачи | Действует до | Скачать\nЗапрошенные колонки: ${fields.join(' | ')}`
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

    return createStreamResponse(response);

  } catch (error) {
    console.error('Chat API error:', error);
    return new Response(
      JSON.stringify({ error: 'Request failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
