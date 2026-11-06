import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The 2FA re-auth prompt opens in whichever app made the request (it is
// mounted in the locale layout, not inside mail) and is translated.

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
// The layout reads the request's path to pick the first screen's catalog; a request to the mail view.
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-pathname': '/en' }) }));

const { TotpReauthDialog } = await import('../totp-reauth-dialog');
const { useTotpReauthStore } = await import('@/stores/totp-reauth-store');

function containsType(node: unknown, type: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((child) => containsType(child, type));
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === type) return true;
  return containsType(el.props?.children, type);
}

describe('TOTP re-auth dialog', () => {
  it('is mounted in the locale layout, so every app can show it', async () => {
    const { default: LocaleLayout } = await import('@/app/(main)/[locale]/layout');
    const tree = await LocaleLayout({ children: null, params: Promise.resolve({ locale: 'en' }) });
    expect(containsType(tree, TotpReauthDialog)).toBe(true);
  }, 120_000);

  it('asks in the user language and hands the code back', async () => {
    render(<TotpReauthDialog />);
    let answer: Promise<string | null> = Promise.resolve(null);
    act(() => { answer = useTotpReauthStore.getState().requestTotp(); });

    expect(screen.getByRole('dialog', { name: 'title' })).toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: 'code_label' });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: '123456' } });
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'verify' })); });
    await expect(answer).resolves.toBe('123456');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
