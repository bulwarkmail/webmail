"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "@/i18n/navigation";
import { openKeyboardShortcuts, parkAppCommand, requestAppCommand, type AppCommand } from "@/lib/app-commands";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { runDesktopCommand, setDesktopBaseState } from "@/lib/desktop/commands";
import { useDesktopPrefs } from "@/lib/desktop/preferences";
import { applySystemAccent } from "@/lib/desktop/system-accent";
import type { DesktopSystemTheme } from "@/lib/desktop/types";
import { canDownloadAnywhere, canPrintAnywhere } from "@/lib/device-policy";
import { useOfflineStore } from "@/lib/offline/state";
import { openNewComposerWindow } from "@/lib/popout/open";
import { isPopoutWindow } from "@/lib/popout/window-role";
import { useAuthStore } from "@/stores/auth-store";
import { useLocaleStore } from "@/stores/locale-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useThemeStore } from "@/stores/theme-store";

/**
 * The webmail's side of what every desktop window needs: runs menu commands nothing
 * else on the page took, tells the shell the language and the device policy, and
 * says how much mail is waiting when the app quits. Renders nothing and does nothing
 * in a browser, where there's no bridge.
 */
export function DesktopHost() {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const singleKeys = useSettingsStore((s) => s.singleKeyShortcuts);
  const writingLanguage = useSettingsStore((s) => s.writingLanguage);
  const uiLocale = useLocaleStore((s) => s.locale);
  const policyLoaded = usePolicyStore((s) => s.loaded);
  const accounts = useAuthStore((s) => s.getAllConnectedClients().size);
  const { restoreWindows } = useDesktopPrefs();
  const theme = useThemeStore((s) => s.theme);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);

  // Commands no surface on the page answers: those work from anywhere in the app.
  useEffect(() => {
    const menu = getDesktopBridge()?.menu;
    if (!menu?.onCommand) return;
    const toMail = (command: AppCommand) => {
      if (requestAppCommand(command)) return;
      parkAppCommand(command);
      routerRef.current.push("/");
    };
    const fallback: Record<string, () => void> = {
      "file.newMessage": () => {
        if (isPopoutWindow()) openNewComposerWindow(useAuthStore.getState().activeAccountId);
        else toMail("compose");
      },
      "edit.search": () => toMail("search"),
      "go.inbox": () => routerRef.current.push("/"),
      "go.mail": () => routerRef.current.push("/"),
      "go.calendar": () => routerRef.current.push("/calendar"),
      "go.contacts": () => routerRef.current.push("/contacts"),
      "go.files": () => routerRef.current.push("/files"),
      "help.shortcuts": () => openKeyboardShortcuts(),
    };
    return menu.onCommand((id) => {
      // A bulwark:// link to a folder.
      if (id.startsWith("link.folder:")) {
        routerRef.current.push(`/mail/folder/${encodeURIComponent(id.slice("link.folder:".length))}`);
        return;
      }
      if (!runDesktopCommand(id)) fallback[id]?.();
    });
  }, []);

  // What's on offer anywhere, and what the organisation allows.
  useEffect(() => {
    if (!getDesktopBridge()?.menu) return;
    const canPrint = canPrintAnywhere();
    const signedIn = isAuthenticated;
    const popout = isPopoutWindow();
    setDesktopBaseState({
      "shortcuts.singleKeys": singleKeys,
      "policy.download": canDownloadAnywhere(),
      "file.print": canPrint,
      "file.savePdf": canPrint,
      "file.newMessage": signedIn,
      "edit.search": signedIn && !popout,
      "go.inbox": signedIn,
      "go.mail": signedIn,
      "go.calendar": signedIn,
      "go.contacts": signedIn,
      "go.files": signedIn,
      "help.shortcuts": true,
    });
  }, [isAuthenticated, singleKeys, policyLoaded, accounts]);

  // Menus and spellcheck follow the interface, and the composer's language too.
  useEffect(() => {
    const shell = getDesktopBridge()?.shell;
    if (!shell?.setLanguages) return;
    const ui = uiLocale || document.documentElement.lang;
    if (!ui) return;
    const composer = writingLanguage && writingLanguage !== "auto" ? [writingLanguage] : [];
    shell.setLanguages({ ui, composer });
  }, [uiLocale, writingLanguage]);

  // The windows' behaviour lives here, the shell only needs its copy.
  useEffect(() => {
    getDesktopBridge()?.windows?.setRestoreEnabled?.(restoreWindows);
  }, [restoreWindows]);

  // Signed in: this window has a session to lend, so pop-outs from last time can open.
  useEffect(() => {
    if (!isAuthenticated || isPopoutWindow()) return;
    getDesktopBridge()?.windows?.sessionReady?.();
  }, [isAuthenticated]);

  // A quit asks for this: mail that hasn't left is worth a question.
  useEffect(() => {
    const lifecycle = getDesktopBridge()?.lifecycle;
    if (!lifecycle || isPopoutWindow()) return;
    return lifecycle.onFlushRequest(async () => ({ unsent: useOfflineStore.getState().outbox.length }));
  }, []);

  // The OS accent colour, while the theme follows the OS.
  useEffect(() => {
    const bridge = getDesktopBridge()?.theme;
    if (!bridge) return;
    const followsSystem = theme === "system" && !activeThemeId;
    const apply = (system: DesktopSystemTheme) => {
      applySystemAccent({
        accent: system.accent,
        highContrast: system.highContrast,
        dark: document.documentElement.classList.contains("dark"),
        followsSystem,
      });
    };
    let cancelled = false;
    void bridge.system?.().then((system) => {
      if (!cancelled) apply(system);
    });
    const stop = bridge.onSystemChange?.(apply);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [theme, resolvedTheme, activeThemeId]);

  return null;
}
