// The assistant's host API areas, merged, host side (see README.md).

import type { InstalledPlugin, Permission } from '../../plugin-types';
import { NOT_MINE } from './not-mine';
import * as b from './b';
import * as c from './c';
import * as d from './d';
import * as f from './f';
import type { AssistantHostFeatures } from './types';

export { NOT_MINE };
const AREAS = [b, c, d, f];

/** Method → permission of every area, joined into PERM_PER_METHOD. */
export const ASSISTANT_PERMS: Readonly<Record<string, Permission | null>> = Object.assign({}, ...AREAS.map((a) => a.PERMS));

/** Runs an area's method; NOT_MINE when no area owns it. The permission is checked before. */
export async function dispatchAssistant(plugin: InstalledPlugin, method: string, args: unknown[]): Promise<unknown> {
  for (const area of AREAS) {
    if (!(method in area.PERMS)) continue;
    return area.dispatch(plugin, method, args);
  }
  return NOT_MINE;
}

/** Every area's api.host.features flags, right now. */
export function assistantFeatures(): AssistantHostFeatures {
  return Object.assign({}, ...AREAS.map((a) => a.features()));
}
