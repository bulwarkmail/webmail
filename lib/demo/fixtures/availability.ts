/**
 * Free/busy of the Meridian colleagues (Principal/getAvailability). The demo
 * client answers from the events on the demo calendars each person takes
 * part in (fixtures/calendars.ts) plus the blocks here: what is on their own
 * calendars, which Nora can't see but the server counts. Mixed on purpose,
 * so inviting Alice, Bob and Priya to something shows free, busy and
 * tentative side by side.
 */
import type { BusyPeriod } from '@/lib/jmap/types';
import { demoAt } from '../demo-utils';
import { PRINCIPAL } from './directory';

interface Block {
  day: number;
  hour: number;
  minute?: number;
  /** Length in minutes. */
  minutes: number;
  tentative?: boolean;
}

const BLOCKS: Record<string, Block[]> = {
  [PRINCIPAL.alice]: [
    { day: 0, hour: 11, minutes: 60 },
    { day: 0, hour: 14, minutes: 30, tentative: true },
    { day: 1, hour: 9, minute: 30, minutes: 90 },
    { day: 2, hour: 15, minutes: 90 },
    { day: 3, hour: 10, minutes: 60, tentative: true },
  ],
  [PRINCIPAL.bob]: [
    { day: 0, hour: 14, minutes: 90 },
    { day: 1, hour: 10, minutes: 120 },
    { day: 2, hour: 9, minutes: 60, tentative: true },
    { day: 3, hour: 13, minutes: 120 },
  ],
  [PRINCIPAL.priya]: [
    { day: 0, hour: 11, minutes: 30, tentative: true },
    { day: 0, hour: 15, minutes: 60 },
    { day: 1, hour: 16, minutes: 90 },
    { day: 2, hour: 11, minutes: 60 },
    { day: 3, hour: 14, minutes: 60 },
  ],
};

/** The extra busy blocks of one principal, as BusyPeriods. */
export function createDemoBusyBlocks(principalId: string): BusyPeriod[] {
  return (BLOCKS[principalId] ?? []).map((b) => ({
    utcStart: demoAt(b.day, b.hour, b.minute ?? 0),
    utcEnd: demoAt(b.day, b.hour, (b.minute ?? 0) + b.minutes),
    busyStatus: b.tentative ? 'tentative' : 'confirmed',
  }));
}
