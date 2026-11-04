import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import en from '@/locales/en/common.json';
import { EmailAddressesSection } from '../identity-settings';

// SET-19: "Learn more" next to Sub-Addressing opened the identity manager,
// which says nothing about sub-addressing. The row keeps its description;
// only "Manage" opens the identity manager.

vi.mock('@/components/identity/identity-manager-modal', () => ({
  IdentityManagerModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div role="dialog">identities</div> : null),
}));

describe('Email addresses section', () => {
  it('explains sub-addressing without a button that opens the identity manager', () => {
    render(<EmailAddressesSection />);
    const row = screen.getByText('sub_addressing.label').closest('[data-search-label]') as HTMLElement;
    expect(within(row).getByText('sub_addressing.description')).toBeTruthy();
    // Only the glossary info button that explains the term.
    expect(within(row).queryAllByRole('button').map((b) => b.getAttribute('data-glossary-term'))).toEqual(['sub_addressing']);

    fireEvent.click(screen.getByRole('button', { name: 'manage' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  // settings-p2-18: "Email addresses: The email addresses you can send from"
  // over "Your sender addresses: Addresses you can send mail from". The
  // section says it once; the row only counts them, without "identity".
  it('says what the addresses are once, and counts them as addresses', () => {
    render(<EmailAddressesSection />);
    const row = screen.getByText('label').closest('[data-search-label]') as HTMLElement;
    expect(row.querySelector('p')).toBeNull();
    expect(within(row).getByText('count')).toBeTruthy();
    expect(screen.queryByText('identities_count.description')).toBeNull();
    expect(en.uxs2_ident.addresses.count).not.toMatch(/identit/i);
    expect(en.uxs2_ident.addresses.manage).toBe('Edit addresses…');
  });
});
