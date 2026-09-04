import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LinkifiedText } from '../linkified-text';

/**
 * A meeting invitation puts the join URL in the event description, so that
 * text has to render its http(s) URLs as real links - while staying plain
 * text: the description is attacker-controlled (anyone can send an iTIP
 * invitation), so no markup in it may ever reach the DOM.
 */

describe('LinkifiedText', () => {
  afterEach(cleanup);

  it('turns a URL in the text into a link that opens in a new tab', () => {
    render(<LinkifiedText text="Join: https://teams.example.com/meet/319560?p=CTYa9 Meeting ID: 319 560" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://teams.example.com/meet/319560?p=CTYa9');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('stops the URL at the closing angle bracket of an <https://...> form', () => {
    render(<LinkifiedText text="Need help? <https://aka.example/JoinMeeting?omkt=fr-FR> | System" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://aka.example/JoinMeeting?omkt=fr-FR');
  });

  it('renders markup in the text as text, never as elements', () => {
    const { container } = render(<LinkifiedText text={'<img src=x onerror=alert(1)> <b>bold</b>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror=alert(1)> <b>bold</b>');
  });

  it('does not linkify non-http schemes', () => {
    const { container } = render(<LinkifiedText text="try javascript:alert(1) or file:///etc/passwd" />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('leaves text without a URL untouched', () => {
    const { container } = render(<LinkifiedText text="no links here" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('no links here');
  });
});
