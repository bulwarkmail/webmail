// Process-wide queue for plugin-requested host dialogs (confirm / alert /
// prompt). The sandboxed plugin posts a `ui.confirm`/`ui.prompt` API request;
// the host enqueues a dialog here and resolves the awaited Promise after the
// user acts. The `PluginDialogHost` component subscribes and renders one dialog
// at a time. Prompts collect one or more (optionally masked) text fields so a
// plugin never has to fall back to the sandbox-blocked `window.prompt`.

export type DialogKind = 'confirm' | 'alert' | 'prompt' | 'custom';

export interface PromptField {
  /** Key the field's value is returned under. */
  name: string;
  label: string;
  /** `password` masks the input; defaults to `text`. */
  type?: 'text' | 'password';
  placeholder?: string;
  /** Submit is blocked until every required field is non-empty. */
  required?: boolean;
}

/**
 * confirm/alert resolve to a boolean; prompt resolves to a name→value map on
 * submit, or `null` when cancelled.
 */
export type DialogResult = boolean | Record<string, string> | null;

export interface DialogRequest {
  id: string;
  pluginId: string;
  kind: DialogKind;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true, confirm button uses destructive styling. */
  danger?: boolean;
  /** Fields to collect, for `kind === 'prompt'`. */
  fields?: PromptField[];
  /**
   * For `kind === 'custom'`: the plugin's own slot name to render in place of
   * the confirm/prompt body, and the props to pass it. Unlike every other
   * slot mount, this one renders inside `PluginDialogHost`'s real
   * `position: fixed; inset: 0` container at the app root - not a small,
   * CSS-constrained row - so it's the only way a plugin can show a large,
   * fully custom, genuinely clickable UI (see PR discussion / the
   * webdav-storage plugin's folder browser for why this exists at all: a
   * prompt-loop UI works but nobody wants to type folder numbers).
   */
  slot?: string;
  extraProps?: Record<string, unknown>;
  /** Optional width override in px for the dialog box (custom kind only). */
  width?: number;
  /** Called when the dialog closes with its typed result (see DialogResult). */
  resolve: (result: unknown) => void;
}

const queue: DialogRequest[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function enqueueDialog(req: Omit<DialogRequest, 'id'>): { id: string } {
  const entry: DialogRequest = { ...req, id: uid() };
  queue.push(entry);
  notify();
  return { id: entry.id };
}

export function head(): DialogRequest | null {
  return queue[0] ?? null;
}

export function resolveHead(result: unknown): void {
  const entry = queue.shift();
  if (!entry) return;
  try { entry.resolve(result); } catch { /* ignore */ }
  notify();
}

/** The "cancelled" result for a given dialog kind (null for prompt/custom, else false). */
function cancelledResult(kind: DialogKind): unknown {
  return kind === 'prompt' || kind === 'custom' ? null : false;
}

/** Cancel every pending dialog for a plugin (called on unload). */
export function cancelForPlugin(pluginId: string): void {
  let changed = false;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].pluginId === pluginId) {
      const entry = queue[i];
      queue.splice(i, 1);
      try { entry.resolve(cancelledResult(entry.kind)); } catch { /* ignore */ }
      changed = true;
    }
  }
  if (changed) notify();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Internal helper used by host-api to convert a confirm/alert `enqueueDialog`
 * call into a boolean Promise the plugin-side `await` can land on.
 */
export function awaitDialog(req: Omit<DialogRequest, 'id' | 'resolve'>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    enqueueDialog({ ...req, resolve: (r) => resolve(r === true) });
  });
}

/**
 * Prompt variant of `awaitDialog`: resolves to the collected name→value map on
 * submit, or `null` when the user cancels/dismisses.
 */
export function awaitPrompt(req: Omit<DialogRequest, 'id' | 'resolve'>): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    enqueueDialog({ ...req, resolve: (r) => resolve(r && typeof r === 'object' ? (r as Record<string, string>) : null) });
  });
}

/**
 * Custom variant: renders the given plugin slot inside PluginDialogHost's
 * real full-screen container instead of a confirm/prompt form. Resolves to
 * whatever value the slot component passes to its `onResult` prop (an
 * ordinary callback, marshalled across the iframe boundary the same way
 * `composer-attachment-source`'s `onAttach` is), or `null` if the user
 * closes the dialog (X button / Escape) without calling it.
 */
export function awaitCustomDialog(req: Omit<DialogRequest, 'id' | 'resolve' | 'kind'>): Promise<unknown> {
  return new Promise((resolve) => {
    enqueueDialog({ ...req, kind: 'custom', resolve });
  });
}
