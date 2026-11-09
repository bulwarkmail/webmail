import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { IdentityForm } from '../identity-form';
import type { Identity } from '@/lib/jmap/types';

// RFC 8621 §6: Identity.name is a String with default "", so an identity
// without a display name is valid and must stay editable (#1462).

const nameInput = () => document.getElementById('identity-name') as HTMLInputElement;

const NAMELESS = { id: 'id-alias', name: '', email: 'alias@example.org', mayDelete: true } as Identity;

describe('identity display name', () => {
  it('saves an identity that has no display name', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<IdentityForm identity={NAMELESS} onSave={onSave} onCancel={() => {}} />);

    fireEvent.submit(nameInput().closest('form')!);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].name).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('saves a cleared name as an empty string, not as whitespace', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<IdentityForm identity={{ ...NAMELESS, name: 'Alias' }} onSave={onSave} onCancel={() => {}} />);

    fireEvent.change(nameInput(), { target: { value: '   ' } });
    fireEvent.submit(nameInput().closest('form')!);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].name).toBe('');
  });
});
