import { SandboxRuntime } from '@/lib/plugin-sandbox/runtime';

// Privileged-tier sandbox route. Identical runtime to /plugin-sandbox, but the
// host loads it into a same-origin (`allow-same-origin`) iframe so the bundle
// gets real `crypto.subtle` + IndexedDB. The trust gate (signature + admin
// approval) is enforced host-side before this route is ever framed; the page
// itself carries no extra privilege.
//
// Must be dynamic so the per-request CSP nonce from proxy.ts is embedded in
// Next's injected hydration/chunk scripts.
export const dynamic = 'force-dynamic';

export default function PrivilegedPluginSandboxPage() {
  return <SandboxRuntime />;
}
