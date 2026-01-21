'use client';

import { useState } from 'react';
import { useChat } from 'ai/react';
import { Send, FileText, AlertCircle, RotateCcw, ChevronDown, ChevronUp, Link2, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import { parseAssistantResponse, hasStructuredFormat, type ParsedResponse, type QuoteItem } from '@/lib/response-parser';
import { exportToDocx } from '@/lib/docx-generator';

// Компонент для отображения блока "Ответ по существу"
function SummaryBlock({ text }: { text: string }) {
  if (!text) return null;

  return (
    <div className="mb-4">
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="my-2 text-sgc-blue-500">{children}</p>,
          strong: ({ children }) => <strong className="font-bold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
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
        </div>
      </div>
    </div>
  );
}

// Компонент структурированного ответа
function StructuredResponse({ content }: { content: string }) {
  const parsed = parseAssistantResponse(content);
  const isStructured = hasStructuredFormat(content);

  // Если ответ не структурирован — показываем как обычный markdown
  if (!isStructured) {
    return (
      <ReactMarkdown
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
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-sgc-orange-500/50 pl-3 my-2 italic text-sgc-blue-500/80">
              {children}
            </blockquote>
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
      <SummaryBlock text={parsed.summary} />
      <CollapsibleDocumentsBlock quotes={allQuotes} />
    </div>
  );
}

export default function ChatInterface() {
  const { messages, input, handleInputChange, handleSubmit, isLoading, error, setMessages, setInput } = useChat({
    api: '/api/chat',
  });
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const handleNewQuery = () => {
    setMessages([]);
    setInput('');
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

  return (
    <div className="flex flex-col h-screen bg-[#f8fafc]">
      {/* Header with SGC Gradient - compact on mobile */}
      <header className="sgc-header px-3 py-2 sm:px-6 sm:py-4 shadow-lg">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="w-10 h-10 sm:w-16 sm:h-16 flex items-center justify-center flex-shrink-0">
              <img src="/icon-512.png" alt="СГК" className="w-10 h-10 sm:w-16 sm:h-16 object-contain" />
            </div>
            <div className="flex flex-col">
              <span className="text-base sm:text-xl font-bold"><span className="text-sgc-orange-500">SGC</span> <span className="text-white">Legal</span></span>
              <span className="text-base sm:text-xl font-bold text-white">Search</span>
            </div>
            <div className="hidden sm:block h-12 w-px bg-white/30 mx-2"></div>
            <div className="hidden sm:block">
              <h1 className="text-xl font-semibold text-white">Юридическая служба СГК</h1>
              <p className="text-sm text-white/50">Поиск по внутренним документам</p>
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
              <h2 className="text-2xl font-semibold text-sgc-blue-500 mb-3">
                Юридическая служба СГК
              </h2>
              <p className="text-sgc-blue-500/60 max-w-md mb-2">
                Система поиска по внутренним нормативным документам, стандартам и регламентам
                Юридической службы СГК.
              </p>
              <p className="text-sgc-blue-500/50 text-sm max-w-md">
                Задайте вопрос, и система найдёт релевантную информацию в базе документов.
              </p>

              {/* Quick suggestions */}
              <div className="mt-8 flex flex-wrap justify-center gap-2">
                {[
                  'Порядок подготовки претензий',
                  'Предъявление исков',
                  'Регламент работы юристов',
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="px-4 py-2 rounded-full bg-sgc-orange-500 text-white text-sm hover:bg-sgc-orange-600 transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
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
                      <span className="whitespace-pre-wrap text-white">{message.content}</span>
                    ) : (
                      <StructuredResponse content={message.content} />
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

      {/* Input Form */}
      <div className="bg-white border-t border-slate-200 px-4 py-4 sm:px-6 shadow-[0_-4px_20px_rgba(0,0,0,0.05)]">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto">
          <div className="flex gap-3">
            <input
              type="text"
              value={input}
              onChange={handleInputChange}
              placeholder="Задайте вопрос о документах..."
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
              disabled={isLoading || !input.trim()}
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
    </div>
  );
}
