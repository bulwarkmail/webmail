import {
  Accessibility,
  Settings as SettingsIcon,
  Palette,
  User,
  Shield,
  PalmtreeIcon,
  Calendar,
  Filter,
  FolderOpen,
  HardDrive,
  BookUser,
  Bell,
  Puzzle,
  BookOpen,
  PenLine,
  LayoutList,
  Database,
  Users,
  RotateCcw,
  CloudOff,
  EyeOff,
  Info,
  type AppIcon,
} from '@/components/icons';
import type { SettingsSearchTab } from '@/lib/settings-search';

/**
 * The icon of each settings page in the nav. Shared by the settings page and
 * its boot skeleton (components/boot-skeleton/settings-skeleton.tsx), which
 * draws the same icons before any script runs.
 */
export const SETTINGS_TAB_ICONS: Record<SettingsSearchTab, AppIcon> = {
  account: User,
  general: SettingsIcon,
  notifications: Bell,
  appearance: Palette,
  accessibility: Accessibility,
  message_list: LayoutList,
  reading: BookOpen,
  composing: PenLine,
  vacation: PalmtreeIcon,
  filters: Filter,
  organize: FolderOpen,
  security: Shield,
  sharing: Users,
  recovery: RotateCcw,
  calendar: Calendar,
  contacts: BookUser,
  files: HardDrive,
  addons: Puzzle,
  offline: CloudOff,
  privacy: EyeOff,
  backup: Database,
  about: Info,
};

export type SettingsTabGroup = 'top' | 'mail' | 'apps' | 'bottom';

/**
 * The settings nav in order, by group, with every page a server can offer.
 * The settings page leaves out what the account or the admin doesn't have
 * (see the `tabs` list in settings-app.tsx); the skeleton hides those rows
 * from the last session's hints.
 */
export const SETTINGS_NAV_GROUPS: readonly { group: SettingsTabGroup; tabs: readonly SettingsSearchTab[] }[] = [
  { group: 'top', tabs: ['account', 'security', 'privacy', 'sharing', 'notifications', 'general', 'offline', 'appearance', 'accessibility'] },
  { group: 'mail', tabs: ['message_list', 'reading', 'composing', 'organize', 'filters', 'vacation', 'recovery'] },
  { group: 'apps', tabs: ['calendar', 'contacts', 'files', 'addons'] },
  { group: 'bottom', tabs: ['backup', 'about'] },
];
