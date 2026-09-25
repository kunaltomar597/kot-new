import { accentVariables, isHexColor, type ThemeName } from '@rp/design-tokens';
import type { CSSProperties, HTMLAttributes } from 'react';
import { cx } from '../internal/cx.js';

export interface ThemeRootProps extends HTMLAttributes<HTMLDivElement> {
  /** Light, dark or KDS dark (NFR-U02, KDS-011). Omit to follow the operating system. */
  theme?: ThemeName;
  /**
   * Restaurant accent colour as `#rrggbb`, applied to accent surfaces (NFR-U02). An invalid value
   * (bad branding data) is ignored and the theme's default accent is used, rather than breaking
   * the screen.
   */
  accent?: string;
}

/**
 * Applies a theme (and optionally the restaurant accent) to everything inside it. Themes nest, so
 * a dark KDS panel can sit inside a light dashboard.
 */
export function ThemeRoot({ theme, accent, className, style, children, ...rest }: ThemeRootProps) {
  const accentStyle =
    accent && isHexColor(accent) ? (accentVariables(accent) as CSSProperties) : undefined;
  return (
    <div
      {...rest}
      data-theme={theme}
      className={cx('rp-theme', className)}
      style={accentStyle || style ? { ...accentStyle, ...style } : undefined}
    >
      {children}
    </div>
  );
}
