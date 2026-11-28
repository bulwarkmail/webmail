import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as browserNavigation from '@/lib/browser-navigation';
import { redirectToLogin } from '../auth-store';

// A link that names the account (?login_hint=) on a page other than the login
// page lost the hint on the way there, so the Email field stayed empty (#1860).

let replaceSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  replaceSpy = vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
});

describe('the way to the login page', () => {
  it('keeps a login_hint from the page it leaves', () => {
    window.history.pushState({}, '', '/en/calendar?login_hint=alice%40example.com&view=week');
    redirectToLogin();
    expect(replaceSpy).toHaveBeenCalledWith('/en/login?login_hint=alice%40example.com');
  });

  it('drops a hint that is no address, and adds nothing without one', () => {
    window.history.pushState({}, '', '/en/mail?login_hint=%3Cscript%3E');
    redirectToLogin();
    window.history.pushState({}, '', '/en/mail?view=all');
    redirectToLogin();
    expect(replaceSpy.mock.calls).toEqual([['/en/login'], ['/en/login']]);
  });
});
