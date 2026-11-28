let current: number | null = null;
const listeners = new Set<() => void>();

function valid(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function getTitleBadge(): number | null {
  return current;
}

export function setTitleBadge(count: number | null): void {
  const next = count === null ? null : valid(count);
  if (next === current) return;
  const previous = current;
  current = next;
  if (next !== null && typeof document !== 'undefined') {
    const old = previous === null ? '' : `(${previous}) `;
    const rest = old && document.title.startsWith(old) ? document.title.slice(old.length) : document.title;
    document.title = withTitleBadge(rest, next);
  }
  listeners.forEach((listener) => listener());
}

export function subscribeTitleBadge(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function withTitleBadge(title: string, count: number | null = current): string {
  return count === null ? title : `(${valid(count)}) ${title}`;
}
