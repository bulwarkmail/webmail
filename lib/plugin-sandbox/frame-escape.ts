/**
 * Escape pressed in a slot frame and left alone by the plugin, for the host:
 * keys in a frame never reach the page around it. A dropdown in the frame that
 * closes on Escape prevents the default, and a plugin's own window listener
 * may do so after this one (it is added from an effect, later than this), so
 * the decision waits until the event has been through all of them.
 */
export function frameEscapeListener(send: () => void) {
  return (event: Pick<KeyboardEvent, 'key' | 'isTrusted' | 'defaultPrevented'>): void => {
    if (event.key !== 'Escape' || !event.isTrusted) return;
    setTimeout(() => {
      if (!event.defaultPrevented) send();
    }, 0);
  };
}
