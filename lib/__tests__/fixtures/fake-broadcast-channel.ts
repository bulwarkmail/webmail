/**
 * A same-process BroadcastChannel for tests: what one instance posts reaches
 * every other open instance of that name, on a later task, never the sender.
 */
export class FakeBroadcastChannel {
  static open = new Set<FakeBroadcastChannel>();
  static reset() {
    FakeBroadcastChannel.open.clear();
  }
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(public name: string) {
    FakeBroadcastChannel.open.add(this);
  }
  postMessage(data: unknown) {
    const copy = JSON.parse(JSON.stringify(data));
    for (const other of [...FakeBroadcastChannel.open]) {
      if (other === this || other.name !== this.name) continue;
      setTimeout(() => {
        if (FakeBroadcastChannel.open.has(other)) other.onmessage?.({ data: copy } as MessageEvent);
      }, 0);
    }
  }
  close() {
    FakeBroadcastChannel.open.delete(this);
  }
}
