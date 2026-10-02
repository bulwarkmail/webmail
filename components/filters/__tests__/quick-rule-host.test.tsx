import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { FilterRule, VacationForward } from '@/lib/jmap/sieve-types';
import { generateScript } from '@/lib/sieve/generator';
import { mockStalwartAccount } from '@/lib/filters/__tests__/sieve-mock';
import { useQuickRuleStore } from '@/stores/quick-rule-store';
import { QuickRuleHost } from '../quick-rule-host';

vi.mock('@/stores/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const EXTENSIONS = ['fileinto', 'imap4flags', 'include', 'envelope', 'copy', 'date', 'relational', 'spamtestplus', 'comparator-i;ascii-numeric'];

const forwardRule = (id: string): FilterRule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'chef@example.com' }],
  actions: [{ type: 'forward', value: 'kollege@example.com' }],
  stopProcessing: false,
});

/** An account that allows one redirect per message, as Stalwart does. */
const account = (rules: FilterRule[], vacationForward?: VacationForward) => mockStalwartAccount('b', [
  { name: 'filters', content: generateScript(rules, undefined, { extensions: EXTENSIONS, vacationForward }), isActive: true },
], EXTENSIONS);

function openEditor(server: ReturnType<typeof account>, mode: 'prefill' | 'edit', rule: FilterRule) {
  useQuickRuleStore.getState().openEditor({
    mode,
    target: {
      client: server.client,
      clientAccountId: null,
      key: 'login/b',
      accountId: 'b',
      sieveAccountId: 'b',
      shared: false,
      supportsSieve: true,
      mailboxes: [],
    },
    rule,
    suggestions: [],
    sourceMailboxId: null,
  });
  render(<QuickRuleHost />);
}

/** Once the account's script has been read and counted. */
async function counted(server: ReturnType<typeof account>) {
  await waitFor(() => expect(server.client.getSieveScriptContent).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  useQuickRuleStore.getState().closeEditor();
});

describe('a rule made from a message, against the redirect limit', () => {
  it('counts the vacation forwarding that keeps a copy', async () => {
    const server = account([], { enabled: true, to: 'vertretung@example.com', keepCopy: true });
    openEditor(server, 'prefill', forwardRule('new'));
    expect(await screen.findByText('forward_limit')).toBeInTheDocument();
  });

  it('leaves out vacation forwarding without a copy: it stops the message before any rule', async () => {
    const server = account([], { enabled: true, to: 'vertretung@example.com', keepCopy: false });
    openEditor(server, 'prefill', forwardRule('new'));
    await counted(server);
    expect(screen.queryByText('forward_limit')).toBeNull();
  });

  it('leaves out the forwards of the rule being edited', async () => {
    const edited = forwardRule('edited');
    const server = account([edited]);
    openEditor(server, 'edit', edited);
    await counted(server);
    expect(screen.queryByText('forward_limit')).toBeNull();
  });

  it('counts the forwards of the other rules', async () => {
    const edited = forwardRule('edited');
    const server = account([edited, forwardRule('other')]);
    openEditor(server, 'edit', edited);
    expect(await screen.findByText('forward_limit')).toBeInTheDocument();
  });

  it('leaves out a rule above that forwards and stops: its messages never get here', async () => {
    const edited = forwardRule('edited');
    const server = account([{ ...forwardRule('above'), stopProcessing: true }, edited]);
    openEditor(server, 'edit', edited);
    await counted(server);
    expect(screen.queryByText('forward_limit')).toBeNull();
  });

  it('puts a new rule first, ahead of a rule that forwards and stops', async () => {
    const server = account([{ ...forwardRule('below'), stopProcessing: true }]);
    openEditor(server, 'prefill', forwardRule('new'));
    // A message both match gets the new rule's forward first ...
    expect(await screen.findByText('forward_limit')).toBeInTheDocument();
    // ... unless the new rule stops.
    fireEvent.click(screen.getByLabelText('stop_processing'));
    expect(screen.queryByText('forward_limit')).toBeNull();
  });

  it('takes an edited rule no longer there for one saved first again', async () => {
    const server = account([{ ...forwardRule('below'), stopProcessing: true }]);
    openEditor(server, 'edit', forwardRule('gone'));
    expect(await screen.findByText('forward_limit')).toBeInTheDocument();
  });
});
