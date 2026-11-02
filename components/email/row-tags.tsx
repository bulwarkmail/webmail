"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { fitRowTags, type RowTagSize } from '@/lib/row-tag-fit';
import { useKeywordFormat } from '@/hooks/use-keyword-format';
import type { TagScope } from '@/hooks/use-account-tags';
import { useSettingsStore } from '@/stores/settings-store';
import { TagBadge, tagBadgeMarkup, TAG_GROUP_CLASS, type TagBadgeVariant } from './tag-badge';

/** Natural text width, independent of the current flex allocation. */
function textPreference(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const width = typeof range.getBoundingClientRect === 'function'
    ? range.getBoundingClientRect().width : element.scrollWidth;
  const maximum = parseFloat(getComputedStyle(element).maxWidth);
  return Number.isFinite(maximum) ? Math.min(width, maximum) : width;
}

/**
 * A bounded row tag group. Its parent is a flex lane: data-tag-text marks the
 * truncatable text, and data-tag-text="preview" yields without reserving space.
 * Other siblings and the optional leading controls keep their measured widths.
 */
export function RowTags({ tagIds, variant, scope, leading, className }: {
  tagIds: string[];
  variant: TagBadgeVariant;
  scope?: TagScope | null;
  leading?: ReactNode;
  className?: string;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const controls = useRef<HTMLSpanElement>(null);
  const named = useRef<HTMLSpanElement>(null);
  const compact = useRef<HTMLSpanElement>(null);
  const { tagName, tagColor } = useKeywordFormat(scope);
  const showColorNames = useSettingsStore(state => state.showColorNames);
  const [fit, setFit] = useState<ReturnType<typeof fitRowTags> & { total: number; height: number } | null>(null);
  const canMeasure = typeof ResizeObserver !== 'undefined';

  // Resolve account/settings once per row. The samples share the visible
  // badge's markup and CSS, but contain no TagBadge fibers, hooks or observers.
  const tagKey = JSON.stringify(tagIds);
  const samples = useMemo(() => (JSON.parse(tagKey) as string[]).map(id => ({
    key: id, name: tagName(id), label: tagName(id), color: tagColor(id),
  })), [tagKey, tagName, tagColor]);
  const sampleMarkup = useMemo(() => ({
    named: samples.map(sample => tagBadgeMarkup({ ...sample, variant: 'badge', showColorNames })),
    compact: samples.map(sample => tagBadgeMarkup({ ...sample, variant: 'dot', showColorNames })),
  }), [samples, showColorNames]);
  const hasTags = tagIds.length > 0;
  const inputs = useRef({ variant, showColorNames });
  const refresh = useRef<(() => void) | null>(null);
  const flushMutations = useRef<(() => void) | null>(null);

  // Content/settings changes require fresh measurements, not new subscriptions.
  // Fresh tagIds/scope/leading objects on an unrelated row render do not reset
  // the observers. Text and controls elsewhere in the lane are watched below.
  useLayoutEffect(() => {
    inputs.current = { variant, showColorNames };
    if (hasTags) refresh.current?.();
  }, [samples, variant, showColorNames, className, hasTags]);

  // React has already updated the lane's DOM at this point. Drain actual
  // content mutations before paint, rather than fitting them in a later
  // observer callback/commit. Unrelated renders have no records to measure.
  useLayoutEffect(() => { flushMutations.current?.(); });

  useLayoutEffect(() => {
    const group = root.current;
    const lane = group?.parentElement;
    if (!canMeasure || !hasTags || !group || !lane) return;
    const measure = () => {
      if (!named.current || !compact.current) return;
      const namedTags = Array.from(named.current.children) as HTMLElement[];
      const compactTags = Array.from(compact.current.children) as HTMLElement[];
      const { variant, showColorNames } = inputs.current;
      const siblings = Array.from(lane.children) as HTMLElement[];
      const gap = parseFloat(getComputedStyle(lane).columnGap) || 0;
      const tagGap = parseFloat(getComputedStyle(group).columnGap) || 0;
      const fixed = siblings.filter(child => child !== group && !child.hasAttribute('data-tag-text'));
      const groupStyle = getComputedStyle(group);
      const margins = (parseFloat(groupStyle.marginInlineStart) || 0) + (parseFloat(groupStyle.marginInlineEnd) || 0);
      const reserved = fixed.reduce((sum, child) => {
        const style = getComputedStyle(child);
        return sum + child.getBoundingClientRect().width
          + (parseFloat(style.marginInlineStart) || 0) + (parseFloat(style.marginInlineEnd) || 0);
      }, margins + gap * Math.max(0, siblings.length - 1));
      const leadingWidth = controls.current?.getBoundingClientRect().width || 0;
      const leadingGap = leadingWidth && namedTags.length ? tagGap : 0;
      const available = Math.max(0, lane.getBoundingClientRect().width - reserved);
      const textWidth = siblings.filter(child => child.getAttribute('data-tag-text') === '')
        .reduce((sum, child) => sum + textPreference(child), 0);
      const sizes: RowTagSize[] = namedTags.map((tag, index) => {
        const width = tag.getBoundingClientRect().width;
        const label = tag.querySelector<HTMLElement>('.truncate');
        const minimumNamed = label ? Math.min(width, width - label.getBoundingClientRect().width
          + 2 * (parseFloat(getComputedStyle(label).fontSize) || 0)) : width;
        return { named: width, minimumNamed, compact: showColorNames
          ? minimumNamed : compactTags[index].getBoundingClientRect().width };
      });
      if (sizes.some(size => size.compact <= 0)) return;
      // With colour names enabled the compact form is still a named badge;
      // let it expand too, and truncate its label inside a complete lozenge.
      const result = fitRowTags(available - leadingWidth - leadingGap, textWidth, sizes, tagGap,
        showColorNames ? 'badge' : variant);
      const heightSamples = variant === 'badge' ? namedTags : compactTags;
      const height = Math.max(controls.current?.getBoundingClientRect().height || 0,
        ...heightSamples.map(tag => tag.getBoundingClientRect().height));
      const next = { ...result, total: Math.min(available, leadingWidth + (result.items.length ? leadingGap + result.width : 0)), height };
      setFit(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const observer = new ResizeObserver(measure);
    const observed = new Set<Element>();
    const update = () => {
      const targets = new Set<Element>([lane, ...lane.children,
        ...Array.from(named.current?.children ?? []), ...Array.from(compact.current?.children ?? [])]);
      if (controls.current) targets.add(controls.current);
      for (const element of observed) if (!targets.has(element)) {
        observer.unobserve(element);
        observed.delete(element);
      }
      for (const element of targets) if (!observed.has(element)) {
        observer.observe(element);
        observed.add(element);
      }
      measure();
    };
    const handleMutations = (records: MutationRecord[]) => {
      // Ignore our own fit writes and visible badges' shortening updates.
      // Changes to controls, neighbouring text and ancestor styles do matter.
      if (records.some(record => !group.contains(record.target)
        || controls.current?.contains(record.target)
        || (record.type === 'childList' && record.target === group))) update();
    };
    const mutations = new MutationObserver(handleMutations);
    flushMutations.current = () => handleMutations(mutations.takeRecords());
    mutations.observe(lane, { childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: ['class', 'style', 'dir', 'data-tag-text'] });
    // A font/style change can alter intrinsic text without changing its clipped
    // box. Watch inherited styles too; ResizeObserver covers sample dimensions.
    for (let ancestor = lane.parentElement; ancestor; ancestor = ancestor.parentElement) {
      mutations.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'dir'] });
    }
    document.fonts?.addEventListener('loadingdone', measure);
    document.fonts?.addEventListener('loadingerror', measure);
    refresh.current = update;
    update();
    return () => {
      refresh.current = null;
      flushMutations.current = null;
      observer.disconnect();
      mutations.disconnect();
      document.fonts?.removeEventListener('loadingdone', measure);
      document.fonts?.removeEventListener('loadingerror', measure);
    };
  }, [canMeasure, hasTags]);

  if (!tagIds.length) return <span className={cn(TAG_GROUP_CLASS, className)}>{leading}</span>;
  const items = fit?.items.slice(0, tagIds.length) ?? tagIds.map(() => ({ variant, width: undefined }));
  return (
    <span ref={root} role="group" aria-label={tagIds.map(tagName).join(', ')}
      data-row-tags="" data-tag-space={!fit ? undefined : !items.length ? 'insufficient' : items.length < tagIds.length ? 'partial' : 'fit'}
      className={cn(TAG_GROUP_CLASS, 'relative min-w-0 max-w-full overflow-hidden', className)}
      style={{ width: fit?.total, height: fit?.height }}>
      {leading && <span ref={controls} data-tag-controls="" className="inline-flex shrink-0 items-center gap-1">{leading}</span>}
      <span data-tag-visible="" aria-hidden="true" className="flex min-w-0 items-center gap-1 overflow-hidden">
        {items.map((item, index) => (
          <span key={tagIds[index]} className="inline-flex shrink-0" style={{ width: item.width }}>
            <TagBadge tagId={tagIds[index]} variant={item.variant} scope={scope} className="max-w-full" />
          </span>
        ))}
      </span>
      {canMeasure && <span aria-hidden="true" className="pointer-events-none invisible absolute start-0 top-0 w-max">
        <span ref={named} data-tag-measure="named" className={TAG_GROUP_CLASS}>
          {sampleMarkup.named}
        </span>
        <span ref={compact} data-tag-measure="compact" className={TAG_GROUP_CLASS}>
          {sampleMarkup.compact}
        </span>
      </span>}
    </span>
  );
}
