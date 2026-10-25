import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { RichTextEditor } from '../rich-text-editor';

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));

vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: () => null,
}));

vi.mock('@/hooks/use-plugin-slot-offers', () => ({
  usePluginSlotOffers: () => [],
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'e1',
    blobId: 'b1',
    threadId: 't1',
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    from: [{ name: 'Alice', email: 'alice@example.com' }],
    to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Hello',
    receivedAt: '2026-01-01T00:00:00Z',
    preview: 'Hello',
    hasAttachment: false,
    size: 100,
    textBody: [],
    htmlBody: [],
    attachments: [],
    bodyValues: {},
    ...overrides,
  } as unknown as Email;
}

describe('Composer and viewer spacing consistency (#1340)', () => {
  it('applies p margin in the EmailViewer iframe stylesheet to match the composer', () => {
    const { container } = render(
      <EmailViewer
        email={makeEmail({
          htmlBody: [{ partId: '1', type: 'text/html' }],
          bodyValues: { '1': { value: '<p>Test line 1</p><p>Test line 2</p>', isTruncated: false } },
        } as never)}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
      />,
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const srcDoc = iframe?.getAttribute('srcdoc') ?? '';
    expect(srcDoc).toContain('p { margin: 0.25rem 0; }');
  });

  it('includes leading-[1.6] class on the RichTextEditor for consistent line-height', () => {
    const { container } = render(
      <RichTextEditor
        content="<p>Test line</p>"
        onChange={() => {}}
      />,
    );

    const editorEl = container.querySelector('.tiptap');
    expect(editorEl).not.toBeNull();
    expect(editorEl?.className).toContain('leading-[1.6]');
  });
});
