import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { generateScript } from '@/lib/sieve/generator';
import { parseScript } from '@/lib/sieve/parser';
import { STALWART_VACATION_SCRIPT, mockStalwartAccount } from '@/lib/filters/__tests__/sieve-mock';
import { useAuthStore } from '@/stores/auth-store';
import { useFilterStore } from '@/stores/filter-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useVacationStore } from '@/stores/vacation-store';
import { VacationSettings } from '../vacation-settings';

// The vacation card as it is used: the real card, vacation store, filter
// sync and script generator, against a server that behaves like Stalwart
// (turning the auto-reply on activates its own script and switches every
// other script off).

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));

// next-intl hands out the same translate function on every render; the card's
// validation effect depends on it, so the shared mock's fresh function per
// call would make the effect run forever.
vi.mock('next-intl', () => {
  const t = (key: string, values?: Record<string, unknown>) => (values ? `${key} ${Object.values(values).join(' ')}` : key);
  return { useTranslations: () => t, useLocale: () => 'en' };
});

const EXTENSIONS = ['fileinto', 'mailbox', 'mailboxid', 'imap4flags', 'include', 'envelope', 'copy', 'date', 'relational', 'spamtestplus', 'comparator-i;ascii-numeric'];

const rule = (id: string, extra: Partial<FilterRule> = {}): FilterRule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: `${id}@example.net` }],
  actions: [{ type: 'mark_read' }],
  stopProcessing: false,
  ...extra,
});

/** A Stalwart-like account whose active filters script holds `rules`, away 5-16 Oct. */
const stalwart = (rules: FilterRule[], options: { extensions?: string[]; maxNumberRedirects?: number } = {}) => {
  const extensions = options.extensions ?? EXTENSIONS;
  return mockStalwartAccount('b', [
    { name: 'filters', content: generateScript(rules, undefined, { extensions }), isActive: true },
  ], extensions, {
    // Left out, the server allows one redirect, as Stalwart does by default.
    ...(options.maxNumberRedirects !== undefined ? { maxNumberRedirects: options.maxNumberRedirects } : {}),
    vacation: {
      fromDate: '2026-10-05T06:00:00Z',
      toDate: '2026-10-16T16:00:00Z',
      subject: 'Abwesend',
      textBody: 'Ich bin nicht da.',
    },
  });
};

const initial = {
  auth: useAuthStore.getState(),
  vacation: useVacationStore.getState(),
  filter: useFilterStore.getState(),
  identity: useIdentityStore.getState(),
};
beforeEach(() => {
  toast.error.mockClear();
  toast.success.mockClear();
});
afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useVacationStore.setState(initial.vacation, true);
  useFilterStore.setState(initial.filter, true);
  useIdentityStore.setState(initial.identity, true);
});

async function openCard(server: ReturnType<typeof stalwart>) {
  useAuthStore.setState({ client: server.client as never });
  useVacationStore.setState({ isSupported: true });
  render(<VacationSettings />);
  await screen.findByText('status.label');
}

const forwardSwitch = () => screen.getByRole('switch', { name: 'forward.enabled_label' });
const keepSwitch = () => screen.getByRole('switch', { name: 'forward.keep_label' });
const addressInput = () => screen.getByLabelText('forward.to_label') as HTMLInputElement;
const saveButton = () => screen.getByText('save').closest('button') as HTMLButtonElement;

async function save(server: ReturnType<typeof stalwart>) {
  fireEvent.click(saveButton());
  await waitFor(() => expect(server.client.setVacationResponse).toHaveBeenCalled());
  await waitFor(() => expect(toast.success.mock.calls.length + toast.error.mock.calls.length).toBe(1));
}

describe('forwarding in the vacation card', () => {
  it('is offered only where the server can run it next to the auto-reply', async () => {
    await openCard(stalwart([rule('a')], { extensions: ['fileinto', 'imap4flags'] }));
    expect(screen.queryByText('forward.title')).toBeNull();
  });

  it('turns the auto-reply on with forwarding: only forwarded, in its period, ahead of the rules', async () => {
    const server = stalwart([rule('a')]);
    await openCard(server);
    expect(screen.getByText('forward.title')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'status.label' }));
    fireEvent.click(forwardSwitch());
    fireEvent.change(addressInput(), { target: { value: 'kollege@example.com' } });
    await save(server);

    expect(toast.success).toHaveBeenCalledWith('vacation_saved');
    expect(server.client.setVacationResponse.mock.calls[0][0]).not.toHaveProperty('forward');
    expect(server.active()).toBe('filters');
    const written = server.content('filters');
    expect(parseScript(written).vacationForward).toEqual({
      enabled: true,
      to: 'kollege@example.com',
      keepCopy: false,
      activeFrom: '2026-10-05T06:00:00Z',
      activeUntil: '2026-10-16T16:00:00Z',
    });
    expect(written).toContain('include :personal :optional "vacation";');
    expect(written).toMatch(/# Vacation forwarding\nif allof\(.*"2026-10-05".*"2026-10-16".*not spamtest[^\n]*\) \{\n {4}redirect "kollege@example\.com";\n {4}stop;\n\}/);
    expect(written.indexOf('# Vacation forwarding')).toBeLessThan(written.indexOf('# Rule: Rule a'));
  });

  it('forwards without sending any auto-reply', async () => {
    const server = stalwart([rule('a')]);
    await openCard(server);
    // The auto-reply stays off; only forwarding is switched on.
    fireEvent.click(forwardSwitch());
    fireEvent.change(addressInput(), { target: { value: 'kollege@example.com' } });
    await save(server);

    expect(toast.success).toHaveBeenCalledWith('vacation_saved');
    expect(server.client.setVacationResponse.mock.calls[0][0]).toMatchObject({ isEnabled: false });
    expect(server.scripts.some((s) => s.name === 'vacation' && s.isActive)).toBe(false);
    expect(server.active()).toBe('filters');
    const written = server.content('filters');
    expect(written).not.toContain('include');
    expect(written).toMatch(/# Vacation forwarding\n[^\n]*\n {4}redirect "kollege@example\.com";\n {4}stop;\n\}/);
  });

  it('keeps forwarding through a later save, also without any filter rule', async () => {
    const server = stalwart([]);
    await openCard(server);
    fireEvent.click(screen.getByRole('switch', { name: 'status.label' }));
    fireEvent.click(forwardSwitch());
    fireEvent.change(addressInput(), { target: { value: 'kollege@example.com' } });
    await save(server);
    expect(server.active()).toBe('filters');
    toast.success.mockClear();

    // Saving again turns Stalwart's own vacation script back on.
    fireEvent.change(screen.getByPlaceholderText('message.subject_placeholder'), { target: { value: 'Bis bald' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(server.client.setVacationResponse).toHaveBeenCalledTimes(2);
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain('# Vacation forwarding');
  });

  it('keeps a copy here when asked to', async () => {
    const server = stalwart([rule('a')]);
    await openCard(server);
    fireEvent.click(screen.getByRole('switch', { name: 'status.label' }));
    fireEvent.click(forwardSwitch());
    fireEvent.change(addressInput(), { target: { value: 'kollege@example.com' } });
    fireEvent.click(keepSwitch());
    await save(server);
    expect(server.content('filters')).toContain('    redirect :copy "kollege@example.com";');
    expect(server.content('filters')).not.toContain('    stop;');
  });

  it('will not save forwarding without a usable address', async () => {
    const server = stalwart([rule('a')]);
    await openCard(server);
    fireEvent.click(forwardSwitch());
    fireEvent.change(addressInput(), { target: { value: 'kollege' } });
    expect(screen.getByText('warnings.forward_address')).toBeInTheDocument();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(addressInput(), { target: { value: 'kollege@example.com' } });
    expect(screen.queryByText('warnings.forward_address')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('does not count an address typed and switched off again as a change', async () => {
    const server = stalwart([rule('a')]);
    await openCard(server);
    fireEvent.click(forwardSwitch());
    fireEvent.change(addressInput(), { target: { value: 'kollege' } });
    fireEvent.click(forwardSwitch());
    // Nothing a save would store is different, so there is nothing to save.
    expect(saveButton().disabled).toBe(true);
  });

  it('warns that a forwarding rule is skipped when a copy is kept and the server allows one redirect', async () => {
    const server = stalwart([rule('f', { actions: [{ type: 'forward', value: 'chef@example.com' }] })], { maxNumberRedirects: 1 });
    await openCard(server);
    fireEvent.click(forwardSwitch());
    fireEvent.change(addressInput(), { target: { value: 'kollege@example.com' } });
    expect(screen.queryByText(/^forward_limit/)).toBeNull();
    fireEvent.click(keepSwitch());
    expect(screen.getByText('forward_limit 1')).toBeInTheDocument();
  });

  it('shows the stored forwarding, stops it with the switch and keeps the address', async () => {
    const server = stalwart([rule('a')]);
    await openCard(server);
    fireEvent.click(screen.getByRole('switch', { name: 'status.label' }));
    fireEvent.click(forwardSwitch());
    fireEvent.change(addressInput(), { target: { value: 'kollege@example.com' } });
    await save(server);
    toast.success.mockClear();

    // Back as stored after the save, as the server has it now.
    expect(useVacationStore.getState().forward).toMatchObject({ enabled: true, to: 'kollege@example.com' });
    expect(forwardSwitch().getAttribute('aria-checked')).toBe('true');
    expect(addressInput().value).toBe('kollege@example.com');
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(forwardSwitch());
    fireEvent.click(saveButton());
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const written = server.content('filters');
    expect(written).not.toContain('# Vacation forwarding');
    expect(written).not.toContain('redirect');
    expect(parseScript(written).vacationForward).toMatchObject({ enabled: false, to: 'kollege@example.com' });
  });

  it('opens with the forwarding the server has', async () => {
    const server = stalwart([rule('a')]);
    const forward = { enabled: true, to: 'kollege@example.com', keepCopy: true };
    await server.client.updateSieveScript(
      server.scripts[0].id,
      generateScript([rule('a')], undefined, { extensions: EXTENSIONS, vacationForward: forward }),
      true,
      'b',
    );
    await openCard(server);
    expect(forwardSwitch().getAttribute('aria-checked')).toBe('true');
    expect(addressInput().value).toBe('kollege@example.com');
    expect(keepSwitch().getAttribute('aria-checked')).toBe('true');
    expect(saveButton().disabled).toBe(true);
  });

  it('says so when the auto-reply was saved but the forwarding was not', async () => {
    const server = stalwart([rule('a')]);
    await openCard(server);
    server.client.updateSieveScript.mockRejectedValueOnce(new Error('server said no'));
    fireEvent.click(screen.getByRole('switch', { name: 'status.label' }));
    fireEvent.click(forwardSwitch());
    fireEvent.change(addressInput(), { target: { value: 'kollege@example.com' } });
    await save(server);
    expect(toast.error).toHaveBeenCalledWith('vacation_filters_save_failed');
    expect(toast.success).not.toHaveBeenCalled();
    // What was set stays, to be saved again.
    expect(forwardSwitch().getAttribute('aria-checked')).toBe('true');
    expect(saveButton().disabled).toBe(false);
  });

  it('saves only what was changed here, not forwarding another tab changed since', async () => {
    const server = stalwart([rule('a')]);
    const stored = (enabled: boolean) => generateScript([rule('a')], undefined, {
      extensions: EXTENSIONS,
      vacationForward: { enabled, to: 'kollege@example.com', keepCopy: false },
    });
    await server.client.updateSieveScript(server.scripts[0].id, stored(true), true, 'b');
    await openCard(server);
    expect(forwardSwitch().getAttribute('aria-checked')).toBe('true');

    // Switched off elsewhere; here only the subject changes.
    await server.client.updateSieveScript(server.scripts[0].id, stored(false), true, 'b');
    fireEvent.change(screen.getByPlaceholderText('message.subject_placeholder'), { target: { value: 'Bis bald' } });
    await save(server);
    expect(toast.success).toHaveBeenCalledWith('vacation_saved');
    expect(parseScript(server.content('filters')).vacationForward).toMatchObject({ enabled: false });
    expect(server.content('filters')).not.toContain('redirect');
  });

  it('says when stored forwarding does not run, and a save sets it right', async () => {
    const server = mockStalwartAccount('b', [
      {
        name: 'filters',
        content: generateScript([rule('a')], undefined, {
          extensions: EXTENSIONS,
          includeVacation: true,
          vacationForward: { enabled: true, to: 'kollege@example.com', keepCopy: false },
        }),
        isActive: false,
      },
      // Stalwart's own script took over: it answers, nothing is forwarded.
      { name: 'vacation', content: STALWART_VACATION_SCRIPT, isActive: true },
    ], EXTENSIONS);
    await openCard(server);
    expect(screen.getByText('warnings.not_running')).toBeInTheDocument();
    expect(saveButton().disabled).toBe(false);

    await save(server);
    expect(toast.success).toHaveBeenCalledWith('vacation_saved');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain('# Vacation forwarding');
    expect(screen.queryByText('warnings.not_running')).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('starts over on another account, even where both store the same', async () => {
    const server = stalwart([rule('a')]);
    await openCard(server);
    fireEvent.click(forwardSwitch());
    fireEvent.change(addressInput(), { target: { value: 'chef@a.example' } });
    expect(saveButton().disabled).toBe(false);

    // Neither account has forwarding stored, so no stored value changes.
    useAuthStore.setState({ activeAccountId: 'other-login' });
    await waitFor(() => expect(forwardSwitch().getAttribute('aria-checked')).toBe('false'));
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(forwardSwitch());
    expect(addressInput().value).toBe('');
  });
});

describe('the vacation period in the card', () => {
  const dateField = (index: number) => document.querySelectorAll('input[type="datetime-local"]')[index] as HTMLInputElement;
  // jsdom never holds a field half filled in: let it say so, as a browser does.
  const halfFilledIn = (input: HTMLInputElement, half: boolean) =>
    Object.defineProperty(input, 'validity', { value: { badInput: half }, configurable: true });

  it('will not take a date without its time for no date at all', async () => {
    const server = stalwart([rule('a')]);
    await openCard(server);
    // A browser reports the end as empty once its time is cleared.
    halfFilledIn(dateField(1), true);
    fireEvent.change(dateField(1), { target: { value: '' } });
    expect(screen.getByText('warnings.invalid_date')).toBeInTheDocument();
    expect(saveButton().disabled).toBe(true);

    halfFilledIn(dateField(1), false);
    fireEvent.change(dateField(1), { target: { value: '2026-10-17T18:00' } });
    expect(screen.queryByText('warnings.invalid_date')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('checks the fields again on save, which a field filled in only half may never have told', async () => {
    const server = stalwart([rule('a')]);
    await openCard(server);
    fireEvent.change(dateField(1), { target: { value: '' } });
    halfFilledIn(dateField(1), true);
    fireEvent.click(saveButton());
    expect(await screen.findByText('warnings.invalid_date')).toBeInTheDocument();
    expect(server.client.setVacationResponse).not.toHaveBeenCalled();
  });

  it('will not save a year with more than four digits', async () => {
    const server = stalwart([rule('a')]);
    await openCard(server);
    fireEvent.change(dateField(1), { target: { value: '20266-10-16T18:00' } });
    expect(dateField(1).value).toBe('20266-10-16T18:00');
    expect(screen.getByText('warnings.invalid_date')).toBeInTheDocument();
    expect(saveButton().disabled).toBe(true);
  });

  it('keeps the dates the server has while their fields are left alone', async () => {
    const server = stalwart([rule('a')]);
    await openCard(server);
    fireEvent.change(screen.getByPlaceholderText('message.subject_placeholder'), { target: { value: 'Bis bald' } });
    await save(server);
    expect(server.client.setVacationResponse.mock.calls[0][0]).toMatchObject({
      fromDate: '2026-10-05T06:00:00Z',
      toDate: '2026-10-16T16:00:00Z',
    });
  });
});

describe('who gets the auto-reply, in the vacation card', () => {
  const identities = ['max@example.com', 'info@example.com', 'shop@example.org'];
  const withIdentities = () =>
    useIdentityStore.setState({ identities: identities.map((email, i) => ({ id: `i${i}`, name: '', email })) as never });
  const audienceSelect = () => screen.getByRole('combobox', { name: 'audience.label' }) as HTMLSelectElement;

  it('is offered with the own domains taken from the identities', async () => {
    withIdentities();
    await openCard(stalwart([rule('a')]));
    expect(audienceSelect().value).toBe('all');
    expect(screen.getByText('audience.description example.com, example.org')).toBeInTheDocument();
  });

  it('is not offered without identities to tell the own domains', async () => {
    await openCard(stalwart([rule('a')]));
    expect(screen.queryByRole('combobox', { name: 'audience.label' })).toBeNull();
  });

  it('answers external senders only', async () => {
    withIdentities();
    const server = stalwart([rule('a')]);
    await openCard(server);
    fireEvent.click(screen.getByRole('switch', { name: 'status.label' }));
    fireEvent.change(audienceSelect(), { target: { value: 'external' } });
    await save(server);

    expect(toast.success).toHaveBeenCalledWith('vacation_saved');
    expect(server.active()).toBe('filters');
    const written = server.content('filters');
    expect(written).toContain([
      '# Vacation auto-reply',
      'if not envelope :domain :is "from" ["example.com", "example.org"] {',
      '    include :personal :optional "vacation";',
      '}',
    ].join('\n'));
    expect(parseScript(written).vacationAudience).toEqual({ only: 'external', domains: ['example.com', 'example.org'] });
  });

  it('opens with the stored choice and goes back to everyone', async () => {
    withIdentities();
    const server = stalwart([rule('a')]);
    await server.client.updateSieveScript(
      server.scripts[0].id,
      generateScript([rule('a')], undefined, {
        extensions: EXTENSIONS,
        includeVacation: true,
        vacationAudience: { only: 'internal', domains: ['example.com', 'example.org'] },
      }),
      true,
      'b',
    );
    // The auto-reply is on, run from the filters script.
    await server.client.createSieveScript('vacation', STALWART_VACATION_SCRIPT, false, 'b');
    await openCard(server);
    expect(screen.getByRole('switch', { name: 'status.label' }).getAttribute('aria-checked')).toBe('true');
    expect(audienceSelect().value).toBe('internal');
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(audienceSelect(), { target: { value: 'all' } });
    await save(server);
    expect(server.active()).toBe('filters');
    const written = server.content('filters');
    expect(written).not.toContain('envelope :domain');
    expect(written).toContain('# Vacation auto-reply\ninclude :personal :optional "vacation";');
    expect(parseScript(written).vacationAudience).toBeUndefined();
  });
});

describe('layout of the out-of-office card', () => {
  const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it('puts the period first, then the auto-reply and forwarding, each with its own switch and state', async () => {
    await openCard(stalwart([rule('a')]));
    const [page, reply, forwarding] = ['title', 'auto_reply.title', 'forward.title'].map((key) => screen.getByText(key));
    const start = screen.getByText('date_range.start');
    expect(follows(page, start)).toBe(true);
    expect(follows(start, reply)).toBe(true);
    expect(follows(reply, forwarding)).toBe(true);
    expect(screen.queryByText('date_range.title')).toBeNull();

    // Two switches, each saying whether it is on, independent of the other.
    const replyRow = screen.getByRole('switch', { name: 'status.label' }).parentElement!;
    const forwardRow = forwardSwitch().parentElement!;
    expect(within(replyRow).getByText('status.inactive')).toBeInTheDocument();
    expect(within(forwardRow).getByText('status.inactive')).toBeInTheDocument();
    fireEvent.click(forwardSwitch());
    expect(within(forwardRow).getByText('status.active')).toBeInTheDocument();
    expect(within(replyRow).getByText('status.inactive')).toBeInTheDocument();
  });
});
