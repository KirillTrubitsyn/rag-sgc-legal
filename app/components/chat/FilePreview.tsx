'use client';

import { FileUploadResult, TYPE_ICONS } from '@/lib/file-types';
import { X } from 'lucide-react';

interface Props {
  file: FileUploadResult;
  onRemove: () => void;
}

export default function FilePreview({ file, onRemove }: Props) {
  const icon = TYPE_ICONS[file.file_type] || '📎';

  return (
    <div className="inline-flex items-center gap-2 bg-sgc-blue-700/20 rounded-lg px-3 py-1.5 text-sm border border-sgc-blue-500/20">
      <span className="text-lg">{icon}</span>
      <span className="text-sgc-blue-600 max-w-[200px] truncate font-medium">
        {file.filename}
      </span>
      <button
        onClick={onRemove}
        className="text-sgc-blue-400 hover:text-red-500 ml-1 transition-colors"
        title="Удалить файл"
        type="button"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
