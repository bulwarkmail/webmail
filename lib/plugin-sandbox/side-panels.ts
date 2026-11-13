// How plugins' side panels are named in the rail beside the mail
// (api.ui.setSidePanel): a title and a host icon. The host draws the button
// and the panel's header itself; without a title it shows the plugin's name,
// without an icon a puzzle piece. `rail: false` leaves the button out: the
// plugin opens its panel itself (api.ui.openPanel / togglePanel), e.g. from
// a top bar action.

export interface SidePanelLook {
  title?: string;
  /** Name of a host icon (see components/icons), as for api.ui.setPages. */
  icon?: string;
  /** false: no button in the rail; the panel opens only on the plugin's request. */
  rail?: boolean;
}

export const MAX_SIDE_PANEL_TITLE = 40;
const ICON_RE = /^[A-Za-z0-9-]{1,40}$/;

let looks: ReadonlyMap<string, SidePanelLook> = new Map();
const listeners = new Set<() => void>();

function changed(): void {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

/** Check and store a panel's title and icon (null clears both); throws with a message the plugin sees. */
export function setSidePanel(pluginId: string, value: unknown): void {
  if (value === null || value === undefined) {
    clearSidePanel(pluginId);
    return;
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('ui.setSidePanel: expects { title, icon, rail } or null');
  const raw = value as Record<string, unknown>;
  const look: SidePanelLook = {};
  if (raw.title !== undefined && raw.title !== null) {
    if (typeof raw.title !== 'string') throw new Error('ui.setSidePanel: title must be a string');
    // eslint-disable-next-line no-control-regex -- one line of text
    const title = raw.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (title.length > MAX_SIDE_PANEL_TITLE) throw new Error(`ui.setSidePanel: title has at most ${MAX_SIDE_PANEL_TITLE} characters`);
    if (title) look.title = title;
  }
  if (raw.icon !== undefined && raw.icon !== null) {
    if (typeof raw.icon !== 'string' || !ICON_RE.test(raw.icon)) throw new Error('ui.setSidePanel: icon is invalid');
    look.icon = raw.icon;
  }
  if (raw.rail !== undefined && raw.rail !== null) {
    if (typeof raw.rail !== 'boolean') throw new Error('ui.setSidePanel: rail must be a boolean');
    if (!raw.rail) look.rail = false;
  }
  looks = new Map(looks).set(pluginId, look);
  changed();
}

/** Every plugin's title and icon; a new map after each change, the same one between. */
export function sidePanelLooks(): ReadonlyMap<string, SidePanelLook> {
  return looks;
}

export function clearSidePanel(pluginId: string): void {
  if (!looks.has(pluginId)) return;
  const next = new Map(looks);
  next.delete(pluginId);
  looks = next;
  changed();
}

export function subscribeSidePanels(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// The open panel's frame, kept by PluginSidePanelFrame in the layout so it
// outlives the view drawing the panel (the mail view, a plugin page): each
// view's panel says where its frame goes (`slot`), null when it leaves the
// screen; closing the panel drops the frame.

export interface SidePanelFrame {
  pluginId: string;
  fill: boolean;
  focusRequest: number;
  /** Where the panel on screen wants the frame; null: no panel on screen. */
  slot: HTMLElement | null;
}

let frame: SidePanelFrame | null = null;
/** Counts the plugin's requests to open its panel while its frame lives, so a view switch never changes it. */
let focusRequests = 0;
const frameListeners = new Set<() => void>();

function frameChanged(): void {
  for (const l of frameListeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function sidePanelFrame(): SidePanelFrame | null {
  return frame;
}

export function setSidePanelFrame(next: SidePanelFrame | null): void {
  frame = next;
  // A new frame starts counting again.
  if (!next) focusRequests = 0;
  frameChanged();
}

export function sidePanelFocusRequest(): number {
  return focusRequests;
}

/** The plugin asked to open its panel: the frame is told to take the focus. */
export function requestSidePanelFocus(): void {
  focusRequests += 1;
  frameChanged();
}

/** The panel on screen at `slot` went away: its frame stays, hidden. */
export function leaveSidePanelFrame(slot: HTMLElement): void {
  if (frame?.slot === slot) setSidePanelFrame({ ...frame, slot: null });
}

/** Ends the plugin's kept frame (the plugin unloaded). */
export function dropSidePanelFrame(pluginId: string): void {
  if (frame?.pluginId === pluginId) setSidePanelFrame(null);
}

export function subscribeSidePanelFrame(listener: () => void): () => void {
  frameListeners.add(listener);
  return () => { frameListeners.delete(listener); };
}
