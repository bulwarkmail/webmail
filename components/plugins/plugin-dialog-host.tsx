'use client';

// Host-rendered modal for plugin-requested confirm/alert/prompt dialogs.
// Subscribes to the host-dialog queue and renders the head request, one at
// a time. Closing the modal advances the queue. Prompts collect one or more
// (optionally masked) fields so plugins never fall back to `window.prompt`,
// which the sandbox blocks.
//
// They look like the app's own dialogs: a custom dialog (api.ui.openDialog)
// is the filter editor's layout, with the plugin's buttons (kit
// DialogButtons) drawn by the host in its footer; confirm, alert and prompt
// are the app's ConfirmDialog and PromptDialog. A custom dialog opened with
// `anchor: 'trigger'` is a popover beside the control the user clicked
// (dialog-anchor.ts), with a one-line header naming the plugin. `fill: true`
// gives either form a fixed height the plugin's frame fills (a chat), so an
// anchored, filled dialog is a tall popover beside the control.
//
// In the desktop app a confirm or alert is a window of its own instead
// (lib/desktop/dialog-window.ts), with the same parts: the title, the
// "From the plugin" line, the ⋮ menu and the buttons. A prompt is the page's
// own card in a window of its own (dialog-surface.tsx). Custom dialogs stay
// over the page: the plugin's frame talks to the page's window, and in
// another window its messages would go to that window instead.

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { cancelForPlugin, head, overlay, resolveDialog, subscribe, type DialogRequest } from '@/lib/plugin-sandbox/host-dialog';
import { placePopover, POPOVER_MARGIN, trackTriggers, type AnchorRect } from '@/lib/plugin-sandbox/dialog-anchor';
import type { DialogButtonSpec } from '@/lib/plugin-sandbox/ui-kit/dialog-buttons';
import { usePluginStore } from '@/stores/plugin-store';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { toast } from '@/stores/toast-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ContextMenu, ContextMenuItem } from '@/components/ui/context-menu';
import { useContextMenu } from '@/hooks/use-context-menu';
import { iconForName, Loader2, MoreVertical, Power, Puzzle, X } from '@/components/icons';
import { cn } from '@/lib/utils';
import { askInWindow, dialogWindowsAvailable } from '@/lib/desktop/dialog-window';
import { DialogSurfacePortal, useDialogSurface } from '@/components/ui/dialog-surface';
import { PluginIframeSlot } from './plugin-iframe-slot';
import type { SlotName } from '@/lib/plugin-types';

// Lightweight **bold** support in plugin dialog messages. Everything else is
// rendered literally (newlines come from the parent's white-space: pre-wrap).
// Splitting on the ** delimiter yields alternating plain/bold segments (odd
// indices are bold). Plugins control these strings, so the delimiters balance.
function renderMessage(message?: string): React.ReactNode {
  if (!message) return null;
  return message.split('**').map((seg, i) =>
    i % 2 === 1
      ? <strong key={i}>{seg}</strong>
      : <React.Fragment key={i}>{seg}</React.Fragment>,
  );
}

export function PluginDialogHost(): React.JSX.Element | null {
  const base = useSyncExternalStore(subscribe, head, () => null);
  const top = useSyncExternalStore(subscribe, overlay, () => null);
  const t = useTranslations('plugins.dialog');

  // What the user clicked last, for a dialog that opens beside it.
  useEffect(() => trackTriggers(), []);

  // Say so when a plugin was turned off for failing; otherwise it just
  // stops working with no hint why.
  useEffect(() => {
    const onDisabled = (e: Event) => {
      const id = (e as CustomEvent<{ pluginId: string }>).detail?.pluginId;
      const name = usePluginStore.getState().plugins.find((p) => p.id === id)?.name ?? id;
      if (id) toast.warning(t('toast_auto_disabled', { name }));
    };
    window.addEventListener('plugin:auto-disabled', onDisabled);
    return () => window.removeEventListener('plugin:auto-disabled', onDisabled);
  }, [t]);

  return (
    <>
      {base && (inWindow(base)
        ? <PluginDialogWindow key={base.id} current={base} layer={top ? 'below' : 'only'} />
        : <PluginDialogView key={base.id} current={base} layer={top ? 'below' : 'only'} />)}
      {top && (inWindow(top)
        ? <PluginDialogWindow key={top.id} current={top} layer="above" />
        : <PluginDialogView key={top.id} current={top} layer="above" />)}
    </>
  );
}

/** A confirm or alert, in the desktop app: a window of its own. */
function inWindow(request: DialogRequest): boolean {
  return (request.kind === 'confirm' || request.kind === 'alert') && dialogWindowsAvailable();
}

const TURN_OFF = 'turn-off';

/**
 * A plugin's confirm or alert in a window of the app's own. The host names the plugin
 * in the window's own line, which the plugin's text can't change, and the ⋮ menu
 * still turns it off. If the shell refuses, the dialog is drawn in the page.
 */
function PluginDialogWindow({ current, layer }: { current: DialogRequest; layer: 'only' | 'below' | 'above' }): React.JSX.Element | null {
  const t = useTranslations('plugins.dialog');
  const pluginName = usePluginStore((s) => s.plugins.find((p) => p.id === current.pluginId)?.name);
  const disablePlugin = usePluginStore((s) => s.disablePlugin);
  const [refused, setRefused] = useState(false);
  const name = pluginName ?? current.pluginId;

  useEffect(() => {
    if (refused) return;
    const confirm = current.kind === 'confirm';
    const okLabel = current.confirmLabel ?? (confirm ? t('confirm') : t('ok'));
    const buttons = confirm
      ? [{ label: current.cancelLabel ?? t('cancel'), variant: 'secondary' as const }, { label: okLabel, variant: current.danger ? 'destructive' as const : 'primary' as const }]
      : [{ label: okLabel, variant: 'primary' as const }];
    const yes = buttons.length - 1;
    const asked = askInWindow({
      title: current.title || name,
      message: current.message,
      boldMarks: true,
      source: t('from_plugin', { name }),
      buttons,
      // As in the page: a destructive confirm only says yes from its own button.
      defaultIndex: confirm && current.danger ? 0 : yes,
      menu: { label: t('plugin_menu', { name }), items: [{ id: TURN_OFF, label: t('turn_off', { name }), destructive: true }] },
    });
    if (!asked) return;
    let live = true;
    void asked.answer.then((answer) => {
      if (!live) return;
      live = false;
      if (answer === 'failed') {
        setRefused(true);
      } else if (answer && 'menu' in answer && answer.menu === TURN_OFF) {
        cancelForPlugin(current.pluginId);
        disablePlugin(current.pluginId);
      } else {
        resolveDialog(current.id, Boolean(answer && 'button' in answer && answer.button === yes));
      }
    });
    return () => {
      if (!live) return;
      live = false;
      asked.cancel();
    };
  }, [current, name, refused, t, disablePlugin]);

  return refused ? <PluginDialogView current={current} layer={layer} /> : null;
}

const DIALOG_BUTTON_VARIANT = { primary: 'default', secondary: 'outline', ghost: 'ghost', destructive: 'destructive' } as const;
const DIALOG_BUTTON_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
export const MAX_DIALOG_BUTTONS = 4;

/** The buttons a plugin dialog asked for (kit DialogButtons), checked. */
export function readDialogButtons(value: unknown): DialogButtonSpec[] {
  if (!Array.isArray(value)) return [];
  const out: DialogButtonSpec[] = [];
  for (const raw of value.slice(0, MAX_DIALOG_BUTTONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Record<string, unknown>;
    if (typeof b.id !== 'string' || !DIALOG_BUTTON_ID_RE.test(b.id)) continue;
    if (typeof b.label !== 'string') continue;
    // eslint-disable-next-line no-control-regex -- one line of text
    const label = b.label.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 40);
    if (!label) continue;
    const variant = b.variant === 'secondary' || b.variant === 'ghost' || b.variant === 'destructive' ? b.variant : 'primary';
    const icon = typeof b.icon === 'string' && /^[A-Za-z0-9:-]{1,48}$/.test(b.icon) ? b.icon : undefined;
    out.push({
      id: b.id, label, variant,
      ...(b.disabled === true ? { disabled: true } : {}),
      ...(b.busy === true ? { busy: true } : {}),
      ...(icon ? { icon } : {}),
    });
  }
  return out;
}

/**
 * One plugin dialog. `below`: a custom dialog with a confirm or prompt of
 * the same plugin open on top of it; it stays mounted but takes no keys.
 */
function PluginDialogView({ current, layer }: { current: DialogRequest; layer: 'only' | 'below' | 'above' }): React.JSX.Element | null {
  const t = useTranslations('plugins.dialog');
  const titleId = useId();
  const pluginName = usePluginStore((s) => s.plugins.find((p) => p.id === current?.pluginId)?.name);
  const disablePlugin = usePluginStore((s) => s.disablePlugin);
  const resolveThis = (result: unknown) => resolveDialog(current.id, result);

  const isPrompt = current?.kind === 'prompt';
  const fields = useMemo(() => (isPrompt ? current?.fields ?? [] : []), [isPrompt, current]);
  const hasPassword = fields.some((f) => f.type === 'password');

  // Field values for a prompt, re-initialised whenever a new dialog surfaces.
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!current) return;
    const init: Record<string, string> = {};
    for (const f of current.fields ?? []) init[f.name] = '';
    setValues(init);
  }, [current]);

  // Footer buttons of a custom dialog: the plugin declares them, the host
  // draws them and passes each click back as `dialogButtonClick` ({ id, n }).
  const [buttons, setButtons] = useState<DialogButtonSpec[]>([]);
  const viewportHeight = useVisibleHeight(current?.kind === 'custom' && current.fill === true);
  const [buttonClick, setButtonClick] = useState<{ id: string; n: number }>({ id: '', n: 0 });
  const setDialogButtons = useCallback((value: unknown) => { setButtons(readDialogButtons(value)); }, []);
  const pressButton = (id: string) => setButtonClick((c) => ({ id, n: c.n + 1 }));

  // The custom slot's onResult answers its own dialog only; a stray second
  // call after it closed must not resolve the next one in the queue.
  const customProps = useMemo(() => {
    if (current?.kind !== 'custom') return undefined;
    const id = current.id;
    return {
      ...(current.extraProps ?? {}),
      onResult: (value: unknown) => resolveDialog(id, value),
      setDialogButtons,
      dialogButtonClick: buttonClick,
    };
  }, [current, setDialogButtons, buttonClick]);

  const canSubmit = fields.every((f) => !f.required || (values[f.name] ?? '').length > 0);

  const cancel = () => resolveThis(current?.kind === 'prompt' || current?.kind === 'custom' ? null : false);
  const submitPrompt = () => { if (canSubmit) resolveThis(values); };
  const turnOff = () => {
    if (!current) return;
    const id = current.pluginId;
    cancelForPlugin(id);
    disablePlugin(id);
  };

  // A prompt in the desktop app: a window of its own.
  const surface = useDialogSurface(current?.kind === 'prompt' && layer !== 'below', { title: current?.title ?? '', onClose: () => cancel() });
  const surfaceDoc = surface.mode === 'window' ? surface.surface.doc : null;

  useEffect(() => {
    if (!current || layer === 'below') return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        // This closes the dialog and nothing else: an event popover behind it
        // listens for Escape on the window.
        e.stopPropagation();
        cancel();
      } else if (e.key === 'Enter' && (current?.kind === 'confirm' || current?.kind === 'alert')) {
        // For prompts, Enter is handled by the form (so it respects required
        // validation and works from within an input); confirm/alert accept.
        // Custom dialogs resolve only via their own onResult callback or the
        // host's X/Escape - an Enter press has no defined meaning for them.
        // On a button Enter is that button's: Cancel must not answer yes. And
        // a destructive confirm only says yes from its own button.
        if ((e.target as Element | null)?.closest?.('button') || current.danger) return;
        e.preventDefault();
        resolveThis(true);
      }
    }
    const doc = surfaceDoc ?? document;
    doc.addEventListener('keydown', onKey, true);
    return () => doc.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, canSubmit, values, surfaceDoc]);

  // Tab stays in the dialog and the focus goes back to what opened it. The
  // first field of a prompt takes the focus, a confirm's safe button (Cancel
  // when it is destructive), else the first control. A dialog under another
  // one lets go. Escape is the listener above.
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useFocusTrap({
    isActive: !!current && layer !== 'below' && surface.mode !== 'pending',
    restoreFocus: true,
    initialFocus: () => {
      if (current?.kind === 'prompt') return panelRef.current?.querySelector<HTMLElement>('input');
      if (current?.kind === 'confirm' && current.danger) return cancelButtonRef.current;
      if (current?.kind === 'confirm' || current?.kind === 'alert') return confirmButtonRef.current;
      return undefined;
    },
  });

  const anchor = current?.kind === 'custom' ? current.anchor : undefined;
  const place = usePopoverPlace(anchor, panelRef);

  if (!current || surface.mode === 'pending') return null;
  const inWindow = surface.mode === 'window';

  const name = pluginName ?? current.pluginId;
  const confirmLabel = current.confirmLabel ?? (current.kind === 'alert' ? t('ok') : current.kind === 'prompt' ? t('submit') : t('confirm'));
  const cancelLabel = current.cancelLabel ?? t('cancel');
  const custom = current.kind === 'custom';
  const fill = custom && current.fill === true;
  // A filled dialog is as tall as the visible window lets it be (a phone's
  // keyboard takes its share), centred or as a popover alike.
  const fillHeight = Math.min(640, Math.round(viewportHeight * 0.9) - 16);

  // Plugins choose the title, however long: it scrolls within its own part of
  // the dialog, so it can't push the line below and the buttons out of it.
  const titleClass = 'max-h-[30vh] overflow-y-auto text-lg font-semibold text-foreground [overflow-wrap:anywhere]';
  // Who is asking, under the title: plugins choose the title and message, so
  // the host names the plugin in a place the plugin can't change.
  const attribution = (
    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground" data-plugin-dialog-source="">
      <Puzzle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{t('from_plugin', { name })}</span>
    </p>
  );
  const message = current.message ? (
    <p className="mb-4 whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">
      {renderMessage(current.message)}
    </p>
  ) : null;

  const footer = buttons.length > 0 && (
    <div className={cn('flex flex-wrap items-center justify-end gap-2 border-t border-border', anchor ? 'px-3 py-2' : 'px-6 py-4')} data-plugin-dialog-buttons="">
      {buttons.map((b) => (
        <Button
          key={b.id}
          type="button"
          variant={DIALOG_BUTTON_VARIANT[b.variant ?? 'primary']}
          size={anchor ? 'sm' : undefined}
          disabled={b.disabled || b.busy}
          aria-busy={b.busy || undefined}
          className="gap-1.5"
          onClick={() => pressButton(b.id)}
        >
          {b.busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <FooterIcon name={b.icon} />}
          {b.label}
        </Button>
      ))}
    </div>
  );
  const frame = (
    <PluginIframeSlot
      pluginId={current.pluginId}
      slot={(current.slot ?? 'plugin-dialog') as SlotName}
      extraProps={customProps}
      fill={fill}
    />
  );

  // Beside the control the user clicked: no backdrop, no big header. The
  // plugin is still named in the host's own line, with the way to turn it
  // off; a click outside or Escape closes it as the dialog's X does.
  if (anchor) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-hidden={layer === 'below' ? true : undefined}
        className="fixed inset-0 z-[100000]"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) cancel();
        }}
        data-plugin-dialog-popover=""
        // A list the frame asks for is drawn in here (plugin-iframe-slot.tsx).
        data-plugin-dialog-layer=""
      >
        <div
          ref={panelRef}
          className="absolute flex flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl animate-in fade-in zoom-in-95 duration-150"
          style={{
            left: place?.left ?? 0,
            top: place?.top ?? 0,
            visibility: place ? undefined : 'hidden',
            width: `min(${current.width ?? 560}px, calc(100vw - ${2 * POPOVER_MARGIN}px))`,
            maxHeight: `calc(100vh - ${2 * POPOVER_MARGIN}px)`,
            ...(fill ? { height: fillHeight } : {}),
          }}
          data-plugin-dialog={current.pluginId}
        >
          <div className="flex items-center gap-1 border-b border-border ps-3 pe-1 py-0.5">
            <h2 id={titleId} className="sr-only">{current.title || name}</h2>
            <p className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground" data-plugin-dialog-source="">
              <Puzzle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{t('from_plugin', { name })}</span>
            </p>
            <PluginDialogMenu name={name} onTurnOff={turnOff} compact />
          </div>
          <div className={cn('min-h-0 flex-1', fill ? 'flex flex-col overflow-hidden' : 'overflow-y-auto')}>{frame}</div>
          {footer}
        </div>
      </div>
    );
  }

  const tree = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-hidden={layer === 'below' ? true : undefined}
      // In its own window there is no backdrop: the window behind can't be used meanwhile.
      className={inWindow
        ? 'flex max-h-full w-full items-center justify-center'
        : layer === 'above'
          ? 'fixed inset-0 z-[100001] flex items-center justify-center bg-black/30 p-4'
          : 'fixed inset-0 z-[100000] flex items-center justify-center bg-black/50 backdrop-blur-[1px] p-4 animate-in fade-in duration-150'}
      onMouseDown={inWindow ? undefined : (e) => {
        if (e.target === e.currentTarget) cancel();
      }}
      // A list the frame asks for is drawn in here (plugin-iframe-slot.tsx).
      data-plugin-dialog-layer=""
    >
      <div
        ref={panelRef}
        className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl animate-in zoom-in-95 duration-200"
        style={fill
          ? { maxWidth: current.width ?? 560, height: fillHeight }
          : { maxWidth: custom ? (current.width ?? 560) : 448, maxHeight: '90vh' }}
        data-plugin-dialog={current.pluginId}
      >
        {custom ? (
          <>
            <div className="flex items-start gap-1 px-6 py-4 border-b border-border">
              <div className="min-w-0 flex-1 pe-2">
                <h2 id={titleId} className={titleClass}>{current.title}</h2>
                {attribution}
              </div>
              <PluginDialogMenu name={name} onTurnOff={turnOff} />
              <button
                type="button"
                onClick={cancel}
                aria-label={t('close')}
                className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <div className={cn('min-h-0 flex-1 px-6 py-4', fill ? 'flex flex-col overflow-hidden' : 'overflow-y-auto')}>
              {message}
              {frame}
            </div>
            {footer}
          </>
        ) : (
          <>
            <div className="flex shrink-0 items-start gap-1 px-6 pt-6" data-dialog-drag="">
              <div className="min-w-0 flex-1 pe-2">
                <h2 id={titleId} className={titleClass}>{current.title}</h2>
                {attribution}
              </div>
              <PluginDialogMenu name={name} onTurnOff={turnOff} />
            </div>
            {/* A long message scrolls here, under the title and over the buttons.
                The panel itself clips: the focus on a button would scroll the
                title away for good. A stop for Tab, so the arrow keys can scroll it. */}
            {isPrompt ? (
              <form onSubmit={(e) => { e.preventDefault(); submitPrompt(); }} className="flex min-h-0 flex-1 flex-col">
                <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-3" tabIndex={message ? 0 : undefined}>
                  {message}
                  <div className="mb-6 flex flex-col gap-4">
                    {fields.map((f) => (
                      <label key={f.name} className="block">
                        <span className="text-sm font-medium mb-1 block text-foreground">
                          {f.label}{f.required && <span className="text-destructive" aria-hidden="true"> *</span>}
                        </span>
                        <Input
                          type={f.type === 'password' ? 'password' : 'text'}
                          value={values[f.name] ?? ''}
                          placeholder={f.placeholder}
                          aria-required={f.required || undefined}
                          autoComplete={f.type === 'password' ? 'off' : undefined}
                          onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                        />
                      </label>
                    ))}
                    {hasPassword && (
                      <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-foreground">{t('password_note', { name })}</p>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center justify-end gap-3 px-6 pb-6">
                  <Button type="button" variant="outline" onClick={cancel}>{cancelLabel}</Button>
                  <Button type="submit" disabled={!canSubmit}>{confirmLabel}</Button>
                </div>
              </form>
            ) : (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-3" tabIndex={message ? 0 : undefined}>{message}</div>
                <div className={cn('flex shrink-0 items-center justify-end gap-3 px-6 pb-6', !current.message && 'mt-3')}>
                  {current.kind === 'confirm' && (
                    <Button ref={cancelButtonRef} type="button" variant="outline" onClick={cancel}>{cancelLabel}</Button>
                  )}
                  <Button
                    ref={confirmButtonRef}
                    type="button"
                    variant={current.danger ? 'destructive' : 'default'}
                    onClick={() => resolveThis(true)}
                  >
                    {confirmLabel}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
  return surface.mode === 'window' ? <DialogSurfacePortal surface={surface.surface}>{tree}</DialogSurfacePortal> : tree;
}

/**
 * Where a popover dialog's panel stands: measured before it paints and again
 * when its content (the plugin's frame) or the window changes size.
 */
function usePopoverPlace(anchor: AnchorRect | undefined, panelRef: React.RefObject<HTMLElement | null>): { left: number; top: number } | null {
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const update = () => {
      const r = panel.getBoundingClientRect();
      const next = placePopover(
        anchor,
        { width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight },
        document.documentElement.dir === 'rtl',
      );
      setPlace((p) => (p && p.left === next.left && p.top === next.top ? p : next));
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(panel);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [anchor, panelRef]);
  return place;
}

/** A footer button's icon by name; unknown names show none. */
/** The height of what the window shows now (the visual viewport, without a phone's keyboard), followed while `on`. */
function useVisibleHeight(on: boolean): number {
  const read = () => (typeof window === 'undefined' ? 800 : Math.round(window.visualViewport?.height ?? window.innerHeight));
  const [height, setHeight] = useState(read);
  useEffect(() => {
    if (!on || typeof window === 'undefined') return;
    const update = () => setHeight(read());
    update();
    const target = window.visualViewport ?? window;
    target.addEventListener('resize', update);
    return () => target.removeEventListener('resize', update);
  }, [on]);
  return height;
}

function FooterIcon({ name }: { name?: string }) {
  const Glyph = name ? iconForName(name) : null;
  return Glyph ? <Glyph className="w-4 h-4" aria-hidden="true" /> : null;
}

/** The "⋯" menu in a plugin dialog's header: the way out of a plugin that keeps asking. */
function PluginDialogMenu({ name, onTurnOff, compact }: { name: string; onTurnOff: () => void; compact?: boolean }) {
  const t = useTranslations('plugins.dialog');
  const menu = useContextMenu<null>();
  const open = menu.contextMenu.isOpen;
  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={(e) => (open ? menu.closeContextMenu() : menu.openContextMenuFrom(e.currentTarget, null, 'end'))}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('plugin_menu', { name })}
        title={t('plugin_menu', { name })}
        className={cn(compact ? 'p-1' : 'p-1.5', 'rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground', open && 'bg-muted text-foreground')}
      >
        <MoreVertical className={compact ? 'w-4 h-4' : 'w-5 h-5'} />
      </button>
      <ContextMenu ref={menu.menuRef} isOpen={open} position={menu.contextMenu.position} onClose={menu.closeContextMenu} label={t('plugin_menu', { name })}>
        <ContextMenuItem
          icon={Power}
          label={t('turn_off', { name })}
          destructive
          onClick={() => { menu.closeContextMenu(); onTurnOff(); }}
        />
      </ContextMenu>
    </div>
  );
}
