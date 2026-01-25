'use client';

import { useState, useCallback } from 'react';
import { useChat } from 'ai/react';
import { Send, FileText, AlertCircle, RotateCcw, ChevronDown, ChevronUp, Link2, Download, Upload, Maximize2, Minimize2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseAssistantResponse, hasStructuredFormat, type ParsedResponse, type QuoteItem } from '@/lib/response-parser';
import { exportToDocx } from '@/lib/docx-generator';
import { FileUploadResult, PhotoItem, MAX_PHOTOS } from '@/lib/file-types';
import FilePreview from './FilePreview';
import PhotoPreview from './PhotoPreview';
import { FileButton, CameraButton, VoiceButton } from './UploadButtons';

// Компонент модального окна для полноэкранной таблицы
function FullscreenTableModal({
  isOpen,
  onClose,
  tableHtml
}: {
  isOpen: boolean;
  onClose: () => void;
  tableHtml: string;
}) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full h-full max-w-[95vw] max-h-[95vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-sgc-blue-200 bg-gradient-to-r from-sgc-blue-500 to-sgc-blue-600">
          <button
            onClick={onClose}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <Minimize2 className="w-5 h-5" />
            <span className="font-medium">Свернуть</span>
          </button>
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <Maximize2 className="w-5 h-5" />
            Таблица (альбомный вид)
          </h3>
          <button
            onClick={onClose}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Table content - rotated for landscape view */}
        <div className="flex-1 overflow-auto p-6">
          <div
            className="fullscreen-table-content"
            dangerouslySetInnerHTML={{ __html: tableHtml }}
          />
        </div>
      </div>
    </div>
  );
}

// Компонент для отображения блока "Ответ по существу"
function SummaryBlock({ text, onExpandTable }: { text: string; onExpandTable?: (tableHtml: string) => void }) {
  if (!text) return null;

  return (
    <div className="mb-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-lg font-bold text-sgc-blue-500 mt-4 mb-2">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-bold text-sgc-blue-500 mt-3 mb-2">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-bold text-sgc-blue-500 mt-2 mb-1">{children}</h3>,
          p: ({ children }) => <p className="my-2 text-sgc-blue-500">{children}</p>,
          ul: ({ children }) => <ul className="list-disc list-inside my-2 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside my-2 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="ml-2 text-sgc-blue-500">{children}</li>,
          strong: ({ children }) => <strong className="font-bold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          // Inline код
          code: ({ children }) => <code className="bg-slate-100 px-1 py-0.5 rounded text-sm text-sgc-blue-700">{children}</code>,
          // Многострочные блоки кода (pre) - светлый фон для читаемости текста документов
          pre: ({ children }) => (
            <pre className="bg-slate-50 border border-slate-200 rounded-lg p-4 my-3 overflow-x-auto text-sm text-sgc-blue-700 whitespace-pre-wrap break-words">
              {children}
            </pre>
          ),
          // Компонент для ссылок
          a: ({ href, children }) => {
            const isDownloadLink = href?.includes('/api/download');
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "inline-flex items-center gap-1 transition-colors",
                  isDownloadLink
                    ? "text-sgc-orange-600 hover:text-sgc-orange-700 underline decoration-sgc-orange-300"
                    : "text-sgc-blue-600 hover:text-sgc-blue-700 underline"
                )}
              >
                {isDownloadLink && <Download className="w-3.5 h-3.5" />}
                {children}
              </a>
            );
          },
          // Обработка изображений - преобразуем ![text](url) в ссылку если это URL скачивания
          img: ({ src, alt }) => {
            const srcStr = typeof src === 'string' ? src : '';
            // Если это ссылка на скачивание файла, отображаем как ссылку вместо изображения
            if (srcStr.includes('/api/download')) {
              return (
                <a
                  href={srcStr}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sgc-orange-600 hover:text-sgc-orange-700 underline decoration-sgc-orange-300 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  {alt || 'Скачать'}
                </a>
              );
            }
            // Для обычных изображений - стандартное отображение
            return <img src={srcStr} alt={alt} className="max-w-full h-auto" />;
          },
          // Компоненты для таблиц с кнопкой разворота на десктопе
          table: ({ children, node }) => {
            const tableRef = { current: null as HTMLTableElement | null };

            const handleExpand = () => {
              if (tableRef.current && onExpandTable) {
                onExpandTable(tableRef.current.outerHTML);
              }
            };

            return (
              <div className="my-4 relative group">
                {/* Кнопка разворота - только на десктопе */}
                {onExpandTable && (
                  <button
                    onClick={handleExpand}
                    className="hidden md:flex absolute -top-2 -right-2 z-10 items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-sgc-blue-500 text-white hover:bg-sgc-blue-600 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Развернуть таблицу на весь экран"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    Развернуть
                  </button>
                )}
                <div className="overflow-x-auto rounded-lg border border-sgc-blue-200 shadow-sm">
                  <table
                    ref={(el) => { tableRef.current = el; }}
                    className="min-w-full divide-y divide-sgc-blue-200"
                  >
                    {children}
                  </table>
                </div>
              </div>
            );
          },
          thead: ({ children }) => (
            <thead className="bg-sgc-orange-50">
              {children}
            </thead>
          ),
          tbody: ({ children }) => (
            <tbody className="bg-white divide-y divide-sgc-blue-100">
              {children}
            </tbody>
          ),
          tr: ({ children }) => (
            <tr className="hover:bg-sgc-blue-50/50 transition-colors">
              {children}
            </tr>
          ),
          th: ({ children }) => (
            <th className="px-4 py-3 text-left text-xs font-semibold text-sgc-blue-700 uppercase tracking-wider border-b-2 border-sgc-orange-300">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-4 py-3 text-sm text-sgc-blue-600 border-b border-sgc-blue-100">
              {children}
            </td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// Компонент сворачиваемого блока "Ссылки на документы" (объединяет ссылки и цитаты)
function CollapsibleDocumentsBlock({ quotes }: { quotes: QuoteItem[] }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!quotes || quotes.length === 0) return null;

  return (
    <div className="mt-4 rounded-lg overflow-hidden border border-sgc-blue-700/20">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 bg-sgc-blue-700/10 hover:bg-sgc-blue-700/15 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Link2 className="w-4 h-4 text-sgc-blue-700" />
          <span className="font-medium text-sgc-blue-700">Ссылки на документы ({quotes.length})</span>
        </div>
        {isOpen ? (
          <ChevronUp className="w-5 h-5 text-sgc-blue-700" />
        ) : (
          <ChevronDown className="w-5 h-5 text-sgc-blue-700" />
        )}
      </button>
      <div
        className={cn(
          'overflow-hidden transition-all duration-300 ease-in-out',
          isOpen ? 'max-h-[5000px] opacity-100' : 'max-h-0 opacity-0'
        )}
      >
        <div className="px-4 py-3 bg-sgc-blue-700/5 space-y-4">
          {quotes.map((quote, idx) => (
            <div key={idx} className="border-l-4 border-sgc-orange-500/50 pl-3">
              <p className="italic text-sgc-blue-500/90">«{quote.text}»</p>
              {quote.source && (
                <p className="text-xs text-sgc-blue-400 mt-1">— {quote.source}</p>
              )}
            </div>
          ))}

          {/* Блок со ссылками на скачивание уникальных источников */}
          {(() => {
            const uniqueSources = new Map<string, { source: string; downloadUrl: string }>();
            quotes.forEach(q => {
              if (q.downloadUrl && !uniqueSources.has(q.downloadUrl)) {
                uniqueSources.set(q.downloadUrl, { source: q.source, downloadUrl: q.downloadUrl });
              }
            });

            if (uniqueSources.size === 0) return null;

            return (
              <div className="pt-3 mt-3 border-t border-sgc-blue-700/10">
                <p className="text-xs text-sgc-blue-500 font-medium mb-2">Скачать источники:</p>
                <div className="flex flex-wrap gap-2">
                  {Array.from(uniqueSources.values()).map((item, idx) => (
                    <a
                      key={idx}
                      href={item.downloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-sgc-orange-500/10 text-sgc-orange-600 hover:bg-sgc-orange-500/20 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {item.source.length > 40 ? item.source.substring(0, 40) + '...' : item.source}
                    </a>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

// Компонент структурированного ответа
function StructuredResponse({ content, onExpandTable }: { content: string; onExpandTable?: (tableHtml: string) => void }) {
  const parsed = parseAssistantResponse(content);
  const isStructured = hasStructuredFormat(content);

  // Если ответ не структурирован — показываем как обычный markdown
  if (!isStructured) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-lg font-bold text-sgc-blue-500 mt-4 mb-2">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-bold text-sgc-blue-500 mt-3 mb-2">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-bold text-sgc-blue-500 mt-2 mb-1">{children}</h3>,
          p: ({ children }) => <p className="my-2">{children}</p>,
          ul: ({ children }) => <ul className="list-disc list-inside my-2 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside my-2 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="ml-2">{children}</li>,
          strong: ({ children }) => <strong className="font-bold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ children }) => <code className="bg-slate-100 px-1 py-0.5 rounded text-sm">{children}</code>,
          // Многострочные блоки кода (pre) - светлый фон для читаемости
          pre: ({ children }) => (
            <pre className="bg-slate-50 border border-slate-200 rounded-lg p-4 my-3 overflow-x-auto text-sm text-sgc-blue-700 whitespace-pre-wrap break-words">
              {children}
            </pre>
          ),
          // Компонент для ссылок
          a: ({ href, children }) => {
            const isDownloadLink = href?.includes('/api/download');
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "inline-flex items-center gap-1 transition-colors",
                  isDownloadLink
                    ? "text-sgc-orange-600 hover:text-sgc-orange-700 underline decoration-sgc-orange-300"
                    : "text-sgc-blue-600 hover:text-sgc-blue-700 underline"
                )}
              >
                {isDownloadLink && <Download className="w-3.5 h-3.5" />}
                {children}
              </a>
            );
          },
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-sgc-orange-500/50 pl-3 my-2 italic text-sgc-blue-500/80">
              {children}
            </blockquote>
          ),
          // Обработка изображений - преобразуем ![text](url) в ссылку если это URL скачивания
          img: ({ src, alt }) => {
            const srcStr = typeof src === 'string' ? src : '';
            // Если это ссылка на скачивание файла, отображаем как ссылку вместо изображения
            if (srcStr.includes('/api/download')) {
              return (
                <a
                  href={srcStr}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sgc-orange-600 hover:text-sgc-orange-700 underline decoration-sgc-orange-300 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  {alt || 'Скачать'}
                </a>
              );
            }
            // Для обычных изображений - стандартное отображение
            return <img src={srcStr} alt={alt} className="max-w-full h-auto" />;
          },
          // Компоненты для таблиц с кнопкой разворота
          table: ({ children }) => {
            const tableRef = { current: null as HTMLTableElement | null };

            const handleExpand = () => {
              if (tableRef.current && onExpandTable) {
                onExpandTable(tableRef.current.outerHTML);
              }
            };

            return (
              <div className="my-4 relative group">
                {onExpandTable && (
                  <button
                    onClick={handleExpand}
                    className="hidden md:flex absolute -top-2 -right-2 z-10 items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-sgc-blue-500 text-white hover:bg-sgc-blue-600 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Развернуть таблицу на весь экран"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    Развернуть
                  </button>
                )}
                <div className="overflow-x-auto rounded-lg border border-sgc-blue-200">
                  <table
                    ref={(el) => { tableRef.current = el; }}
                    className="min-w-full divide-y divide-sgc-blue-200"
                  >
                    {children}
                  </table>
                </div>
              </div>
            );
          },
          thead: ({ children }) => (
            <thead className="bg-sgc-blue-50">
              {children}
            </thead>
          ),
          tbody: ({ children }) => (
            <tbody className="bg-white divide-y divide-sgc-blue-100">
              {children}
            </tbody>
          ),
          tr: ({ children }) => (
            <tr className="hover:bg-sgc-blue-50/50 transition-colors">
              {children}
            </tr>
          ),
          th: ({ children }) => (
            <th className="px-4 py-3 text-left text-xs font-semibold text-sgc-blue-700 uppercase tracking-wider">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-4 py-3 text-sm text-sgc-blue-600">
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    );
  }

  // Структурированный ответ — показываем в визуальных блоках
  // Объединяем все цитаты (из legalBasis парсинга и из quotes) в один массив
  const allQuotes = [...parsed.quotes];

  return (
    <div>
      <SummaryBlock text={parsed.summary} onExpandTable={onExpandTable} />
      <CollapsibleDocumentsBlock quotes={allQuotes} />
    </div>
  );
}

// Функция загрузки файла на сервер
async function uploadFile(file: File): Promise<FileUploadResult> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch('/api/upload', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Ошибка загрузки файла');
  }

  return res.json();
}

export default function ChatInterface() {
  const { messages, input, handleInputChange, handleSubmit, isLoading, error, setMessages, setInput, append } = useChat({
    api: '/api/chat',
  });
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // Состояния для загруженных документов
  const [uploadedFiles, setUploadedFiles] = useState<FileUploadResult[]>([]);
  const [capturedPhotos, setCapturedPhotos] = useState<PhotoItem[]>([]);

  // Состояние для полноэкранной таблицы
  const [fullscreenTableHtml, setFullscreenTableHtml] = useState<string | null>(null);

  const handleNewQuery = () => {
    setMessages([]);
    setInput('');
    setUploadedFiles([]);
    setCapturedPhotos([]);
  };

  // Обработчик голосового ввода
  const handleVoiceTranscript = useCallback((text: string) => {
    // Добавляем текст к текущему input
    setInput(prev => prev ? prev + ' ' + text : text);
  }, [setInput]);

  // Обработчик загрузки файла
  const handleFileProcessed = useCallback((result: FileUploadResult) => {
    if (result.success) {
      setUploadedFiles(prev => [...prev, result]);
    }
  }, []);

  // Обработчик удаления файла
  const handleRemoveFile = useCallback((index: number) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Обработчик захвата фото с камеры
  const handlePhotoCapture = useCallback(async (file: File) => {
    // Добавляем фото в состояние с флагом обработки
    const preview = URL.createObjectURL(file);
    const newPhoto: PhotoItem = {
      file,
      preview,
      isProcessing: true,
    };

    setCapturedPhotos(prev => [...prev, newPhoto]);

    // Отправляем на OCR
    try {
      const result = await uploadFile(file);
      setCapturedPhotos(prev =>
        prev.map(p =>
          p.preview === preview
            ? { ...p, result, isProcessing: false }
            : p
        )
      );
    } catch (err) {
      setCapturedPhotos(prev =>
        prev.map(p =>
          p.preview === preview
            ? { ...p, error: err instanceof Error ? err.message : 'Ошибка распознавания', isProcessing: false }
            : p
        )
      );
    }
  }, []);

  // Обработчик удаления фото
  const handleRemovePhoto = useCallback((index: number) => {
    setCapturedPhotos(prev => {
      const photo = prev[index];
      if (photo?.preview) {
        URL.revokeObjectURL(photo.preview);
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  // Формирование контекста документов для отправки
  const getDocumentContext = useCallback(() => {
    const contexts: string[] = [];

    // Добавляем загруженные файлы
    uploadedFiles.forEach(file => {
      if (file.extracted_text) {
        contexts.push(`--- ЗАГРУЖЕННЫЙ ДОКУМЕНТ: ${file.filename} ---\n${file.extracted_text}\n--- КОНЕЦ ДОКУМЕНТА ---`);
      }
    });

    // Добавляем распознанные фото
    capturedPhotos.forEach((photo, idx) => {
      if (photo.result?.extracted_text) {
        contexts.push(`--- ФОТО ДОКУМЕНТА ${idx + 1} ---\n${photo.result.extracted_text}\n--- КОНЕЦ ФОТО ---`);
      }
    });

    return contexts.join('\n\n');
  }, [uploadedFiles, capturedPhotos]);

  // Кастомный обработчик отправки сообщения
  const handleCustomSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();

    const documentContext = getDocumentContext();
    const currentInput = input.trim();

    if (!currentInput && !documentContext) {
      return; // Ничего не отправляем если нет ни текста ни документов
    }

    if (documentContext) {
      // Если есть документы, добавляем их в начало сообщения
      const messageWithContext = `[ЗАГРУЖЕННЫЕ ДОКУМЕНТЫ ДЛЯ АНАЛИЗА]\n${documentContext}\n[КОНЕЦ ЗАГРУЖЕННЫХ ДОКУМЕНТОВ]\n\nВОПРОС ПОЛЬЗОВАТЕЛЯ: ${currentInput}`;

      // Очищаем загруженные файлы и input после отправки
      setUploadedFiles([]);
      setCapturedPhotos([]);
      setInput('');

      // Используем append для прямой отправки сообщения (без проблем с состоянием)
      append({
        role: 'user',
        content: messageWithContext,
      });
    } else {
      // Если нет документов, отправляем как обычно
      handleSubmit(e);
    }
  }, [input, getDocumentContext, handleSubmit, setInput, append]);

  // Проверяем, есть ли документы для отправки
  const hasDocuments = uploadedFiles.length > 0 || capturedPhotos.some(p => p.result);
  const isProcessingPhotos = capturedPhotos.some(p => p.isProcessing);

  // Функция для отображения сообщения пользователя (скрывает технический контекст загруженных документов)
  const getDisplayContent = (content: string): { text: string; hasDocuments: boolean } => {
    // Проверяем, содержит ли сообщение загруженные документы
    if (content.includes('[ЗАГРУЖЕННЫЕ ДОКУМЕНТЫ ДЛЯ АНАЛИЗА]')) {
      // Извлекаем вопрос пользователя после маркера
      const questionMatch = content.match(/ВОПРОС ПОЛЬЗОВАТЕЛЯ:\s*([\s\S]*?)$/);
      if (questionMatch) {
        return { text: questionMatch[1].trim(), hasDocuments: true };
      }
      // Fallback: если маркер есть, но формат другой
      return { text: 'Анализ загруженного документа', hasDocuments: true };
    }
    return { text: content, hasDocuments: false };
  };

  // Функция для получения вопроса пользователя для данного ответа ассистента
  const getQuestionForAssistant = (messageIndex: number): string => {
    // Ищем последнее сообщение пользователя перед этим ответом
    for (let i = messageIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        return messages[i].content;
      }
    }
    return '';
  };

  // Функция экспорта в DOCX
  const handleExportDocx = async (messageId: string, messageIndex: number, content: string) => {
    setDownloadingId(messageId);
    try {
      const question = getQuestionForAssistant(messageIndex);
      await exportToDocx({
        question,
        answer: content,
      });
    } catch (error) {
      console.error('Ошибка экспорта:', error);
      alert('Не удалось экспортировать документ');
    } finally {
      setDownloadingId(null);
    }
  };

  // Функция для открытия таблицы в полноэкранном режиме
  const handleExpandTable = useCallback((tableHtml: string) => {
    setFullscreenTableHtml(tableHtml);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-[#f8fafc]">
      {/* Модальное окно для полноэкранной таблицы */}
      <FullscreenTableModal
        isOpen={fullscreenTableHtml !== null}
        onClose={() => setFullscreenTableHtml(null)}
        tableHtml={fullscreenTableHtml || ''}
      />

      {/* Header with SGC Gradient - compact on mobile */}
      <header className="bg-gradient-to-r from-[#152840] via-[#1e3a5f] to-[#2a4a6f] px-3 py-[9px] sm:px-6 sm:py-2 shadow-lg">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-2">
          <div className="flex items-center min-w-0">
            <div className="h-[46px] sm:h-[72px] flex items-center justify-center flex-shrink-0">
              <img src="/sgc_search_horizontal_logo3.png" alt="SGC Legal Search" className="h-[46px] sm:h-[72px] object-contain" />
            </div>
          </div>
          {messages.length > 0 && (
            <button
              onClick={handleNewQuery}
              className="flex items-center gap-1.5 px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs sm:text-sm transition-colors flex-shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span>Новый</span>
            </button>
          )}
        </div>
      </header>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto px-2 py-4 sm:px-6 sm:py-6">
        <div className="max-w-4xl mx-auto space-y-4">
          {messages.length === 0 ? (
            // Empty State
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-sgc-orange-500/10 to-sgc-orange-500/5 flex items-center justify-center mb-6">
                <FileText className="w-10 h-10 text-sgc-orange-500" />
              </div>
              <h2 className="text-2xl font-semibold text-sgc-blue-500 mb-1">
                Юридическая служба
              </h2>
              <h3 className="text-xl font-medium text-sgc-blue-500 mb-3">
                Сибирской генерирующей компании
              </h3>
              <p className="text-sgc-blue-500/60 max-w-md mb-2">
                Система поиска по внутренним нормативным документам, стандартам и регламентам.
              </p>
              <p className="text-sgc-blue-500/50 text-sm max-w-md">
                Задайте вопрос, и система найдёт релевантную информацию в базе документов.
              </p>
              <div className="mt-6 flex items-center gap-2 text-sgc-blue-500/40 text-xs">
                <Upload className="w-4 h-4" />
                <span>Вы можете загрузить документ для анализа</span>
              </div>
            </div>
          ) : (
            // Messages
            messages.map((message, messageIndex) => (
              <div
                key={message.id}
                className={cn(
                  'flex',
                  message.role === 'user' ? 'justify-end' : 'justify-start'
                )}
              >
                <div
                  className={cn(
                    'px-3 sm:px-4 py-3 rounded-2xl',
                    message.role === 'user'
                      ? 'max-w-[85%] sm:max-w-[75%] sgc-user-bubble'
                      : 'w-full sm:max-w-[90%] sgc-assistant-bubble text-sgc-blue-500'
                  )}
                >
                  {/* Message Content with Markdown */}
                  <div className="prose prose-sm max-w-none break-words leading-relaxed prose-headings:font-bold prose-headings:text-sgc-blue-500 prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0">
                    {message.role === 'user' ? (
                      (() => {
                        const display = getDisplayContent(message.content);
                        return (
                          <div>
                            {display.hasDocuments && (
                              <div className="flex items-center gap-1.5 mb-2 text-white/80 text-xs">
                                <Upload className="w-3.5 h-3.5" />
                                <span>Загружен документ для анализа</span>
                              </div>
                            )}
                            <span className="whitespace-pre-wrap text-white">{display.text}</span>
                          </div>
                        );
                      })()
                    ) : (
                      <StructuredResponse content={message.content} onExpandTable={handleExpandTable} />
                    )}
                  </div>

                  {/* Export Button for Assistant Messages */}
                  {message.role === 'assistant' && message.content && !isLoading && (
                    <div className="mt-3 pt-3 border-t border-sgc-blue-700/10">
                      <button
                        onClick={() => handleExportDocx(message.id, messageIndex, message.content)}
                        disabled={downloadingId === message.id}
                        className={cn(
                          'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors',
                          'bg-sgc-orange-500/10 text-sgc-orange-600 hover:bg-sgc-orange-500/20',
                          'disabled:opacity-50 disabled:cursor-not-allowed'
                        )}
                      >
                        <Download className="w-4 h-4" />
                        {downloadingId === message.id ? 'Загрузка...' : 'Скачать .docx'}
                      </button>
                    </div>
                  )}

                  {/* Tool Invocations - Search Results */}
                  {message.toolInvocations && message.toolInvocations.length > 0 && (
                    <div className="mt-4 space-y-3">
                      {message.toolInvocations.map((toolInvocation) => {
                        if (
                          toolInvocation.state === 'result' &&
                          toolInvocation.toolName === 'collections_search'
                        ) {
                          const result = toolInvocation.result as {
                            results: Array<{
                              content: string;
                              source: string;
                              score?: number;
                              page?: number;
                            }>;
                          };

                          if (result.results && result.results.length > 0) {
                            return (
                              <div key={toolInvocation.toolCallId} className="mt-4">
                                <div className="flex items-center gap-2 text-sm font-medium mb-3 text-sgc-blue-500">
                                  <FileText className="w-4 h-4 text-sgc-orange-500" />
                                  Найденные документы:
                                </div>
                                <div className="space-y-2">
                                  {result.results.map((doc, idx) => (
                                    <div
                                      key={idx}
                                      className="sgc-doc-card rounded-lg p-3 text-sm"
                                    >
                                      <div className="flex items-start justify-between gap-2 mb-1">
                                        <span className="font-medium text-sgc-blue-500">
                                          {doc.source}
                                        </span>
                                        {doc.page && (
                                          <span className="text-xs text-sgc-blue-500/50 whitespace-nowrap bg-white/50 px-2 py-0.5 rounded">
                                            стр. {doc.page}
                                          </span>
                                        )}
                                      </div>
                                      {doc.score !== undefined && (
                                        <div className="text-xs text-sgc-orange-500 mb-2 flex items-center gap-1">
                                          <div className="w-16 h-1.5 bg-white/50 rounded-full overflow-hidden">
                                            <div
                                              className="h-full bg-sgc-orange-500 rounded-full"
                                              style={{ width: `${doc.score * 100}%` }}
                                            />
                                          </div>
                                          <span>{(doc.score * 100).toFixed(0)}%</span>
                                        </div>
                                      )}
                                      <div className="text-sgc-blue-500/80 line-clamp-3">
                                        {doc.content}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          }
                        }
                        return null;
                      })}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}

          {/* Loading State */}
          {isLoading && (
            <div className="flex justify-start">
              <div className="sgc-assistant-bubble rounded-2xl px-5 py-4 flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-sgc-orange-500 loading-dot" />
                <div className="w-2 h-2 rounded-full bg-sgc-orange-500 loading-dot" />
                <div className="w-2 h-2 rounded-full bg-sgc-orange-500 loading-dot" />
              </div>
            </div>
          )}

          {/* Error State */}
          {error && (
            <div className="flex justify-start">
              <div className="max-w-[85%] sm:max-w-[75%] px-4 py-3 rounded-2xl bg-red-50 border border-red-200">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-red-700 mb-1">Ошибка</div>
                    <div className="text-sm text-red-600">{error.message}</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input Form - Mobile: dark theme, Desktop: light theme */}
      <div className="bg-gradient-to-b from-[#0a1929] to-[#152840] sm:bg-white sm:bg-none border-t border-slate-700 sm:border-slate-200 px-4 py-4 sm:px-6 shadow-[0_-4px_20px_rgba(0,0,0,0.3)] sm:shadow-[0_-4px_20px_rgba(0,0,0,0.05)]">
        <div className="max-w-4xl mx-auto">
          {/* Превью загруженных файлов */}
          {uploadedFiles.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {uploadedFiles.map((file, idx) => (
                <FilePreview
                  key={`${file.filename}-${idx}`}
                  file={file}
                  onRemove={() => handleRemoveFile(idx)}
                />
              ))}
            </div>
          )}

          {/* Превью фото документов */}
          <PhotoPreview
            photos={capturedPhotos}
            onRemove={handleRemovePhoto}
            maxPhotos={MAX_PHOTOS}
          />

          {/* Индикатор наличия документов */}
          {hasDocuments && (
            <div className="mb-2 text-xs text-sgc-orange-400 sm:text-sgc-orange-500 flex items-center gap-1">
              <FileText className="w-3 h-3" />
              <span>Документы будут использованы для ответа на ваш вопрос</span>
            </div>
          )}

          <form onSubmit={handleCustomSubmit}>
            {/* Mobile Layout */}
            <div className="sm:hidden">
              {/* Поле ввода с кнопкой отправки */}
              <div className="flex items-center gap-3 mb-3">
                <input
                  type="text"
                  value={input}
                  onChange={handleInputChange}
                  placeholder={hasDocuments ? "Задайте вопрос..." : "Спросите что угодно..."}
                  disabled={isLoading}
                  className={cn(
                    'flex-1 rounded-2xl border-0 px-4 py-3.5',
                    'bg-[#1e3a5f]/80 backdrop-blur-sm',
                    'focus:outline-none focus:ring-2 focus:ring-sgc-orange-500/50',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    'text-white placeholder-slate-400',
                    'transition-all duration-200'
                  )}
                />
                <button
                  type="submit"
                  disabled={isLoading || isProcessingPhotos || (!input.trim() && !hasDocuments)}
                  className={cn(
                    'inline-flex items-center justify-center',
                    'w-12 h-12 rounded-full',
                    'bg-gradient-to-r from-sgc-orange-500 to-sgc-orange-600',
                    'text-white font-medium',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    'focus:outline-none focus:ring-2 focus:ring-sgc-orange-500 focus:ring-offset-2 focus:ring-offset-[#152840]',
                    'shadow-lg shadow-sgc-orange-500/30',
                    'transition-all duration-200 hover:scale-105 active:scale-95'
                  )}
                >
                  <Send className="w-5 h-5" />
                </button>
              </div>

              {/* Кнопки загрузки - под полем ввода */}
              <div className="flex items-center gap-4 pl-1">
                <FileButton
                  onFileProcessed={handleFileProcessed}
                  disabled={isLoading}
                  variant="dark"
                />
                <CameraButton
                  onCapture={handlePhotoCapture}
                  disabled={isLoading}
                  maxPhotos={MAX_PHOTOS}
                  currentPhotoCount={capturedPhotos.length}
                  variant="dark"
                />
                <VoiceButton
                  onTranscript={handleVoiceTranscript}
                  disabled={isLoading}
                  variant="dark"
                />
              </div>
            </div>

            {/* Desktop Layout */}
            <div className="hidden sm:flex gap-3 items-center">
              {/* Кнопки загрузки */}
              <div className="flex items-center gap-1">
                <FileButton
                  onFileProcessed={handleFileProcessed}
                  disabled={isLoading}
                />
                <CameraButton
                  onCapture={handlePhotoCapture}
                  disabled={isLoading}
                  maxPhotos={MAX_PHOTOS}
                  currentPhotoCount={capturedPhotos.length}
                />
                <VoiceButton
                  onTranscript={handleVoiceTranscript}
                  disabled={isLoading}
                />
              </div>

              <input
                type="text"
                value={input}
                onChange={handleInputChange}
                placeholder={hasDocuments ? "Задайте вопрос по загруженным документам..." : "Задайте вопрос о документах..."}
                disabled={isLoading}
                className={cn(
                  'flex-1 rounded-xl border border-slate-200 px-4 py-3',
                  'focus:outline-none sgc-input',
                  'disabled:bg-slate-50 disabled:cursor-not-allowed',
                  'text-sgc-blue-500 placeholder-slate-400',
                  'transition-all duration-200'
                )}
              />
              <button
                type="submit"
                disabled={isLoading || isProcessingPhotos || (!input.trim() && !hasDocuments)}
                className={cn(
                  'inline-flex items-center justify-center',
                  'rounded-xl px-5 py-3',
                  'text-white font-medium',
                  'sgc-btn-primary',
                  'focus:outline-none focus:ring-2 focus:ring-sgc-orange-500 focus:ring-offset-2'
                )}
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </form>
        </div>
        <p className="text-center text-xs text-slate-500 sm:text-sgc-blue-500/40 mt-3 sm:mt-2">
          Разработка @Кирилл Трубицын
        </p>
      </div>
    </div>
  );
}
