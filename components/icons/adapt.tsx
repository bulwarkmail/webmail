import { forwardRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { IconProps, TablerIcon } from '@tabler/icons-react';

// Tabler used numeric `stroke` for weight. Lucide follows SVG and uses
// `strokeWidth`; translate here rather than changing hundreds of callers.
export function adaptIcon(Glyph: LucideIcon, filled = false): TablerIcon {
  const Icon = forwardRef<SVGSVGElement, IconProps>(function MemailIcon(
    { stroke, strokeWidth, ...props }, ref,
  ) {
    return <Glyph ref={ref} fill={filled ? 'currentColor' : 'none'} {...props}
      stroke={typeof stroke === 'string' ? stroke : 'currentColor'}
      strokeWidth={strokeWidth ?? (typeof stroke === 'number' ? stroke : 1.75)} />;
  });
  Icon.displayName = `Memail${Glyph.displayName ?? 'Icon'}`;
  return Icon;
}
