"use client";

import { Button } from "@/components/ui/button";
import { ContextMenu, CONTEXT_MENU_ITEM_CLASS } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { Check, ChevronDown, iconForName, Puzzle, type AppIcon } from "@/components/icons";
import { usePluginActions } from "@/components/plugins/plugin-actions";
import { runAction } from "@/lib/plugin-sandbox/actions";
import { cn } from "@/lib/utils";

interface ComposerToolbarMenuProps {
  icon: AppIcon;
  label: string;
  /** Number of options that are switched on, shown as a badge on the button. */
  activeCount?: number;
  testId?: string;
  children: (close: () => void) => React.ReactNode;
}

/**
 * A labelled toolbar button that opens a menu (the ContextMenu, so it looks
 * and answers keys like every other menu, R6) above it. The label is always
 * the accessible name; it is only hidden visually on narrow screens.
 */
export function ComposerToolbarMenu({ icon: Icon, label, activeCount = 0, testId, children }: ComposerToolbarMenuProps) {
  const menu = useContextMenu<null>();
  const open = menu.contextMenu.isOpen;
  const close = menu.closeContextMenu;

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        // The press that would close an open menu as a click outside toggles it instead.
        onMouseDown={(e) => { if (open) e.stopPropagation(); }}
        onClick={(e) => {
          if (open) close();
          else menu.openContextMenuFrom(e.currentTarget, null, "start");
        }}
        // 44px on a phone, where 36px was hard to hit with a finger.
        className={cn("h-9 max-md:h-11 max-md:min-w-11 justify-center gap-1.5 px-2 sm:px-2.5", open && "bg-muted")}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
      >
        <Icon className="w-4 h-4" />
        {/* By the bar's width, not the window's: a composer pane on a wide
            screen has no room for the labels either (#1375). */}
        <span className="hidden @[40rem]/composer-bar:inline text-sm">{label}</span>
        {activeCount > 0 && (
          <span className="min-w-4 h-4 rounded-full bg-primary px-1 text-[0.625rem] font-semibold leading-4 text-primary-foreground">
            {activeCount}
          </span>
        )}
        <ChevronDown className="hidden @[40rem]/composer-bar:block w-3.5 h-3.5 text-muted-foreground" />
      </Button>
      <ContextMenu ref={menu.menuRef} isOpen={open} position={menu.contextMenu.position} onClose={close}>
        <div className="min-w-56">{children(close)}</div>
      </ContextMenu>
    </div>
  );
}

interface ItemProps {
  icon?: AppIcon;
  onSelect: () => void;
  testId?: string;
  children: React.ReactNode;
}

export function ComposerToolbarMenuItem({ icon: Icon, onSelect, testId, children }: ItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      data-testid={testId}
      className={CONTEXT_MENU_ITEM_CLASS}
    >
      {Icon ? <Icon className="w-4 h-4 shrink-0" /> : null}
      <span className="flex-1">{children}</span>
    </button>
  );
}

interface CheckItemProps {
  checked: boolean;
  onToggle: () => void;
  description?: string;
  testId?: string;
  children: React.ReactNode;
}

/** A menu entry that stays open on click so several options can be set in one go. */
export function ComposerToolbarMenuCheckItem({ checked, onToggle, description, testId, children }: CheckItemProps) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onToggle}
      data-testid={testId}
      className={cn(CONTEXT_MENU_ITEM_CLASS, "items-start")}
    >
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50"
        )}
        aria-hidden="true"
      >
        {checked && <Check className="w-3 h-3" />}
      </span>
      <span className="flex-1">
        <span className="block">{children}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </span>
    </button>
  );
}

interface RadioItemProps {
  checked: boolean;
  onSelect: () => void;
  testId?: string;
  children: React.ReactNode;
}

/** One choice of a group (message priority); stays open like the check items. */
export function ComposerToolbarMenuRadioItem({ checked, onSelect, testId, children }: RadioItemProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onSelect}
      data-testid={testId}
      className={CONTEXT_MENU_ITEM_CLASS}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-primary" : "border-muted-foreground/50"
        )}
        aria-hidden="true"
      >
        {checked && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className="flex-1">{children}</span>
    </button>
  );
}

interface PluginItemsProps {
  /** A surface of kind 'action' in lib/plugin-slot-catalog.ts. */
  surface: string;
  /** What the click is about; a function is read at click time. */
  context: Record<string, unknown> | (() => Record<string, unknown>);
  /** Called before the plugin gets the click, e.g. to close the menu. */
  onSelect?: () => void;
  /** Draw a separator before the entries (when the menu has its own above). */
  separator?: boolean;
  /** Only while the composer bar is narrower than 44rem (see ComposerPluginToolbarButtons). */
  onlyWhenNarrow?: boolean;
}

/**
 * Buttons plugins declared for the composer's bottom bar
 * (composer-toolbar-actions), drawn like Attach and Templates. An action's
 * shortcut is shown in its tooltip; the composer binds it.
 *
 * The bar is a container (`@container/composer-bar`). Below 44rem there is
 * no room next to the app's own buttons, Discard and Send, so the buttons
 * are hidden and the same actions are listed in the Options menu instead
 * (ComposerPluginMenuItems with `onlyWhenNarrow`).
 * `alwaysVisible` is for a wrapping toolbar without an Options fallback.
 * Options 대체 메뉴가 없는 줄바꿈 툴바는 `alwaysVisible`로 작업을 표시합니다.
 */
export function ComposerPluginToolbarButtons({ surface, context, alwaysVisible = false }: { surface: "composer-toolbar-actions"; context: () => Record<string, unknown>; alwaysVisible?: boolean }) {
  const actions = usePluginActions(surface);
  if (actions.length === 0) return null;
  return (
    <>
      {actions.map((action) => {
        const Icon = iconForName(action.icon) ?? Puzzle;
        const tip = action.shortcut ? `${action.label} (${action.shortcut})` : action.label;
        return (
          <Button
            key={`${action.pluginId}:${action.id}`}
            type="button"
            variant="ghost"
            className={cn("h-9 gap-1.5 px-2 sm:px-2.5", alwaysVisible && "max-w-full", !alwaysVisible && "hidden @[44rem]/composer-bar:inline-flex", action.danger && "text-destructive")}
            title={tip}
            aria-label={action.label}
            aria-keyshortcuts={action.shortcut}
            data-plugin-action={`${action.pluginId}:${action.id}`}
            onClick={() => { void runAction(action, surface, context()); }}
          >
            <Icon className="w-4 h-4 shrink-0" />
            <span className={cn("text-sm", alwaysVisible && "truncate")}>{action.label}</span>
          </Button>
        );
      })}
    </>
  );
}

/** Shows its children only while the composer bar is narrower than 44rem. */
function NarrowOnly({ active, children }: { active: boolean; children: React.ReactNode }) {
  if (!active) return <>{children}</>;
  return <div className="@[44rem]/composer-bar:hidden" data-narrow-only="">{children}</div>;
}

/** Entries plugins declared for a composer menu, drawn like the menu's own. */
export function ComposerPluginMenuItems({ surface, context, onSelect, separator, onlyWhenNarrow }: PluginItemsProps) {
  const actions = usePluginActions(surface);
  if (actions.length === 0) return null;
  return (
    <NarrowOnly active={!!onlyWhenNarrow}>
      {separator && <div role="separator" className="my-1 h-px bg-border" />}
      {actions.map((action) => {
        const Icon = iconForName(action.icon) ?? Puzzle;
        if (action.checked !== undefined) {
          // An option like the menu's own (plain text, read receipt): stays
          // open, so several can be set in one go.
          return (
            <ComposerToolbarMenuCheckItem
              key={`${action.pluginId}:${action.id}`}
              checked={action.checked}
              description={action.description}
              onToggle={() => { void runAction(action, surface, typeof context === "function" ? context() : context); }}
            >
              {action.label}
            </ComposerToolbarMenuCheckItem>
          );
        }
        return (
          <button
            key={`${action.pluginId}:${action.id}`}
            type="button"
            role="menuitem"
            title={action.pluginName}
            onClick={() => {
              onSelect?.();
              void runAction(action, surface, typeof context === "function" ? context() : context);
            }}
            className={cn(CONTEXT_MENU_ITEM_CLASS, action.danger && "text-destructive")}
          >
            <Icon className="w-4 h-4 shrink-0" />
            <span className="flex-1">
              <span className="block">{action.label}</span>
              {action.description && <span className="block text-xs text-muted-foreground">{action.description}</span>}
            </span>
          </button>
        );
      })}
    </NarrowOnly>
  );
}
