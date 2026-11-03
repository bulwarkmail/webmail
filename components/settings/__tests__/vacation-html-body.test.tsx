import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { mockStalwartAccount } from '@/lib/filters/__tests__/sieve-mock';
import { useAuthStore } from '@/stores/auth-store';
import { useVacationStore } from '@/stores/vacation-store';
import { VacationSettings } from '../vacation-settings';

// The HTML reply and its plain-text part in the real vacation card: a save
// derives the text from the HTML when the Body is left blank, and what the
// server then holds must not look like a change still waiting to be saved.

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));
vi.mock('next-intl', () => {
  const t = (key: string, values?: Record<string, unknown>) => (values ? `${key} ${Object.values(values).join(' ')}` : key);
  return { useTranslations: () => t, useLocale: () => 'en' };
});
// The editor hands the card its HTML as typed.
vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (html: string) => void }) => (
    <textarea data-testid="html-editor" value={content} onChange={(e) => onChange(e.target.value)} />
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

const body = () => screen.getByPlaceholderText('message.body_placeholder') as HTMLTextAreaElement;
const htmlSwitch = () => screen.getByRole('switch', { name: 'message.html_label' });
const editor = () => screen.getByTestId('html-editor') as HTMLTextAreaElement;
const sends = (server: Server) => server.client.setVacationResponse.mock.calls.length;
const lastSent = (server: Server) =>
  server.client.setVacationResponse.mock.calls[sends(server) - 1][0] as { textBody: string; htmlBody: string | null };
async function saved(server: Server, count: number) {
  await waitFor(() => expect(sends(server)).toBe(count), { timeout: 3000 });
  await waitFor(() => expect(useVacationStore.getState().isSaving).toBe(false));
}
/** Long enough for a save that was due to have started, twice over. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 2500)));

describe('HTML auto-reply and its plain-text part', () => {
  it('saves an HTML reply with a blank Body once, with the text derived from it', async () => {
    const server = mockStalwartAccount('b', [], ['vacation'], { vacation: { textBody: '' } });
    await openCard(server);
    fireEvent.click(htmlSwitch());
    fireEvent.change(editor(), { target: { value: '<p>Away until Monday.</p>' } });
    await saved(server, 1);
    expect(lastSent(server)).toMatchObject({ htmlBody: '<p>Away until Monday.</p>', textBody: 'Away until Monday.' });

    await settle();
    expect(sends(server)).toBe(1);
    expect(screen.getByRole('status').textContent).toMatch(/saved/);
  }, 15_000);

  it('saves HTML the sanitizer rewrites once', async () => {
    const server = mockStalwartAccount('b', [], ['vacation'], { vacation: { textBody: '' } });
    await openCard(server);
    fireEvent.change(body(), { target: { value: 'Away.' } });
    fireEvent.click(htmlSwitch());
    fireEvent.change(editor(), { target: { value: '<p>Away<br/>until Monday.</p>' } });
    await saved(server, 1);
    expect(lastSent(server).htmlBody).toBe('<p>Away<br>until Monday.</p>');

    await settle();
    expect(sends(server)).toBe(1);
  }, 15_000);

  it('derives the text again after a reload, and keeps it when HTML is switched off', async () => {
    const server = mockStalwartAccount('b', [], ['vacation'], {
      vacation: { htmlBody: '<p>Back on 5 May.</p>', textBody: 'Back on 5 May.' },
    });
    await openCard(server);
    expect(body().value).toBe('');
    fireEvent.change(editor(), { target: { value: '<p>Back on 12 May.</p>' } });
    await saved(server, 1);
    expect(lastSent(server)).toMatchObject({ htmlBody: '<p>Back on 12 May.</p>', textBody: 'Back on 12 May.' });

    fireEvent.click(htmlSwitch());
    expect(body().value).toBe('Back on 12 May.');
    await saved(server, 2);
    expect(lastSent(server)).toMatchObject({ htmlBody: null, textBody: 'Back on 12 May.' });
  }, 15_000);

  it('keeps a plain-text part the user wrote', async () => {
    const server = mockStalwartAccount('b', [], ['vacation'], {
      vacation: { htmlBody: '<p>Back on 5 May.</p>', textBody: 'Back soon.' },
    });
    await openCard(server);
    expect(body().value).toBe('Back soon.');
    fireEvent.change(editor(), { target: { value: '<p>Back on 12 May.</p>' } });
    await saved(server, 1);
    expect(lastSent(server)).toMatchObject({ htmlBody: '<p>Back on 12 May.</p>', textBody: 'Back soon.' });
  }, 15_000);
});
