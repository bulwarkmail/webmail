'use client';

// Reactive accessor for sandboxed plugin slot offers. Components that gate
// layout on the *presence* of a plugin-supplied slot (e.g. a detail
// sidebar) read from here instead of the legacy `usePluginStore.slots` map.
//
// These are the offers the host shows: a retired plugin's offer is left out
// while Bulwark does its job itself (lib/plugin-sandbox/host-features.ts), so
// nothing is built for a slot nobody will see.

import { useMemo, useSyncExternalStore } from 'react';
import type { SlotName } from '@/lib/plugin-types';
import { offersForSlot, subscribe } from '@/lib/plugin-sandbox/registry';
import { hostFeaturesFor, slotHandedOver } from '@/lib/plugin-sandbox/handover';
import { usePolicyStore } from '@/stores/policy-store';

export function usePluginSlotOffers(slotName: SlotName) {
  const getSnapshot = () => offersForSlot(slotName);
  const offers = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const externalMail = usePolicyStore((s) => s.policy.organisation?.externalMail);
  return useMemo(() => {
    const features = hostFeaturesFor(externalMail);
    const shown = offers.filter((offer) => !slotHandedOver(offer.pluginId, slotName, features));
    return shown.length === offers.length ? offers : shown;
  }, [offers, slotName, externalMail]);
}
