'use client';

import React from 'react';
import type { SlotName } from '@/lib/plugin-types';
import { PluginIframeSlot } from './plugin-iframe-slot';
import { isInlineSlot } from '@/lib/plugin-sandbox/slot-layout';
import { usePluginSlotOffers } from '@/hooks/use-plugin-slot-offers';
import { cn } from '@/lib/utils';

interface PluginSlotProps {
  name: SlotName;
  className?: string;
  extraProps?: Record<string, unknown>;
}

/** Height a filling frame keeps when it shares its panel with other frames. */
export const SHARED_FILL_MIN_HEIGHT = 280;

export function PluginSlot({ name, className, extraProps }: PluginSlotProps) {
  // Without a retired plugin's offer while Bulwark does its job (host-features.ts).
  const offers = usePluginSlotOffers(name);

  if (offers.length === 0) return null;

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
