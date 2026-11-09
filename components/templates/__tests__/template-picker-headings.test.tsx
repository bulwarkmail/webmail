import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TemplatePicker } from '../template-picker';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { resolvePolicy } from '@/lib/admin/policy-scopes';
import { usePolicyStore } from '@/stores/policy-store';
import { useTemplateStore } from '@/stores/template-store';
import { useAccountTemplatesStore } from '@/stores/account-templates-store';
import type { EmailTemplate } from '@/lib/template-types';

// compose-18: a template saved from the composer showed its name twice
// ("Meeting follow-up / Meeting follow-up") under the heading "Other", with
// no other heading for it to stand apart from. The next-intl mock returns keys.

const own = (id: string, name: string, extra: Partial<EmailTemplate> = {}): EmailTemplate => ({
  id, name, subject: name, body: `${name} body`, category: '', isFavorite: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
});

beforeEach(() => {
  const subject = { email: 'alice@example.org', groups: [] };
  usePolicyStore.setState({ rawPolicy: DEFAULT_POLICY, policy: resolvePolicy(DEFAULT_POLICY, subject).policy, subject });
  useTemplateStore.setState({ templates: [own('t1', 'Meeting follow-up')], recentTemplateIds: [], deletedTemplateIds: {} });
  useAccountTemplatesStore.setState({ personal: {}, teams: {}, active: null });
});

describe('the template picker', () => {
  it('shows a name once, and no "Other" heading without categories', () => {
    render(<TemplatePicker isOpen onClose={() => {}} onSelect={() => {}} />);

    expect(screen.getAllByText('Meeting follow-up')).toHaveLength(1);
    expect(screen.queryByText('section_uncategorized')).not.toBeInTheDocument();
  });

  it('keeps the subject when it says more than the name', () => {
    useTemplateStore.setState({ templates: [own('t1', 'Follow-up', { subject: 'Thanks for meeting today' })] });
    render(<TemplatePicker isOpen onClose={() => {}} onSelect={() => {}} />);

    expect(screen.getByText('Thanks for meeting today')).toBeInTheDocument();
  });

  it('keeps "Other" apart from the categories', () => {
    useTemplateStore.setState({ templates: [own('t1', 'Follow-up'), own('t2', 'Invoice', { category: 'Billing' })] });
    render(<TemplatePicker isOpen onClose={() => {}} onSelect={() => {}} />);

    expect(screen.getByText('Billing', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('section_uncategorized')).toBeInTheDocument();
  });
});
