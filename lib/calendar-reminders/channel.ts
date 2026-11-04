/**
 * Telling the other windows that a reminder has been dealt with, so its toast and system
 * notification go there too. What's done is recorded in the store; this only clears what's
 * on screen. Only keys cross it, and they say nothing about the event but its uid.
 */

const CHANNEL_NAME = 'bulwark-calendar-reminders';

interface AcknowledgedMessage {
  kind: 'acknowledged';
  keys: string[];
}

function open(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
}

export function announceAcknowledged(keys: readonly string[]): void {
  const channel = open();
  if (!channel) return;
  channel.postMessage({ kind: 'acknowledged', keys: [...keys] } satisfies AcknowledgedMessage);
  channel.close();
}

export function onAcknowledged(listener: (keys: string[]) => void): () => void {
  const channel = open();
  if (!channel) return () => {};
  channel.onmessage = (event: MessageEvent<AcknowledgedMessage>) => {
    if (event.data?.kind === 'acknowledged' && Array.isArray(event.data.keys)) listener(event.data.keys);
  };
  return () => channel.close();
}
