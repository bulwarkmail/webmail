import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerProofreader, OPEN_GRACE_MS } from '@/lib/proofreading/composer-proofreader';
import { checkerAccess, type PolicyView } from '@/lib/proofreading/gate';
import { draftProtection, type Protection } from '@/lib/proofreading/protection';
import type { CheckRequest } from '@/lib/proofreading/check-session';
import type { Segment } from '@/lib/proofreading/segments';
import type { CheckerSpec } from '@/lib/plugin-sandbox/checkers';
import type { RegisteredAction } from '@/lib/plugin-sandbox/actions';
import type { InstalledPlugin } from '@/lib/plugin-types';

const spec = (pluginId: string, over: Partial<CheckerSpec> = {}): CheckerSpec => ({
  pluginId, pluginName: pluginId, id: 'check', label: pluginId.toUpperCase(), kinds: ['spelling', 'grammar'],
  debounceMs: 800, languages: [], mode: 'typing', warnBeforeSend: false, epoch: 1, order: 0, ...over,
});

const policy = (over: Partial<PolicyView> = {}): PolicyView => ({ restrictions: {}, defaults: {}, settled: true, ...over });

interface Rig {
  p: ComposerProofreader;
  sent: { plugin: string; request: CheckRequest }[];
  actions: unknown[];
  checkers: CheckerSpec[];
  policy: PolicyView;
  user: { proofreading: boolean; proofreadingPlugins: Record<string, boolean> };
  protection: Protection;
  composerOn: boolean;
  segments: Segment[];
  answers: Map<string, unknown>;
}

function rig(checkers: CheckerSpec[], over: Partial<Pick<Rig, 'policy' | 'user' | 'protection' | 'composerOn'>> = {}): Rig {
  const r = {
    sent: [], actions: [], checkers,
    policy: policy(), user: { proofreading: true, proofreadingPlugins: {} },
    protection: { protected: false }, composerOn: true,
    segments: [{ id: 's1', text: 'Ich habe dem Brief geschrieben', start: 1 }],
    answers: new Map(),
    ...over,
  } as unknown as Rig;
  r.p = new ComposerProofreader({
    composerId: 'c1',
    checkers: () => r.checkers,
    readSegments: () => r.segments,
    language: () => 'auto',
    access: (pluginId) => checkerAccess(r.policy, r.user, pluginId),
    protection: () => r.protection,
    composerOn: () => r.composerOn,
    send: async (s, request) => { r.sent.push({ plugin: s.pluginId, request }); return r.answers.get(s.pluginId) ?? []; },
    action: async (_s, payload) => { r.actions.push(payload); },
    onChange: () => {},
    openedAt: Date.now() - OPEN_GRACE_MS,
  });
  return r;
}

const dem = { segmentId: 's1', offset: 9, length: 3, kind: 'grammar', message: 'den?', replacements: ['den'] };
const settle = () => vi.advanceTimersByTimeAsync(10);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ComposerProofreader: when text goes out', () => {
  it('sends to a checker the user turned on', async () => {
    const r = rig([spec('lt')]);
    await settle();
    expect(r.sent.map((s) => s.plugin)).toEqual(['lt']);
  });

  it('sends nothing while proofreading is off for the user', async () => {
    const r = rig([spec('lt')], { user: { proofreading: false, proofreadingPlugins: {} } });
    r.p.edited('now');
    await settle();
    expect(r.sent).toHaveLength(0);
  });

  it('sends nothing to a plugin the user turned off, even with proofreading on', async () => {
    const r = rig([spec('lt'), spec('ai', { order: 1 })], { user: { proofreading: true, proofreadingPlugins: { ai: false } } });
    await settle();
    expect(r.sent.map((s) => s.plugin)).toEqual(['lt']);
  });

  it('sends nothing when switched off in this composer, unless the admin requires it', async () => {
    const r = rig([spec('lt')], { composerOn: false });
    await settle();
    expect(r.sent).toHaveLength(0);
    r.policy = policy({ restrictions: { proofreading: { locked: true, value: true } } });
    r.p.gateChanged();
    await settle();
    expect(r.sent).toHaveLength(1);
  });

  it('sends nothing for a signed or encrypted message, also when the admin requires checking', async () => {
    const r = rig([spec('lt')], {
      protection: { protected: true, reason: 'encrypt', pluginName: 'S/MIME' },
      policy: policy({ restrictions: { proofreading: { locked: true, value: true } } }),
    });
    r.p.edited('now');
    await settle();
    expect(r.sent).toHaveLength(0);
    expect(r.p.status()).toMatchObject({ on: true, forced: true, paused: { reason: 'encrypt' }, count: 0 });
  });

  it('drops what it had the moment the message becomes protected', async () => {
    const r = rig([spec('lt')]);
    r.answers.set('lt', [dem]);
    await settle();
    expect(r.p.issues()).toHaveLength(1);
    r.protection = { protected: true, reason: 'sign', pluginName: 'S/MIME' };
    r.p.gateChanged();
    expect(r.p.issues()).toHaveLength(0);
    expect(r.p.sessionOf({ pluginId: 'lt', id: 'check' })!.annotations.size).toBe(0);
  });

  it('sends nothing until the policy is known, and nothing when the admin locked it off', async () => {
    const r = rig([spec('lt')], { policy: policy({ settled: false }) });
    await settle();
    expect(r.sent).toHaveLength(0);
    r.policy = policy({ restrictions: { proofreading: { locked: true, value: false, hidden: true } } });
    r.p.gateChanged();
    await settle();
    expect(r.sent).toHaveLength(0);
    expect(r.p.status()).toMatchObject({ lockedOff: true, available: false });
  });

  it('waits a moment after the composer opens', async () => {
    const sent: string[] = [];
    const p = new ComposerProofreader({
      composerId: 'c1', checkers: () => [spec('lt')],
      readSegments: () => [{ id: 's', text: 'Hallo', start: 1 }], language: () => 'auto',
      access: () => ({ on: true, forced: false, lockedOff: false, hidden: false }),
      protection: () => ({ protected: false }), composerOn: () => true,
      send: async (s) => { sent.push(s.pluginId); return []; }, action: async () => {}, onChange: () => {},
    });
    p.edited('now');
    await vi.advanceTimersByTimeAsync(OPEN_GRACE_MS - 100);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toHaveLength(1);
    p.dispose();
  });
});

describe('ComposerProofreader: issues', () => {
  it('places issues at document positions and shows one per spot when checkers overlap', async () => {
    const r = rig([spec('lt'), spec('ai', { order: 1, label: 'AI' })]);
    r.answers.set('lt', [dem]);
    r.answers.set('ai', [{ ...dem, offset: 9, length: 9, kind: 'grammar', message: 'Rewrite' }]);
    await settle();
    const issues = r.p.issues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ pluginId: 'lt', from: 10, to: 13, annotation: { text: 'dem' } });
    expect(issues[0].alternatives.map((a) => a.pluginId)).toEqual(['ai']);
  });

  it('hides a dismissed issue and tells its checker', async () => {
    const r = rig([spec('lt')]);
    r.answers.set('lt', [dem, { segmentId: 's1', offset: 0, length: 3, kind: 'spelling', message: 'x', ruleId: 'R1' }]);
    await settle();
    const [first] = r.p.issues();
    r.p.dismiss(first, 'disable-rule');
    await settle();
    expect(r.p.issues().map((i) => i.annotation.text)).toEqual(['dem']);
    expect(r.actions).toEqual([{ composerId: 'c1', action: 'disable-rule', annotation: expect.objectContaining({ text: 'Ich', ruleId: 'R1' }) }]);
  });

  it('turns the browser spell check off only while a spelling checker works here', async () => {
    const r = rig([spec('lt')]);
    await settle();
    expect(r.p.browserSpellcheck()).toBe(false);
    r.composerOn = false;
    r.p.gateChanged();
    expect(r.p.browserSpellcheck()).toBe(true);
    const grammarOnly = rig([spec('g', { kinds: ['grammar'] })]);
    await settle();
    expect(grammarOnly.p.browserSpellcheck()).toBe(true);
  });

  it('turns the browser spell check back on when the checker fails', async () => {
    const r = rig([spec('lt')]);
    r.answers.set('lt', { status: 'unavailable', message: 'down' });
    await settle();
    expect(r.p.status().trouble).toMatchObject({ label: 'LT', status: 'unavailable' });
    expect(r.p.browserSpellcheck()).toBe(true);
  });

  it('lists issues for the send warning only for checkers that asked', async () => {
    const r = rig([spec('lt', { warnBeforeSend: true }), spec('ai', { order: 1 })]);
    r.answers.set('lt', [dem]);
    r.answers.set('ai', [{ segmentId: 's1', offset: 0, length: 3, kind: 'spelling', message: 'x' }]);
    await settle();
    expect(r.p.issuesForSendWarning().map((i) => i.pluginId)).toEqual(['lt']);
  });
});

describe('checkerAccess', () => {
  const user = (proofreading: boolean, plugins: Record<string, boolean> = {}) => ({ proofreading, proofreadingPlugins: plugins });

  it('follows the user without locks', () => {
    expect(checkerAccess(policy(), user(true), 'lt')).toMatchObject({ on: true, forced: false });
    expect(checkerAccess(policy(), user(false), 'lt')).toMatchObject({ on: false, forced: false });
    expect(checkerAccess(policy(), user(false, { lt: true }), 'lt').on).toBe(true);
    expect(checkerAccess(policy({ defaults: { 'proofreading.lt': true } }), user(false), 'lt').on).toBe(true);
  });

  it('a lock beats whatever the user stored', () => {
    const forced = policy({ restrictions: { proofreading: { locked: true, value: true } } });
    expect(checkerAccess(forced, user(false, { lt: false }), 'lt')).toMatchObject({ on: true, forced: true });
    const off = policy({ restrictions: { proofreading: { locked: true, value: false } } });
    expect(checkerAccess(off, user(true, { lt: true }), 'lt')).toMatchObject({ on: false, lockedOff: true });
  });

  it('locks one plugin on or off', () => {
    const one = policy({ restrictions: { 'proofreading.lt': { locked: true, value: true } } });
    expect(checkerAccess(one, user(false), 'lt')).toMatchObject({ on: true, forced: true });
    expect(checkerAccess(one, user(false), 'ai')).toMatchObject({ on: false, forced: false });
    const offOne = policy({ restrictions: { proofreading: { locked: true, value: true }, 'proofreading.ai': { locked: true, value: false } } });
    expect(checkerAccess(offOne, user(true), 'ai')).toMatchObject({ on: false, lockedOff: true });
    expect(checkerAccess(offOne, user(true), 'lt')).toMatchObject({ on: true, forced: true });
  });

  it('a lock off on the setting wins over a plugin forced on', () => {
    const both = policy({ restrictions: { proofreading: { locked: true, value: false }, 'proofreading.lt': { locked: true, value: true } } });
    expect(checkerAccess(both, user(true), 'lt')).toMatchObject({ on: false, lockedOff: true });
  });
});

describe('draftProtection', () => {
  const plugin = (id: string, permissions: string[]) => ({ id, name: id.toUpperCase(), permissions } as unknown as InstalledPlugin);
  const action = (pluginId: string, id: string, checked: boolean, protects?: 'sign' | 'encrypt') =>
    ({ pluginId, pluginName: pluginId.toUpperCase(), id, label: id, checked, ...(protects ? { protects } : {}) }) as RegisteredAction;

  it('is protected while a sign or encrypt entry is ticked', () => {
    const smime = plugin('smime', ['crypto:full']);
    expect(draftProtection([action('smime', 'sign', false), action('smime', 'encrypt', false)], [smime])).toEqual({ protected: false });
    expect(draftProtection([action('smime', 'sign', true), action('smime', 'encrypt', false)], [smime])).toMatchObject({ protected: true, reason: 'sign' });
    expect(draftProtection([action('x', 'secure', true, 'encrypt')], [smime, plugin('x', ['crypto:full'])])).toMatchObject({ protected: true, reason: 'encrypt' });
  });

  it('does not take an entry named "sign" from a plugin that cannot sign', () => {
    expect(draftProtection([action('poll', 'sign', true)], [plugin('poll', ['compose:read'])])).toEqual({ protected: false });
  });

  it('pauses everything while a signing plugin runs that does not say what it does', () => {
    expect(draftProtection([], [plugin('openpgp', ['crypto:full'])])).toMatchObject({ protected: true, reason: 'unknown', pluginName: 'OPENPGP' });
  });
});
