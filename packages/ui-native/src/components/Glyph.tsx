import { type StyleProp, Text, type TextStyle } from 'react-native';
import { GLYPHS, type GlyphName } from '../glyphs.js';

export interface GlyphProps {
  name: GlyphName;
  color: string;
  size?: number;
  style?: StyleProp<TextStyle>;
}

/** A decorative symbol, hidden from screen readers (the words next to it carry the meaning). */
export function Glyph({ name, color, size = 16, style }: GlyphProps) {
  return (
    <Text
      accessible={false}
      importantForAccessibility="no"
      aria-hidden
      style={[{ color, fontSize: size, lineHeight: size * 1.2 }, style]}
    >
      {GLYPHS[name]}
    </Text>
  );
}
