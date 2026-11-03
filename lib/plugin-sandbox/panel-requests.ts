// Plugins opening and closing the panel their slot sits in
// (api.ui.openPanel / closePanel / togglePanel): the composer's side panels
// and the reader's detail panel. A toolbar button, a shortcut or a
// right-click entry can then bring the plugin's panel up instead of a
// dialog. The app-side-panel is the panel of Calendar, Contacts, Files and
// Settings (components/plugins/app-side-panel.tsx). The panels subscribe
// here while they are on screen; a request nobody answers (no composer
// open, no message open, a phone) resolves to null, so the plugin can fall
// back to a dialog. Where the app-side-panel can't dock (phones, Settings
// below 1024 px) it answers false and asks the plugin for its dialog.
//
// When a panel opens on request, its slot gets a new `focusRequest` number
// in its props, so the plugin can put the focus where it belongs.

export const PANEL_SLOTS = ['composer-sidebar', 'composer-sidebar-right', 'email-detail-sidebar', 'app-side-panel'] as const;
export type PanelSlot = typeof PANEL_SLOTS[number];
export type PanelMode = 'open' | 'close' | 'toggle';

export interface PanelRequest {
  pluginId: string;
  slot: PanelSlot;
  mode: PanelMode;
  /** For a composer panel: the composer it belongs to (from the plugin's click context or slot props). */
  composerId?: string;
}

/** Answers with the panel's state after the request (true = open), or null when the request is not for it. */
export type PanelRequestHandler = (request: PanelRequest) => boolean | null;

const handlers = new Set<PanelRequestHandler>();

export function onPanelRequest(handler: PanelRequestHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

export function isPanelSlot(value: unknown): value is PanelSlot {
  return typeof value === 'string' && (PANEL_SLOTS as readonly string[]).includes(value);
}

/**
 * Check a plugin's request and deliver it: the panel's state afterwards, or
 * null when no such panel is on screen. Throws with a message the plugin sees.
 */
export function requestPanel(pluginId: string, slot: unknown, mode: unknown, opts: unknown): boolean | null {
  const method = `ui.${mode === 'open' ? 'openPanel' : mode === 'close' ? 'closePanel' : 'togglePanel'}`;
  if (!isPanelSlot(slot)) throw new Error(`${method}: "${String(slot)}" is not a panel (${PANEL_SLOTS.join(', ')})`);
  if (mode !== 'open' && mode !== 'close' && mode !== 'toggle') throw new Error(`${method}: unknown mode`);
  let composerId: string | undefined;
  if (opts !== undefined && opts !== null) {
    if (typeof opts !== 'object') throw new Error(`${method}: options must be an object`);
    const value = (opts as { composerId?: unknown }).composerId;
    if (value !== undefined) {
      if (typeof value !== 'string' || !value) throw new Error(`${method}: options.composerId must be a string`);
      composerId = value;
    }
  }
  const request: PanelRequest = { pluginId, slot, mode, ...(composerId ? { composerId } : {}) };
  for (const handler of handlers) {
    let answer: boolean | null = null;
    try { answer = handler(request); } catch { answer = null; }
    if (answer !== null) return answer;
  }
  return null;
}

/** Test helper. */
export function resetPanelRequests(): void {
  handlers.clear();
}
