import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// "Your name" saves like the other fields on the page: Enter, leaving the field, or
// leaving the page with a change typed. No Save button to forget (settings-p3-10).

const saveIdentityChanges = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
vi.mock('@/stores/identity-store', () => ({ saveIdentityChanges }));
vi.mock('@/stores/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { YourNameRow } = await import('../your-name-row');
const { useAuthStore } = await import('@/stores/auth-store');

const identity = { id: 'i1', name: 'Sam', email: 'sam@example.org' };

beforeEach(() => {
  saveIdentityChanges.mockClear();
  useAuthStore.setState({ client: {} as never, primaryIdentity: identity as never, syncIdentities: vi.fn() as never });
});

const field = () => screen.getByRole('textbox') as HTMLInputElement;
const savedNames = () => saveIdentityChanges.mock.calls.map((call) => (call[2] as { name: string }).name);

describe('Your name', () => {
  it('has no Save button', () => {
    render(<YourNameRow />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('saves when the field loses the focus', async () => {
    render(<YourNameRow />);
    fireEvent.change(field(), { target: { value: 'Sam Lee ' } });
    await act(async () => { fireEvent.blur(field()); });
    expect(savedNames()).toEqual(['Sam Lee']);
  });

  it('saves on Enter', async () => {
    render(<YourNameRow />);
    fireEvent.change(field(), { target: { value: 'Sam Lee' } });
    await act(async () => { fireEvent.submit(field().closest('form')!); });
    expect(savedNames()).toEqual(['Sam Lee']);
  });

  it('saves what is typed when the page goes away', async () => {
    const { unmount } = render(<YourNameRow />);
    fireEvent.change(field(), { target: { value: 'Sam Lee' } });
    await act(async () => { unmount(); });
    expect(savedNames()).toEqual(['Sam Lee']);
  });

  it('saves nothing when nothing changed', async () => {
    const { unmount } = render(<YourNameRow />);
    await act(async () => { fireEvent.blur(field()); });
    await act(async () => { unmount(); });
    expect(saveIdentityChanges).not.toHaveBeenCalled();
  });
});
