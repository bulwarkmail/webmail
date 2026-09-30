import { describe, expect, it, vi } from 'vitest';
import { takeSetupTokenFromUrl } from '@/lib/setup/url-token';

function take(href: string) {
  const url = new URL(href);
  const history = { state: { k: 1 }, replaceState: vi.fn() };
  const token = takeSetupTokenFromUrl(url, history);
  return { token, history };
}

describe('takeSetupTokenFromUrl', () => {
  it('reads the token from the fragment and clears it from the address bar', () => {
    const { token, history } = take('https://mail.example/setup#token=abc123');
    expect(token).toBe('abc123');
    expect(history.replaceState).toHaveBeenCalledWith({ k: 1 }, '', '/setup');
  });

  it('still accepts the legacy query parameter and keeps other parameters', () => {
    const { token, history } = take('https://mail.example/setup?lang=de&token=abc123');
    expect(token).toBe('abc123');
    expect(history.replaceState).toHaveBeenCalledWith({ k: 1 }, '', '/setup?lang=de');
  });

  it('leaves a URL without a token alone', () => {
    const { token, history } = take('https://mail.example/setup?lang=de');
    expect(token).toBe('');
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});
