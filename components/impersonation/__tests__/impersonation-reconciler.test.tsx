import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createJSONStorage } from 'zustand/middleware';
import * as browserNavigation from '@/lib/browser-navigation';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { ImpersonationReconciler } from '../impersonation-reconciler';
import { IMPERSONATION_MARKER_COOKIE } from '@/lib/impersonation/marker-cookie';

const previous = {
  id: 'old@mail.example', label: 'old', serverUrl: 'https://mail.example', username: 'old', authMode: 'basic' as const,
  rememberMe: true, cookieSlot: 0, displayName: 'old', email: 'old@mail.example', isConnected: true, hasError: false,
  lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};

function signedInAsPrevious() {
  useAccountStore.setState({ accounts: [previous], activeAccountId: previous.id, defaultAccountId: previous.id });
  useAuthStore.setState({
    isAuthenticated: true, authMode: 'basic', rememberMe: true, serverUrl: previous.serverUrl,
    username: previous.username, activeAccountId: previous.id,
  });
}

/** What checkAuth does while the reconciler waits for the reload. */
function liveStoresWriteBack() {
  useAccountStore.getState().updateAccount(previous.id, { lastLoginAt: 2 });
  useAuthStore.setState({ isLoading: false, activeAccountId: previous.id });
}

function cookieSet(): boolean {
  return document.cookie.split(';').some((c) => c.trim().startsWith(`${IMPERSONATION_MARKER_COOKIE}=`));
}

describe('ImpersonationReconciler', () => {
  let replace: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    // A handoff earlier in this file detached the stores from localStorage.
    useAccountStore.persist.setOptions({ storage: createJSONStorage(() => localStorage) });
    useAuthStore.persist.setOptions({ storage: createJSONStorage(() => localStorage) });
    document.cookie = `${IMPERSONATION_MARKER_COOKIE}=; Max-Age=0; path=/`;
    replace = vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
    signedInAsPrevious();
  });

  afterEach(() => {
    replace.mockRestore();
    window.history.replaceState({}, '', '/');
  });

  it('drops the previous account for good after an impersonation handoff', () => {
    window.history.replaceState({}, '', '/en/mail?impersonated=1&x=y');
    document.cookie = `${IMPERSONATION_MARKER_COOKIE}=1; path=/`;
    expect(localStorage.getItem('account-registry')).toContain(previous.id);

    render(<ImpersonationReconciler />);
    liveStoresWriteBack();

    expect(localStorage.getItem('account-registry')).toBeNull();
    expect(localStorage.getItem('auth-storage')).toBeNull();
    expect(cookieSet()).toBe(false);
    expect(replace).toHaveBeenCalledWith('/en/mail?x=y');
  });

  it('ignores the query marker without the cookie the impersonate route sets', () => {
    window.history.replaceState({}, '', '/en/mail?impersonated=1');

    render(<ImpersonationReconciler />);

    expect(replace).not.toHaveBeenCalled();
    expect(localStorage.getItem('account-registry')).toContain(previous.id);
    expect(localStorage.getItem('auth-storage')).toContain(previous.id);
  });
});
