"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { useStrictestDevices } from "@/hooks/use-device-policy";
import { useRouter } from "@/i18n/navigation";
import { openKeyboardShortcuts, parkAppCommand, requestAppCommand, type AppCommand } from "@/lib/app-commands";
import { onComposerOpened, composerIsOpen } from "@/lib/compose-flush-registry";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { runDesktopCommand, setDesktopBaseState } from "@/lib/desktop/commands";
import { dictionaryDownloadAllowed } from "@/lib/desktop/dictionary-download";
import { noteComposerLanguage, setDesktopInterfaceLanguage, shellLabels } from "@/lib/desktop/languages";
import { openLinkFromNativeMenu } from "@/lib/desktop/open-link";
import { readDesktopPrefs, setDesktopPref, useDesktopPrefs } from "@/lib/desktop/preferences";
import { applySystemAccent } from "@/lib/desktop/system-accent";
import type { DesktopSystemTheme } from "@/lib/desktop/types";
import { canDownloadAnywhere, canPrintAnywhere } from "@/lib/device-policy";
import { useOfflineStore } from "@/lib/offline/state";
import { openNewComposerWindow } from "@/lib/popout/open";
import { onReturnedComposerElsewhere } from "@/lib/popout/return-to-main";
import { isPopoutWindow } from "@/lib/popout/window-role";
import { parkMailSearch, requestMailSearch } from "@/lib/mail-search-request";
import { onBeforeSignOut, onFullSignOut } from "@/lib/sign-out-cleanup";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useLocaleStore } from "@/stores/locale-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useThemeStore } from "@/stores/theme-store";
import { toast } from "@/stores/toast-store";

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
  const t = useTranslations();
  const tRef = useRef(t);
  tRef.current = t;

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const singleKeys = useSettingsStore((s) => s.singleKeyShortcuts);
  const writingLanguage = useSettingsStore((s) => s.writingLanguage);
  const uiLocale = useLocaleStore((s) => s.locale);
  const strictest = useStrictestDevices();
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
      // Open Link in a native menu.
      if (id.startsWith("link.open:")) {
        try {
          const { url, text } = JSON.parse(id.slice("link.open:".length)) as { url: string; text: string };
          void openLinkFromNativeMenu(url, text, useEmailStore.getState().selectedEmail?.id);
        } catch {
          // Only the shell sends this, and it sends JSON.
        }
        return;
      }
      // Search mail for the text selected under a right-click.
      if (id.startsWith("mail.searchText:")) {
        try {
          const text = JSON.parse(id.slice("mail.searchText:".length)) as unknown;
          if (typeof text === "string" && text.trim()) {
            const request = { text: text.trim() };
            if (!requestMailSearch(request)) {
              parkMailSearch(request);
              routerRef.current.push("/");
            }
          }
        } catch {
          // Only the shell sends this, and it sends JSON.
        }
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
      "link.check": true,
      "mail.searchText": signedIn && !popout,
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
  }, [isAuthenticated, singleKeys, strictest]);

  // Menus and spellcheck follow the interface.
  useEffect(() => {
    const ui = uiLocale || document.documentElement.lang;
    if (ui) setDesktopInterfaceLanguage(ui, shellLabels(tRef.current as unknown as Parameters<typeof shellLabels>[0]));
  }, [uiLocale]);

  // What the user writes in, whichever composer asks for it too.
  useEffect(() => {
    noteComposerLanguage("settings", writingLanguage && writingLanguage !== "auto" ? writingLanguage : null);
  }, [writingLanguage]);

  // A language with no checker in the OS needs a dictionary from Google: the composer
  // asks once, and never in no-third-party mode. Until a yes, the shell has nowhere to
  // fetch from at all.
  useEffect(() => {
    const spellcheck = getDesktopBridge()?.spellcheck;
    if (!spellcheck) return;
    if (readDesktopPrefs().dictionaryDownload === "yes" && dictionaryDownloadAllowed()) spellcheck.allowDownload();
    const waiting = new Set<string>();
    const offer = () => {
      const [language] = waiting;
      if (!language || !composerIsOpen() || !dictionaryDownloadAllowed()) return;
      if (readDesktopPrefs().dictionaryDownload !== "ask") return;
      // Asked once, whatever comes of it.
      setDesktopPref("dictionaryDownload", "no");
      const translate = tRef.current;
      let name = language;
      try {
        name = new Intl.DisplayNames([document.documentElement.lang || "en"], { type: "language" }).of(language) ?? language;
      } catch {
        // The tag itself will do.
      }
      toast.info(translate("desktopUi.spellcheck.offer", { language: name }), {
        duration: 0,
        action: {
          label: translate("desktopUi.spellcheck.download"),
          onClick: () => {
            setDesktopPref("dictionaryDownload", "yes");
            if (dictionaryDownloadAllowed()) spellcheck.allowDownload();
          },
        },
      });
    };
    const heard = (language: string) => {
      waiting.add(language);
      offer();
    };
    void spellcheck.missing().then((list) => list.forEach(heard));
    const stopMissing = spellcheck.onMissing(heard);
    const stopComposer = onComposerOpened(offer);
    return () => {
      stopMissing();
      stopComposer();
    };
  }, []);

  // Signed out: nothing of that account stays on the file clipboard.
  useEffect(() => {
    const clipboard = getDesktopBridge()?.clipboard;
    if (!clipboard?.clearFiles) return;
    const clear = () => clipboard.clearFiles?.();
    onFullSignOut(clear);
    onBeforeSignOut(async () => clear());
  }, []);

  // The windows' behaviour lives here, the shell only needs its copy.
  useEffect(() => {
    getDesktopBridge()?.windows?.setRestoreEnabled?.(restoreWindows);
  }, [restoreWindows]);

  // Signed in: this window has a session to lend, for pop-outs from last time, links and
  // quick compose. Signed out: they'd find nothing, and the shell shows this window instead.
  useEffect(() => {
    if (isPopoutWindow()) return;
    const windows = getDesktopBridge()?.windows;
    if (isAuthenticated) windows?.sessionReady?.();
    else windows?.sessionEnded?.();
  }, [isAuthenticated]);

  // A composer coming back from its own window, with no mail page here to take it.
  useEffect(() => {
    if (!getDesktopBridge()?.windows || isPopoutWindow()) return;
    return onReturnedComposerElsewhere(() => routerRef.current.push("/"));
  }, []);

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
