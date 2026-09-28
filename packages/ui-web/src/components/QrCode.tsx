import { useMemo } from 'react';
import { encode } from 'uqr';
import { cx } from '../internal/cx.js';

export interface QrCodeProps {
  /** The text the code carries, e.g. an `otpauth://` link or a pairing code. */
  value: string;
  /** What the code is for, read by screen readers ("QR code to add the restaurant to…"). */
  label: string;
  /** Width and height in CSS pixels. */
  size?: number;
  className?: string;
}

/**
 * A QR code drawn as one SVG path, so it stays sharp at any size and prints cleanly (the Owner's
 * authenticator, AUTH-006; device pairing, AUTH-007). Always dark modules on white with the
 * standard four-module quiet zone, whatever the theme, because phone cameras read that best;
 * error correction M survives a scratched or glary screen. The value is encoded here, offline.
 */
export function QrCode({ value, label, size = 192, className }: QrCodeProps) {
  const { modules, path } = useMemo(() => {
    const code = encode(value, { ecc: 'M', border: 4 });
    let drawn = '';
    code.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) drawn += `M${String(x)} ${String(y)}h1v1h-1z`;
      });
    });
    return { modules: code.size, path: drawn };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      className={cx('rp-qr', className)}
      viewBox={`0 0 ${String(modules)} ${String(modules)}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      data-modules={modules}
    >
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
