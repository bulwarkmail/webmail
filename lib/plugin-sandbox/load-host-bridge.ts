// The sandbox bridge as a chunk, fetched once for every slot that asks: it comes
// with the plugin runtime (stores/plugin-store.ts), so this mostly picks it up.

let loading: Promise<typeof import('./host-bridge')> | null = null;

export function loadHostBridge(): Promise<typeof import('./host-bridge')> {
  loading ??= import('./host-bridge');
  loading.catch(() => { loading = null; });
  return loading;
}
