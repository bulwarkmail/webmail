import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { EmailTemplate } from '../template-types';
import { useAuthStore } from '@/stores/auth-store';
import { useTemplateStore } from '@/stores/template-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useVacationStore } from '@/stores/vacation-store';
import { usePolicyStore } from '@/stores/policy-store';
import { emptyPartition, useAccountTemplatesStore } from '@/stores/account-templates-store';
import { DEFAULT_POLICY } from '../admin/types';
import { HIGH_RISK_PERMISSIONS } from '../plugin-sandbox/permission-text';
import { clearAllHooks, identityHooks } from '../plugin-hooks';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

function plugin(perms: string[]): InstalledPlugin {
  return {
    id: 'helper', name: 'Helper', version: '1.0.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}

const ALL = plugin(['templates:read', 'templates:write', 'identity:write', 'vacation:read', 'vacation:write']);
const READ_ONLY = plugin(['templates:read', 'identity:read', 'vacation:read']);
const call = (p: InstalledPlugin, method: string, ...args: unknown[]) => dispatchApiCall(p, method, args);

const greeting: EmailTemplate = {
  id: 'tpl-1', name: 'Greeting', subject: 'Hello', body: 'Hi {{recipient_name}}', isHTML: false,
  category: 'Sales', isFavorite: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

let client: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  client = {
    updateIdentity: vi.fn(async () => undefined),
    supportsVacationResponse: vi.fn(() => true),
    supportsSieve: vi.fn(() => false),
    getVacationResponse: vi.fn(async () => ({
      id: 'singleton', isEnabled: true, fromDate: null, toDate: '2026-06-01T00:00:00Z',
      subject: 'Away', textBody: 'Back in June', htmlBody: null,
    })),
    setVacationResponse: vi.fn(async () => undefined),
    // The out-of-office calendar sync (lib/vacation-calendar.ts) reads the
    // account and skips servers without calendars.
    getAccountId: vi.fn(() => 'acc1'),
    supportsCalendars: vi.fn(() => false),
  };
  useAuthStore.setState({ client: client as unknown as IJMAPClient });
  useTemplateStore.setState({ templates: [greeting], recentTemplateIds: [], deletedTemplateIds: {} });
  useIdentityStore.setState({
    identities: [{ id: 'id1', name: 'Ann', email: 'ann@example.com', replyTo: null, bcc: null, textSignature: '', htmlSignature: '', mayDelete: true }] as never,
  });
});

afterEach(() => {
  useAuthStore.setState({ client: null, activeAccountId: null });
  useAccountTemplatesStore.setState({ personal: {} });
  usePolicyStore.setState({ policy: DEFAULT_POLICY });
  useTemplateStore.setState({ templates: [], deletedTemplateIds: {} });
  useIdentityStore.setState({ identities: [] });
  useVacationStore.getState().clearState();
});

describe('api.templates', () => {
  it('lists and gets templates as views', async () => {
    expect(await call(READ_ONLY, 'templates.list')).toEqual([
      { id: 'tpl-1', name: 'Greeting', category: 'Sales', subject: 'Hello', body: 'Hi {{recipient_name}}', isHTML: false },
    ]);
    expect(await call(READ_ONLY, 'templates.get', 'tpl-1')).toEqual(expect.objectContaining({ name: 'Greeting' }));
    expect(await call(READ_ONLY, 'templates.get', 'nope')).toBeNull();
  });

  it('needs templates:read and templates:write', async () => {
    await expect(call(plugin([]), 'templates.list')).rejects.toThrow(/lacks permission "templates:read"/);
    await expect(call(READ_ONLY, 'templates.create', { name: 'x' })).rejects.toThrow(/lacks permission "templates:write"/);
    await expect(call(READ_ONLY, 'templates.delete', 'tpl-1')).rejects.toThrow(/lacks permission "templates:write"/);
    expect(useTemplateStore.getState().templates).toHaveLength(1);
  });

  it('creates, updates and deletes through the store, sanitising HTML bodies', async () => {
    const created = await call(ALL, 'templates.create', {
      name: 'Rich', subject: 'S', body: '<p onclick="x()">Hi</p><script>alert(1)</script>', isHTML: true,
    }) as { id: string; body: string };
    expect(created.body).toContain('<p>Hi</p>');
    expect(created.body).not.toMatch(/script|onclick/);
    expect(useTemplateStore.getState().templates.map((t) => t.name)).toEqual(['Greeting', 'Rich']);

    expect(await call(ALL, 'templates.update', 'tpl-1', { subject: 'Hi there' }))
      .toEqual(expect.objectContaining({ id: 'tpl-1', subject: 'Hi there', body: 'Hi {{recipient_name}}' }));

    await call(ALL, 'templates.delete', created.id);
    expect(useTemplateStore.getState().templates.map((t) => t.id)).toEqual(['tpl-1']);
    expect(useTemplateStore.getState().deletedTemplateIds).toHaveProperty(created.id);
  });

  it('refuses bad template input', async () => {
    await expect(call(ALL, 'templates.create', { subject: 'no name' })).rejects.toThrow(/name is required/);
    await expect(call(ALL, 'templates.create', { name: 'x', isFavorite: true })).rejects.toThrow(/unknown property "isFavorite"/);
    await expect(call(ALL, 'templates.create', { name: 'x', body: 'a'.repeat(100_001) })).rejects.toThrow(/at most 100000/);
    await expect(call(ALL, 'templates.update', 'nope', { name: 'x' })).rejects.toThrow(/no template with id "nope"/);
    useTemplateStore.setState({ templates: Array.from({ length: 500 }, (_, i) => ({ ...greeting, id: `t${i}` })) });
    await expect(call(ALL, 'templates.create', { name: 'one more' })).rejects.toThrow(/already 500 templates/);
  });
});

describe('api.templates and organisation settings', () => {
  it('works on the account\'s own copy when the account keeps its templates (Stalwart 1.0)', async () => {
    const inAccount = { ...greeting, id: 'acc-1', name: 'In the account' };
    useAuthStore.setState({ activeAccountId: 'ann@mail' });
    useAccountTemplatesStore.setState({ personal: { 'ann@mail': { ...emptyPartition(), templates: [inAccount] } } });
    expect((await call(ALL, 'templates.list') as Array<{ name: string }>).map((t) => t.name)).toEqual(['In the account']);
    const created = await call(ALL, 'templates.create', { name: 'From a plugin' }) as { id: string };
    await call(ALL, 'templates.update', 'acc-1', { subject: 'Changed' });
    await call(ALL, 'templates.delete', created.id);
    const copy = useAccountTemplatesStore.getState().personal['ann@mail'];
    expect(copy.templates.map((t) => t.subject)).toEqual(['Changed']);
    expect(copy.deletedTemplateIds).toHaveProperty(created.id);
    // The browser's list is left alone.
    expect(useTemplateStore.getState().templates.map((t) => t.id)).toEqual(['tpl-1']);
  });

  it('shows and accepts nothing when the admin hid personal templates', async () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, restrictions: { personalTemplates: { hidden: true } } } });
    expect(await call(ALL, 'templates.list')).toEqual([]);
    expect(await call(ALL, 'templates.get', 'tpl-1')).toBeNull();
    await expect(call(ALL, 'templates.create', { name: 'x' })).rejects.toThrow(/turned personal templates off/);
    await expect(call(ALL, 'templates.update', 'tpl-1', { name: 'x' })).rejects.toThrow(/turned personal templates off/);
    await expect(call(ALL, 'templates.delete', 'tpl-1')).rejects.toThrow(/turned personal templates off/);
    expect(useTemplateStore.getState().templates.map((t) => t.name)).toEqual(['Greeting']);
  });
});

describe('api.identities.update', () => {
  it('changes name, reply-to and signatures and never the address', async () => {
    const view = await call(ALL, 'identities.update', 'id1', {
      name: 'Ann Smith',
      replyTo: ['Desk <desk@example.com>'],
      htmlSignature: '<b>Ann</b><img src=x onerror="steal()">',
    });
    const [id, updates] = client.updateIdentity.mock.calls[0];
    expect(id).toBe('id1');
    expect(updates).toEqual(expect.objectContaining({
      name: 'Ann Smith', replyTo: [{ name: 'Desk', email: 'desk@example.com' }],
    }));
    expect(updates.htmlSignature).toContain('<b>Ann</b>');
    expect(updates.htmlSignature).not.toContain('onerror');
    expect(updates).not.toHaveProperty('email');
    expect(view).toEqual(expect.objectContaining({ id: 'id1', name: 'Ann Smith', email: 'ann@example.com', replyTo: 'desk@example.com' }));
    expect(useIdentityStore.getState().identities[0].name).toBe('Ann Smith');
  });

  it('refuses the address, bad addresses and unknown identities', async () => {
    await expect(call(ALL, 'identities.update', 'id1', { email: 'evil@example.com' })).rejects.toThrow(/can't be changed/);
    await expect(call(ALL, 'identities.update', 'id1', { replyTo: ['not an address'] })).rejects.toThrow(/not a valid address/);
    await expect(call(ALL, 'identities.update', 'id1', { replyTo: ['a@example.com\r\nBcc: x@example.com'] })).rejects.toThrow(/not a valid address/);
    await expect(call(ALL, 'identities.update', 'other', { name: 'x' })).rejects.toThrow(/no identity with id "other"/);
    expect(client.updateIdentity).not.toHaveBeenCalled();
  });

  it('needs identity:write, which the consent dialog marks', async () => {
    await expect(call(READ_ONLY, 'identities.update', 'id1', { name: 'x' })).rejects.toThrow(/lacks permission "identity:write"/);
    expect(client.updateIdentity).not.toHaveBeenCalled();
    expect(HIGH_RISK_PERMISSIONS.has('identity:write')).toBe(true);
  });

  it('lets another plugin stop the change, like one made in Settings', async () => {
    identityHooks.onBeforeIdentityChange.register('guard', () => false);
    try {
      await expect(call(ALL, 'identities.update', 'id1', { name: 'x' })).resolves.toBeNull();
      expect(client.updateIdentity).not.toHaveBeenCalled();
    } finally {
      clearAllHooks();
    }
  });
});

describe('api.vacation', () => {
  it('reads the reply', async () => {
    expect(await call(READ_ONLY, 'vacation.get')).toEqual({
      isEnabled: true, subject: 'Away', textBody: 'Back in June', htmlBody: '', fromDate: null, toDate: '2026-06-01T00:00:00Z',
    });
  });

  it('sets the reply through the store, sanitising HTML and deriving the text', async () => {
    const saved = await call(ALL, 'vacation.set', {
      isEnabled: true, subject: 'Out', htmlBody: '<p>Back <b>Monday</b></p><script>x()</script>',
      fromDate: '2026-05-01T08:00:00+02:00', toDate: null,
    });
    const [updates] = client.setVacationResponse.mock.calls[0];
    expect(updates).toEqual(expect.objectContaining({ isEnabled: true, subject: 'Out', fromDate: '2026-05-01T06:00:00.000Z', toDate: null }));
    expect(updates.htmlBody).toContain('<b>Monday</b>');
    expect(updates.htmlBody).not.toContain('script');
    expect(updates.textBody).toMatch(/Back Monday/);
    expect(saved).toEqual(expect.objectContaining({ isEnabled: true, subject: 'Out' }));
    expect(useVacationStore.getState().subject).toBe('Out');
  });

  it('refuses bad input and needs vacation:write', async () => {
    await expect(call(ALL, 'vacation.set', { subject: 'x' })).rejects.toThrow(/isEnabled must be true or false/);
    await expect(call(ALL, 'vacation.set', { isEnabled: true, fromDate: 'next week' })).rejects.toThrow(/fromDate must be a date/);
    await expect(call(ALL, 'vacation.set', { isEnabled: true, fromDate: '2026-06-01T00:00:00Z', toDate: '2026-05-01T00:00:00Z' }))
      .rejects.toThrow(/toDate must be after fromDate/);
    await expect(call(READ_ONLY, 'vacation.set', { isEnabled: false })).rejects.toThrow(/lacks permission "vacation:write"/);
    expect(client.setVacationResponse).not.toHaveBeenCalled();
    expect(HIGH_RISK_PERMISSIONS.has('vacation:write')).toBe(true);
  });
});
