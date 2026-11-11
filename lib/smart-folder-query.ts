import { fromWallClock, getEffectiveTimeZone, parseLocalDateTime } from './timezone';
import type { SmartFolder } from './smart-folder-types';
import { isSmartFolder } from './smart-folder-schema';

/** Only schema-owned fields reach JMAP; raw JSON/expressions are never accepted. */
export function compileSmartFolder(folder: SmartFolder): Record<string, unknown> {
  if (!isSmartFolder(folder)) throw new Error('Invalid smart folder');
  const conditions = folder.conditions.map((c): Record<string, unknown> => {
    switch (c.field) {
      case 'after': case 'before': {
        // The editor chooses a calendar day in the same zone as the rest of Bulwark.
        const wall = parseLocalDateTime(c.value + 'T00:00:00')!;
        return { [c.field]: fromWallClock(wall, getEffectiveTimeZone()).toISOString() };
      }
      case 'hasAttachment': return { hasAttachment: c.value };
      case 'from': return { from: c.value };
      case 'subject': return { subject: c.value };
    }
  });
  return { operator: { all: 'AND', any: 'OR', not: 'NOT' }[folder.match], conditions };
}
