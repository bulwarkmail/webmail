import type { RouteSkeleton } from '@/components/boot-skeleton/route-skeleton';

type Messages = Record<string, unknown>;

// lite-intl-assets.tsx as every build but Lite gets it (next.config.ts): the
// server's catalog is there before the first render, so nothing is needed.
export const LITE_ENGLISH: Messages | null = null;
export const LiteRouteSkeleton: typeof RouteSkeleton | null = null;
