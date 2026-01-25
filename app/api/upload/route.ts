import { getFileType, getImageMimeType, type FileUploadResult } from '@/lib/file-types';

export const runtime = 'edge';
export const maxDuration = 120;

// OCR через Grok 4 Vision для точного распознавания текста
async function ocrWithGrok(
  base64Image: string,
  mimeType: string,
  apiKey: string
): Promise<string> {
  console.log('OCR with Grok Vision, mime:', mimeType);

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-4',  // Grok 4 с встроенной поддержкой vision
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
              },
            },
            {
              type: 'text',
              text: `Распознай текст с этого изображения документа.

КРИТИЧЕСКИ ВАЖНО - ТОЧНОСТЬ:
- Читай КАЖДУЮ букву и цифру ВНИМАТЕЛЬНО
- НЕ угадывай и НЕ додумывай - только то, что реально видишь
- Номера документов (КГ-24/34, №123 и т.п.) - переписывай ТОЧНО символ за символом
- ФИО - читай ОЧЕНЬ внимательно каждую букву фамилии, имени, отчества
- Даты - переписывай точно как написано (01.03.2024, первое марта и т.п.)
- Если символ неразборчив - пиши [?] вместо угадывания

ФОРМАТ ВЫВОДА:
- Сохраняй оригинальную структуру (абзацы, списки)
- Если есть печати/подписи - опиши кратко: [печать организации], [подпись]
- Не добавляй свои комментарии

Верни ТОЛЬКО распознанный текст.`,
            },
          ],
        },
      ],
      max_tokens: 8192,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Grok Vision OCR failed:', response.status, errorText);
    throw new Error(`OCR failed: ${response.status}`);
  }

  const data = await response.json();
  const extractedText = data.choices?.[0]?.message?.content || '';

  console.log('OCR extracted text length:', extractedText.length);
  return extractedText;
}

// Извлечение текста из PDF (через конвертацию в изображения на стороне клиента)
// В Edge runtime нет возможности работать с PDF напрямую,
// поэтому мы ожидаем, что PDF будет загружен как изображения страниц
// или отправлен целиком для анализа через vision

// Анализ документа через Grok (для PDF и сканов)
async function analyzeDocumentWithGrok(
  base64Data: string,
  mimeType: string,
  filename: string,
  apiKey: string
): Promise<string> {
  console.log('Analyzing document with Grok:', filename, mimeType);

  // Для PDF используем vision модель с base64 данными
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-4',  // Grok 4 с встроенной поддержкой vision
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Data}`,
              },
            },
            {
              type: 'text',
              text: `Извлеки текст из документа: ${filename}

КРИТИЧЕСКИ ВАЖНО - ТОЧНОСТЬ РАСПОЗНАВАНИЯ:
- Читай КАЖДУЮ букву и цифру ОЧЕНЬ ВНИМАТЕЛЬНО
- НЕ угадывай и НЕ додумывай - переписывай только то, что реально видишь
- Номера документов (КГ-24/34, №123) - переписывай ТОЧНО, символ за символом
- ФИО - читай внимательно каждую букву (Мифтахов ≠ Муратов, Сергей ≠ Софья)
- Даты - переписывай точно как написано
- Если символ неразборчив - пиши [?]

ФОРМАТ:
1. Сохраняй структуру (заголовки, абзацы, списки, таблицы)
2. Для таблиц используй текстовый формат
3. Печати/подписи: [печать], [подпись]
4. Тип документа укажи в начале

Верни ТОЛЬКО распознанный текст без своих комментариев.`,
            },
          ],
        },
      ],
      max_tokens: 8192,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Grok document analysis failed:', response.status, errorText);
    throw new Error(`Document analysis failed: ${response.status}`);
  }

  const data = await response.json();
  const extractedText = data.choices?.[0]?.message?.content || '';

  console.log('Document analysis text length:', extractedText.length);
  return extractedText;
}

// Генерация краткого описания документа
async function generateSummary(
  text: string,
  filename: string,
  apiKey: string
): Promise<string> {
  if (text.length < 100) {
    return `Загружен документ: ${filename}`;
  }

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-3-fast',
      messages: [
        {
          role: 'system',
          content: 'Ты - помощник для анализа документов. Создавай краткие описания документов на русском языке.',
        },
        {
          role: 'user',
          content: `Создай краткое описание (1-2 предложения) для этого документа.

Файл: ${filename}

Содержимое (первые 2000 символов):
${text.substring(0, 2000)}

Формат ответа: Загружен [тип документа]: [краткое описание содержания]`,
        },
      ],
      max_tokens: 150,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    return `Загружен документ: ${filename}`;
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || `Загружен документ: ${filename}`;
}

export async function POST(req: Request) {
  console.log('=== Upload API called ===');

  try {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'API key not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return new Response(
        JSON.stringify({ success: false, error: 'Файл не загружен' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log('File received:', file.name, 'size:', file.size, 'type:', file.type);

    // Проверка размера файла (25 MB max)
    if (file.size > 25 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ success: false, error: 'Файл слишком большой. Максимум: 25 МБ' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const filename = file.name;
    const fileType = getFileType(filename);
    const arrayBuffer = await file.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');

    let extractedText = '';
    let mimeType = file.type || 'application/octet-stream';

    // Обработка в зависимости от типа файла
    if (fileType === 'image') {
      // Изображения - OCR через Grok Vision
      mimeType = getImageMimeType(filename);
      extractedText = await ocrWithGrok(base64Data, mimeType, apiKey);
    } else if (fileType === 'pdf') {
      // PDF - анализ через Grok Vision
      mimeType = 'application/pdf';
      extractedText = await analyzeDocumentWithGrok(base64Data, mimeType, filename, apiKey);
    } else if (fileType === 'text') {
      // Текстовые файлы - читаем напрямую
      const decoder = new TextDecoder('utf-8');
      extractedText = decoder.decode(arrayBuffer);
    } else if (fileType === 'document' || fileType === 'spreadsheet') {
      // Word/Excel документы - пытаемся анализировать через vision
      // (для полноценной работы нужна библиотека извлечения текста)
      extractedText = await analyzeDocumentWithGrok(base64Data, mimeType, filename, apiKey);
    } else {
      // Неизвестный тип - пытаемся как текст
      try {
        const decoder = new TextDecoder('utf-8');
        extractedText = decoder.decode(arrayBuffer);
      } catch {
        extractedText = '[Не удалось извлечь текст из файла]';
      }
    }

    // Генерируем краткое описание
    const summary = await generateSummary(extractedText, filename, apiKey);

    const result: FileUploadResult = {
      success: true,
      file_type: fileType,
      extracted_text: extractedText,
      summary: summary,
      filename: filename,
    };

    console.log('Upload success:', filename, 'extracted text length:', extractedText.length);

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Upload API error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка обработки файла',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
