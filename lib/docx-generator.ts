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

  // Убираем разделители
  text = text.replace(/^---+\s*$/gm, '');

  // Убираем markdown bold маркеры
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');

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
 * Парсит текст и создаёт массив параграфов
 */
function parseTextToParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = text.split('\n');
  let currentParagraphText = '';

  for (const line of lines) {
    const stripped = line.trim();

    if (!stripped) {
      // Пустая строка - завершаем текущий параграф
      if (currentParagraphText) {
        paragraphs.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      continue;
    }

    // Секционные заголовки с буквами (A., B., C.) - но не "C#" и подобные
    const letterSectionMatch = stripped.match(/^([A-ZА-Я])\.\s+([^#].*)$/);
    if (letterSectionMatch && stripped.length < 100 && !stripped.includes('#')) {
      if (currentParagraphText) {
        paragraphs.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      paragraphs.push(createHeadingParagraph(stripped, true));
      continue;
    }

    // Нумерованные заголовки (1., 1.1., 2.)
    const sectionMatch = stripped.match(/^(\d+(?:\.\d+)?)\.\s+([А-ЯA-Z].*)$/);
    if (sectionMatch && stripped.length < 100) {
      if (currentParagraphText) {
        paragraphs.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      const isSubsection = sectionMatch[1].includes('.');
      paragraphs.push(createHeadingParagraph(stripped, !isSubsection));
      continue;
    }

    // Markdown заголовки (##, ###, ####)
    if (stripped.startsWith('#### ')) {
      if (currentParagraphText) {
        paragraphs.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      paragraphs.push(createHeadingParagraph(stripped.slice(5), false));
      continue;
    }
    if (stripped.startsWith('### ')) {
      if (currentParagraphText) {
        paragraphs.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      paragraphs.push(createHeadingParagraph(stripped.slice(4), false));
      continue;
    }
    if (stripped.startsWith('## ')) {
      if (currentParagraphText) {
        paragraphs.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      paragraphs.push(createHeadingParagraph(stripped.slice(3), true));
      continue;
    }
    if (stripped.startsWith('# ')) {
      if (currentParagraphText) {
        paragraphs.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      paragraphs.push(createHeadingParagraph(stripped.slice(2), true));
      continue;
    }

    // Маркированные списки
    if (stripped.startsWith('- ') || stripped.startsWith('• ') || stripped.startsWith('* ')) {
      if (currentParagraphText) {
        paragraphs.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      paragraphs.push(createBulletParagraph(stripped.slice(2)));
      continue;
    }

    // Цитаты (строки начинающиеся с ">")
    if (stripped.startsWith('> ') || stripped.startsWith('>')) {
      if (currentParagraphText) {
        paragraphs.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      const quoteText = stripped.replace(/^>\s*/, '');
      paragraphs.push(createQuoteParagraph(quoteText));
      continue;
    }

    // Источник цитаты (строки начинающиеся с "—", "― ", или "«—")
    if (stripped.startsWith('—') || stripped.startsWith('― ') || stripped.startsWith('«—')) {
      if (currentParagraphText) {
        paragraphs.push(createBodyParagraph(currentParagraphText));
        currentParagraphText = '';
      }
      paragraphs.push(createQuoteSourceParagraph(stripped));
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
          paragraphs.push(createBodyParagraph(currentParagraphText));
          currentParagraphText = '';
        }
        paragraphs.push(createHeadingParagraph(stripped, false));
        continue;
      }
    }

    // Обычный текст
    if (currentParagraphText) {
      currentParagraphText += ' ' + stripped;
    } else {
      currentParagraphText = stripped;
    }
  }

  // Добавляем последний параграф
  if (currentParagraphText) {
    paragraphs.push(createBodyParagraph(currentParagraphText));
  }

  return paragraphs;
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
      after: 360, // Большой отступ после для разделения блоков цитат (линия прерывается)
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

  // Парсим основной текст
  const contentParagraphs = parseTextToParagraphs(cleanText);

  // Создаём секцию источников (если есть)
  const sourcesParagraphs = sources.length > 0 ? createSourcesSection(sources) : [];

  // Создаём футер документа
  const footerParagraphs = createDocumentFooter(createdAt);

  // Собираем все элементы документа
  const allElements = [
    ...titleElements,
    ...titleParagraphs,
    ...contentParagraphs,
    ...sourcesParagraphs,
    ...footerParagraphs,
  ];

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
