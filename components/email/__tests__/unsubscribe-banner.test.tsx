import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/hooks/use-media-query', () => ({
  useIsDesktop: () => true,
}));

import { UnsubscribeBanner } from '../unsubscribe-banner';

// A List-Unsubscribe mailto: is written by the sender. One click used to
// send whatever it named - several hidden recipients, any subject and body -
// from the user's account, behind a dialog that showed none of it.
describe('UnsubscribeBanner mailto', () => {
  it('shows where the message goes and sends it to that one address only', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    render(
      <UnsubscribeBanner
        listUnsubscribe={{
          mailto: 'mailto:boss@corp.example?to=hr@corp.example&subject=I%20resign&body=Effective%20today',
          preferred: 'mailto',
        }}
        senderEmail="news@evil.example"
        onSendMailtoUnsubscribe={send}
        onDismiss={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('email_viewer.unsubscribe_banner.button'));
    expect(screen.getByText('boss@corp.example')).toBeTruthy();
    expect(screen.getByText('I resign')).toBeTruthy();
    expect(screen.getByText('Effective today')).toBeTruthy();

    fireEvent.click(screen.getByText('email_viewer.unsubscribe_banner.confirm_button'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toEqual({ to: ['boss@corp.example'], subject: 'I resign', body: 'Effective today' });
  });

  it('offers nothing for a mailto: naming several recipients', () => {
    const { container } = render(
      <UnsubscribeBanner
        listUnsubscribe={{ mailto: 'mailto:a@example.com,b@example.com', preferred: 'mailto' }}
        senderEmail="news@example.com"
        onSendMailtoUnsubscribe={vi.fn()}
        onDismiss={() => {}}
      />,
    );
    expect(container.textContent).toBe('');
  });
});

// The https unsubscribe page is a link from the sender like any other in
// the mail: it opened without the plugins' link check.
describe('UnsubscribeBanner https', () => {
  it('opens the page through the link check and stays put when the check says no', async () => {
    const { uiHooks, clearAllHooks } = await import('@/lib/plugin-hooks');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const check = vi.fn(() => false);
    uiHooks.onBeforeExternalLink.register('link-check', check);
    try {
      render(
        <UnsubscribeBanner
          listUnsubscribe={{ http: 'https://evil.example/unsub?u=1', preferred: 'http' }}
          senderEmail="news@evil.example"
          onSendMailtoUnsubscribe={vi.fn()}
          onDismiss={() => {}}
        />,
      );
      fireEvent.click(screen.getByText('email_viewer.unsubscribe_banner.button'));
      fireEvent.click(screen.getByText('email_viewer.unsubscribe_banner.confirm_button'));
      await waitFor(() => expect(check).toHaveBeenCalledWith(expect.objectContaining({ href: 'https://evil.example/unsub?u=1' })));
      await new Promise((r) => setTimeout(r, 10));
      expect(open).not.toHaveBeenCalled();
      expect(screen.queryByText('email_viewer.unsubscribe_banner.success')).toBeNull();
    } finally {
      clearAllHooks();
      open.mockRestore();
    }
  });
});
