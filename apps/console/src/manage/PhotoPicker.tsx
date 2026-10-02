import { PHOTO_MAX_BYTES, photoUrl } from '@rp/contracts';
import { Button } from '@rp/ui-web';
import { useRef, useState } from 'react';
import { useConsole } from '../app/console-context.js';
import { useT } from '../app/i18n.js';
import { messageOf } from '../app/messages.js';

/** Reads a chosen file as base64 without the `data:` prefix. */
export function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('The file could not be read'));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * A photo from the photo store (P1-04): a preview, upload or replace, and remove. Used for a
 * dish's photo (MENU-008) and the restaurant's logo (ONB-004). Failures go to `onError`, so the
 * dialog shows them where it shows its own.
 */
export function PhotoPicker({
  photoId,
  onChange,
  onUploading,
  onError,
  label,
  hint,
  alt,
  uploadLabel,
  replaceLabel,
  removeLabel,
  tooLarge,
}: {
  photoId: string | null;
  onChange: (photoId: string | null) => void;
  onUploading?: (uploading: boolean) => void;
  onError: (message: string | undefined) => void;
  label: string;
  hint: string;
  alt: string;
  uploadLabel: string;
  replaceLabel: string;
  removeLabel: string;
  tooLarge: string;
}) {
  const t = useT();
  const controller = useConsole();
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = (value: boolean) => {
    setUploading(value);
    onUploading?.(value);
  };

  const upload = async (file: File | undefined) => {
    if (file === undefined) return;
    onError(undefined);
    if (file.size > PHOTO_MAX_BYTES) {
      onError(tooLarge);
      return;
    }
    busy(true);
    try {
      const photo = await controller.api.uploadPhoto({
        body: { contentBase64: await base64Of(file) },
      });
      onChange(photo.id);
    } catch (failure) {
      onError(messageOf(failure, t));
    } finally {
      busy(false);
      if (fileInput.current !== null) fileInput.current.value = '';
    }
  };

  return (
    <div className="menu-photo">
      {photoId === null ? null : (
        <img
          className="menu-photo__preview"
          src={photoUrl(photoId, 160)}
          alt={alt}
          width={96}
          height={96}
        />
      )}
      <div className="menu-photo__actions">
        <span className="menu-photo__label">{label}</span>
        <span className="menu-photo__hint">{hint}</span>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="menu-photo__input"
          aria-label={uploadLabel}
          onChange={(event) => {
            void upload(event.target.files?.[0]);
          }}
        />
        <div className="staff-row__actions">
          <Button
            variant="secondary"
            loading={uploading}
            onClick={() => {
              fileInput.current?.click();
            }}
          >
            {photoId === null ? uploadLabel : replaceLabel}
          </Button>
          {photoId === null ? null : (
            <Button
              variant="ghost"
              onClick={() => {
                onChange(null);
              }}
            >
              {removeLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
