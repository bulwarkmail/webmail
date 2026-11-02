// Area f of the assistant's host APIs, host side (see README.md).

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
  return {};
}
