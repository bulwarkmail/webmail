"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  CalendarEvent,
  Folder,
  Users,
  Keyboard,
  LogOut,
  Mail,
  Moon,
  PenSquare,
  Puzzle,
  Search,
  Settings,
  Sun,
  UserCircle,
  X,
  iconForName,
} from "@/components/icons";
import type { AppIcon } from "@/components/icons";
import { usePathname, useRouter } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useAccountStore } from "@/stores/account-store";
import { useGlobalSearchStore } from "@/stores/global-search-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useThemeStore } from "@/stores/theme-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePluginActions } from "@/components/plugins/plugin-actions";
import { usePluginPages, pluginPageHref } from "@/hooks/use-plugin-pages";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { GlobalSearchPalette } from "@/components/global-search/global-search-palette";
import { isContextMenuOpen } from "@/components/ui/context-menu";
import { runAction } from "@/lib/plugin-sandbox/actions";
import { COMMAND_PALETTE_OPEN_EVENT, KEYBOARD_SHORTCUTS_OPEN_EVENT, parkAppCommand, requestAppCommand, type AppCommand } from "@/lib/app-commands";
import { commandMatches, useRegisteredCommandGroups } from "@/lib/command-registry";
import { shortcutAlternatives } from "@/lib/shortcut-keys";
import { toUnicodeEmail } from "@/lib/idn";
import { isEditableEventTarget, isKeyboardLayerOpen } from "@/lib/keyboard";
import { isSingleKeyHint, isSingleKeyShortcutOff } from "@/lib/single-key-shortcuts";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useMediaQuery } from "@/hooks/use-media-query";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

interface PaletteCommand {
  id: string;
  label: string;
  icon: AppIcon;
  /** Shown after the label: the plugin that added the entry. */
  source?: string;
  /** The heading of the group the command is listed under. */
  group: string;
  keywords?: readonly string[];
  /** Key hint at the end of the row (devices with a keyboard only). */
  shortcut?: string;
  run: () => void;
}

/** The action surface plugins declare palette entries on (api.ui.setActions). */
const surface = "command-palette";

/** Surfaces where the palette does not take Ctrl+K: the Pro shell uses it for global search. */
const isProShell = (pathname: string) => pathname === "/pro" || pathname.startsWith("/pro/");

/**
 * The command palette (Ctrl+K / ⌘K): a searchable list of the app's own
 * commands and of the entries plugins declare for `command-palette`.
 * Mounted once in the locale layout; it only listens while signed in.
 */
export function CommandPaletteHost() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const proShell = isProShell(pathname);
  const enabled = isAuthenticated && !proShell;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      // event.code: the K key on any keyboard layout, Latin or not.
      if (event.code !== "KeyK" && event.key.toLowerCase() !== "k") return;
      if (isEditableEventTarget(event)) return;
      event.preventDefault();
      setOpen((v) => !v);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  // `?` opens the keyboard shortcuts in every app (R8), on the app's own
  // section. Captured before the apps' own key handlers, so Mail's doesn't
  // open a second copy.
  useEffect(() => {
    if (!isAuthenticated) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const question = event.key === "?" || (event.code === "Slash" && event.shiftKey);
      if (!question || isEditableEventTarget(event) || isContextMenuOpen()) return;
      // Another dialog, a menu or a popup is open: the key belongs to it.
      if (event.defaultPrevented || isKeyboardLayerOpen()) return;
      // Turned off with the other single-key shortcuts; the menu and the
      // command palette still open the help.
      if (isSingleKeyShortcutOff(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setShowShortcuts(true);
    };
    const onOpen = () => setShowShortcuts(true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener(KEYBOARD_SHORTCUTS_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener(KEYBOARD_SHORTCUTS_OPEN_EVENT, onOpen);
    };
  }, [isAuthenticated]);

  return (
    <>
      {open && <CommandPalette onClose={() => setOpen(false)} onShowShortcuts={() => setShowShortcuts(true)} />}
      {/* "Search everything" in the standard shell; the Pro shell mounts its own. */}
      {enabled && <GlobalSearchPalette proShell={false} />}
      <KeyboardShortcutsModal isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </>
  );
}

function CommandPalette({ onClose, onShowShortcuts }: { onClose: () => void; onShowShortcuts: () => void }) {
  const t = useTranslations("command_palette");
  const tCommon = useTranslations("common");
  const tSidebar = useTranslations("sidebar");
  const tGlobalSearch = useTranslations("global_search");
  const router = useRouter();
  const pathname = usePathname();
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const client = useAuthStore((s) => s.client);
  const supportsCalendar = useCalendarStore((s) => s.supportsCalendar);
  const isFeatureEnabled = usePolicyStore((s) => s.isFeatureEnabled);
  const colorModeLocked = usePolicyStore((s) => s.getColorModePolicy().locked);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const pluginActions = usePluginActions(surface);
  const pluginPages = usePluginPages();
  const registeredGroups = useRegisteredCommandGroups();
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  // A touch screen has no keyboard to use the shortcuts with (R8).
  const touch = useMediaQuery("(pointer: coarse)");
  // With single-key shortcuts off, "r" or "#" does nothing: no hint for it.
  const singleKeys = useSettingsStore((s) => s.singleKeyShortcuts !== false);
  const hintKeys = (shortcut: string) => shortcutAlternatives(shortcut).filter((key) => singleKeys || !isSingleKeyHint(key));

  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useFocusTrap({ isActive: true, onEscape: onClose, restoreFocus: true, initialFocus: () => inputRef.current });

  const commands = useMemo<PaletteCommand[]>(() => {
    const go = (href: string) => () => router.push(href);
    // Compose and search belong to the mail page: run there, or open mail first.
    const onMail = (command: AppCommand) => () => {
      if (requestAppCommand(command)) return;
      parkAppCommand(command);
      router.push("/");
    };
    const navigation = t("group_navigation");
    const actions = t("group_actions");
    const account = t("group_account");
    // The current app's own commands come first (useRegisterCommands).
    const list: PaletteCommand[] = registeredGroups.flatMap((group) =>
      group.commands.map((command) => ({
        id: `app:${group.label}:${command.id}`,
        group: group.label,
        icon: command.icon ?? Puzzle,
        label: command.label,
        keywords: command.keywords,
        shortcut: command.shortcut,
        run: command.run,
      })),
    );
    list.push({ id: "go-mail", group: navigation, icon: Mail, label: t("go_to", { name: tSidebar("mail") }), run: go("/") });
    if (supportsCalendar && isFeatureEnabled("calendarEnabled")) {
      list.push({ id: "go-calendar", group: navigation, icon: CalendarEvent, label: t("go_to", { name: tSidebar("calendar") }), run: go("/calendar") });
    }
    if ((client?.supportsContacts?.() ?? false) && isFeatureEnabled("contactsEnabled")) {
      list.push({ id: "go-contacts", group: navigation, icon: Users, label: t("go_to", { name: tSidebar("contacts") }), run: go("/contacts") });
    }
    if ((client?.supportsFiles?.() ?? false) && isFeatureEnabled("filesEnabled")) {
      list.push({ id: "go-files", group: navigation, icon: Folder, label: t("go_to", { name: tSidebar("files") }), run: go("/files") });
    }
    // Plugin pages sit next to the built-in apps in the rail and the tab bar.
    for (const page of pluginPages) {
      list.push({
        id: `go-page:${page.pluginId}:${page.id}`,
        group: navigation,
        icon: iconForName(page.icon) ?? Puzzle,
        label: t("go_to", { name: page.title }),
        source: page.pluginName,
        run: go(pluginPageHref(page)),
      });
    }
    // "c" and "/" compose and search only in Mail; another app may give the
    // same keys its own meaning (Calendar: new event, search events), listed
    // with its own commands above.
    const inMail = pathname === "/" || pathname === "" || pathname === "/mail" || pathname.startsWith("/mail/");
    const appKeys = new Set(list.map((c) => c.shortcut).filter(Boolean));
    const mailKey = (key: string) => (inMail && !appKeys.has(key) ? key : undefined);
    list.push(
      { id: "go-settings", group: navigation, icon: Settings, label: t("go_to", { name: tSidebar("settings") }), run: go("/settings") },
      { id: "compose", group: actions, icon: PenSquare, label: t("compose"), shortcut: mailKey("c"), run: onMail("compose") },
      { id: "search", group: actions, icon: Search, label: t("search"), shortcut: mailKey("/"), run: onMail("search") },
      {
        id: "search-everything",
        group: actions,
        icon: Search,
        label: tGlobalSearch("title"),
        keywords: [tSidebar("contacts"), tSidebar("calendar"), tSidebar("files")],
        run: () => useGlobalSearchStore.getState().openPalette(),
      },
    );
    // The theme policy can pin the color mode (#1280).
    if (!colorModeLocked) {
      list.push({
        id: "theme",
        group: actions,
        icon: resolvedTheme === "dark" ? Sun : Moon,
        label: resolvedTheme === "dark" ? t("theme_light") : t("theme_dark"),
        run: () => useThemeStore.getState().setTheme(resolvedTheme === "dark" ? "light" : "dark"),
      });
    }
    if (!touch) {
      list.push({ id: "shortcuts", group: actions, icon: Keyboard, label: t("shortcuts"), shortcut: "?", run: onShowShortcuts });
    }
    // Account: switch to each other signed-in account, sign out.
    for (const entry of accounts) {
      if (entry.id === activeAccountId) continue;
      const name = entry.label || toUnicodeEmail(entry.email || entry.username);
      list.push({
        id: `account:${entry.id}`,
        group: account,
        icon: UserCircle,
        label: t("switch_to", { account: name }),
        keywords: [tSidebar("switch_account"), entry.email],
        run: () => { void useAuthStore.getState().switchAccount(entry.id); },
      });
    }
    // It signs out of the open account only, as the account menu's entry says.
    const current = accounts.find((entry) => entry.id === activeAccountId);
    const currentName = current ? toUnicodeEmail(current.email || current.username) : "";
    list.push({
      id: "sign-out",
      group: account,
      icon: LogOut,
      label: currentName ? tSidebar("sign_out_of", { account: currentName }) : tSidebar("sign_out"),
      run: () => { void useAuthStore.getState().logout(); },
    });
    for (const action of pluginActions) {
      list.push({
        id: `plugin:${action.pluginId}:${action.id}`,
        group: t("group_plugins"),
        icon: iconForName(action.icon) ?? Puzzle,
        label: action.label,
        source: action.pluginName,
        run: () => { void runAction(action, surface, {}); },
      });
    }
    return list;
  }, [client, supportsCalendar, isFeatureEnabled, colorModeLocked, resolvedTheme, pluginActions, pluginPages, registeredGroups, accounts, activeAccountId, router, pathname, t, tSidebar, tGlobalSearch, onShowShortcuts, touch]);

  const needle = query.trim();
  const visible = needle
    ? commands.filter((c) => commandMatches(needle, c.label, [...(c.keywords ?? []), ...(c.source ? [c.source] : [])]))
    : commands;
  const activeIndex = visible.length === 0 ? -1 : Math.min(active, visible.length - 1);

  // Close when the page changes underneath (a "go to" command ran).
  const startPath = useRef(pathname);
  useEffect(() => {
    if (pathname !== startPath.current) onClose();
  }, [pathname, onClose]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const runCommand = useCallback((command: PaletteCommand) => {
    onClose();
    command.run();
  }, [onClose]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (visible.length) setActive((activeIndex + 1) % visible.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (visible.length) setActive((activeIndex - 1 + visible.length) % visible.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, visible.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0) runCommand(visible[activeIndex]);
    } else if ((event.ctrlKey || event.metaKey) && (event.code === "KeyK" || event.key.toLowerCase() === "k")) {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[12vh] max-sm:p-0 max-sm:pt-0"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("title")}
        className={cn(
          "w-full max-w-xl overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl",
          "max-sm:h-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:pt-[var(--app-top-inset)]",
          "flex flex-col",
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-label={t("title")}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder={t("placeholder")}
            autoComplete="off"
            spellCheck={false}
            className="h-12 flex-1 min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-inset"
          />
          <kbd className="hidden sm:inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground">Esc</kbd>
          {/* Full screen on a phone: no backdrop to tap and no Escape key (R4). */}
          <IconButton label={tCommon("close")} size="icon-lg" className="sm:hidden -me-2" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={t("title")}
          className="max-h-[60vh] max-sm:max-h-none max-sm:flex-1 overflow-y-auto py-1"
        >
          {visible.length === 0 && (
            <li role="presentation" className="px-4 py-6 text-center text-sm text-muted-foreground">{t("no_results")}</li>
          )}
          {visible.map((command, index) => {
            const Icon = command.icon;
            const showGroup = index === 0 || visible[index - 1].group !== command.group;
            return (
              <li key={command.id} role="presentation">
                {showGroup && (
                  <div aria-hidden="true" className="px-3 pt-2 pb-1 text-[0.6875rem] font-semibold text-muted-foreground">
                    {command.group}
                  </div>
                )}
                <div
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  data-index={index}
                  data-command-id={command.id}
                  onMouseMove={() => { if (index !== activeIndex) setActive(index); }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => runCommand(command)}
                  className={cn(
                    "mx-1 flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm max-sm:min-h-[44px]",
                    index === activeIndex ? "bg-muted text-foreground" : "text-foreground/90",
                  )}
                >
                  <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <span className="flex-1 min-w-0 truncate">{command.label}</span>
                  {command.source && (
                    <span className="flex-shrink-0 truncate max-w-[40%] text-xs text-muted-foreground">{command.source}</span>
                  )}
                  {command.shortcut && hintKeys(command.shortcut).length > 0 && (
                    // Key hints only where there is a keyboard (R8).
                    <span className="flex-shrink-0 flex items-center gap-1 pointer-coarse:hidden" aria-hidden="true">
                      {hintKeys(command.shortcut).map((key) => (
                        <kbd key={key} className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground">{key}</kbd>
                      ))}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
