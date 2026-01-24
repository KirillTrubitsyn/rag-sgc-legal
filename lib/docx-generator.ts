/**
 * DOCX generator service for exporting AI responses
 * Стиль: Правовое заключение (корпоративный юридический документ)
 */
import {
  Document,
  Paragraph,
  TextRun,
  AlignmentType,
  Footer,
  PageNumber,
  convertInchesToTwip,
  HeadingLevel,
  BorderStyle,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  VerticalAlign,
  PageOrientation,
} from 'docx';
import { saveAs } from 'file-saver';
import { Packer } from 'docx';

// Константы для форматирования
const FONT_NAME = 'Times New Roman';
const FONT_SIZE_NORMAL = 22; // В half-points (11pt * 2)
const FONT_SIZE_TITLE = 28; // 14pt
const FONT_SIZE_HEADING = 24; // 12pt
const FONT_SIZE_SMALL = 18; // 9pt
const FONT_SIZE_FOOTER = 16; // 8pt

// Отступы в twips (1 inch = 1440 twips)
const MARGIN_LEFT = convertInchesToTwip(1.18); // ~3cm
const MARGIN_RIGHT = convertInchesToTwip(0.79); // ~2cm
const MARGIN_TOP = convertInchesToTwip(0.59); // ~1.5cm
const MARGIN_BOTTOM = convertInchesToTwip(0.98); // ~2.5cm
const FIRST_LINE_INDENT = convertInchesToTwip(0.49); // ~1.25cm

interface ExportOptions {
  question: string;
  answer: string;
  title?: string;
  createdAt?: Date;
}

/**
 * Загружает изображение как ArrayBuffer для вставки в документ
 */
async function loadImage(url: string): Promise<ArrayBuffer | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Очищает текст от дублирующихся заголовков и форматирования
 */
function cleanTextForDocx(text: string): string {
  // Убираем стандартные заголовки из текста (они добавляются отдельно)
  text = text.replace(/^[\s]*ПРАВОВОЕ ЗАКЛЮЧЕНИЕ[^\n]*\n?/gmi, '');
  text = text.replace(/^[\s]*РЕЗУЛЬТАТЫ ПОИСКА[^\n]*\n?/gmi, '');
  text = text.replace(/^[\s]*АНАЛИТИЧЕСКАЯ СПРАВКА[:\s]*/gmi, '');

  // Убираем подписи
  text = text.replace(/^Председатель\s+(юридического\s+)?консилиума.*$/gmi, '');
  text = text.replace(/^Дата составления заключения.*$/gmi, '');

  // Убираем секцию "Ссылки на документы" со всем содержимым
  // Формат: "Ссылки на документы" или "### Ссылки на документы" и всё до следующей секции
  text = text.replace(/^#{0,4}\s*Ссылки на документы[\s\S]*?(?=^#{1,4}\s+[А-ЯA-Z]|\n\n[А-ЯA-Z]|$)/gmi, '');

  // Убираем строки с URL ссылками на скачивание (— Этап N, ... — [Скачать](...))
  text = text.replace(/^[—―-]\s*.*?\[Скачать\]\([^)]+\).*$/gmi, '');

  // Убираем разделители
  text = text.replace(/^---+\s*$/gm, '');

  // Убираем markdown ссылки: [текст](url) -> текст
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Убираем HTML теги <br>, <br/>, <br />
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Убираем другие HTML теги
  text = text.replace(/<[^>]+>/g, '');

  // Убираем markdown bold маркеры **text** -> text
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');

  // Убираем markdown italic маркеры *text* -> text (но не списки)
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');

  // Убираем markdown код `text` -> text
  text = text.replace(/`([^`]+)`/g, '$1');

  // Убираем лишние переносы
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * Извлекает источники [N] из текста
 */
function extractSources(text: string): { cleanText: string; sources: string[] } {
  const sources: string[] = [];
  const sourcePattern = /\[(\d+)\]/g;

  // Находим уникальные номера источников
  const foundNumbers = new Set<string>();
  let match;
  while ((match = sourcePattern.exec(text)) !== null) {
    foundNumbers.add(match[1]);
  }

  // Убираем [N] из текста
  const cleanText = text
    .replace(/\s*\[\d+\](?:\[\d+\])*/g, '')
    .replace(/  +/g, ' ');

  // Генерируем placeholder для источников
  const sortedNumbers = Array.from(foundNumbers).sort((a, b) => parseInt(a) - parseInt(b));
  for (const num of sortedNumbers) {
    sources.push(`[${num}] Источник из результатов поиска`);
  }

  return { cleanText, sources };
}

/**
 * Определяет индексы столбцов для удаления (например, "Скачать")
 */
function getColumnsToRemove(headerCells: string[]): number[] {
  const columnsToRemove: number[] = [];
  const excludeHeaders = ['скачать', 'download', 'ссылка', 'link'];

  headerCells.forEach((cell, index) => {
    const cellLower = cell.toLowerCase().trim();
    if (excludeHeaders.some(header => cellLower.includes(header))) {
      columnsToRemove.push(index);
    }
  });

  return columnsToRemove;
}

/**
 * Удаляет указанные столбцы из строки таблицы
 */
function removeColumns(cells: string[], columnsToRemove: number[]): string[] {
  return cells.filter((_, index) => !columnsToRemove.includes(index));
}

/**
 * Парсит markdown таблицу и создаёт DOCX Table
 * Автоматически убирает столбец "Скачать" при экспорте
 */
function parseMarkdownTable(lines: string[], startIndex: number): { table: Table | null; endIndex: number; columnCount: number } {
  const tableLines: string[] = [];
  let i = startIndex;

  // Собираем все строки таблицы
  while (i < lines.length) {
    const line = lines[i].trim();
    // Строка таблицы должна начинаться и заканчиваться на |
    if (line.startsWith('|') && line.includes('|')) {
      tableLines.push(line);
      i++;
    } else if (tableLines.length > 0) {
      // Таблица закончилась
      break;
    } else {
      // Не таблица
      return { table: null, endIndex: startIndex, columnCount: 0 };
    }
  }

  if (tableLines.length < 2) {
    return { table: null, endIndex: startIndex, columnCount: 0 };
  }

  // Парсим строки таблицы
  const rows: string[][] = [];
  let columnsToRemove: number[] = [];

  for (const line of tableLines) {
    // Убираем первый и последний |
    const content = line.slice(1, -1);
    const cells = content.split('|').map(cell => cell.trim());

    // Пропускаем строку-разделитель (|---|---|)
    if (cells.every(cell => /^[-:]+$/.test(cell))) {
      continue;
    }

    // Для первой строки (заголовок) определяем столбцы для удаления
    if (rows.length === 0) {
      columnsToRemove = getColumnsToRemove(cells);
    }

    // Убираем столбцы со ссылками
    const filteredCells = removeColumns(cells, columnsToRemove);
    rows.push(filteredCells);
  }

  if (rows.length === 0) {
    return { table: null, endIndex: startIndex, columnCount: 0 };
  }

  const columnCount = rows[0]?.length || 0;

  // Создаём DOCX таблицу
  const tableRows: TableRow[] = rows.map((cells, rowIndex) => {
    const isHeaderRow = rowIndex === 0;

    return new TableRow({
      children: cells.map(cellText => {
        // Обрабатываем ссылки в ячейках: [текст](url) -> текст
        const cleanText = cellText.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

        return new TableCell({
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: cleanText,
                  bold: isHeaderRow,
                  font: FONT_NAME,
                  size: FONT_SIZE_NORMAL,
                }),
              ],
              alignment: AlignmentType.LEFT,
            }),
          ],
          verticalAlign: VerticalAlign.CENTER,
          shading: isHeaderRow ? {
            fill: 'F5F5F5', // Светло-серый фон для заголовка
          } : undefined,
        });
      }),
    });
  });

  const table = new Table({
    width: {
      size: 100,
      type: WidthType.PERCENTAGE,
    },
    rows: tableRows,
  });

  return { table, endIndex: i, columnCount };
}

/**
 * Результат парсинга текста с информацией о таблицах
 */
interface ParsedContent {
  elements: (Paragraph | Table)[];
  maxTableColumns: number;
}

/**
 * Парсит текст и создаёт массив параграфов
 * Возвращает также максимальное количество столбцов в таблицах
 */
function parseTextToParagraphs(text: string): ParsedContent {
  const elements: (Paragraph | Table)[] = [];
  const lines = text.split('\n');
  let currentParagraphText = '';
  let i = 0;
  let maxTableColumns = 0;

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();

    // Проверяем, начинается ли таблица
    if (stripped.startsWith('|') && stripped.includes('|')) {
      // Завершаем текущий параграф перед таблицей
      if (currentParagraphText) {
        elements.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }

      // Парсим таблицу
      const { table, endIndex, columnCount } = parseMarkdownTable(lines, i);
      if (table) {
        elements.push(table);
        // Отслеживаем максимальное количество столбцов
        if (columnCount > maxTableColumns) {
          maxTableColumns = columnCount;
        }
        i = endIndex;
        continue;
      }
    }

    if (!stripped) {
      // Пустая строка - завершаем текущий параграф
      if (currentParagraphText) {
        elements.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      i++;
      continue;
    }

    // Секционные заголовки с буквами (A., B., C.) - но не "C#" и подобные
    const letterSectionMatch = stripped.match(/^([A-ZА-Я])\.\s+([^#].*)$/);
    if (letterSectionMatch && stripped.length < 100 && !stripped.includes('#')) {
      if (currentParagraphText) {
        elements.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      elements.push(createHeadingParagraph(stripped, true));
      i++;
      continue;
    }

    // Нумерованные заголовки (1., 1.1., 2.)
    const sectionMatch = stripped.match(/^(\d+(?:\.\d+)?)\.\s+([А-ЯA-Z].*)$/);
    if (sectionMatch && stripped.length < 100) {
      if (currentParagraphText) {
        elements.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      const isSubsection = sectionMatch[1].includes('.');
      elements.push(createHeadingParagraph(stripped, !isSubsection));
      i++;
      continue;
    }

    // Markdown заголовки (##, ###, ####)
    if (stripped.startsWith('#### ')) {
      if (currentParagraphText) {
        elements.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      elements.push(createHeadingParagraph(stripped.slice(5), false));
      i++;
      continue;
    }
    if (stripped.startsWith('### ')) {
      if (currentParagraphText) {
        elements.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      elements.push(createHeadingParagraph(stripped.slice(4), false));
      i++;
      continue;
    }
    if (stripped.startsWith('## ')) {
      if (currentParagraphText) {
        elements.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      elements.push(createHeadingParagraph(stripped.slice(3), true));
      i++;
      continue;
    }
    if (stripped.startsWith('# ')) {
      if (currentParagraphText) {
        elements.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      elements.push(createHeadingParagraph(stripped.slice(2), true));
      i++;
      continue;
    }

    // Маркированные списки
    if (stripped.startsWith('- ') || stripped.startsWith('• ') || stripped.startsWith('* ')) {
      if (currentParagraphText) {
        elements.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      elements.push(createBulletParagraph(stripped.slice(2)));
      i++;
      continue;
    }

    // Цитаты (строки начинающиеся с ">")
    if (stripped.startsWith('> ') || stripped.startsWith('>')) {
      if (currentParagraphText) {
        elements.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      const quoteContent = stripped.replace(/^>\s*/, '');

      // Проверяем, является ли это строкой источника внутри blockquote
      if (quoteContent.startsWith('—') || quoteContent.startsWith('― ') || quoteContent.startsWith('- ')) {
        elements.push(createQuoteSourceParagraph(quoteContent));
        // Добавляем пустой параграф для разрыва между блоками цитат
        elements.push(new Paragraph({
          children: [],
          spacing: { before: 160, after: 160 },
        }));
      } else {
        elements.push(createQuoteParagraph(quoteContent));
      }
      i++;
      continue;
    }

    // Источник цитаты (строки начинающиеся с "—", "― ", или "«—")
    if (stripped.startsWith('—') || stripped.startsWith('― ') || stripped.startsWith('«—')) {
      if (currentParagraphText) {
        elements.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      elements.push(createQuoteSourceParagraph(stripped));
      // Добавляем пустой параграф БЕЗ линии для разрыва между блоками цитат
      elements.push(new Paragraph({
        children: [],
        spacing: { before: 160, after: 160 },
      }));
      i++;
      continue;
    }

    // Подзаголовки (короткие строки с заглавной буквы без точки в конце)
    if (
      stripped.length < 60 &&
      stripped[0].toUpperCase() === stripped[0] &&
      !stripped.endsWith('.') &&
      !stripped.endsWith(':') &&
      !stripped.match(/^\d/) &&
      !stripped.startsWith('-') &&
      !stripped.startsWith('•')
    ) {
      const words = stripped.split(' ');
      if (words.length <= 6 && words.slice(0, -1).every(w => !w.endsWith(','))) {
        if (currentParagraphText) {
          elements.push(createBodyParagraph(currentParagraphText));
          currentParagraphText = '';
        }
        elements.push(createHeadingParagraph(stripped, false));
        i++;
        continue;
      }
    }

    // Обычный текст
    if (currentParagraphText) {
      currentParagraphText += ' ' + stripped;
    } else {
      currentParagraphText = stripped;
    }
    i++;
  }

  // Добавляем последний параграф
  if (currentParagraphText) {
    elements.push(createBodyParagraph(currentParagraphText));
  }

  return { elements, maxTableColumns };
}

/**
 * Создаёт параграф заголовка
 */
function createHeadingParagraph(text: string, isMain: boolean): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: text,
        bold: true,
        font: FONT_NAME,
        size: isMain ? FONT_SIZE_HEADING : FONT_SIZE_NORMAL,
      }),
    ],
    spacing: {
      before: isMain ? 200 : 120,
      after: isMain ? 80 : 40,
    },
  });
}

/**
 * Создаёт параграф основного текста
 */
function createBodyParagraph(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: text,
        font: FONT_NAME,
        size: FONT_SIZE_NORMAL,
      }),
    ],
    alignment: AlignmentType.JUSTIFIED,
    indent: {
      firstLine: FIRST_LINE_INDENT,
    },
    spacing: {
      after: 120,
      line: 276, // 1.15 line spacing
    },
  });
}

/**
 * Создаёт параграф маркированного списка
 */
function createBulletParagraph(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: '• ' + text,
        font: FONT_NAME,
        size: FONT_SIZE_NORMAL,
      }),
    ],
    alignment: AlignmentType.JUSTIFIED,
    indent: {
      left: convertInchesToTwip(0.28), // ~0.7cm
    },
    spacing: {
      before: 20,
      after: 20,
    },
  });
}

/**
 * Создаёт параграф цитаты с оранжевой линией слева (как на сайте)
 */
function createQuoteParagraph(text: string): Paragraph {
  // Убираем кавычки если они уже есть
  const cleanText = text.replace(/^[«"']|[»"']$/g, '').trim();

  return new Paragraph({
    children: [
      new TextRun({
        text: `«${cleanText}»`,
        font: FONT_NAME,
        size: FONT_SIZE_NORMAL,
        italics: true,
        color: '1e3a5f', // Тёмно-синий как на сайте
      }),
    ],
    alignment: AlignmentType.JUSTIFIED,
    indent: {
      left: convertInchesToTwip(0.15),
    },
    border: {
      left: {
        color: 'E87722', // Оранжевый цвет SGC
        style: BorderStyle.SINGLE,
        size: 18,
        space: 8,
      },
    },
    spacing: {
      before: 200,
      after: 40,
      line: 276,
    },
  });
}

/**
 * Создаёт параграф источника цитаты (серый текст с тире, С линией как у цитаты)
 */
function createQuoteSourceParagraph(text: string): Paragraph {
  // Убираем кавычки и тире если есть, добавляем своё тире
  const cleanSource = text
    .replace(/^[«"']\s*/, '') // Убираем открывающую кавычку
    .replace(/[»"']$/, '')    // Убираем закрывающую кавычку
    .replace(/^[—―-]\s*/, '') // Убираем тире
    .trim();

  return new Paragraph({
    children: [
      new TextRun({
        text: `— ${cleanSource}`,
        font: FONT_NAME,
        size: FONT_SIZE_SMALL,
        color: '888888', // Серый цвет
      }),
    ],
    indent: {
      left: convertInchesToTwip(0.15),
    },
    border: {
      left: {
        color: 'E87722', // Оранжевый цвет SGC - та же линия что у цитаты
        style: BorderStyle.SINGLE,
        size: 18,
        space: 8,
      },
    },
    spacing: {
      before: 0,
      after: 60,
    },
  });
}

/**
 * Создаёт секцию с источниками
 */
function createSourcesSection(sources: string[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  // Пустая строка перед секцией
  paragraphs.push(new Paragraph({ children: [] }));

  // Заголовок "Источники"
  paragraphs.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'Источники',
          bold: true,
          font: FONT_NAME,
          size: FONT_SIZE_NORMAL,
        }),
      ],
      spacing: {
        before: 160,
        after: 80,
      },
    })
  );

  // Список источников
  for (const source of sources) {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: source,
            font: FONT_NAME,
            size: FONT_SIZE_SMALL,
            italics: true,
          }),
        ],
        indent: {
          left: convertInchesToTwip(0.2),
        },
        spacing: {
          before: 20,
          after: 20,
        },
      })
    );
  }

  return paragraphs;
}

/**
 * Создаёт футер документа
 */
function createDocumentFooter(createdAt?: Date): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  // Пустая строка
  paragraphs.push(new Paragraph({ children: [] }));

  // Разделитель
  paragraphs.push(
    new Paragraph({
      children: [
        new TextRun({
          text: '─'.repeat(50),
          font: FONT_NAME,
          size: FONT_SIZE_FOOTER,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: {
        before: 80,
        after: 80,
      },
    })
  );

  // Дата
  const dateStr = (createdAt || new Date()).toLocaleDateString('ru-RU');
  paragraphs.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Дата: ${dateStr}`,
          font: FONT_NAME,
          size: FONT_SIZE_SMALL,
        }),
      ],
      alignment: AlignmentType.RIGHT,
      spacing: {
        after: 40,
      },
    })
  );

  return paragraphs;
}

/**
 * Создаёт заголовок документа с лого слева
 */
async function createTitleSection(title?: string): Promise<(Paragraph | Table)[]> {
  const elements: (Paragraph | Table)[] = [];

  // Загружаем лого
  const logoData = await loadImage('/icon-512.png');

  if (logoData) {
    // Таблица с лого слева и заголовком справа
    const headerTable = new Table({
      width: {
        size: 100,
        type: WidthType.PERCENTAGE,
      },
      rows: [
        new TableRow({
          children: [
            // Ячейка с лого
            new TableCell({
              width: {
                size: 15,
                type: WidthType.PERCENTAGE,
              },
              verticalAlign: VerticalAlign.CENTER,
              borders: {
                top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
              },
              children: [
                new Paragraph({
                  children: [
                    new ImageRun({
                      data: logoData,
                      transformation: {
                        width: 60,
                        height: 60,
                      },
                      type: 'png',
                    }),
                  ],
                  alignment: AlignmentType.LEFT,
                }),
              ],
            }),
            // Ячейка с заголовком
            new TableCell({
              width: {
                size: 85,
                type: WidthType.PERCENTAGE,
              },
              verticalAlign: VerticalAlign.CENTER,
              borders: {
                top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
              },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: title || 'РЕЗУЛЬТАТЫ ПОИСКА',
                      bold: true,
                      font: FONT_NAME,
                      size: FONT_SIZE_TITLE,
                    }),
                  ],
                  alignment: AlignmentType.LEFT,
                }),
              ],
            }),
          ],
        }),
      ],
    });

    // Отступ сверху
    elements.push(
      new Paragraph({
        children: [],
        spacing: { before: 100 },
      })
    );
    elements.push(headerTable);
  } else {
    // Без лого - просто заголовок с отступом сверху
    elements.push(
      new Paragraph({
        children: [
          new TextRun({
            text: title || 'РЕЗУЛЬТАТЫ ПОИСКА',
            bold: true,
            font: FONT_NAME,
            size: FONT_SIZE_TITLE,
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: {
          before: 100,
          after: 160,
        },
      })
    );
  }

  // Пустая строка после заголовка
  elements.push(
    new Paragraph({
      children: [],
      spacing: { after: 200 },
    })
  );

  return elements;
}

/**
 * Создаёт и экспортирует документ DOCX
 */
export async function exportToDocx(options: ExportOptions): Promise<void> {
  const { question, answer, title, createdAt } = options;

  // Очищаем текст
  const cleanAnswer = cleanTextForDocx(answer);

  // Извлекаем источники
  const { cleanText, sources } = extractSources(cleanAnswer);

  // Создаём заголовок с лого
  const titleElements = await createTitleSection(title);

  // Дополнительные параграфы для заголовка
  const titleParagraphs: Paragraph[] = [];

  // Добавляем вопрос, если он есть
  if (question) {
    titleParagraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: 'Вопрос: ',
            bold: true,
            font: FONT_NAME,
            size: FONT_SIZE_NORMAL,
          }),
          new TextRun({
            text: question,
            font: FONT_NAME,
            size: FONT_SIZE_NORMAL,
          }),
        ],
        spacing: {
          after: 200,
        },
      })
    );
  }

  // Парсим основной текст (может содержать таблицы)
  const { elements: contentElements, maxTableColumns } = parseTextToParagraphs(cleanText);

  // Создаём секцию источников (если есть)
  const sourcesParagraphs = sources.length > 0 ? createSourcesSection(sources) : [];

  // Создаём футер документа
  const footerParagraphs = createDocumentFooter(createdAt);

  // Собираем все элементы документа
  const allElements: (Paragraph | Table)[] = [
    ...titleElements,
    ...titleParagraphs,
    ...contentElements,
    ...sourcesParagraphs,
    ...footerParagraphs,
  ];

  // Определяем ориентацию страницы
  // Если таблица имеет 5+ столбцов - используем альбомную ориентацию
  const useLandscape = maxTableColumns >= 5;

  // Создаём документ
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: MARGIN_TOP,
              right: MARGIN_RIGHT,
              bottom: MARGIN_BOTTOM,
              left: MARGIN_LEFT,
            },
            // Альбомная ориентация для широких таблиц
            ...(useLandscape ? {
              size: {
                orientation: PageOrientation.LANDSCAPE,
              },
            } : {}),
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: 'Документ подготовлен SGC Legal Search',
                    font: FONT_NAME,
                    size: FONT_SIZE_FOOTER,
                    italics: true,
                  }),
                ],
                alignment: AlignmentType.LEFT,
              }),
            ],
          }),
        },
        children: allElements,
      },
    ],
  });

  // Генерируем файл
  const blob = await Packer.toBlob(doc);

  // Формируем имя файла
  const timestamp = new Date().toISOString().slice(0, 10);
  const filename = `sgc-legal-${timestamp}.docx`;

  // Скачиваем файл
  saveAs(blob, filename);
}

/**
 * Хелпер для скачивания blob (альтернативный метод)
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
