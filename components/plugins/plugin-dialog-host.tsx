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
// are the app's ConfirmDialog and PromptDialog.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { cancelForPlugin, head, overlay, resolveDialog, subscribe, type DialogRequest } from '@/lib/plugin-sandbox/host-dialog';
import type { DialogButtonSpec } from '@/lib/plugin-sandbox/ui-kit/dialog-buttons';
import { usePluginStore } from '@/stores/plugin-store';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { toast } from '@/stores/toast-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { iconForName, Loader2, MoreVertical, Power, Puzzle, X } from '@/components/icons';
import { cn } from '@/lib/utils';
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
      {base && <PluginDialogView key={base.id} current={base} layer={top ? 'below' : 'only'} />}
      {top && <PluginDialogView key={top.id} current={top} layer="above" />}
    </>
  );
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

  useEffect(() => {
    if (!current || layer === 'below') return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter' && (current?.kind === 'confirm' || current?.kind === 'alert')) {
        // For prompts, Enter is handled by the form (so it respects required
        // validation and works from within an input); confirm/alert accept.
        // Custom dialogs resolve only via their own onResult callback or the
        // host's X/Escape - an Enter press has no defined meaning for them.
        e.preventDefault();
        resolveThis(true);
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, canSubmit, values]);

  // Tab stays in the dialog and the focus goes back to what opened it. The
  // first field of a prompt takes the focus, a confirm's safe button (Cancel
  // when it is destructive), else the first control. A dialog under another
  // one lets go. Escape is the listener above.
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useFocusTrap({
    isActive: !!current && layer !== 'below',
    restoreFocus: true,
    initialFocus: () => {
      if (current?.kind === 'prompt') return panelRef.current?.querySelector<HTMLElement>('input');
      if (current?.kind === 'confirm' && current.danger) return cancelButtonRef.current;
      if (current?.kind === 'confirm' || current?.kind === 'alert') return confirmButtonRef.current;
      return undefined;
    },
  });

  if (!current) return null;

  const name = pluginName ?? current.pluginId;
  const confirmLabel = current.confirmLabel ?? (current.kind === 'alert' ? t('ok') : current.kind === 'prompt' ? t('submit') : t('confirm'));
  const cancelLabel = current.cancelLabel ?? t('cancel');
  const custom = current.kind === 'custom';

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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-hidden={layer === 'below' ? true : undefined}
      className={layer === 'above'
        ? 'fixed inset-0 z-[100001] flex items-center justify-center bg-black/30 p-4'
        : 'fixed inset-0 z-[100000] flex items-center justify-center bg-black/50 backdrop-blur-[1px] p-4 animate-in fade-in duration-150'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        ref={panelRef}
        className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl animate-in zoom-in-95 duration-200"
        style={custom && current.fill
          // As tall as the visible window lets it be (a phone's keyboard takes its share).
          ? { maxWidth: current.width ?? 560, height: Math.min(640, Math.round(viewportHeight * 0.9) - 16) }
          : { maxWidth: custom ? (current.width ?? 560) : 448, maxHeight: '90vh' }}
        data-plugin-dialog={current.pluginId}
      >
        {custom ? (
          <>
            <div className="flex items-start gap-1 px-6 py-4 border-b border-border">
              <div className="min-w-0 flex-1 pe-2">
                <h2 id={titleId} className="text-lg font-semibold text-foreground [overflow-wrap:anywhere]">{current.title}</h2>
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
            <div className={cn('min-h-0 flex-1 px-6 py-4', current.fill ? 'flex flex-col overflow-hidden' : 'overflow-y-auto')}>
              {message}
              <PluginIframeSlot
                pluginId={current.pluginId}
                slot={(current.slot ?? 'plugin-dialog') as SlotName}
                extraProps={customProps}
                fill={current.fill === true}
              />
            </div>
            {buttons.length > 0 && (
              <div className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-border" data-plugin-dialog-buttons="">
                {buttons.map((b) => (
                  <Button
                    key={b.id}
                    type="button"
                    variant={DIALOG_BUTTON_VARIANT[b.variant ?? 'primary']}
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
            )}
          </>
        ) : (
          <>
            <div className="flex items-start gap-1 px-6 pt-6">
              <div className="min-w-0 flex-1 pe-2">
                <h2 id={titleId} className="text-lg font-semibold text-foreground [overflow-wrap:anywhere]">{current.title}</h2>
                {attribution}
              </div>
              <PluginDialogMenu name={name} onTurnOff={turnOff} />
            </div>
            <div className="px-6 pt-3 pb-6">
              {message}
              {isPrompt ? (
                <form onSubmit={(e) => { e.preventDefault(); submitPrompt(); }}>
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
                  <div className="flex items-center justify-end gap-3">
                    <Button type="button" variant="outline" onClick={cancel}>{cancelLabel}</Button>
                    <Button type="submit" disabled={!canSubmit}>{confirmLabel}</Button>
                  </div>
                </form>
              ) : (
                <div className={cn('flex items-center justify-end gap-3', !current.message && 'mt-3')}>
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
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
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
function PluginDialogMenu({ name, onTurnOff }: { name: string; onTurnOff: () => void }) {
  const t = useTranslations('plugins.dialog');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);
  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('plugin_menu', { name })}
        title={t('plugin_menu', { name })}
        className={cn('p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground', open && 'bg-muted text-foreground')}
      >
        <MoreVertical className="w-5 h-5" />
      </button>
      {open && (
        <div role="menu" className="absolute end-0 top-full z-10 mt-1 min-w-[200px] rounded-md border border-border bg-background py-1 shadow-lg">
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onTurnOff(); }}
            className="w-full px-3 py-1.5 text-sm text-start flex items-center gap-2 transition-colors duration-150 text-destructive hover:bg-destructive/10 focus:outline-none focus:bg-destructive/10"
          >
            <Power className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1">{t('turn_off', { name })}</span>
          </button>
        </div>
      )}
    </div>
  );
}
