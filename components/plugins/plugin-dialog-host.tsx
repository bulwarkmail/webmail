'use client';

// Host-rendered modal for plugin-requested confirm/alert/prompt dialogs.
// Subscribes to the host-dialog queue and renders the head request, one at
// a time. Closing the modal advances the queue. Prompts collect one or more
// (optionally masked) fields so plugins never fall back to `window.prompt`,
// which the sandbox blocks.

import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { head, resolveHead, subscribe } from '@/lib/plugin-sandbox/host-dialog';
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
  const current = useSyncExternalStore(subscribe, head, () => null);

  const isPrompt = current?.kind === 'prompt';
  const fields = useMemo(() => (isPrompt ? current?.fields ?? [] : []), [isPrompt, current]);

  // Field values for a prompt, re-initialised whenever a new dialog surfaces.
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!current) return;
    const init: Record<string, string> = {};
    for (const f of current.fields ?? []) init[f.name] = '';
    setValues(init);
  }, [current]);

  const canSubmit = fields.every((f) => !f.required || (values[f.name] ?? '').length > 0);

  const cancel = () => resolveHead(current?.kind === 'prompt' || current?.kind === 'custom' ? null : false);
  const submitPrompt = () => { if (canSubmit) resolveHead(values); };

  useEffect(() => {
    if (!current) return;
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
        resolveHead(true);
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, canSubmit, values]);

  if (!current) return null;

  const confirmLabel = current.confirmLabel ?? (current.kind === 'alert' ? 'OK' : current.kind === 'prompt' ? 'Submit' : 'Confirm');
  const cancelLabel = current.cancelLabel ?? 'Cancel';

  const btnBase: React.CSSProperties = { padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer' };
  const secondaryBtn: React.CSSProperties = { ...btnBase, border: '1px solid var(--color-border, #e2e8f0)', background: 'transparent', color: 'inherit' };
  const primaryBtn: React.CSSProperties = { ...btnBase, border: '1px solid transparent', background: 'var(--color-primary, #3b82f6)', color: 'var(--color-primary-foreground, #fff)' };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="plugin-dialog-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100000,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        style={{
          background: 'var(--color-popover, #fff)',
          color: 'var(--color-popover-foreground, #0f172a)',
          border: '1px solid var(--color-border, #e2e8f0)',
          borderRadius: 12,
          padding: 20,
          maxWidth: current.kind === 'custom' ? (current.width ?? 560) : 480,
          maxHeight: current.kind === 'custom' ? '85vh' : undefined,
          overflowY: current.kind === 'custom' ? 'auto' : undefined,
          width: '92%',
          boxShadow: '0 16px 48px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <h2 id="plugin-dialog-title" style={{ fontSize: 16, fontWeight: 600, margin: '0 0 10px 0' }}>
            {current.title}
          </h2>
          {current.kind === 'custom' && (
            <button
              type="button"
              onClick={cancel}
              aria-label="Close"
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0, color: 'inherit' }}
            >
              ✕
            </button>
          )}
        </div>
        {current.message && (
          <p style={{ fontSize: 13, lineHeight: 1.5, margin: '0 0 16px 0', color: 'var(--color-muted-foreground, #64748b)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {renderMessage(current.message)}
          </p>
        )}
        {current.kind === 'custom' ? (
          <PluginIframeSlot
            pluginId={current.pluginId}
            slot={(current.slot ?? 'plugin-dialog') as SlotName}
            extraProps={{ ...(current.extraProps ?? {}), onResult: (value: unknown) => resolveHead(value) }}
          />
        ) : isPrompt ? (
          <form onSubmit={(e) => { e.preventDefault(); submitPrompt(); }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
              {fields.map((f, i) => (
                <label key={f.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 500 }}>
                    {f.label}{f.required ? ' *' : ''}
                  </span>
                  <input
                    type={f.type === 'password' ? 'password' : 'text'}
                    value={values[f.name] ?? ''}
                    placeholder={f.placeholder}
                    autoFocus={i === 0}
                    autoComplete={f.type === 'password' ? 'off' : undefined}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    style={{
                      fontSize: 13,
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--color-input, var(--color-border, #cbd5e1))',
                      background: 'var(--color-background, #fff)',
                      color: 'inherit',
                      outline: 'none',
                      width: '100%',
                      boxSizing: 'border-box',
                    }}
                  />
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={cancel} style={secondaryBtn}>{cancelLabel}</button>
              <button
                type="submit"
                disabled={!canSubmit}
                style={{ ...primaryBtn, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}
              >
                {confirmLabel}
              </button>
            </div>
          </form>
        ) : (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {current.kind === 'confirm' && (
              <button type="button" autoFocus={!!current.danger} onClick={cancel} style={secondaryBtn}>
                {cancelLabel}
              </button>
            )}
            <button
              type="button"
              autoFocus={current.kind === 'alert' || !current.danger}
              onClick={() => resolveHead(true)}
              style={{
                ...primaryBtn,
                background: current.danger ? 'var(--color-destructive, #dc2626)' : 'var(--color-primary, #3b82f6)',
                color: current.danger ? 'var(--color-destructive-foreground, #fff)' : 'var(--color-primary-foreground, #fff)',
              }}
            >
              {confirmLabel}
            </button>
          </div>
        )}
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--color-muted-foreground, #94a3b8)', textAlign: 'right' }}>
          From plugin: {current.pluginId}
        </div>
      </div>
    </div>
  );
}
