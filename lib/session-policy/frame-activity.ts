/**
 * User input inside plugin frames, for the idle timeout. Input in an iframe
 * never reaches the host window, so the session timeout guard can't see it;
 * the plugin sandbox runtime reports trusted input from its frame instead
 * (lib/plugin-sandbox/runtime.tsx), the host bridge passes it on here, and
 * the guard counts it like input in its own window.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Someone used a plugin frame just now. */
export function reportFrameActivity(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* a listener's own error */
    }
  }
}

/** Calls `listener` on every report; returns the unsubscribe. */
export function onFrameActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
