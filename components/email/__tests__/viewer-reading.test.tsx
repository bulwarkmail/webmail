import { render, act, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { clearAllHooks } from '@/lib/plugin-hooks';

// How a received message is shown: the body frame's name and language, and
// the reading settings that reach the body.

const t = Object.assign(
  (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  { raw: (key: string) => key, rich: (key: string) => key, has: () => true },
);
vi.mock('next-intl', () => ({
  useTranslations: () => t,
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) }),
}));
const media = vi.hoisted(() => ({ matches: new Set<string>() }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: (query: string) => media.matches.has(query),
  useIsMobile: () => false,
  useIsDesktop: () => true,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { useSettingsStore } = await import('@/stores/settings-store');
const { ACCESSIBILITY_DEFAULTS } = await import('@/lib/accessibility-settings');
const { useThemeStore } = await import('@/stores/theme-store');
const { DARK_PENDING_CLASS } = await import('@/lib/email-dark-mode');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function message(overrides: Partial<Email> & { html?: string; text?: string } = {}): Email {
  const { html, text, ...rest } = overrides;
  const bodyValues: Record<string, { value: string }> = {};
  if (html !== undefined) bodyValues.h = { value: html };
  if (text !== undefined) bodyValues.t = { value: text };
  return {
    id: 'm1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Bonjour', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
    htmlBody: html !== undefined ? [{ partId: 'h', type: 'text/html' }] : [],
    textBody: text !== undefined ? [{ partId: 't', type: 'text/plain' }] : html !== undefined ? [{ partId: 'h', type: 'text/html' }] : [],
    attachments: [],
    bodyValues,
    ...rest,
  } as unknown as Email;
}

async function show(email: Email) {
  const view = render(
    <EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />,
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return view;
}

beforeEach(() => {
  clearAllHooks();
  media.matches.clear();
  useSettingsStore.setState({ ...ACCESSIBILITY_DEFAULTS, fontSize: 'medium', emailAlwaysLightMode: false } as never);
  useThemeStore.setState({ resolvedTheme: 'light' });
});

describe('message body frame', () => {
  it('is named after the subject and carries the mail language', async () => {
    const { container } = await show(message({
      html: '<html lang="fr"><body><p>Bonjour tout le monde</p></body></html>',
    }));
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('title')).toBe('frame_title {"subject":"Bonjour"}');
    expect(iframe.getAttribute('srcdoc')).toMatch(/^<!DOCTYPE html>\s*<html lang="fr"/);
  });

  it('is named after the sender when there is no subject, with no language guessed', async () => {
    const { container } = await show(message({ subject: '', html: '<p>Hi there, <b>friend</b></p>' }));
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('title')).toBe('frame_title_from {"sender":"Alice"}');
    expect(iframe.getAttribute('srcdoc')).not.toMatch(/<html[^>]*\slang=/);
  });

  it('keeps a mail that scrolls its own body from adding a second scrollbar', async () => {
    const { container } = await show(message({ html: '<style>body { overflow-y: scroll; }</style><p>Hi there, <b>friend</b></p>' }));
    const srcdoc = container.querySelector('iframe')!.getAttribute('srcdoc')!;
    // The mail's style sits inside our body, so only a rule after it wins.
    expect(srcdoc.indexOf('overflow-y: scroll')).toBeGreaterThan(-1);
    expect(srcdoc.lastIndexOf('body{overflow-y:hidden!important}')).toBeGreaterThan(srcdoc.indexOf('overflow-y: scroll'));
  });

  it('marks a plain-text body with its Content-Language', async () => {
    await show(message({ text: 'Hallo zusammen', textBody: [{ partId: 't', type: 'text/plain', language: ['de'] }] as never }));
    expect(screen.getByText('Hallo zusammen').closest('[lang]')?.getAttribute('lang')).toBe('de');
  });
});

describe('attachment actions', () => {
  it('name the file they act on', async () => {
    await show(message({
      html: '<p>See the <b>attached</b> report</p>',
      hasAttachment: true,
      attachments: [{ partId: '2', blobId: 'blob2', name: 'report.pdf', type: 'application/pdf', size: 2048 }] as never,
    }));
    expect(screen.getAllByRole('button', { name: 'download_named {"name":"report.pdf"}' }).length).toBeGreaterThan(0);
  });
});

describe('message text size', () => {
  it('plain text follows the mail text size and its minimum instead of a fixed 14px', async () => {
    useSettingsStore.setState({ mailTextScale: 1.5, mailMinFontSize: 16 } as never);
    await show(message({ text: 'Plain words here' }));
    const body = screen.getByText('Plain words here').closest('.email-content-text') as HTMLElement;
    // jsdom folds the calc().
    expect(body.style.fontSize).toMatch(/^max\(.*(0\.875rem \* 1\.5|1\.3125rem).*, 16px\)$/);
  });

  it('plain text follows the app text size by default', async () => {
    useSettingsStore.setState({ fontSize: 'xx-large' } as never);
    await show(message({ text: 'Plain words here' }));
    const body = screen.getByText('Plain words here').closest('.email-content-text') as HTMLElement;
    expect(body.style.fontSize).toBe('0.875rem');
  });

  it('rebuilds the HTML frame for a new size', async () => {
    useSettingsStore.setState({ fontSize: 'xx-large' } as never);
    const { container } = await show(message({ html: '<p>Some <b>formatted</b> text</p>' }));
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('data-reading="1.5/0"');
  });
});

describe('forced colours', () => {
  it('dark theme recolours the mail normally', async () => {
    useThemeStore.setState({ resolvedTheme: 'dark' });
    const { container } = await show(message({ html: '<p>Some <b>formatted</b> text</p>' }));
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain(DARK_PENDING_CLASS);
  });

  it('skips our dark recolouring when the browser forces colours', async () => {
    useThemeStore.setState({ resolvedTheme: 'dark' });
    media.matches.add('(forced-colors: active)');
    const { container } = await show(message({ html: '<p>Some <b>formatted</b> text</p>' }));
    const srcdoc = container.querySelector('iframe')!.getAttribute('srcdoc')!;
    expect(srcdoc).not.toContain(DARK_PENDING_CLASS);
    expect(srcdoc).not.toContain('forced-color-adjust');
  });
});

describe('reduce motion inside the mail', () => {
  const html = '<style>@keyframes spin{to{transform:rotate(1turn)}} .s{animation:spin 1s infinite}</style><p class="s">Spinning <b>text</b></p>';
  const srcdoc = async () => (await show(message({ html }))).container.querySelector('iframe')!.getAttribute('srcdoc')!;

  it('stops animations and transitions when reduce motion is on', async () => {
    useSettingsStore.setState({ reduceMotion: 'on' } as never);
    expect(await srcdoc()).toContain('animation-duration:0.01ms!important');
  });

  it('follows the system preference', async () => {
    media.matches.add('(prefers-reduced-motion: reduce)');
    expect(await srcdoc()).toContain('animation-duration:0.01ms!important');
  });

  it('leaves the mail alone when reduce motion is off', async () => {
    media.matches.add('(prefers-reduced-motion: reduce)');
    useSettingsStore.setState({ reduceMotion: 'off' } as never);
    expect(await srcdoc()).not.toContain('animation-duration:0.01ms');
  });
});

describe('mail in the app font and colours', () => {
  const html = '<p style="font-family: Comic Sans MS; color: #ff0; background: #00f">Loud <b>mail</b></p>';
  const srcdoc = async () => (await show(message({ html }))).container.querySelector('iframe')!.getAttribute('srcdoc')!;

  it('leaves the sender styles alone by default', async () => {
    expect(await srcdoc()).not.toContain('background-image:none!important');
  });

  it('replaces them when set to always, and skips the dark recolouring', async () => {
    useThemeStore.setState({ resolvedTheme: 'dark' });
    useSettingsStore.setState({ mailOverrideStyles: 'always' } as never);
    const doc = await srcdoc();
    expect(doc).toContain('background-image:none!important');
    expect(doc).not.toContain(DARK_PENDING_CLASS);
  });

  it('in high contrast mode only, following the system', async () => {
    useSettingsStore.setState({ mailOverrideStyles: 'high-contrast' } as never);
    expect(await srcdoc()).not.toContain('background-image:none!important');
  });

  it('in high contrast mode when the system asks for more contrast', async () => {
    useSettingsStore.setState({ mailOverrideStyles: 'high-contrast' } as never);
    media.matches.add('(prefers-contrast: more)');
    expect(await srcdoc()).toContain('background-image:none!important');
  });

  it('underlines links inside the mail when links are underlined', async () => {
    useSettingsStore.setState({ underlineLinks: true } as never);
    expect(await srcdoc()).toContain('a[href]{text-decoration-line:underline!important}');
  });
});

describe('reading width', () => {
  it('keeps HTML mail to about 80 characters a line, centred, when comfortable', async () => {
    useSettingsStore.setState({ readingWidth: 'comfortable' } as never);
    const { container } = await show(message({ html: '<p>Some <b>formatted</b> text</p>' }));
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('body{max-width:80ch!important;margin-inline:auto!important}');
  });

  it('keeps plain text to about 80 characters a line, centred, when comfortable', async () => {
    useSettingsStore.setState({ readingWidth: 'comfortable' } as never);
    await show(message({ text: 'Plain words here' }));
    const body = screen.getByText('Plain words here').closest('.email-content-text') as HTMLElement;
    expect(body.style.maxWidth).toBe('80ch');
    expect(body.style.marginInline).toBe('auto');
  });

  it('centres the reader view text at about 80 characters a line when comfortable', async () => {
    useSettingsStore.setState({ readingWidth: 'comfortable' } as never);
    await show(message({ html: '<p>Read this in peace.</p>' }));
    await act(async () => { screen.getByRole('button', { name: 'more_actions' }).click(); });
    const readerItem = screen.getAllByRole('menuitem').find((el) => el.textContent?.includes('reader_view'))!;
    await act(async () => { readerItem.click(); });
    const body = screen.getByTestId('reader-view-body');
    expect(body.style.maxWidth).toBe('80ch');
    expect(body.style.marginInline).toBe('auto');
  });

  it('uses the full width by default', async () => {
    const { container } = await show(message({ html: '<p>Some <b>formatted</b> text</p>' }));
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).not.toContain('80ch');
  });
});

describe('HTML mail as plain text', () => {
  it('shows the text part instead of the frame when plain text is the default', async () => {
    useSettingsStore.setState({ mailViewMode: 'plain' } as never);
    const { container } = await show(message({ html: '<p>Fancy <b>HTML</b> version</p>', text: 'The plain version' }));
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText('The plain version')).toBeInTheDocument();
    expect(screen.getByTestId('plain-view-note')).toHaveTextContent('shown_as_plain_text');
  });

  it('converts the HTML, keeping link targets and alt text, when there is no text part', async () => {
    useSettingsStore.setState({ mailViewMode: 'plain' } as never);
    const { container } = await show(message({ html: '<p>Read <a href="https://ex.com/r">the report</a></p><img src="data:image/png;base64,AA==" alt="Chart">' }));
    const body = container.querySelector('.email-content-text')!;
    expect(body.textContent).toContain('Read the report (https://ex.com/r)');
    expect(body.textContent).toContain('[Chart]');
  });

  it('switches one message back to formatted', async () => {
    useSettingsStore.setState({ mailViewMode: 'plain' } as never);
    const { container } = await show(message({ html: '<p>Fancy <b>HTML</b> version</p>', text: 'The plain version' }));
    await act(async () => { screen.getByRole('button', { name: 'show_formatted' }).click(); });
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(screen.queryByTestId('plain-view-note')).toBeNull();
  });

  it('shows HTML mail formatted by default', async () => {
    const { container } = await show(message({ html: '<p>Fancy <b>HTML</b> version</p>', text: 'The plain version' }));
    expect(container.querySelector('iframe')).not.toBeNull();
  });
});

describe('pausing animated images', () => {
  const frameKey = async () => {
    const { container } = await show(message({ html: '<p>Look <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="x"></p>' }));
    return /data-reading="([^"]*)"/.exec(container.querySelector('iframe')!.getAttribute('srcdoc')!)?.[1];
  };

  it('follows reduce motion by default', async () => {
    expect(await frameKey()).not.toContain('/p');
    media.matches.add('(prefers-reduced-motion: reduce)');
    expect(await frameKey()).toContain('/p');
  });

  it('can be turned on or off on its own', async () => {
    useSettingsStore.setState({ pauseAnimatedImages: 'on' } as never);
    expect(await frameKey()).toContain('/p');
    useSettingsStore.setState({ pauseAnimatedImages: 'off', reduceMotion: 'on' } as never);
    expect(await frameKey()).not.toContain('/p');
  });
});

describe('reader toolbar actions', () => {
  async function openMenu() {
    await act(async () => { screen.getByRole('button', { name: 'more_actions' }).click(); });
  }
  const item = (name: string) => screen.getAllByRole('menuitem').find((el) => el.textContent?.includes(name));

  it('switches one HTML message to plain text and back', async () => {
    const { container } = await show(message({ html: '<p>Fancy <b>HTML</b> version</p>', text: 'The plain version' }));
    await openMenu();
    await act(async () => { item('show_as_plain_text')!.click(); });
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText('The plain version')).toBeInTheDocument();
    await openMenu();
    expect(item('show_formatted')).toBeTruthy();
  });

  it('opens the reader view as a dialog that Escape closes, with focus back', async () => {
    await show(message({ html: '<p>Read <a href="https://ex.com/r">this</a> in peace.</p>' }));
    const more = screen.getByRole('button', { name: 'more_actions' });
    await openMenu();
    await act(async () => { item('reader_view')!.click(); });
    const dialog = screen.getByRole('dialog', { name: 'Bonjour' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('reader-view-body').textContent).toContain('Read this (https://ex.com/r) in peace.');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(screen.queryByRole('dialog', { name: 'Bonjour' })).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(document.activeElement === more || more.contains(document.activeElement)).toBe(true);
  });
});

describe('reading mask', () => {
  it('is drawn over the message only when turned on', async () => {
    await show(message({ text: 'Plain words here' }));
    expect(screen.queryByTestId('reading-mask')).toBeNull();
  });

  it('covers the body when on', async () => {
    useSettingsStore.setState({ readingMask: true } as never);
    await show(message({ text: 'Plain words here' }));
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    const mask = screen.getByTestId('reading-mask');
    expect(mask.closest('.email-content-wrapper')).not.toBeNull();
  });
});
