'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { SlotName } from '@/lib/plugin-types';
import { PluginIframeSlot } from './plugin-iframe-slot';
import { isFillableSlot, isInlineSlot, MAX_TOP_BANNER_HEIGHT } from '@/lib/plugin-sandbox/slot-layout';
import { get as getActivePlugin, type ResolvedSlotOffer } from '@/lib/plugin-sandbox/registry';
import { usePluginSlotOffers } from '@/hooks/use-plugin-slot-offers';
import { usePluginStore } from '@/stores/plugin-store';
import { ChevronDown, ChevronUp, Puzzle } from '@/components/icons';
import { cn } from '@/lib/utils';

interface PluginSlotProps {
  name: SlotName;
  className?: string;
  extraProps?: Record<string, unknown>;
}

/** Height a filling frame keeps when it shares its panel with other frames. */
export const SHARED_FILL_MIN_HEIGHT = 280;

/**
 * The share of the window's height all top banners together may take. Past
 * it, the remaining banners wait behind a host-drawn control that names
 * their plugins. The first banner always shows (it is at most 120 px).
 */
export const TOP_BANNERS_SHARE = 0.3;
/** What a banner row takes at least: the row of its name chip. */
const BANNER_ROW_MIN = 32;

export function PluginSlot({ name, className, extraProps }: PluginSlotProps) {
  // Without a retired plugin's offer while Bulwark does its job (host-features.ts).
  const allOffers = usePluginSlotOffers(name);
  // One frame per plugin, and a frame fills its panel only in a slot made
  // for that, whatever the plugin's frame reported.
  const offers = useMemo(() => {
    const seen = new Set<string>();
    const out: ResolvedSlotOffer[] = [];
    for (const offer of allOffers) {
      if (seen.has(offer.pluginId)) continue;
      seen.add(offer.pluginId);
      out.push(offer.fill && !isFillableSlot(name) ? { ...offer, fill: false } : offer);
    }
    return out;
  }, [allOffers, name]);

  if (offers.length === 0) return null;

  if (name === 'app-top-banner') {
    return (
      <div className={className} data-plugin-slot={name}>
        <TopBannerStack offers={offers} extraProps={extraProps} />
      </div>
    );
  }

  // Inline slots line up next to each other in a toolbar row. A panel slot
  // with a frame that fills the panel takes the panel's height and shares
  // it between such frames. Next to another frame it keeps a usable height
  // however short the panel is: the panel scrolls instead of squeezing it
  // away, input and all.
  const fills = offers.some((offer) => offer.fill);
  const minFillHeight = offers.length > 1 ? SHARED_FILL_MIN_HEIGHT : undefined;
  return (
    <div
      className={isInlineSlot(name)
        ? cn('inline-flex flex-wrap items-center gap-1', className)
        : cn(className, fills && 'h-full flex flex-col min-h-0')}
      data-plugin-slot={name}
    >
      {offers.map((offer) => (
        <PluginIframeSlot
          key={offer.pluginId}
          pluginId={offer.pluginId}
          slot={name}
          extraProps={extraProps}
          fill={offer.fill}
          minFillHeight={offer.fill ? minFillHeight : undefined}
        />
      ))}
    </div>
  );
}

function useWindowHeight(): number {
  const read = () => (typeof window === 'undefined' ? 800 : window.innerHeight);
  const [height, setHeight] = useState(read);
  useEffect(() => {
    const update = () => setHeight(read());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return height;
}

/**
 * The plugins' top banners, in order, as long as together they take at most
 * TOP_BANNERS_SHARE of the window's height. The rest wait behind a control
 * at the top that names their plugins and shows them all on request.
 */
function TopBannerStack({ offers, extraProps }: { offers: readonly ResolvedSlotOffer[]; extraProps?: Record<string, unknown> }) {
  const t = useTranslations('plugin_surfaces');
  const windowHeight = useWindowHeight();
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState(false);
  const installed = usePluginStore((s) => s.plugins);
  const onHeight = useCallback((pluginId: string, height: number) => {
    setHeights((prev) => (prev[pluginId] === height ? prev : { ...prev, [pluginId]: height }));
  }, []);

  const budget = Math.max(MAX_TOP_BANNER_HEIGHT, Math.round(windowHeight * TOP_BANNERS_SHARE));
  const shown: ResolvedSlotOffer[] = [];
  const waiting: ResolvedSlotOffer[] = [];
  let used = 0;
  for (const offer of offers) {
    const row = Math.max(heights[offer.pluginId] ?? 0, BANNER_ROW_MIN);
    if (expanded || shown.length === 0 || (waiting.length === 0 && used + row <= budget)) {
      shown.push(offer);
      used += row;
    } else {
      waiting.push(offer);
    }
  }
  const nameOf = (id: string) => installed.find((p) => p.id === id)?.name || getActivePlugin(id)?.plugin.name || id;
  const more = waiting.length > 0 || (expanded && offers.length > 1);

  return (
    <>
      {more && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-1.5 border-b border-border px-3 py-1 text-start text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          data-plugin-banners-more=""
        >
          <Puzzle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {waiting.length > 0
              ? t('banners_more', { count: waiting.length, names: waiting.map((o) => nameOf(o.pluginId)).join(', ') })
              : t('banners_fewer')}
          </span>
          {waiting.length > 0
            ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            : <ChevronUp className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />}
        </button>
      )}
      {shown.map((offer) => (
        <PluginIframeSlot
          key={offer.pluginId}
          pluginId={offer.pluginId}
          slot="app-top-banner"
          extraProps={extraProps}
          onHeightChange={(height) => onHeight(offer.pluginId, height)}
        />
      ))}
    </>
  );
}
