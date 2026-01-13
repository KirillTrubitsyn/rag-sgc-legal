import { ExternalLink } from 'lucide-react';

interface Citation {
    content: string;
    source: string;
    score?: number;
    page?: number;
}

interface CitationsProps {
    citations: Citation[];
}

export default function Citations({ citations }: CitationsProps) {
    if (!citations || citations.length === 0) {
          return null;
    }

  return (
        <div className="mt-4 space-y-2">
              <h4 className="text-sm font-medium text-gray-700 flex items-center gap-2">
                      <ExternalLink className="w-4 h-4" />
                      Источники ({citations.length})
              </h4>h4>
              <div className="space-y-2">
                {citations.map((citation, index) => (
                    <div
                                  key={index}
                                  className="bg-gray-50 border border-gray-200 rounded-md p-3 text-sm"
                                >
                                <div className="flex items-start justify-between gap-2 mb-1">
                                              <span className="font-medium text-gray-900">
                                                {citation.source}
                                              </span>span>
                                  {citation.page && (
                                                  <span className="text-xs text-gray-500 whitespace-nowrap">
                                                                    стр. {citation.page}
                                                  </span>span>
                                              )}
                                </div>div>
                      {citation.score !== undefined && (
                                                <div className="text-xs text-gray-500 mb-2">
                                                                Релевантность: {(citation.score * 100).toFixed(1)}%
                                                </div>div>
                                )}
                                <div className="text-gray-700 line-clamp-3">
                                  {citation.content}
                                </div>div>
                    </div>div>
                  ))}
              </div>div>
        </div>div>
      );
}</div>
