'use client';

import { useChat } from 'ai/react';
import { Send, FileText, Scale } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function ChatInterface() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
  });

  return (
    <div className="flex flex-col h-screen bg-[#f8fafc]">
      {/* Header with SGC Gradient */}
      <header className="sgc-header px-4 py-5 sm:px-6 shadow-lg">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center">
            <Scale className="w-6 h-6 text-sgc-orange-500" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white">RAG SGC Legal</h1>
            <p className="text-sm text-white/70">
              Поиск по нормативным документам СГК
            </p>
          </div>
        </div>
      </header>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="max-w-4xl mx-auto space-y-4">
          {messages.length === 0 ? (
            // Empty State
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-sgc-orange-500/10 to-sgc-orange-500/5 flex items-center justify-center mb-6">
                <FileText className="w-10 h-10 text-sgc-orange-500" />
              </div>
              <h2 className="text-2xl font-semibold text-sgc-blue-500 mb-3">
                Добро пожаловать
              </h2>
              <p className="text-sgc-blue-500/60 max-w-md">
                Задайте вопрос о нормативных документах и стандартах СГК.
                Система найдёт релевантную информацию в базе знаний.
              </p>

              {/* Quick suggestions */}
              <div className="mt-8 flex flex-wrap justify-center gap-2">
                {[
                  'Требования к безопасности',
                  'Стандарты качества',
                  'Правила эксплуатации',
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    className="px-4 py-2 rounded-full border border-sgc-orange-500/30 text-sgc-orange-500 text-sm hover:bg-sgc-orange-500/5 transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            // Messages
            messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  'flex',
                  message.role === 'user' ? 'justify-end' : 'justify-start'
                )}
              >
                <div
                  className={cn(
                    'max-w-[85%] sm:max-w-[75%] px-4 py-3 rounded-2xl',
                    message.role === 'user'
                      ? 'sgc-user-bubble'
                      : 'sgc-assistant-bubble text-sgc-blue-500'
                  )}
                >
                  {/* Message Content */}
                  <div className="whitespace-pre-wrap break-words leading-relaxed">
                    {message.content}
                  </div>

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
