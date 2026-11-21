// Parts of the app a plugin's dropdown list never covers
// (components/plugins/plugin-iframe-slot.tsx draws the list).

import type { SlotName } from '../plugin-types';

/**
 * The parts that tell the user whose mail this is and what the app vouches
 * for (the reader's subject, sender, recipients and details, its own security
 * and trust banners and cards; the reader's toolbar; the banners plugins draw
 * in the reader; the app's top bar and account switcher). Any element can opt
 * in with this one attribute.
 */
export const LIST_AVOID_ATTRIBUTE = 'data-plugin-list-avoid';

/**
 * The reader's banner slots: around the subject and sender, and above the
 * message body (where the S/MIME and OpenPGP plugins show their verdicts).
 * Each banner frame there, and each such slot as a whole, carries
 * LIST_AVOID_ATTRIBUTE: one plugin's list never lies over another plugin's
 * banner.
 */
export const READER_BANNER_SLOTS: ReadonlySet<SlotName> = new Set<SlotName>(['reader-header', 'reader-below-subject', 'email-banner', 'thread-summary']);
