/**
 * What runs plugins: the loader and the sandbox bridge. The plugin store loads
 * this with the first plugin to start (stores/plugin-store.ts), so a page with
 * no plugin running never fetches it.
 */
export { deactivatePlugin, forgetSlotOffers, loadPlugin, setPluginStoreAccessor, setSandboxLocale, setupAutoDisable } from '@/lib/plugin-loader';
export { forEachInstance } from '@/lib/plugin-sandbox/host-bridge';
