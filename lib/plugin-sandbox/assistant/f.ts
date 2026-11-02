// Area f of the assistant's host APIs, host side (see README.md).
//
// Area f adds no methods: the app-side-panel slot (plugin-slot-catalog.ts,
// gated by ui:side-panel) and its panel requests (panel-requests.ts) are
// the whole host side, mounted by components/plugins/app-side-panel.tsx.

import type { InstalledPlugin, Permission } from '../../plugin-types';
import { NOT_MINE } from './not-mine';
import type { AreaHostFeaturesF } from './f.types';

/** Method → permission, joined into PERM_PER_METHOD. */
export const PERMS: Readonly<Record<string, Permission | null>> = {};

/** Runs a method of this area; NOT_MINE for any other. */
export async function dispatch(_plugin: InstalledPlugin, _method: string, _args: unknown[]): Promise<unknown> {
  return NOT_MINE;
}

/** This area's flags in api.host.features, right now. */
export function features(): AreaHostFeaturesF {
  return { sidePanel: true };
}
