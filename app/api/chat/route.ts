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
    if (month) {
      const dateStr = `${day}.${month}.${year}`;
      if (!textDates.includes(dateStr)) {
        // Дата после города — скорее всего дата выдачи, добавляем в начало списка
        textDates.unshift(dateStr);
      }
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
        const year = match[3].length === 2 ? '20' + match[3] : match[3];

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
    const formattedResults = filteredDocuments.map((doc, i) => {
      const downloadLink = doc.fileId
        ? `/api/download?file_id=${doc.fileId}&filename=${encodeURIComponent(doc.fileName)}`
        : '';

      return `[${i + 1}] Файл: ${doc.fileName} | ФИО: ${doc.fio} | Номер: ${doc.poaNumber} | Дата выдачи: ${doc.issueDate} | Действует до: ${doc.validUntil} | file_id: ${doc.fileId || 'отсутствует'} | Ссылка: ${downloadLink}`;
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
    const formattedResults = filteredDocuments.map((doc, i) => {
      const downloadLink = doc.fileId
        ? `/api/download?file_id=${doc.fileId}&filename=${encodeURIComponent(doc.fileName)}`
        : '';

      return `[${i + 1}] Файл: ${doc.fileName} | ФИО: ${doc.fio} | Номер: ${doc.poaNumber} | Дата выдачи: ${doc.issueDate} | Действует до: ${doc.validUntil} | file_id: ${doc.fileId || 'отсутствует'} | Ссылка: ${downloadLink}`;
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
