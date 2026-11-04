import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposingSettings } from '../composing-settings';
import { useSettingsStore } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import type { Identity } from '@/lib/jmap/types';

// settings-p2-3: the signature was four clicks deep (Composing > "Email
// addresses" > Account > Manage identities > Edit identity). Composing now
// holds each address with its signature editor, saved as you type.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('../template-settings', () => ({ TemplateSettings: () => null }));
vi.mock('../proofreading-settings', () => ({ ProofreadingSettings: () => null }));

const identity = (id: string, email: string, textSignature = ''): Identity => ({
  id, name: id.toUpperCase(), email, textSignature, htmlSignature: '', mayDelete: true,
});

const updateIdentity = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  updateIdentity.mockReset().mockResolvedValue(undefined);
  useSettingsStore.getState().resetToDefaults();
  // The plain text box: the formatting editor needs a real browser.
  useSettingsStore.setState({ plainTextMode: true });
  const ids = [identity('work', 'sam@work.test', 'Sam'), identity('home', 'sam@home.test')];
  useIdentityStore.setState({ identities: ids });
  useAuthStore.setState({ client: { updateIdentity, hasDelayedSend: () => false } as never, identities: ids, primaryIdentity: ids[0] });
});

afterEach(() => {
  vi.useRealTimers();
});

const editorOf = (email: string) => {
  const box = screen.getAllByTestId('address-signature').find((el) => el.getAttribute('data-address') === email)!;
  return within(box).getByRole('textbox');
};

describe('Composing > Signatures', () => {
  it('shows every sending address with its signature on the page', () => {
    render(<ComposingSettings />);
    expect(screen.getAllByTestId('address-signature').map((el) => el.getAttribute('data-address')))
      .toEqual(['sam@work.test', 'sam@home.test']);
    expect(editorOf('sam@work.test')).toHaveValue('Sam');
    expect(screen.getByText('WORK <sam@work.test>')).toBeTruthy();
  });

  it('saves a signature to its address once typing pauses', async () => {
    render(<ComposingSettings />);
    fireEvent.change(editorOf('sam@home.test'), { target: { value: 'Cheers, Sam' } });
    expect(updateIdentity).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(updateIdentity).toHaveBeenCalledTimes(1);
    expect(updateIdentity).toHaveBeenCalledWith('home', { htmlSignature: null, textSignature: 'Cheers, Sam' });
    expect(useIdentityStore.getState().identities.find((i) => i.id === 'home')?.textSignature).toBe('Cheers, Sam');
    expect(screen.getByText('saved')).toBeTruthy();
  });

  it('saves at once when the field loses focus', async () => {
    render(<ComposingSettings />);
    fireEvent.change(editorOf('sam@work.test'), { target: { value: 'Sam Lee' } });
    await act(async () => { fireEvent.blur(editorOf('sam@work.test')); });
    expect(updateIdentity).toHaveBeenCalledWith('work', { htmlSignature: null, textSignature: 'Sam Lee' });
  });

  it('does not save a signature over the server limit', async () => {
    render(<ComposingSettings />);
    fireEvent.change(editorOf('sam@work.test'), { target: { value: 'x'.repeat(2100) } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(updateIdentity).not.toHaveBeenCalled();
  });

  it('shows one editor without an address line when there is one address', () => {
    const only = [identity('work', 'sam@work.test', 'Sam')];
    useIdentityStore.setState({ identities: only });
    render(<ComposingSettings />);
    expect(screen.getAllByTestId('address-signature')).toHaveLength(1);
    expect(screen.queryByText('WORK <sam@work.test>')).toBeNull();
  });
});
