import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/protocol-handlers/session', () => ({
  // Still asking an open tab whether it takes the message.
  requestOpenMailtoInExistingClient: vi.fn(() => new Promise(() => {})),
  savePendingMailto: vi.fn(),
}));

const { MailtoProtocolClient } = await import('../mailto-protocol-client');

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('mailto handler page', () => {
  // It hands over to the mail page, where the composer opens: it draws that
  // page's skeleton instead of a line of text on a blank page.
  it('draws the mail skeleton with the opening text as its status', () => {
    window.history.replaceState(null, '', '/protocol/mailto?url=mailto%3Aa%40example.com');
    const { container } = render(<MailtoProtocolClient openingText="Opening email…" />);
    const region = container.querySelector('[data-boot-skeleton="mail"]');
    expect(region).not.toBeNull();
    expect(region!.querySelector('[role="status"]')?.textContent).toBe('Opening email…');
  });
});
