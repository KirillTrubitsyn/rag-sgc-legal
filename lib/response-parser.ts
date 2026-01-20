/**
 * Утилита для парсинга и структурирования ответов LLM
 * Парсит ответ по маркерам: Ответ, Правовое обоснование, Цитаты
 */

export interface LegalBasisItem {
  norm: string;       // п. 5.2.1, ст. 10
  document: string;   // Название документа
  description: string; // Краткое содержание нормы
}

export interface QuoteItem {
  text: string;   // Текст цитаты
  source: string; // Источник: документ, пункт
}

export interface ParsedResponse {
  summary: string;
  legalBasis: LegalBasisItem[];
  quotes: QuoteItem[];
  raw: string; // Исходный текст для fallback
}

/**
 * Парсит ответ ассистента и разбивает на структурированные блоки
 */
export function parseAssistantResponse(text: string): ParsedResponse {
  const result: ParsedResponse = {
    summary: '',
    legalBasis: [],
    quotes: [],
    raw: text
  };

  if (!text || !text.trim()) {
    return result;
  }

  // Регулярки для поиска секций (поддерживаем ## и # и просто текст)
  const summaryRegex = /(?:^|\n)##?\s*(?:Ответ|ОТВЕТ|Ответ по существу|ОТВЕТ ПО СУЩЕСТВУ)\s*\n([\s\S]*?)(?=\n##?\s|$)/i;
  // Объединённый раздел "Ссылки на документы" теперь содержит и цитаты
  const legalBasisRegex = /(?:^|\n)##?\s*(?:Ссылки на документы|ССЫЛКИ НА ДОКУМЕНТЫ|Правовое обоснование|ПРАВОВОЕ ОБОСНОВАНИЕ)\s*\n([\s\S]*?)(?=\n##?\s|$)/i;
  // Старый раздел цитат для обратной совместимости
  const quotesRegex = /(?:^|\n)##?\s*(?:Цитаты|ЦИТАТЫ)\s*\n([\s\S]*?)(?=\n##?\s|$)/i;

  // Извлекаем секцию "Ответ"
  const summaryMatch = text.match(summaryRegex);
  if (summaryMatch) {
    result.summary = summaryMatch[1].trim();
  }

  // Извлекаем секцию "Ссылки на документы" (может содержать цитаты или список)
  const legalMatch = text.match(legalBasisRegex);
  if (legalMatch) {
    const legalText = legalMatch[1].trim();
    // Пробуем парсить как blockquote цитаты
    const blockquoteQuotes = parseBlockquotes(legalText);
    if (blockquoteQuotes.length > 0) {
      result.quotes = blockquoteQuotes;
    } else {
      // Если нет blockquote — парсим как список и конвертируем в quotes
      const listItems = parseLegalBasis(legalText);
      // Дедупликация: объединяем описания с одинаковым source
      const groupedBySource = new Map<string, string[]>();
      for (const item of listItems) {
        const source = `${item.norm}, ${item.document}`.replace(/, $/, '');
        if (!groupedBySource.has(source)) {
          groupedBySource.set(source, []);
        }
        groupedBySource.get(source)!.push(item.description);
      }
      result.quotes = Array.from(groupedBySource.entries()).map(([source, descriptions]) => ({
        text: descriptions.join('; '),
        source
      }));
    }
  }

  // Старый раздел "Цитаты" для обратной совместимости
  const quotesMatch = text.match(quotesRegex);
  if (quotesMatch) {
    const quotesText = quotesMatch[1].trim();
    const additionalQuotes = parseBlockquotes(quotesText);
    result.quotes = [...result.quotes, ...additionalQuotes];
  }

  // Fallback: если ни один маркер не найден — весь текст в summary
  if (!summaryMatch && !legalMatch && !quotesMatch) {
    result.summary = text.trim();
  }

  return result;
}

/**
 * Парсит список правовых оснований
 * Формат: - **п. X.X** (Документ) — описание
 */
function parseLegalBasis(text: string): LegalBasisItem[] {
  const items: LegalBasisItem[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Паттерн: - **п. X.X** (Документ) — описание
    // или: - п. X.X (Документ) — описание
    const match = trimmed.match(/^[-•]\s*\*{0,2}(п\.\s*[\d.]+|ст\.\s*[\d.]+|раздел\s*[\d.]+|пункт\s*[\d.]+)[^(]*\*{0,2}\s*\(([^)]+)\)\s*[-—–]\s*(.+)$/i);

    if (match) {
      items.push({
        norm: match[1].trim(),
        document: match[2].trim(),
        description: match[3].trim()
      });
    } else {
      // Попробуем более простой паттерн: - **норма** — описание (документ)
      const simpleMatch = trimmed.match(/^[-•]\s*\*{0,2}([^*—–]+)\*{0,2}\s*[-—–]\s*(.+)$/);
      if (simpleMatch) {
        // Проверяем, есть ли документ в скобках в конце
        const descWithDoc = simpleMatch[2].trim();
        const docMatch = descWithDoc.match(/^(.+?)\s*\(([^)]+)\)\s*$/);

        if (docMatch) {
          items.push({
            norm: simpleMatch[1].trim(),
            document: docMatch[2].trim(),
            description: docMatch[1].trim()
          });
        } else {
          items.push({
            norm: simpleMatch[1].trim(),
            document: '',
            description: simpleMatch[2].trim()
          });
        }
      }
    }
  }

  return items;
}

/**
 * Парсит цитаты в формате blockquote
 * Формат: > «текст цитаты»
 *         > — Источник: документ, пункт
 */
function parseBlockquotes(text: string): QuoteItem[] {
  const items: QuoteItem[] = [];
  const lines = text.split('\n');

  let currentQuote = '';
  let currentSource = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Строка цитаты начинается с > и содержит «
    if (line.startsWith('>')) {
      const content = line.slice(1).trim();

      // Проверяем, это источник или текст цитаты
      if (content.startsWith('—') || content.startsWith('-') || content.toLowerCase().startsWith('источник')) {
        // Это строка источника
        currentSource = content.replace(/^[-—–]\s*/, '').replace(/^источник:\s*/i, '').trim();

        // Если есть накопленная цитата — сохраняем
        if (currentQuote) {
          items.push({
            text: currentQuote,
            source: currentSource
          });
          currentQuote = '';
          currentSource = '';
        }
      } else {
        // Это текст цитаты
        if (currentQuote) {
          currentQuote += ' ' + content;
        } else {
          currentQuote = content;
        }
      }
    } else if (!line && currentQuote) {
      // Пустая строка — конец цитаты без источника
      items.push({
        text: currentQuote,
        source: currentSource
      });
      currentQuote = '';
      currentSource = '';
    }
  }

  // Не забываем последнюю цитату
  if (currentQuote) {
    items.push({
      text: currentQuote,
      source: currentSource
    });
  }

  // Очищаем кавычки из текста цитат
  return items.map(item => ({
    text: item.text.replace(/[«»"]/g, '').trim(),
    source: item.source
  }));
}

/**
 * Проверяет, содержит ли ответ структурированные секции
 */
export function hasStructuredFormat(text: string): boolean {
  const markers = [
    /##?\s*(?:Ответ|ОТВЕТ)/i,
    /##?\s*(?:Ссылки на документы|ССЫЛКИ НА ДОКУМЕНТЫ|Правовое обоснование|ПРАВОВОЕ ОБОСНОВАНИЕ)/i,
    /##?\s*(?:Цитаты|ЦИТАТЫ)/i
  ];

  return markers.some(regex => regex.test(text));
}
