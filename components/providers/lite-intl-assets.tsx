import enCommon from '@/locales/en/common.json';
import enPlain from '@/locales/en/plain.json';
import { RouteSkeleton } from '@/components/boot-skeleton/route-skeleton';
import { withPlainLanguage } from '@/i18n/plain-language';

type Messages = Record<string, unknown>;

/**
 * What IntlProvider needs before it has a catalog, which only happens in the
 * Lite export (no server hands it one): English, with its plain wording, and
 * the page skeletons. Every other build swaps this module for
 * lite-intl-assets.off.ts (next.config.ts), so their first script carries
 * neither; the server's catalog already holds English (i18n/catalog.ts).
 */
export const LITE_ENGLISH: Messages | null = withPlainLanguage(enCommon as Messages, enPlain as Messages);
export const LiteRouteSkeleton: typeof RouteSkeleton | null = RouteSkeleton;
