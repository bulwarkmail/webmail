import type { ReactNode } from 'react';

/** Keep the compact list date, with the precise UTC timestamp on hover. */
export function MessageTimestamp({ value, timeFormat, className, children }: {
  value: string; timeFormat: '12h' | '24h'; className?: string; children: ReactNode;
}) {
  const date = new Date(value);
  const valid = Number.isFinite(date.getTime());
  return <time data-memail-date="" dateTime={valid ? date.toISOString() : undefined}
    title={valid ? date.toLocaleString('en', {
      timeZone: 'UTC',
      year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZoneName: 'short', hour12: timeFormat === '12h',
    }) : undefined} className={className}>{children}</time>;
}
