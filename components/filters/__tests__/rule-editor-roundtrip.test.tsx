import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import type { Mailbox } from '@/lib/jmap/types';
import { generateScript } from '@/lib/sieve/generator';
import { RuleEditor } from '../rule-editor';

vi.mock('next-intl', async () => {
  const { createTranslator } = await import('use-intl/core');
  const messages = (await import('@/locales/en/common.json')).default;
  return {
    useTranslations: (namespace?: string) => createTranslator({ locale: 'en', messages, namespace: namespace as never }),
    useLocale: () => 'en',
    useFormatter: () => ({ dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) }),
  };
});

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

afterEach(cleanup);

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null },
  { id: 'news', name: 'News', role: null, parentId: null },
  { id: 'archive', name: 'Archive', role: 'archive', parentId: null },
] as unknown as Mailbox[];

function rule(overrides: Partial<FilterRule>): FilterRule {
  return {
    id: 'rule-1',
    name: 'Old rule',
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: 'shop.example' }],
    actions: [{ type: 'mark_read' }],
    stopProcessing: false,
    ...overrides,
  };
}

// Rules the old dialog could save: actions in the order they were added.
const saved: Record<string, FilterRule> = {
  'move, then mark read': rule({ actions: [{ type: 'move', mailboxId: 'news', value: 'News' }, { type: 'mark_read' }] }),
  'forward, then move': rule({ actions: [{ type: 'forward', value: 'a@b.example' }, { type: 'move', mailboxId: 'news', value: 'News' }] }),
  'move, then copy': rule({ actions: [{ type: 'move', mailboxId: 'news', value: 'News' }, { type: 'copy', mailboxId: 'archive', value: 'Archive' }] }),
  'keep, then forward': rule({ actions: [{ type: 'keep' }, { type: 'forward', value: 'a@b.example', keepCopy: true }] }),
  'tag, then star': rule({ actions: [{ type: 'add_label', value: 'red' }, { type: 'star' }] }),
  'several values and a header': rule({
    matchType: 'any',
    conditions: [
      { field: 'from', comparator: 'domain_is', value: ['a.example', 'b.example'] },
      { field: 'header', headerName: 'List-Id', comparator: 'contains', value: 'news' },
      { field: 'size', comparator: 'greater_than', value: '5M' },
    ],
    actions: [{ type: 'move', mailboxId: 'news', value: 'News' }],
    includeSpam: true,
  }),
  'a period': rule({ activeFrom: '2026-01-01T00:00:00.000Z', activeUntil: '2026-02-01T00:00:00.000Z' }),
  'stopping': rule({ stopProcessing: true, enabled: false }),
};

describe('RuleEditor on a rule saved before it', () => {
  for (const [label, before] of Object.entries(saved)) {
    it(`saves "${label}" back unchanged when nothing was edited`, () => {
      const onSave = vi.fn();
      render(<RuleEditor rule={before} mailboxes={mailboxes} periodsSupported onSave={onSave} onClose={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(onSave).toHaveBeenCalledTimes(1);
      const after: FilterRule = onSave.mock.calls[0][0];
      expect(generateScript([after])).toBe(generateScript([before]));
    });
  }
});
