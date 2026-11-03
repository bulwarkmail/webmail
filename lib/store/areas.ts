/** Every part of the local store. New areas go here. */

import type { StoreArea } from './area';
import { calendarArea } from './calendar';
import { mailArea } from './mail';
import { outboxArea } from './outbox';

export const STORE_AREAS: readonly StoreArea[] = [mailArea, outboxArea, calendarArea];
