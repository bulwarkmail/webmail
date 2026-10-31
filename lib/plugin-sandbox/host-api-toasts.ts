import { toast, useToastStore } from '@/stores/toast-store';
import type { ToastType } from '@/components/ui/toast';

const recentToasts = new Map<string, number[]>();
const progressToasts = new Map<string, { pluginId: string; signal: AbortSignal; release: () => void }>();

/** Bound plugin text before it reaches host UI. 호스트 UI에 전달하기 전에 플러그인 문구를 제한합니다. */
function toastText(value: unknown): string {
  const text = String(value ?? '');
  if (text.length <= 300) return text;
  return text.slice(0, 299) + '…';
}

/** Share the existing five-per-ten-seconds budget across toast kinds.
 * 모든 알림 종류에 기존 10초당 5회 제한을 함께 적용합니다. */
function mayToast(pluginId: string): boolean {
  const now = Date.now();
  const recent = (recentToasts.get(pluginId) ?? []).filter((time) => now - time < 10_000);
  recentToasts.set(pluginId, recent);
  if (recent.length >= 5) return false;
  recent.push(now);
  return true;
}

/** Keep ordinary notices fire-and-forget and burst-limited.
 * 일반 알림은 기존의 비동기 단방향 호출과 빈도 제한을 유지합니다. */
export function showPluginToast(pluginId: string, type: ToastType, message: unknown): void {
  if (mayToast(pluginId)) toast[type](toastText(message));
}

/** Release UI and abort listeners together, including user dismissal.
 * 사용자가 닫은 경우에도 UI와 수명 구독을 함께 해제합니다. */
function releaseProgressToast(id: string): void {
  const entry = progressToasts.get(id);
  if (!entry) return;
  progressToasts.delete(id);
  entry.signal.removeEventListener('abort', entry.release);
  toast.dismiss(id);
}

/** Admit an indeterminate notice owned by one live sandbox frame.
 * 살아 있는 샌드박스 프레임 하나에 속한 불확정 진행 알림을 생성합니다. */
export function showPluginProgressToast(pluginId: string, message: unknown, signal?: AbortSignal): string {
  if (!signal || signal.aborted) throw new Error('Progress toasts require a live sandbox instance');
  const visible = new Set(useToastStore.getState().toasts.map((item) => item.id));
  for (const id of progressToasts.keys()) {
    if (!visible.has(id)) releaseProgressToast(id);
  }
  const active = [...progressToasts.values()].filter((entry) => entry.pluginId === pluginId).length;
  if (active >= 5 || !mayToast(pluginId)) throw new Error('Plugin has too many toasts');
  const id = useToastStore.getState().addToast({
    type: 'info', title: toastText(message), progress: null, duration: 0,
    onDismiss: () => releaseProgressToast(id),
  });
  const release = () => releaseProgressToast(id);
  progressToasts.set(id, { pluginId, signal, release });
  signal.addEventListener('abort', release, { once: true });
  if (signal.aborted) {
    release();
    throw new Error('Progress toasts require a live sandbox instance');
  }
  return id;
}

/** Dismiss only this frame's handle; cleanup is idempotent and never throttled.
 * 현재 프레임의 알림만 닫으며 정리는 반복 호출해도 안전하고 빈도 제한을 받지 않습니다. */
export function dismissPluginToast(pluginId: string, id: unknown, signal?: AbortSignal): void {
  if (typeof id !== 'string') throw new Error('A toast handle is required');
  const entry = progressToasts.get(id);
  if (!entry || entry.pluginId !== pluginId || entry.signal !== signal) return;
  releaseProgressToast(id);
}
