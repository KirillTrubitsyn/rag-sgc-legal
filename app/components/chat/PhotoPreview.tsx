'use client';

import { useState, useEffect } from 'react';
import { PhotoItem, MAX_PHOTOS } from '@/lib/file-types';
import { X, Check, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';

interface Props {
  photos: PhotoItem[];
  onRemove: (index: number) => void;
  maxPhotos?: number;
}

export default function PhotoPreview({ photos, onRemove, maxPhotos = MAX_PHOTOS }: Props) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      photos.forEach(photo => {
        if (photo.preview) {
          URL.revokeObjectURL(photo.preview);
        }
      });
    };
  }, [photos]);

  if (photos.length === 0) {
    return null;
  }

  return (
    <div className="mb-3">
      {/* Заголовок с счётчиком */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-sgc-blue-500/60">
          Фото документов: {photos.length}/{maxPhotos}
        </span>
        {photos.some(p => p.isProcessing) && (
          <span className="text-xs text-sgc-orange-500 animate-pulse flex items-center gap-1">
            <Loader2 className="w-3 h-3 animate-spin" />
            Распознавание...
          </span>
        )}
      </div>

      {/* Сетка с превью фотографий */}
      <div className="flex gap-2 flex-wrap">
        {photos.map((photo, index) => (
          <div key={index} className="relative group">
            <button
              type="button"
              onClick={() => setSelectedIndex(index)}
              className={`w-16 h-16 rounded-lg overflow-hidden border-2 transition-all
                ${photo.error
                  ? 'border-red-500'
                  : photo.result
                    ? 'border-green-500'
                    : photo.isProcessing
                      ? 'border-sgc-orange-500 animate-pulse'
                      : 'border-sgc-blue-300'
                }`}
            >
              <img
                src={photo.preview}
                alt={`Фото ${index + 1}`}
                className="w-full h-full object-cover"
              />
            </button>

            {/* Индикатор обработки */}
            {photo.isProcessing && (
              <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-white animate-spin" />
              </div>
            )}

            {/* Индикатор успешной обработки */}
            {photo.result && !photo.isProcessing && (
              <div className="absolute -top-1 -right-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center">
                <Check className="w-3 h-3 text-white" />
              </div>
            )}

            {/* Индикатор ошибки */}
            {photo.error && (
              <div className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center">
                <X className="w-3 h-3 text-white" />
              </div>
            )}

            {/* Кнопка удаления */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(index);
              }}
              className="absolute -top-1 -left-1 w-5 h-5 bg-sgc-blue-700 hover:bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X className="w-3 h-3 text-white" />
            </button>

            {/* Номер фото */}
            <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs text-center py-0.5 rounded-b-lg">
              {index + 1}
            </div>
          </div>
        ))}
      </div>

      {/* Модальное окно для просмотра */}
      {selectedIndex !== null && photos[selectedIndex] && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setSelectedIndex(null)}
        >
          <div className="relative max-w-full max-h-full">
            <img
              src={photos[selectedIndex].preview}
              alt={`Фото ${selectedIndex + 1}`}
              className="max-w-full max-h-[80vh] object-contain rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />

            {/* Информация о фото */}
            <div className="absolute bottom-0 left-0 right-0 bg-black/70 p-3 rounded-b-lg">
              <div className="text-white text-sm">
                Фото {selectedIndex + 1} из {photos.length}
              </div>
              {photos[selectedIndex].result && (
                <div className="text-green-400 text-xs mt-1">
                  Текст распознан ({photos[selectedIndex].result?.extracted_text?.length ?? 0} символов)
                </div>
              )}
              {photos[selectedIndex].error && (
                <div className="text-red-400 text-xs mt-1">
                  Ошибка: {photos[selectedIndex].error}
                </div>
              )}
            </div>

            {/* Кнопка закрытия */}
            <button
              onClick={() => setSelectedIndex(null)}
              className="absolute top-2 right-2 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white"
            >
              <X className="w-6 h-6" />
            </button>

            {/* Навигация между фото */}
            {photos.length > 1 && (
              <>
                {selectedIndex > 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setSelectedIndex(selectedIndex - 1); }}
                    className="absolute left-2 top-1/2 -translate-y-1/2 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white"
                  >
                    <ChevronLeft className="w-6 h-6" />
                  </button>
                )}
                {selectedIndex < photos.length - 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setSelectedIndex(selectedIndex + 1); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white"
                  >
                    <ChevronRight className="w-6 h-6" />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
