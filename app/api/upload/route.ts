import { getFileType, getImageMimeType, type FileUploadResult } from '@/lib/file-types';

export const runtime = 'edge';
export const maxDuration = 120;

const OCR_PROMPT = `Ты - OCR система. Твоя ЕДИНСТВЕННАЯ задача - ДОСЛОВНО переписать текст с изображения.

СТРОГИЕ ПРАВИЛА:
1. Пиши ТОЛЬКО тот текст, который РЕАЛЬНО ВИДИШЬ на изображении
2. ЗАПРЕЩЕНО придумывать, дополнять или интерпретировать
3. Если буква/цифра нечёткая - пиши [?]
4. Если слово неразборчиво - пиши [неразборчиво]
5. НИКАКИХ выдуманных названий организаций, ФИО, номеров, дат, реквизитов
6. Если не можешь прочитать текст - напиши "Не удалось распознать текст на изображении"

ФОРМАТ: Сохраняй структуру документа (абзацы, отступы). Не добавляй комментарии.

Начни транскрипцию:`;

// OCR через Gemini 3 Flash Preview (Google) - лучшая точность для документов
async function ocrWithGemini(
  base64Image: string,
  mimeType: string,
  apiKey: string
): Promise<string> {
  console.log('OCR with Gemini 3 Flash Preview, mime:', mimeType);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: mimeType,
                  data: base64Image,
                },
              },
              {
                text: OCR_PROMPT,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8192,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Gemini OCR failed:', response.status, errorText);
    throw new Error(`OCR failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const extractedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  console.log('Gemini OCR extracted text length:', extractedText.length);
  return extractedText;
}

// Анализ документа через Gemini (для PDF и сканов)
async function analyzeDocumentWithGemini(
  base64Data: string,
  mimeType: string,
  filename: string,
  apiKey: string
): Promise<string> {
  console.log('Analyzing document with Gemini:', filename, mimeType);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: mimeType,
                  data: base64Data,
                },
              },
              {
                text: `Документ: ${filename}\n\n${OCR_PROMPT}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8192,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Gemini document analysis failed:', response.status, errorText);
    throw new Error(`Document analysis failed: ${response.status}`);
  }

  const data = await response.json();
  const extractedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  console.log('Gemini document analysis text length:', extractedText.length);
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
      model: 'grok-4-1-fast',
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
    const googleApiKey = process.env.GOOGLE_API_KEY;
    const xaiApiKey = process.env.XAI_API_KEY;

    if (!googleApiKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'GOOGLE_API_KEY not configured for OCR' }),
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
      // Изображения - OCR через Gemini 3 Flash Preview
      mimeType = getImageMimeType(filename);
      extractedText = await ocrWithGemini(base64Data, mimeType, googleApiKey);
    } else if (fileType === 'pdf') {
      // PDF - анализ через Gemini 3 Flash Preview
      mimeType = 'application/pdf';
      extractedText = await analyzeDocumentWithGemini(base64Data, mimeType, filename, googleApiKey);
    } else if (fileType === 'text') {
      // Текстовые файлы - читаем напрямую
      const decoder = new TextDecoder('utf-8');
      extractedText = decoder.decode(arrayBuffer);
    } else if (fileType === 'document' || fileType === 'spreadsheet') {
      // Word/Excel документы - пытаемся анализировать через Gemini
      extractedText = await analyzeDocumentWithGemini(base64Data, mimeType, filename, googleApiKey);
    } else {
      // Неизвестный тип - пытаемся как текст
      try {
        const decoder = new TextDecoder('utf-8');
        extractedText = decoder.decode(arrayBuffer);
      } catch {
        extractedText = '[Не удалось извлечь текст из файла]';
      }
    }

    // Генерируем краткое описание (используем Grok если есть ключ, иначе простое описание)
    const summary = xaiApiKey
      ? await generateSummary(extractedText, filename, xaiApiKey)
      : `Загружен документ: ${filename}`;

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
