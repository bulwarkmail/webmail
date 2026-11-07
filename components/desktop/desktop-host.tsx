"use client";

import { useEffect, useRef } from "react";
import { useLocale, useMessages, useTranslations } from "next-intl";
import { useStrictestDevices } from "@/hooks/use-device-policy";
import { usePathname, useRouter } from "@/i18n/navigation";
import { openKeyboardShortcuts, parkAppCommand, requestAppCommand, type AppCommand } from "@/lib/app-commands";
import { onComposerOpened, composerIsOpen } from "@/lib/compose-flush-registry";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { runDesktopCommand, setDesktopBaseState } from "@/lib/desktop/commands";
import { dictionaryDownloadAllowed } from "@/lib/desktop/dictionary-download";
import { noteComposerLanguage, setDesktopInterfaceLanguage, shellLabels } from "@/lib/desktop/languages";
import { openLinkFromNativeMenu } from "@/lib/desktop/open-link";
import { listenForDesktopPrintRequests } from "@/lib/desktop/print";
import { printCopyInDesktop } from "@/stores/print-store";
import { readDesktopPrefs, setDesktopPref, useDesktopPrefs } from "@/lib/desktop/preferences";
import { applySystemAccent } from "@/lib/desktop/system-accent";
import type { DesktopSystemTheme } from "@/lib/desktop/types";
import { canDownloadAnywhere, canExportAnywhere, canPrintAnywhere } from "@/lib/device-policy";
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
import { showFirstStartNotice } from "@/lib/first-start-notices";
import { openMailImport } from "@/stores/mail-transfer-store";
import { askAndChangeConnection } from "@/lib/desktop/change-connection";

/** The part of the app a path shows, for the menus: Calendar has its own View lines, and no Message menu. */
export function desktopSectionOf(pathname: string): "mail" | "calendar" | "contacts" | "files" | "settings" {
  const first = pathname.split("/").filter(Boolean)[0] ?? "";
  if (first === "calendar" || first === "contacts" || first === "files" || first === "settings") return first;
  return "mail";
}

/**
 * The webmail's side of what every desktop window needs: runs menu commands nothing
 * else on the page took, tells the shell the language and the device policy, and
 * says how much mail is waiting when the app quits. Renders nothing and does nothing
 * in a browser, where there's no bridge.
 */
export function DesktopHost() {
  const router = useRouter();
  const pathname = usePathname();
  const routerRef = useRef(router);
  routerRef.current = router;
  const t = useTranslations();
  const tRef = useRef(t);
  tRef.current = t;

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const singleKeys = useSettingsStore((s) => s.singleKeyShortcuts);
  const writingLanguage = useSettingsStore((s) => s.writingLanguage);
  const uiLocale = useLocaleStore((s) => s.locale);
  const activeLocale = useLocale();
  const messages = useMessages();
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
      // The other apps' New items, run once that app is on screen.
      "file.newEvent": () => {
        if (requestAppCommand("new-event")) return;
        parkAppCommand("new-event");
        routerRef.current.push("/calendar");
      },
      "file.newTask": () => {
        if (requestAppCommand("new-task")) return;
        parkAppCommand("new-task");
        routerRef.current.push("/calendar");
      },
      "file.newContact": () => {
        if (requestAppCommand("new-contact")) return;
        parkAppCommand("new-contact");
        routerRef.current.push("/contacts");
      },
      "file.import": () => openMailImport(),
      // File > Add account…: the sign-in form for another account, as the switcher's item.
      "file.addAccount": () => routerRef.current.push("/login?mode=add-account"),
      // File > Change connection…: asks in the app's own window first, then restarts.
      "file.switchMode": () => {
        const translate = tRef.current;
        void askAndChangeConnection({
          title: translate("ux_p3_settings.connection.title"),
          message: translate("ux_p3_settings.connection.message"),
          confirm: translate("ux_p3_settings.connection.confirm"),
          cancel: translate("common.cancel"),
        });
      },
      // File > Import > Calendar… and Contacts…: that app's own import, once it's on screen.
      "file.importCalendar": () => {
        if (requestAppCommand("import-calendar")) return;
        parkAppCommand("import-calendar");
        routerRef.current.push("/calendar");
      },
      "file.importContacts": () => {
        if (requestAppCommand("import-contacts")) return;
        parkAppCommand("import-contacts");
        routerRef.current.push("/contacts");
      },
      "go.inbox": () => routerRef.current.push("/"),
      "go.mail": () => routerRef.current.push("/"),
      "go.calendar": () => routerRef.current.push("/calendar"),
      "go.contacts": () => routerRef.current.push("/contacts"),
      "go.files": () => routerRef.current.push("/files"),
      // Help > Settings: a page of this window, as the rail's gear opens it.
      "go.settings": () => routerRef.current.push("/settings"),
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
    const section = desktopSectionOf(pathname ?? "/");
    setDesktopBaseState({
      "link.check": true,
      "mail.searchText": signedIn && !popout,
      "shortcuts.singleKeys": singleKeys,
      "policy.download": canDownloadAnywhere(),
      // The shell's backstop for Save as… (os-save-open.ts): no exporting mail on any account.
      "policy.export": canExportAnywhere(),
      "file.print": canPrint,
      "file.savePdf": canPrint,
      "file.newMessage": signedIn,
      "file.newEvent": signedIn,
      "file.newTask": signedIn,
      "file.newContact": signedIn,
      "file.import": signedIn && !popout,
      "file.addAccount": signedIn && !popout,
      "file.switchMode": !popout,
      "file.importCalendar": signedIn && !popout,
      "file.importContacts": signedIn && !popout,
      "file.settings": signedIn,
      [`section.${section}`]: true,
      // Search mail. Calendar, Contacts and Files search themselves, and say so while they can.
      "edit.search": signedIn && !popout && (section === "mail" || section === "settings"),
      "go.inbox": signedIn,
      "go.mail": signedIn,
      "go.calendar": signedIn,
      "go.contacts": signedIn,
      "go.files": signedIn,
      "help.shortcuts": true,
    });
  }, [isAuthenticated, singleKeys, strictest, pathname]);

  // Menus, the tray and spellcheck follow the interface: the language its text is in now,
  // with that text. The stored choice isn't it: on the first render the catalog can still
  // be the one the server picked from the OS language, and the chosen one lands a render
  // later. Going by the choice alone left the menus in the OS language for good.
  useEffect(() => {
    const ui = activeLocale || uiLocale || document.documentElement.lang;
    if (ui) setDesktopInterfaceLanguage(ui, shellLabels(tRef.current as unknown as Parameters<typeof shellLabels>[0]));
  }, [activeLocale, uiLocale, messages]);

  // File > Print and Ctrl+P: the app's own print preview of this page's print copy.
  useEffect(() => listenForDesktopPrintRequests(() => { void printCopyInDesktop(null); }), []);

  // What the user writes in, whichever composer asks for it too.
  useEffect(() => {
    noteComposerLanguage("settings", writingLanguage && writingLanguage !== "auto" ? writingLanguage : null);
  }, [writingLanguage]);

  // A language with no checker in the OS needs a dictionary from Google: once a composer
  // is open, a first-start notice asks, never in no-third-party mode, and not again once
  // closed. Until a yes, the shell has nowhere to fetch from at all. Windows never asks:
  // it checks spelling itself (the shell's context-menu.ts).
  useEffect(() => {
    const spellcheck = getDesktopBridge()?.spellcheck;
    if (!spellcheck) return;
    if (readDesktopPrefs().dictionaryDownload === "yes" && dictionaryDownloadAllowed()) spellcheck.allowDownload();
    const waiting = new Set<string>();
    const offer = () => {
      const [language] = waiting;
      if (!language || !composerIsOpen() || !dictionaryDownloadAllowed()) return;
      if (readDesktopPrefs().dictionaryDownload !== "ask") return;
      const translate = tRef.current;
      let name = language;
      try {
        name = new Intl.DisplayNames([document.documentElement.lang || "en"], { type: "language" }).of(language) ?? language;
      } catch {
        // The tag itself will do.
      }
      showFirstStartNotice({
        id: "dictionary-download",
        text: translate("desktopUi.spellcheck.offer", { language: name }),
        action: {
          label: translate("desktopUi.spellcheck.download"),
          onClick: () => {
            setDesktopPref("dictionaryDownload", "yes");
            if (dictionaryDownloadAllowed()) spellcheck.allowDownload();
          },
        },
        // Closed without a yes: asked once, not again.
        onClose: () => {
          if (readDesktopPrefs().dictionaryDownload === "ask") setDesktopPref("dictionaryDownload", "no");
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
