import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareCollectionDialog } from '../share-collection-dialog';
import { JMAPClient } from '@/lib/jmap/client';
import type { CalendarRights } from '@/lib/jmap/types';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { usePolicyStore } from '@/stores/policy-store';

// P1-8: Stalwart 1.0 refuses to list its directory unless the administrator
// allows directory queries (off by default). The dialog used to say "No other
// users or groups found" and show sharees as bare ids.

type Call = [string, Record<string, unknown>, string];
type MethodResponse = [string, Record<string, unknown>, string];

const ME = { id: 'me', type: 'individual', name: 'me@example.com', description: 'Me', email: 'me@example.com' };
const ANNA = { id: 'anna', type: 'individual', name: 'anna@example.com', description: null, email: 'anna@example.com' };
const SALES = { id: 'grp', type: 'group', name: 'Sales', description: null, email: 'sales@example.com' };
const JANE = { id: 'jane', type: 'individual', name: 'Jane', description: null, email: 'jane@example.com' };
const NICO = { id: 'nico', type: 'individual', name: 'nico@example.net', description: null, email: 'nico@example.net' };
const OLGA = { id: 'olga', type: 'individual', name: 'olga@example.org', description: null, email: 'olga@example.org' };

const DIRECTORY_OFF: MethodResponse[] = [
  ['error', { type: 'forbidden', description: 'The administrator has disabled directory queries.' }, '0'],
  ['error', { type: 'invalidResultReference', description: 'Result reference to 0#Principal/query not found.' }, '1'],
];

// A role without the query permission: 0.16's dispatcher refuses before the
// handler runs (api/auth.rs), whatever the directory setting says.
const NOT_AUTHORIZED: MethodResponse[] = [
  ['error', { type: 'forbidden', description: 'You are not authorized to perform this action' }, '0'],
  ['error', { type: 'invalidResultReference', description: 'Result reference to 0#Principal/query not found.' }, '1'],
];

const READ: CalendarRights = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: false, mayWriteOwn: false,
  mayUpdatePrivate: false, mayRSVP: false, mayShare: false, mayDelete: false,
};

function makeClient(answer: (calls: Call[]) => MethodResponse[]) {
  const client = new JMAPClient('https://jmap.example.com', 'me@example.com', 'pass');
  Object.assign(client, {
    accountId: 'me',
    capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 }, 'urn:ietf:params:jmap:principals': {} },
  });
  vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
    .mockImplementation(async (calls: Call[]) => ({ methodResponses: answer(calls) }));
  return client;
}

// Stalwart 0.16 (and 1.0 with directory queries on): the whole directory.
const fullDirectory = () => makeClient(() => [
  ['Principal/query', { ids: ['me', 'anna', 'grp'] }, '0'],
  ['Principal/get', { list: [ME, ANNA, SALES], notFound: [] }, '1'],
]);

// Stalwart 1.0 with directory queries off: the query is refused, and
// Principal/get without ids returns the principals the user knows.
const restrictedDirectory = (known = [ME, SALES, JANE]) => makeClient((calls) => (calls[0][0] === 'Principal/query'
  ? DIRECTORY_OFF
  : [['Principal/get', { list: known, notFound: [] }, '0']]));

function renderDialog(client: JMAPClient, shareWith: Record<string, CalendarRights> | null = null) {
  const onShare = vi.fn().mockResolvedValue(undefined);
  render(
    <ShareCollectionDialog
      client={client}
      kind="calendar"
      collectionName="Team"
      shareWith={shareWith}
      ownAccountId="me"
      onShare={onShare}
      onClose={vi.fn()}
    />,
  );
  return onShare;
}

describe('ShareCollectionDialog directory', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers everyone but the user on Stalwart 0.16', async () => {
    renderDialog(fullDirectory());
    fireEvent.click(screen.getByText('add_person'));

    // The i18n test mock renders translation keys.
    await waitFor(() => expect(screen.getByText('anna@example.com')).toBeInTheDocument());
    expect(screen.getByText('Sales')).toBeInTheDocument();
    expect(screen.queryByText('me@example.com')).toBeNull();
    expect(screen.queryByText('directory_restricted')).toBeNull();
    expect(screen.queryByText('no_principals')).toBeNull();
  });

  it("offers only the account's own domains, aliases included, under the policy's directory rules", async () => {
    const policy = usePolicyStore.getState();
    const client = makeClient((calls) => (calls[0][0] === 'Identity/get'
      ? [['Identity/get', { list: [
        { id: 'i1', name: 'Me', email: 'me@example.com' },
        { id: 'i2', name: 'Me', email: 'me@example.net' },
      ] }, '0']]
      : [
        ['Principal/query', { ids: ['me', 'anna', 'nico', 'olga'] }, '0'],
        ['Principal/get', { list: [ME, ANNA, NICO, OLGA], notFound: [] }, '1'],
      ]));
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, directorySameDomainOnly: true }, loaded: true, partial: false });
    try {
      renderDialog(client);
      fireEvent.click(screen.getByText('add_person'));
      await waitFor(() => expect(screen.getByText('anna@example.com')).toBeInTheDocument());
      expect(screen.getByText('nico@example.net')).toBeInTheDocument();
      expect(screen.queryByText('olga@example.org')).toBeNull();
    } finally {
      usePolicyStore.setState(policy, true);
    }
  });

  it('explains a restricted directory on Stalwart 1.0 and still offers groups and sharers', async () => {
    const onShare = renderDialog(restrictedDirectory());
    fireEvent.click(screen.getByText('add_person'));

    await waitFor(() => expect(screen.getByText('directory_restricted')).toBeInTheDocument());
    expect(screen.queryByText('directory_not_browsable')).toBeNull();
    expect(screen.getByText('Sales')).toBeInTheDocument();
    expect(screen.queryByText('me@example.com')).toBeNull();

    fireEvent.click(screen.getByText('Jane'));
    await waitFor(() => expect(onShare).toHaveBeenCalledWith('jane', READ));
  });

  it('says only that the directory cannot be browsed when a 0.16 role may not query it, and lists whoever comes back', async () => {
    // Principal/get without ids returns everyone on 0.16, so the 1.0 wording
    // ("only your groups and people who have shared with you") and its hint
    // about Stalwart's sharing settings would both be wrong.
    renderDialog(makeClient((calls) => (calls[0][0] === 'Principal/query'
      ? NOT_AUTHORIZED
      : [['Principal/get', { list: [ME, ANNA, SALES], notFound: [] }, '0']])));
    fireEvent.click(screen.getByText('add_person'));

    await waitFor(() => expect(screen.getByText('directory_not_browsable')).toBeInTheDocument());
    expect(screen.queryByText('directory_restricted')).toBeNull();
    expect(screen.getByText('anna@example.com')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
  });

  it('shows the notice instead of "no users found" when a restricted list offers no one', async () => {
    renderDialog(restrictedDirectory([ME]));
    fireEvent.click(screen.getByText('add_person'));

    await waitFor(() => expect(screen.getByText('directory_restricted')).toBeInTheDocument());
    expect(screen.queryByText('no_principals')).toBeNull();
  });

  it('labels a sharee the server will not name, and can still change and remove it', async () => {
    const onShare = renderDialog(restrictedDirectory(), { x9: READ });

    await waitFor(() => expect(screen.getByText('unknown_user')).toBeInTheDocument());
    expect(screen.getByText('x9')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('preset.read'), { target: { value: 'readWrite' } });
    await waitFor(() => expect(onShare).toHaveBeenCalledWith('x9', expect.objectContaining({ mayWriteAll: true })));

    fireEvent.click(screen.getByLabelText('remove'));
    await waitFor(() => expect(onShare).toHaveBeenCalledWith('x9', null));
  });

  it('names sharees it can resolve', async () => {
    renderDialog(restrictedDirectory(), { jane: READ });

    await waitFor(() => expect(screen.getByText('Jane')).toBeInTheDocument());
    expect(screen.queryByText('unknown_user')).toBeNull();
  });

  it('says the list failed to load on an HTTP 500', async () => {
    const client = makeClient(() => {
      throw new Error('Request failed: 500 - Internal Server Error');
    });
    renderDialog(client);
    fireEvent.click(screen.getByText('add_person'));

    await waitFor(() => expect(screen.getByText('directory_failed')).toBeInTheDocument());
    expect(screen.queryByText('no_principals')).toBeNull();
  });
});

describe('ShareCollectionDialog focus', () => {
  it('takes the focus when it opens and has a named close button', async () => {
    renderDialog(fullDirectory());
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(screen.getAllByRole('button', { name: 'close' }).length).toBeGreaterThan(0);
  });
});
