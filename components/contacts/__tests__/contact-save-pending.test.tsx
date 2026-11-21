import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContactsApp } from '../contacts-app';
import { JMAPClient } from '@/lib/jmap/client';
import type { ContactCard } from '@/lib/jmap/types';
import { setOfflineHooks } from '@/lib/jmap/offline-hooks';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { hasUnsavedChanges } from '@/lib/leave-guard';
import { useAuthStore } from '@/stores/auth-store';
import { useContactStore } from '@/stores/contact-store';
import { useToastStore } from '@/stores/toast-store';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ locale: 'en' }), usePathname: () => '/en/contacts',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/contacts/contact-activity', () => ({ ContactActivity: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/layout/inline-app-view', () => ({ InlineAppView: () => null }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/hooks/use-sidebar-apps', () => ({ useSidebarApps: () => ({
  showAppsModal: false, inlineApp: null, loadedApps: [], handleManageApps: vi.fn(),
  handleInlineApp: vi.fn(), closeInlineApp: vi.fn(), closeAppsModal: vi.fn(),
}) }));
vi.mock('@/lib/error-reporting/client', () => ({ recordJmapCall: vi.fn(), reportJmapFailure: vi.fn() }));

const ID = 'existing-contact';
const ENDPOINT = 'https://contacts.example.test/jmap';
const PHOTO = 'data:image/jpeg;base64,QUJD';
const NEW_PHOTO = 'data:image/jpeg;base64,REVG';
const original = (): ContactCard => ({
  id: ID, addressBookIds: { book: true },
  name: { full: 'Alice Original', components: [{ kind: 'given', value: 'Alice' }, { kind: 'surname', value: 'Original' }], isOrdered: true },
  emails: { e0: { address: 'alice@example.test' }, e1: { address: 'other@example.test' } },
  phones: { p0: { number: '+12345', features: { voice: true } } },
  organizations: { o0: { name: 'Synthetic company' } },
  addresses: { a0: { components: [{ kind: 'name', value: 'Synthetic street' }], countryCode: 'US' } },
  anniversaries: { a0: { kind: 'birth', date: { year: 2000, month: 1, day: 1 } } },
  onlineServices: { s0: { uri: 'https://example.test', service: 'Example' } },
  personalInfo: { p0: { kind: 'hobby', value: 'Reading' } },
  notes: { n0: { note: 'Original note' } }, keywords: { Friends: true },
  media: { photo: { kind: 'photo', uri: PHOTO, mediaType: 'image/jpeg' } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
type RequestBody = { using: string[]; methodCalls: [string, { accountId: string; update: Record<string, Partial<ContactCard>> }, string][] };
let service: ReturnType<typeof deferred<Response>>;
let submitted: RequestBody[];
let server: ContactCard;
let client: JMAPClient;
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const form = () => screen.getByPlaceholderText('given_name').closest('form')!;
const firstName = () => screen.getByPlaceholderText('given_name') as HTMLInputElement;

// Native click() obeys disabled buttons AND disabled fieldset ancestors (also
// for custom role=radio/category buttons). fireEvent.change alone does not.
function click(element: HTMLElement) { act(() => element.click()); }
function change(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  if (element.matches(':disabled') || ('readOnly' in element && element.readOnly)) return;
  fireEvent.change(element, { target: { value } });
}
function key(element: HTMLElement, value: string) {
  if (!element.matches(':disabled')) fireEvent.keyDown(element, { key: value });
}
function pickPhoto() {
  const button = screen.getByRole('button', { name: 'upload_photo' });
  const enabled = !button.matches(':disabled');
  click(button);
  const input = form().querySelector<HTMLInputElement>('input[type=file]')!;
  if (enabled && !input.matches(':disabled')) fireEvent.change(input, { target: { files: [new File(['synthetic'], 'photo.png', { type: 'image/png' })] } });
}
async function open(readOnly = false) {
  server = original();
  client = new JMAPClient('https://contacts.example.test', 'synthetic', 'synthetic');
  Object.assign(client, { apiUrl: ENDPOINT, accountId: 'account',
    capabilities: { 'urn:ietf:params:jmap:contacts': {} },
    accounts: { account: { name: 'Synthetic', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:contacts': {} } } },
  });
  vi.spyOn(client, 'getAllContacts').mockImplementation(async () => [copy(server)]);
  vi.spyOn(client, 'getContact').mockImplementation(async () => copy(server));
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/config' || url === '/api/admin/policy') return Promise.resolve(json({}));
    expect(url).toBe(ENDPOINT); expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)) as RequestBody;
    expect(body.methodCalls).toHaveLength(1);
    expect(body.methodCalls[0][0]).toBe('ContactCard/set');
    expect(Object.keys(body.methodCalls[0][1])).toEqual(['accountId', 'update']);
    expect(Object.keys(body.methodCalls[0][1].update)).toEqual([ID]);
    submitted.push(body);
    return service.promise;
  }));
  act(() => {
    useAuthStore.setState({ isAuthenticated: true, client, isLoading: false });
    useContactStore.setState({ contacts: [copy(server)], addressBooks: [
      { id: 'book', name: 'Synthetic book', myRights: { mayRead: true, mayWrite: !readOnly, mayShare: false, mayDelete: false } },
      { id: 'other-book', name: 'Other book' },
    ], selectedContactId: null, selectedContactIds: new Set(), activeTab: 'all', searchQuery: '', supportsSync: true, contactsLoaded: true, isLoading: false, error: null });
  });
  render(<ContactsApp />);
  click(await screen.findByText('Alice Original'));
  if (!readOnly) {
    click(screen.getByRole('button', { name: 'form.edit_title' }));
    await screen.findByPlaceholderText('given_name');
  }
}
async function save() {
  click(screen.getByRole('button', { name: 'save' }));
  await waitFor(() => expect(submitted).toHaveLength(1));
}
async function succeed(index = 0) {
  Object.assign(server, submitted[index].methodCalls[0][1].update[ID]);
  await act(async () => { service.resolve(json({ methodResponses: [['ContactCard/set', { accountId: 'account', oldState: 's0', newState: 's1', updated: { [ID]: null } }, '0']], sessionState: 'session' })); });
  await waitFor(() => expect(screen.queryByPlaceholderText('given_name')).toBeNull());
}
const mutations = (editor: HTMLFormElement) => [...editor.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input, select, textarea, button')]
  .filter(el => el.getAttribute('aria-label') !== 'close' && !['save', 'updating', 'cancel'].includes(el.textContent?.trim() ?? ''));

beforeEach(() => {
  localStorage.clear(); clearAllHooks(); setOfflineHooks(null);
  useToastStore.getState().clearToasts(); service = deferred<Response>(); submitted = [];
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  act(() => { useAuthStore.setState({ client: null, isAuthenticated: false }); useContactStore.setState({ contacts: [], selectedContactId: null, selectedContactIds: new Set() }); });
});

it('locks every rendered field and row/photo/type control while Save is pending, then confirms A normally', async () => {
  await open();
  if (!screen.queryByRole('textbox', { name: 'online_service_url' })) click(within(form()).getByRole('button', { name: 'more_fields' }));
  const editor = form();
  for (const el of mutations(editor)) expect(el).toBeEnabled();
  change(firstName(), 'Value A');
  change(screen.getByRole('textbox', { name: 'note' }) as HTMLTextAreaElement, 'Note A');
  change(screen.getByRole('combobox', { name: 'phone_type' }) as HTMLSelectElement, 'mobile');
  const before = [...editor.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')].map(el => el.value);
  const controls = mutations(editor);
  await save();
  for (const el of controls) expect(el).toBeDisabled();
  expect(screen.getByRole('button', { name: 'updating' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'cancel' })).toBeDisabled();
  // Try typing/selecting, row additions/removals, type toggles and photo actions
  // through helpers that obey the same disabled semantics as a browser.
  for (const el of controls) {
    if (el instanceof HTMLInputElement && el.type !== 'file') change(el, el.type === 'date' ? '2025-02-02' : 'Value B');
    else if (el instanceof HTMLSelectElement) change(el, [...el.options].find(o => o.value !== el.value)?.value ?? '');
    else if (el instanceof HTMLTextAreaElement) change(el, 'Note B');
    else if (el instanceof HTMLButtonElement) click(el);
  }
  pickPhoto(); key(firstName(), 'Enter'); click(screen.getByRole('button', { name: 'updating' }));
  expect(mutations(editor)).toHaveLength(controls.length);
  expect([...editor.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')].map(el => el.value)).toEqual(before);
  expect(firstName()).toHaveValue('Value A'); expect(submitted).toHaveLength(1);
  expect(useContactStore.getState().contacts[0]).toEqual(original());
  await succeed();
  expect(server.name?.full).toBe('Value A Original');
  expect(useContactStore.getState().contacts[0].name).toEqual(server.name);
  expect(useContactStore.getState().selectedContactId).toBe(ID);
  expect(useToastStore.getState().toasts.map(t => [t.type, t.title])).toEqual([['success', 'toast.updated']]);
  expect(hasUnsavedChanges()).toBe(false);
});

it('disables an already-open category menu, its keyboard input and badge removal during Save', async () => {
  await open(); change(firstName(), 'Value A');
  const input = screen.getByRole('textbox', { name: 'categories' }) as HTMLInputElement;
  change(input, 'New category'); fireEvent.focus(input);
  const add = screen.getByRole('button', { name: /category_add:/ });
  const remove = screen.getByRole('button', { name: 'remove_category' });
  expect(add).toBeEnabled(); expect(remove).toBeEnabled();
  await save();
  expect(add).toBeDisabled(); expect(remove).toBeDisabled(); expect(input).toBeDisabled();
  click(add); click(remove); key(input, 'Enter'); change(input, 'Later category');
  expect(input).toHaveValue('New category'); expect(remove).toBeInTheDocument();
  expect(submitted).toHaveLength(1);
  expect(submitted[0].methodCalls[0][1].update[ID].keywords).toEqual({ Friends: true, 'New category': true });
  await succeed();
  expect(useContactStore.getState().contacts[0].keywords).toEqual({ Friends: true, 'New category': true });
});

it.each(['method refusal', 'record refusal', 'transport rejection'] as const)('%s retains A, unlocks correction and permits deliberate B retry', async kind => {
  await open(); change(firstName(), 'Value A'); await save();
  expect(firstName()).toBeDisabled();
  await act(async () => {
    if (kind === 'transport rejection') service.reject(new TypeError('Connection lost; outcome unknown'));
    else if (kind === 'method refusal') service.resolve(json({ methodResponses: [['error', { type: 'forbidden' }, '0']], sessionState: 'session' }));
    else service.resolve(json({ methodResponses: [['ContactCard/set', { accountId: 'account', oldState: 's0', newState: 's0', notUpdated: { [ID]: { type: 'forbidden', description: 'Synthetic refusal' } } }, '0']], sessionState: 'session' }));
  });
  expect(await within(form()).findByRole('alert')).toHaveTextContent(kind === 'transport rejection' ? 'Connection lost; outcome unknown' : kind === 'record refusal' ? 'Synthetic refusal' : 'Failed to update contact');
  expect(firstName()).toHaveValue('Value A');
  for (const el of mutations(form())) expect(el).toBeEnabled();
  expect(server).toEqual(original()); expect(useContactStore.getState().contacts[0]).toEqual(original());
  expect(useToastStore.getState().toasts).toEqual([]); expect(hasUnsavedChanges()).toBe(true);
  change(firstName(), 'Value B'); service = deferred<Response>();
  click(screen.getByRole('button', { name: 'save' }));
  await waitFor(() => expect(submitted).toHaveLength(2));
  expect(firstName()).toBeDisabled();
  expect(submitted[1].methodCalls[0][1].update[ID].name?.full).toBe('Value B Original');
  await succeed(1);
});

function imagePipeline() {
  const readers: Array<{ onload: (() => void) | null; onerror: (() => void) | null }> = [];
  const images: Array<{ onload: (() => void) | null; onerror: (() => void) | null }> = [];
  vi.stubGlobal('FileReader', class {
    result = PHOTO; onload = null; onerror = null;
    readAsDataURL() { readers.push(this); }
  });
  vi.stubGlobal('Image', class {
    width = 10; height = 10; src = ''; onload = null; onerror = null;
    constructor() { images.push(this); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(NEW_PHOTO);
  return { read: () => readers[0].onload?.(), decode: () => images[0].onload?.(), fail: () => readers[0].onerror?.() };
}
it('waits for an in-flight photo read and resize before allowing Save, then locks the resulting photo', async () => {
  await open(); change(firstName(), 'Value A'); const pipeline = imagePipeline(); pickPhoto();
  expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
  click(screen.getByRole('button', { name: 'save' })); expect(submitted).toEqual([]);
  await act(async () => pipeline.read());
  expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
  await act(async () => pipeline.decode());
  expect(screen.getByRole('button', { name: 'save' })).toBeEnabled();
  await save();
  expect(screen.getByRole('button', { name: 'remove_photo' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'upload_photo' })).toBeDisabled();
  expect(submitted[0].methodCalls[0][1].update[ID].media?.photo.uri).toBe(NEW_PHOTO);
  await succeed();
});
it('unlocks Save when a photo read fails instead of leaving a pending field update', async () => {
  await open(); const pipeline = imagePipeline(); pickPhoto();
  expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
  await act(async () => pipeline.fail());
  expect(screen.getByText('photo_invalid')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'save' })).toBeEnabled();
  change(firstName(), 'Value A'); await save();
  expect(submitted[0].methodCalls[0][1].update[ID].media).toBeUndefined(); await succeed();
});

it('keeps validation, ordinary Cancel and the existing pending Close confirmation intact', async () => {
  await open();
  click(screen.getByRole('button', { name: 'cancel' })); expect(screen.queryByRole('alertdialog')).toBeNull();
  click(screen.getByRole('button', { name: 'form.edit_title' }));
  change(firstName(), ''); change(screen.getByPlaceholderText('surname') as HTMLInputElement, '');
  change(screen.getByPlaceholderText('organization_placeholder') as HTMLInputElement, '');
  click(screen.getByRole('button', { name: 'save' })); expect(within(form()).getByRole('alert')).toHaveTextContent('name_required');
  expect(firstName()).toBeEnabled(); expect(submitted).toEqual([]);
  change(firstName(), 'Value A'); change(screen.getAllByRole('textbox', { name: 'email' })[0] as HTMLInputElement, 'invalid@');
  click(screen.getByRole('button', { name: 'save' })); expect(within(form()).getByRole('alert')).toHaveTextContent('email_invalid');
  expect(firstName()).toBeEnabled(); expect(submitted).toEqual([]);
  change(screen.getAllByRole('textbox', { name: 'email' })[0] as HTMLInputElement, 'valid@example.test');
  await save();
  const close = within(form()).getByRole('button', { name: 'close' }); expect(close).toBeEnabled(); click(close);
  const dialog = await screen.findByRole('alertdialog');
  click(within(dialog).getByRole('button', { name: 'form.keep_editing' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(firstName()).toHaveValue('Value A'); expect(firstName()).toBeDisabled(); await succeed();
});
it('does not expose Edit for a contact in a read-only address book', async () => {
  await open(true); expect(screen.queryByRole('button', { name: 'form.edit_title' })).toBeNull();
  click(screen.getByRole('button', { name: 'detail.more_actions' }));
  expect(screen.queryByText('context_menu.edit')).toBeNull(); expect(submitted).toEqual([]);
});
