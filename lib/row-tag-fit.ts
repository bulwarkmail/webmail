import type { TagBadgeVariant } from '@/components/email/tag-badge';

export interface RowTagSize {
  named: number;
  /** Enough label space for a character and ellipsis, plus the badge's padding/border. */
  minimumNamed: number;
  compact: number;
}

/** All dimensions come from the constrained lane and independent tag samples. */
export function fitRowTags(
  available: number,
  textWidth: number,
  sizes: RowTagSize[],
  gap: number,
  variant: TagBadgeVariant,
) {
  const budget = Math.max(0, Math.floor(available));
  const compact = sizes.reduce((sum, size) => sum + size.compact, 0)
    + gap * Math.max(0, sizes.length - 1);
  // Text gets the remainder, never the space needed for compact tags. In
  // particular, a sender's natural width is only a capped preference here.
  const tagBudget = budget - Math.min(textWidth, Math.max(0, budget - compact));
  const items: { width: number; variant: TagBadgeVariant }[] = [];
  let width = 0;
  for (const size of sizes) {
    const next = width + (items.length ? gap : 0) + size.compact;
    if (next > tagBudget) break; // Never crop a compact indicator at the edge.
    items.push({ width: size.compact, variant: 'dot' });
    width = next;
  }
  if (variant === 'badge') {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const expanded = Math.min(sizes[index].named, item.width + tagBudget - width);
      if (expanded < sizes[index].minimumNamed) break;
      width += expanded - item.width;
      item.width = expanded;
      item.variant = 'badge';
    }
  }
  return { items, width };
}
