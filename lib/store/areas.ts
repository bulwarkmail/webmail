/** Every part of the local store. New areas go here. */

import type { StoreArea } from './area';
import { mailArea } from './mail';

export const STORE_AREAS: readonly StoreArea[] = [mailArea];
