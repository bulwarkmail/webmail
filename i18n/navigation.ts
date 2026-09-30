import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';
import { IS_LITE_STALWART } from '@/lib/lite';
import { MountedLink, useMountedPathname, useMountedRouter } from './mounted-navigation';

const navigation = createNavigation(routing);

// The Stalwart Lite bundle is mounted wherever the admin's `urlPrefix` says,
// which no build-time basePath can know: its navigation adds and strips the
// runtime prefix (i18n/mounted-navigation.tsx). Every other build uses
// next-intl's helpers unchanged.
export const Link = (IS_LITE_STALWART ? MountedLink : navigation.Link) as typeof navigation.Link;
export const usePathname = (IS_LITE_STALWART ? useMountedPathname : navigation.usePathname) as typeof navigation.usePathname;
export const useRouter = (IS_LITE_STALWART ? useMountedRouter : navigation.useRouter) as typeof navigation.useRouter;
export const { redirect } = navigation;
