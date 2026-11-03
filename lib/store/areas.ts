/** Every part of the local store. New areas go here. */

import type { StoreArea } from './area';
import { calendarArea } from './calendar';
import { contactsArea } from './contacts';
import { filesArea } from './files';
import { mailArea } from './mail';
import { outboxArea } from './outbox';
import { remindersArea } from './reminders';

export const STORE_AREAS: readonly StoreArea[] = [mailArea, outboxArea, calendarArea, contactsArea, filesArea, remindersArea];
