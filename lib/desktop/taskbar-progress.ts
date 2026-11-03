import { getDesktopBridge } from './bridge';

type ProgressMode = 'normal' | 'indeterminate' | 'paused' | 'error';

/**
 * The taskbar's progress bar: 0 to 1, or null to take it away. Does nothing in a
 * browser, or in a shell with no `os.setProgress`, which arrives with
 * feat/os-integration. When that merges, its setTaskbarProgress can replace this.
 */
export function showTaskbarProgress(progress: number | null, mode?: ProgressMode): void {
  const bridge = getDesktopBridge() as { os?: { setProgress?: (progress: number | null, mode?: ProgressMode) => void } } | null;
  bridge?.os?.setProgress?.(progress, mode);
}
