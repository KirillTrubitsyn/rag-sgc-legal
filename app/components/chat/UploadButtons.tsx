'use client';

import { useState, useRef, useCallback } from 'react';
import { FileUploadResult, ACCEPTED_FILE_TYPES, MAX_FILE_SIZE, MAX_PHOTOS } from '@/lib/file-types';
import { Paperclip, Camera, Loader2, X } from 'lucide-react';

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

// === FILE BUTTON ===
interface FileButtonProps {
  onFileProcessed: (result: FileUploadResult) => void;
  disabled?: boolean;
}

export function FileButton({ onFileProcessed, disabled }: FileButtonProps) {
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (file: File) => {
    if (!file || disabled) return;

    if (file.size > MAX_FILE_SIZE) {
      alert('Файл слишком большой. Максимум: 25 МБ');
      return;
    }

    setIsUploading(true);
    try {
      const result = await uploadFile(file);
      onFileProcessed(result);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
        className="hidden"
        disabled={disabled || isUploading}
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled || isUploading}
        type="button"
        className="p-2 rounded-full text-sgc-blue-400 hover:text-sgc-orange-500 hover:bg-sgc-orange-500/10 transition-colors disabled:opacity-50"
        title="Загрузить документ"
      >
        {isUploading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <Paperclip className="w-5 h-5" />
        )}
      </button>
    </>
  );
}

// === CAMERA BUTTON ===
interface CameraButtonProps {
  onCapture: (file: File) => void;
  disabled?: boolean;
  maxPhotos?: number;
  currentPhotoCount?: number;
}

export function CameraButton({
  onCapture,
  disabled,
  maxPhotos = MAX_PHOTOS,
  currentPhotoCount = 0
}: CameraButtonProps) {
  const [showCamera, setShowCamera] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const isLimitReached = currentPhotoCount >= maxPhotos;

  const startCamera = useCallback(async () => {
    try {
      setError(null);
      setReady(false);
      if (stream) stream.getTracks().forEach(t => t.stop());

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      setStream(mediaStream);

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play()
            .then(() => setReady(true))
            .catch(() => setError('Не удалось запустить видео'));
        };
      }
    } catch {
      setError('Нет доступа к камере');
    }
  }, [facingMode, stream]);

  const stopCamera = useCallback(() => {
    stream?.getTracks().forEach(t => t.stop());
    setStream(null);
    setReady(false);
  }, [stream]);

  const openCamera = () => {
    if (isLimitReached) {
      alert(`Максимум ${maxPhotos} фото`);
      return;
    }
    setShowCamera(true);
    setTimeout(() => startCamera(), 100);
  };

  const closeCamera = () => {
    stopCamera();
    setShowCamera(false);
    setError(null);
  };

  const capture = () => {
    if (!videoRef.current || !canvasRef.current || !ready) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    canvas.toBlob((blob) => {
      if (blob) {
        onCapture(new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' }));
        closeCamera();
      }
    }, 'image/jpeg', 0.85);
  };

  const switchCam = () => {
    stopCamera();
    setFacingMode(f => f === 'environment' ? 'user' : 'environment');
    setTimeout(() => startCamera(), 100);
  };

  return (
    <>
      <button
        onClick={openCamera}
        disabled={disabled || isLimitReached}
        type="button"
        className="p-2 rounded-full text-sgc-blue-400 hover:text-sgc-orange-500 hover:bg-sgc-orange-500/10 transition-colors disabled:opacity-50 relative md:hidden"
        title="Сфотографировать документ"
      >
        <Camera className="w-5 h-5" />
        {currentPhotoCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-sgc-orange-500 text-white text-xs w-4 h-4 rounded-full flex items-center justify-center text-[10px]">
            {currentPhotoCount}
          </span>
        )}
      </button>

      {/* Модальное окно камеры */}
      {showCamera && (
        <div className="fixed inset-0 z-50 bg-black">
          {/* Header */}
          <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between p-4 pt-12 bg-gradient-to-b from-black/70 to-transparent">
            <button onClick={closeCamera} className="text-white p-2">
              <X className="w-6 h-6" />
            </button>
            <span className="text-white text-sm">
              {currentPhotoCount + 1} / {maxPhotos}
            </span>
            <button onClick={switchCam} className="text-white p-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
                <path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
                <polyline points="16 17 21 12 16 7" />
                <polyline points="8 7 3 12 8 17" />
              </svg>
            </button>
          </div>

          {/* Video или ошибка */}
          {error ? (
            <div className="absolute inset-0 flex items-center justify-center text-white text-center p-4">
              <div>
                <p className="mb-4">{error}</p>
                <button onClick={startCamera} className="px-4 py-2 bg-sgc-orange-500 rounded-lg">
                  Повторить
                </button>
              </div>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 w-full h-full object-cover"
              />
              {!ready && (
                <div className="absolute inset-0 flex items-center justify-center bg-black">
                  <Loader2 className="w-8 h-8 text-white animate-spin" />
                </div>
              )}
            </>
          )}

          {/* Кнопка съёмки */}
          <div
            className="absolute bottom-0 left-0 right-0 z-10 flex justify-center pb-8 pt-4 bg-gradient-to-t from-black/70 to-transparent"
            style={{ paddingBottom: 'calc(2rem + env(safe-area-inset-bottom, 0px))' }}
          >
            <button
              onClick={capture}
              disabled={!ready}
              className={`rounded-full border-4 border-white flex items-center justify-center shadow-lg ${
                !ready ? 'opacity-50' : 'active:scale-95'
              } transition-transform`}
              style={{ width: 72, height: 72 }}
            >
              <div className="rounded-full bg-white" style={{ width: 56, height: 56 }} />
            </button>
          </div>

          <canvas ref={canvasRef} className="hidden" />
        </div>
      )}
    </>
  );
}
