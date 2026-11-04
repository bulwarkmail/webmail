import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { mockStalwartAccount } from '@/lib/filters/__tests__/sieve-mock';
import { useAuthStore } from '@/stores/auth-store';
import { useVacationStore } from '@/stores/vacation-store';
import { VacationSettings } from '../vacation-settings';

// The out-of-office message in the real vacation card: one editor with
// formatting, whose plain-text part a save derives; real starting text for a
// reply never written; and no way to switch on (or keep on) a blank reply.

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));
vi.mock('next-intl', () => {
  const t = (key: string, values?: Record<string, unknown>) => (values ? `${key} ${Object.values(values).join(' ')}` : key);
  return { useTranslations: () => t, useLocale: () => 'en' };
});
// The editor hands the card its HTML as typed.
vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: ({ content, onChange, placeholder }: { content: string; onChange: (html: string) => void; placeholder?: string }) => (
    <textarea data-testid="message-editor" value={content} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const initial = { auth: useAuthStore.getState(), vacation: useVacationStore.getState() };
afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useVacationStore.setState(initial.vacation, true);
});

type Server = ReturnType<typeof mockStalwartAccount>;

async function openCard(server: Server) {
  useAuthStore.setState({ client: server.client as never });
  useVacationStore.setState({ isSupported: true });
  render(<VacationSettings />);
  await waitFor(() => expect(useVacationStore.getState().isLoading).toBe(false));
  await screen.findByText('status.label');
}

const editor = () => screen.getByTestId('message-editor') as HTMLTextAreaElement;
const subject = () => screen.getByRole('textbox', { name: 'message.subject_label' }) as HTMLInputElement;
const replySwitch = () => screen.getByRole('switch', { name: 'status.label' });
const sends = (server: Server) => server.client.setVacationResponse.mock.calls.length;
const lastSent = (server: Server) =>
  server.client.setVacationResponse.mock.calls[sends(server) - 1][0] as {
    isEnabled: boolean; subject: string; textBody: string; htmlBody: string | null;
  };
async function saved(server: Server, count: number) {
  await waitFor(() => expect(sends(server)).toBe(count), { timeout: 3000 });
  await waitFor(() => expect(useVacationStore.getState().isSaving).toBe(false));
}
/** Long enough for a save that was due to have started, twice over. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 2500)));
const blank = () => mockStalwartAccount('b', [], ['vacation'], { vacation: { subject: '', textBody: '', htmlBody: null } });

describe('the out-of-office message', () => {
  it('starts a reply never written with real text, not a placeholder, and saves it only once used', async () => {
    const server = blank();
    await openCard(server);
    expect(subject().value).toBe('default_subject');
    expect(editor().value).toBe('<p>default_message</p>');
    // Opening the page saves nothing.
    await settle();
    expect(sends(server)).toBe(0);

    fireEvent.click(replySwitch());
    await saved(server, 1);
    expect(lastSent(server)).toMatchObject({
      isEnabled: true,
      subject: 'default_subject',
      htmlBody: '<p>default_message</p>',
      textBody: 'default_message',
    });
  }, 15_000);

  it('keeps the switch off while the message is empty, and says to write one', async () => {
    const server = blank();
    await openCard(server);
    fireEvent.change(editor(), { target: { value: '<p></p>' } });
    // An emptied box looks empty: grey sample text there would read as a message that is set.
    expect(editor().getAttribute('placeholder') ?? '').not.toContain('default_message');
    fireEvent.click(replySwitch());
    expect(replySwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('write_message_first')).toBeInTheDocument();
    await settle();
    expect(server.client.setVacationResponse.mock.calls.some(([sent]) => (sent as { isEnabled: boolean }).isEnabled)).toBe(false);

    fireEvent.change(editor(), { target: { value: '<p>Back Monday.</p>' } });
    expect(screen.queryByText('write_message_first')).toBeNull();
    fireEvent.click(replySwitch());
    expect(replySwitch().getAttribute('aria-checked')).toBe('true');
  }, 15_000);

  it('does not save a reply that is on once its text is deleted', async () => {
    const server = blank();
    await openCard(server);
    fireEvent.click(replySwitch());
    await saved(server, 1);
    fireEvent.change(editor(), { target: { value: '<p></p>' } });
    expect(screen.getByText('write_message_first')).toBeInTheDocument();
    await settle();
    expect(sends(server)).toBe(1);
  }, 15_000);

  it('saves a formatted message once, with the plain-text part derived from it', async () => {
    const server = mockStalwartAccount('b', [], ['vacation'], { vacation: { textBody: 'away' } });
    await openCard(server);
    // A stored text-only reply opens in the editor.
    expect(editor().value).toBe('<p>away</p>');
    fireEvent.change(editor(), { target: { value: '<p>Away until <b>Monday</b></p>' } });
    await saved(server, 1);
    expect(lastSent(server)).toMatchObject({ htmlBody: '<p>Away until <b>Monday</b></p>', textBody: 'Away until Monday' });

    await settle();
    expect(sends(server)).toBe(1);
    expect(screen.getByRole('status').textContent).toMatch(/saved/);
  }, 15_000);

  it('saves HTML the sanitizer rewrites once', async () => {
    const server = mockStalwartAccount('b', [], ['vacation'], { vacation: { textBody: 'away' } });
    await openCard(server);
    fireEvent.change(editor(), { target: { value: '<p>Away<br/>until Monday.</p>' } });
    await saved(server, 1);
    expect(lastSent(server).htmlBody).toBe('<p>Away<br>until Monday.</p>');

    await settle();
    expect(sends(server)).toBe(1);
  }, 15_000);

  it('switches a stored reply on without rewriting a message nobody edited', async () => {
    const server = mockStalwartAccount('b', [], ['vacation'], { vacation: { htmlBody: '<p>Back on 5 May.</p>', textBody: 'Back soon.' } });
    await openCard(server);
    expect(editor().value).toBe('<p>Back on 5 May.</p>');
    fireEvent.click(replySwitch());
    await saved(server, 1);
    expect(lastSent(server)).toMatchObject({ isEnabled: true, htmlBody: '<p>Back on 5 May.</p>', textBody: 'Back soon.' });
  }, 15_000);
});
