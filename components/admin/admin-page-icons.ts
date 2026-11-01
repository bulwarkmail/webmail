/**
 * The admin sidebar's icons and group headings. A plain module (no
 * "use client"), so the admin shell and its page skeleton, which the server
 * renders, draw the same list.
 */
import {
  Activity,
  ArrowUpCircle,
  Bell,
  Building2,
  CalendarDays,
  HeartRateMonitor,
  LayoutDashboard,
  LayoutTemplate,
  Palette,
  PenLine,
  Puzzle,
  Scale,
  ScrollText,
  Server,
  Share2,
  Shield,
  ShieldCheck,
  Smartphone,
  Store,
  SwatchBook,
  Tag,
  type AppIcon,
} from '@/components/icons';
import type { AdminPageDef, AdminPageId } from '@/lib/admin/admin-nav';

export const ADMIN_PAGE_ICONS: Record<AdminPageId, AppIcon> = {
  dashboard: LayoutDashboard,
  settings: Server,
  auth: Shield,
  branding: Palette,
  policy: Scale,
  organisation: Building2,
  'org-signatures': PenLine,
  'org-templates': LayoutTemplate,
  'org-security': ShieldCheck,
  'org-sharing': Share2,
  'org-labels': Tag,
  'org-calendars': CalendarDays,
  'org-notices': Bell,
  'org-devices': Smartphone,
  plugins: Puzzle,
  themes: SwatchBook,
  marketplace: Store,
  version: ArrowUpCircle,
  telemetry: Activity,
  monitoring: HeartRateMonitor,
  logs: ScrollText,
};

/** In sidebar order; `top` has no heading. */
export const ADMIN_GROUPS = ['top', 'organisation', 'extensions', 'system'] as const;

export const ADMIN_GROUP_LABELS: Record<AdminPageDef['group'], string | null> = {
  top: null,
  organisation: 'Organisation',
  extensions: 'Extensions',
  system: 'System',
};
