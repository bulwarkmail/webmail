import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Nothing under the gate hydrates while locked. A stolen device at the lock screen still
// has to hear a wipe, so the host that checks in sits beside the gate, not under it.

describe('the wipe host', () => {
  it('is mounted outside the app lock gate', () => {
    const layout = readFileSync('app/(main)/[locale]/layout.tsx', 'utf8');
    const closes = layout.indexOf('</AppLockGate>');
    const opens = layout.indexOf('<AppLockGate>');
    const host = layout.indexOf('<DeviceWipeHost');
    expect(host).toBeGreaterThan(0);
    expect(opens).toBeGreaterThan(0);
    expect(host < opens || host > closes).toBe(true);
    expect(layout.indexOf('</IntlProvider>')).toBeGreaterThan(host);
  });
});
