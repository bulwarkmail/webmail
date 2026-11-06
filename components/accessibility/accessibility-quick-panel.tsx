"use client";

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { Accessibility } from '@/components/icons';
import { useAuthStore } from '@/stores/auth-store';
import { useRegisterCommands } from '@/lib/command-registry';
import { lazyComponent } from '@/lib/lazy-component';

// The panel's code comes with its first open: the host only listens until then.
const QuickPanel = lazyComponent(() => import('./accessibility-quick-panel-body').then((m) => m.QuickPanel));

export const ACCESSIBILITY_PANEL_EVENT = 'bulwark:accessibility-panel';

/** Opens the quick accessibility panel from anywhere (rail button, palette). */
export function openAccessibilityPanel(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ACCESSIBILITY_PANEL_EVENT));
}

/**
 * Alt+Shift+A, by physical key so it works on every keyboard layout. A
 * modifier shortcut, so it stays on when single-key shortcuts are off.
 */
export function isAccessibilityPanelShortcut(event: KeyboardEvent): boolean {
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyA';
}

/**
 * The quick accessibility panel: Alt+Shift+A anywhere, the optional rail
 * button, and a small button on the sign-in page, where text size, contrast
 * and motion are needed before anything else.
 */
export function AccessibilityQuickPanelHost() {
  const t = useTranslations('accessibility_panel');
  const [open, setOpen] = useState(false);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const pathname = usePathname();
  const onLoginPage = !isAuthenticated && /(^|\/)login(\/|$)/.test(pathname ?? '');

  useRegisterCommands(t('title'), [
    { id: 'accessibility-panel', label: t('command'), icon: Accessibility, shortcut: 'Alt + Shift + A', keywords: [t('command_keywords')], run: () => setOpen(true) },
  ], isAuthenticated);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isAccessibilityPanelShortcut(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(true);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener(ACCESSIBILITY_PANEL_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener(ACCESSIBILITY_PANEL_EVENT, onOpen);
    };
  }, []);

  return (
    <>
      {onLoginPage && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-4 end-4 z-40 inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm hover:bg-muted"
          style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
          data-testid="login-accessibility-button"
        >
          <Accessibility className="w-4 h-4" aria-hidden="true" />
          {t('button')}
        </button>
      )}
      {open && <QuickPanel isOpen={open} onClose={() => setOpen(false)} signedIn={isAuthenticated} />}
    </>
  );
}
