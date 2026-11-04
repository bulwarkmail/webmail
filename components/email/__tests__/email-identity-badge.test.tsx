import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import { EmailIdentityBadge } from '../email-identity-badge';
import type { Email, Identity } from '@/lib/jmap/types';

// A draft or sent mail from "User A" showed "User A  via User A", and any
// other own message "via <identity>".

const identity = { id: 'id-1', name: 'User A', email: 'usera@example.org' } as Identity;
const fromUser = (name: string) => ({ from: [{ name, email: 'usera@example.org' }], to: [] }) as unknown as Email;

describe('EmailIdentityBadge', () => {
  it('shows nothing when the sender name already is the identity name', () => {
    const { container } = render(<EmailIdentityBadge email={fromUser('User A')} identities={[identity]} />);
    expect(container.textContent).toBe('');
  });

  it('names no identity on your own message, whatever the sender name', () => {
    // "via <identity>" read like a delegation warning; the address under the
    // name already says which of your addresses sent it.
    const { container } = render(<EmailIdentityBadge email={fromUser('Support Desk')} identities={[identity]} />);
    expect(container.textContent).toBe('');
  });

  it('still shows the sub-address tag', () => {
    const email = { from: [{ name: 'Support Desk', email: 'usera+news@example.org' }], to: [] } as unknown as Email;
    const { container } = render(<EmailIdentityBadge email={email} identities={[identity]} />);
    expect(container.textContent).toContain('news');
  });
});
