import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { IdentityForm } from '../identity-form';
import { SignatureDetailsSection } from '@/components/settings/signature-details-section';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useIdentityStore } from '@/stores/identity-store';
import type { Identity } from '@/lib/jmap/types';

// The `signature` restriction in the identity editor, and the "Your
// details" form the organisation signature asks for.

const ALICE = {
  id: 'id-alice', name: 'Alice', email: 'alice@example.org', mayDelete: false,
  htmlSignature: '<b>Own</b>', textSignature: 'Own',
} as Identity;

const SIGNATURE = { html: '<p>{name}<br>Phone: {phone}</p>', text: '', fields: ['phone' as const] };

function setPolicy(restriction?: { locked?: boolean; hidden?: boolean }, signature = SIGNATURE) {
  const policy: SettingsPolicy = {
    ...DEFAULT_POLICY,
    restrictions: restriction ? { signature: restriction } : {},
    organisation: { ...DEFAULT_ORGANISATION_POLICY, signature },
  };
  usePolicyStore.setState({ policy, rawPolicy: policy, subject: null });
}

afterEach(() => {
  usePolicyStore.setState({ policy: DEFAULT_POLICY, rawPolicy: DEFAULT_POLICY });
  useSettingsStore.setState({ signatureDetails: { title: '', department: '', phone: '', mobile: '' } });
});

describe('identity signature editor and the organisation signature', () => {
  it('shows the filled-in organisation signature read-only with the note when locked', async () => {
    setPolicy({ locked: true });
    useSettingsStore.setState({ signatureDetails: { title: '', department: '', phone: '+49 1', mobile: '' } });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<IdentityForm identity={ALICE} onSave={onSave} onCancel={() => {}} />);

    const locked = screen.getByTestId('identity-locked-signature');
    expect(locked.innerHTML).toContain('Alice<br>Phone: +49 1');
    expect(locked.querySelector('[data-org-locked]')).not.toBeNull();
    expect(screen.queryByText('signature_label')).toBeNull();

    // Saving leaves the identity's own signature as it is.
    fireEvent.submit(locked.closest('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('htmlSignature');
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('textSignature');
  });

  it('shows no signature editor when hidden', () => {
    setPolicy({ hidden: true });
    render(<IdentityForm identity={ALICE} onSave={vi.fn()} onCancel={() => {}} />);
    expect(screen.queryByTestId('identity-locked-signature')).toBeNull();
    expect(screen.queryByText('signature_label')).toBeNull();
  });

  it('keeps the editor, with a hint, when not restricted', () => {
    setPolicy();
    render(<IdentityForm identity={ALICE} onSave={vi.fn()} onCancel={() => {}} />);
    expect(screen.getByText('signature_label')).toBeInTheDocument();
    expect(screen.getByTestId('identity-org-signature-default')).toHaveTextContent('identity_default');
    expect(screen.queryByTestId('identity-locked-signature')).toBeNull();
  });
});

describe('Your details', () => {
  it('asks only for the fields the template uses, and stores them', () => {
    setPolicy({ locked: true });
    useIdentityStore.setState({ identities: [ALICE] });
    render(<SignatureDetailsSection />);
    expect(screen.queryByTestId('signature-detail-title')).toBeNull();
    fireEvent.change(screen.getByTestId('signature-detail-phone'), { target: { value: '+49 30 2' } });
    expect(useSettingsStore.getState().signatureDetails.phone).toBe('+49 30 2');
    expect(screen.getByTestId('signature-details-preview').innerHTML).toContain('Alice<br>Phone: +49 30 2');
  });

  it('previews the signature that is sent: the own one while the organisation one is only the default', () => {
    setPolicy();
    useIdentityStore.setState({ identities: [ALICE] });
    render(<SignatureDetailsSection />);
    expect(screen.getByTestId('signature-detail-phone')).toBeInTheDocument();
    expect(screen.getByTestId('signature-details-preview').innerHTML).toBe('<p class="text-xs font-medium text-muted-foreground mb-1">preview</p><div class="p-3 border border-border rounded-md bg-muted/40 text-sm break-words min-w-0"><div><b>Own</b></div></div>');
  });

  it('asks for what the signature of a group address uses too', () => {
    const team = { id: 'id-team', name: 'Team', email: 'team@example.org', mayDelete: false } as Identity;
    const policy: SettingsPolicy = {
      ...DEFAULT_POLICY,
      organisation: { ...DEFAULT_ORGANISATION_POLICY },
      scopes: [{ id: 'team', label: 'Team', match: { groups: ['team@example.org'] }, policy: { organisation: { signature: { text: '{name}\nMobile: {mobile}' } } } }],
    };
    const subject = { email: 'alice@example.org', groups: ['team@example.org'] };
    usePolicyStore.setState({ rawPolicy: policy, policy: { ...policy, scopes: undefined }, subject });
    useIdentityStore.setState({ identities: [ALICE, team] });
    render(<SignatureDetailsSection />);
    expect(screen.getByTestId('signature-detail-mobile')).toBeInTheDocument();
    expect(screen.queryByTestId('signature-detail-phone')).toBeNull();
  });

  it('shows nothing without an organisation signature', () => {
    setPolicy(undefined, { html: '', text: '', fields: [] });
    const { container } = render(<SignatureDetailsSection />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('signatureDetails in the synced settings', () => {
  it('goes out with the export and comes back sanitised', () => {
    useSettingsStore.setState({ signatureDetails: { title: 'CEO', department: '', phone: '', mobile: '' } });
    const exported = JSON.parse(useSettingsStore.getState().exportSettings());
    expect(exported.signatureDetails).toEqual({ title: 'CEO', department: '', phone: '', mobile: '' });
    useSettingsStore.getState().importSettings(JSON.stringify({ signatureDetails: { title: 7, phone: '+1', evil: 'x' } }));
    expect(useSettingsStore.getState().signatureDetails).toEqual({ title: '', department: '', phone: '+1', mobile: '' });
  });
});
