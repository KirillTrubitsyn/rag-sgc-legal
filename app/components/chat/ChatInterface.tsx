'use client';

import { useChat } from 'ai/react';
import { Send, Loader2, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function ChatInterface() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
  });

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-4 sm:px-6">
        <h1 className="text-xl font-semibold text-gray-900">RAG SGC Legal</h1>
        <p className="text-sm text-gray-600 mt-1">
          Поиск по нормативным документам и стандартам СГК с использованием Grok Collections
        </p>
      </header>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 bg-gray-50">
        <div className="max-w-4xl mx-auto space-y-4">
          {messages.length === 0 ? (
            // Empty State
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <FileText className="w-12 h-12 text-gray-300 mb-4" />
              <h2 className="text-xl font-medium text-gray-900 mb-2">Начните диалог</h2>
              <p className="text-gray-600">
                Задайте вопрос о документах в вашей коллекции
              </p>
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
                    'max-w-[80%] sm:max-w-[70%] px-4 py-3 rounded-lg',
                    message.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-white border border-gray-200 text-gray-900'
                  )}
                >
                  {/* Message Content */}
                  <div className="whitespace-pre-wrap break-words">
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
                              <div key={toolInvocation.toolCallId} className="mt-3">
                                <div className="text-sm font-medium mb-2 text-gray-700">
                                  📚 Найденные документы:
                                </div>
                                <div className="space-y-2">
                                  {result.results.map((doc, idx) => (
                                    <div
                                      key={idx}
                                      className="bg-gray-50 border border-gray-200 rounded-md p-3 text-sm"
                                    >
                                      <div className="flex items-start justify-between gap-2 mb-1">
                                        <span className="font-medium text-gray-900">
                                          {doc.source}
                                        </span>
                                        {doc.page && (
                                          <span className="text-xs text-gray-500 whitespace-nowrap">
                                            стр. {doc.page}
                                          </span>
                                        )}
                                      </div>
                                      {doc.score !== undefined && (
                                        <div className="text-xs text-gray-500 mb-2">
                                          Релевантность: {(doc.score * 100).toFixed(1)}%
                                        </div>
                                      )}
                                      <div className="text-gray-700 line-clamp-3">
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
              <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
                <Loader2 className="w-5 h-5 text-gray-600 animate-spin" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input Form */}
      <div className="bg-white border-t border-gray-200 px-4 py-4 sm:px-6">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto">
          <div className="flex gap-3">
            <input
              type="text"
              value={input}
              onChange={handleInputChange}
              placeholder="Задайте вопрос о документах..."
              disabled={isLoading}
              className={cn(
                'flex-1 rounded-lg border border-gray-300 px-4 py-2.5',
                'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
                'disabled:bg-gray-100 disabled:cursor-not-allowed',
                'text-gray-900 placeholder-gray-500'
              )}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className={cn(
                'inline-flex items-center justify-center',
                'rounded-lg bg-blue-600 px-4 py-2.5',
                'text-white font-medium',
                'hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2',
                'disabled:bg-gray-300 disabled:cursor-not-allowed',
                'transition-colors'
              )}
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
