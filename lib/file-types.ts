// Типы для работы с загрузкой файлов

export interface FileUploadResult {
  success: boolean;
  file_type: 'document' | 'pdf' | 'spreadsheet' | 'text' | 'image' | 'unknown';
  extracted_text: string;
  summary: string;
  filename: string;
  error?: string;
}

export interface PhotoItem {
  file: File;
  preview: string;
  result?: FileUploadResult;
  isProcessing?: boolean;
  error?: string;
}

export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
export const MAX_PHOTOS = 5;

export const ACCEPTED_FILE_TYPES = [
  // Документы
  '.docx', '.doc', '.pdf', '.txt', '.md', '.rtf',
  // Таблицы
  '.xlsx', '.xls', '.xlsm', '.csv',
  // Изображения
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic',
].join(',');

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic'];
export const DOCUMENT_EXTENSIONS = ['docx', 'doc', 'rtf'];
export const PDF_EXTENSIONS = ['pdf'];
export const SPREADSHEET_EXTENSIONS = ['xlsx', 'xls', 'xlsm', 'csv'];
export const TEXT_EXTENSIONS = ['txt', 'md'];

export function getFileType(filename: string): FileUploadResult['file_type'] {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (PDF_EXTENSIONS.includes(ext)) return 'pdf';
  if (DOCUMENT_EXTENSIONS.includes(ext)) return 'document';
  if (SPREADSHEET_EXTENSIONS.includes(ext)) return 'spreadsheet';
  if (TEXT_EXTENSIONS.includes(ext)) return 'text';

  return 'unknown';
}

export function getImageMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  const mimeTypes: Record<string, string> = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'bmp': 'image/bmp',
    'webp': 'image/webp',
    'heic': 'image/heic',
  };

  return mimeTypes[ext] || 'image/jpeg';
}

export const TYPE_ICONS: Record<string, string> = {
  document: '📄',
  pdf: '📕',
  spreadsheet: '📊',
  text: '📝',
  image: '🖼️',
  unknown: '📎',
};
