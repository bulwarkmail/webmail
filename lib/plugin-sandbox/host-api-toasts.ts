import { toast, useToastStore } from '@/stores/toast-store';
import type { ToastType } from '@/components/ui/toast';

const MAX_TOAST_LENGTH = 300;
const TOASTS_PER_TEN_SECONDS = 5;
const MAX_PROGRESS_TOASTS = 5;

const recentToasts = new Map<string, number[]>();
const progressToasts = new Map<string, { pluginId: string; signal: AbortSignal; release: () => void }>();

function toastText(value: unknown): string {
  const text = String(value ?? '');
  return text.length > MAX_TOAST_LENGTH ? text.slice(0, MAX_TOAST_LENGTH - 1) + '…' : text;
}

/** A plugin may show a few toasts; past that they are dropped, not queued.
 * Progress toasts share this budget. */
function mayToast(pluginId: string): boolean {
  const now = Date.now();
  const recent = (recentToasts.get(pluginId) ?? []).filter((time) => now - time < 10_000);
  recentToasts.set(pluginId, recent);
  if (recent.length >= TOASTS_PER_TEN_SECONDS) return false;
  recent.push(now);
  return true;
}

export function showPluginToast(pluginId: string, type: ToastType, message: unknown): void {
  if (mayToast(pluginId)) toast[type](toastText(message));
}

/** Frees the toast and its slot, also when the user closes it. */
function releaseProgressToast(id: string): void {
  const entry = progressToasts.get(id);
  if (!entry) return;
  progressToasts.delete(id);
  entry.signal.removeEventListener('abort', entry.release);
  toast.dismiss(id);
}

/** Shows a progress toast that belongs to one plugin frame and goes away
 * when that frame is destroyed. */
export function showPluginProgressToast(pluginId: string, message: unknown, signal?: AbortSignal): string {
  if (!signal || signal.aborted) throw new Error('Progress toasts require a live sandbox instance');
  // Drop entries whose toast is gone from the store without onDismiss.
  const visible = new Set(useToastStore.getState().toasts.map((item) => item.id));
  for (const id of progressToasts.keys()) {
    if (!visible.has(id)) releaseProgressToast(id);
  }
  const active = [...progressToasts.values()].filter((entry) => entry.pluginId === pluginId).length;
  if (active >= MAX_PROGRESS_TOASTS || !mayToast(pluginId)) throw new Error('Plugin has too many toasts');
  const id = useToastStore.getState().addToast({
    type: 'info', title: toastText(message), progress: null, duration: 0,
    onDismiss: () => releaseProgressToast(id),
  });
  const release = () => releaseProgressToast(id);
  progressToasts.set(id, { pluginId, signal, release });
  signal.addEventListener('abort', release, { once: true });
  return id;
}

/** Dismisses one of this frame's progress toasts. Repeated calls are harmless
 * and don't count against the toast budget. */
export function dismissPluginToast(pluginId: string, id: unknown, signal?: AbortSignal): void {
  if (typeof id !== 'string') throw new Error('A toast handle is required');
  const entry = progressToasts.get(id);
  if (!entry || entry.pluginId !== pluginId || entry.signal !== signal) return;
  releaseProgressToast(id);
}
