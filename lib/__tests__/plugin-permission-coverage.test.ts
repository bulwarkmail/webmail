import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ALL_PERMISSIONS, IMPLICIT_PERMISSIONS } from '../plugin-types';
import { HOOK_CATALOG } from '../plugin-hook-catalog';
import { SLOT_CATALOG } from '../plugin-slot-catalog';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { PERM_PER_METHOD } from '../plugin-sandbox/host-api';

const root = path.resolve(__dirname, '../..');

/**
 * Gates that live outside the three tables, each with the call that
 * enforces it. The test reads the file, so a gate that is removed there
 * no longer counts here.
 */
const OTHER_GATES: Record<string, { file: string; call: string }> = {
  'ui:keyboard': { file: 'lib/plugin-sandbox/loader.ts', call: "pluginHasPermission(plugin, 'ui:keyboard')" },
};

/**
 * Permissions in ALL_PERMISSIONS that nothing checks. A plugin could ask
 * for one and the user would be asked to allow it, but it would grant
 * nothing. None today; one added without a gate shows up here.
 */
const GATES_NOTHING: string[] = [];

function gatedPermissions(): Map<string, string[]> {
  const where = new Map<string, string[]>();
  const add = (perm: string | null | undefined, by: string) => {
    if (!perm) return;
    where.set(perm, [...(where.get(perm) ?? []), by]);
  };
  for (const [method, perm] of Object.entries(PERM_PER_METHOD)) add(perm, `method ${method}`);
  for (const [hook, spec] of Object.entries(HOOK_CATALOG)) add(spec.permission, `hook ${hook}`);
  for (const [slot, spec] of Object.entries(SLOT_CATALOG)) {
    for (const perm of spec.permissions) add(perm, `slot ${slot}`);
    if (spec.props === '*') continue;
    for (const [prop, perm] of Object.entries(spec.props)) add(perm, `slot prop ${slot}.${prop}`);
  }
  for (const perm of IMPLICIT_PERMISSIONS) add(perm, 'implicit');
  for (const [perm, gate] of Object.entries(OTHER_GATES)) {
    if (readFileSync(path.join(root, gate.file), 'utf8').includes(gate.call)) add(perm, gate.file);
  }
  return where;
}

describe('plugin permissions', () => {
  it('every permission gates a method, hook or slot (or is a known gap)', () => {
    const gated = gatedPermissions();
    const ungated = ALL_PERMISSIONS.filter((perm) => !gated.has(perm));
    expect(ungated).toEqual(GATES_NOTHING);
  });

  it('the tables only use permissions that exist', () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    expect([...gatedPermissions().keys()].filter((perm) => !known.has(perm))).toEqual([]);
  });

  it('the new host APIs are behind the permissions they were given', () => {
    expect(PERM_PER_METHOD).toMatchObject({
      'calendar.getEvents': 'calendar:read',
      'calendar.createEvent': 'calendar:write',
      'tasks.list': 'tasks:read',
      'tasks.setComplete': 'tasks:write',
      'tasks.acknowledgeAlert': 'tasks:write',
      'templates.list': 'templates:read',
      'templates.create': 'templates:write',
      'identities.update': 'identity:write',
      'vacation.get': 'vacation:read',
      'vacation.set': 'vacation:write',
      'email.get': 'email:read',
      'email.list': 'email:read',
      'mailboxes.list': 'email:read',
      'email.getAttachment': 'email:blob-read',
      'email.getRaw': 'email:blob-read',
      'compose.open': 'compose:open',
      'drafts.create': 'email:write',
      'email.forward': 'email:forward',
      'notifications.show': 'ui:notifications',
    });
  });
});
