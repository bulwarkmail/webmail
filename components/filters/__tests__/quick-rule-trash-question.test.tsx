import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQuickRuleStore } from '@/stores/quick-rule-store';
import { QuickRuleHost } from '../quick-rule-host';

vi.mock('next-intl', async () => {
  const { createTranslator } = await import('use-intl/core');
  const messages = (await import('@/locales/en/common.json')).default;
  return {
    useTranslations: (namespace?: string) => createTranslator({ locale: 'en', messages, namespace: namespace as never }),
    useLocale: () => 'en',
    useFormatter: () => ({ dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) }),
  };
});

afterEach(() => {
  useQuickRuleStore.getState().answerTrash(false);
});

describe('the Trash question of "Run rules" on a folder', () => {
  it('names how many messages go to Trash and answers yes on Move to Trash', async () => {
    render(<QuickRuleHost />);
    let answer: Promise<boolean> | undefined;
    act(() => {
      answer = useQuickRuleStore.getState().askTrash(3);
    });
    expect(await screen.findByText('This moves 3 existing messages to Trash.', {}, { timeout: 10000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await expect(answer).resolves.toBe(true);
    expect(useQuickRuleStore.getState().trashQuestion).toBeNull();
  }, 20000);

  it('answers no on Cancel', async () => {
    render(<QuickRuleHost />);
    let answer: Promise<boolean> | undefined;
    act(() => {
      answer = useQuickRuleStore.getState().askTrash(1);
    });
    expect(await screen.findByText('This moves 1 existing message to Trash.', {}, { timeout: 10000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(answer).resolves.toBe(false);
  }, 20000);

  it('cancels an open question when another one is asked', async () => {
    const first = useQuickRuleStore.getState().askTrash(1);
    const second = useQuickRuleStore.getState().askTrash(2);
    await expect(first).resolves.toBe(false);
    expect(useQuickRuleStore.getState().trashQuestion?.count).toBe(2);
    useQuickRuleStore.getState().answerTrash(true);
    await expect(second).resolves.toBe(true);
  });
});
