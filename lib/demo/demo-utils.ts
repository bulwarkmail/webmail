let demoIdCounter = 0;

/** Generate a unique demo ID with the given prefix. */
export function generateDemoId(prefix: string = 'demo'): string {
  return `${prefix}-${Date.now()}-${++demoIdCounter}`;
}

/**
 * Generate an ISO date string relative to "now".
 * @param daysOffset - whole days from today
 * @param hoursOffset - additional hours offset (default 0)
 * @param minutesOffset - additional minutes offset (default 0)
 */
export function demoDate(daysOffset: number, hoursOffset: number = 0, minutesOffset: number = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  d.setHours(d.getHours() + hoursOffset, d.getMinutes() + minutesOffset, 0, 0);
  return d.toISOString();
}

/**
 * Generate a local date-time string (YYYY-MM-DDTHH:mm:ss) for JSCalendar "start" fields.
 */
export function demoISODate(daysOffset: number, hours: number = 0, minutes: number = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  d.setHours(hours, minutes, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

/** Deep clone fixture data so in-memory mutations don't corrupt originals. */
export function cloneFixtures<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}
