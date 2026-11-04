import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAnnotations } from '@/lib/proofreading/annotations';
import { ComposerProofreader, OPEN_GRACE_MS } from '@/lib/proofreading/composer-proofreader';
import { draftProtection } from '@/lib/proofreading/protection';
import { issueNavigationKey } from '@/components/email/proofreading/text-check-extension';
import type { CheckRequest } from '@/lib/proofreading/check-session';
import type { CheckerSpec } from '@/lib/plugin-sandbox/checkers';
import type { InstalledPlugin } from '@/lib/plugin-types';

// What the security and accessibility reviews of #1397 found, each fixed.

const SEGS = new Map([['s1', 'Ich habe dem Brief geschrieben.']]);
const ann = (replacements: string[], message = 'Use den') => ({ segmentId: 's1', offset: 9, length: 3, kind: 'grammar', message, replacements });

describe('what a checker may put into the message', () => {
  it('only text a user could type: no zero-width, bidi, line or paragraph separators, no C1 controls', () => {
    const bad = ['de\u200Bn', 'd\u202Een', 'den\u2028', 'den\u2029', 'den\u0085', 'de\uFEFFn', 'den\u2066'];
    const [a] = validateAnnotations([ann([...bad, 'den'])], SEGS, ['grammar']).annotations;
    expect(a.replacements).toEqual(['den']);
  });

  it('shows no bidi overrides in the message', () => {
    const [a] = validateAnnotations([ann(['den'], 'Use \u202Enot\u202C den')], SEGS, ['grammar']).annotations;
    expect(a.message).toBe('Use not den');
  });

  it('never cuts a long message in the middle of a character', () => {
    const [a] = validateAnnotations([ann(['den'], `${'x'.repeat(498)}😀😀`)], SEGS, ['grammar']).annotations;
    expect(a.message.endsWith('…')).toBe(true);
    const beforeEllipsis = a.message.charCodeAt(a.message.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
  });

  it('stops looking at a flood of annotations once it has enough', () => {
    const many = Array.from({ length: 5000 }, () => ann(['den']));
    const { annotations, dropped } = validateAnnotations(many, SEGS, ['grammar'], 10);
    expect(annotations).toHaveLength(10);
    expect(dropped).toBe(4990);
  });
});

describe('a checker never learns the composer id', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('gets a name for the composer of its own, the same in requests and actions', async () => {
    const sent: CheckRequest[] = [];
    const actions: { composerId: string }[] = [];
    const spec: CheckerSpec = {
      pluginId: 'lt', pluginName: 'LanguageTool', id: 'c', label: 'Checker', kinds: ['grammar'], debounceMs: 300,
      languages: [], mode: 'typing', warnBeforeSend: false, epoch: 1, order: 0,
    };
    const p = new ComposerProofreader({
      composerId: 'real-composer-id', checkers: () => [spec],
      readSegments: () => [{ id: 's1', text: 'Ich habe dem Brief geschrieben.', start: 1 }], language: () => 'auto',
      access: () => ({ on: true, forced: false, lockedOff: false, hidden: false }),
      protection: () => ({ protected: false }), composerOn: () => true,
      send: async (_s, r) => { sent.push(r); return [ann(['den'])]; },
      action: async (_s, payload) => { actions.push(payload as { composerId: string }); },
      onChange: () => {}, openedAt: Date.now() - OPEN_GRACE_MS,
    });
    await vi.advanceTimersByTimeAsync(10);
    p.dismiss(p.issues()[0], 'ignore');
    expect(sent[0].composerId).not.toBe('real-composer-id');
    expect(sent[0].composerId).toMatch(/^chk-/);
    expect(actions[0].composerId).toBe(sent[0].composerId);
    // Its notices name the plugin as installed, not the label it chose.
    expect(p.status().activePlugins).toEqual([{ pluginId: 'lt', label: 'LanguageTool' }]);
    p.dispose();
  });
});

describe('protection while plugins start', () => {
  const plugin = (id: string, permissions: string[]) => ({ id, name: id, permissions } as unknown as InstalledPlugin);
  it('pauses while a plugin that can sign is turned on but not running yet', () => {
    expect(draftProtection([], [], [plugin('smime', ['crypto:full'])])).toMatchObject({ protected: true, reason: 'unknown' });
    expect(draftProtection([], [], [plugin('gravatar', ['http:fetch'])])).toEqual({ protected: false });
  });
});

describe('next and previous issue keys', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { ctrlKey: true, ...init });
  it('follow the character, so other layouts keep their own Ctrl keys', () => {
    expect(issueNavigationKey(key({ key: "'", code: 'Quote' }))).toBe(1);
    expect(issueNavigationKey(key({ key: ';', code: 'Semicolon' }))).toBe(-1);
    // Dvorak: the ;-position types "s", the '-position "-": Ctrl+S and Ctrl+- stay the browser's.
    expect(issueNavigationKey(key({ key: 's', code: 'Semicolon' }))).toBeNull();
    expect(issueNavigationKey(key({ key: '-', code: 'Quote' }))).toBeNull();
    // German: Ä and Ö, where the US keyboard has ' and ;.
    expect(issueNavigationKey(key({ key: 'ä', code: 'Quote' }))).toBe(1);
    expect(issueNavigationKey(key({ key: 'ö', code: 'Semicolon' }))).toBe(-1);
    expect(issueNavigationKey(new KeyboardEvent('keydown', { key: "'" }))).toBeNull();
  });
});
