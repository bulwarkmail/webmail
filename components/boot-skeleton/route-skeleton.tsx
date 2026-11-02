import type { BootSurface } from "@/lib/boot-skeleton/surfaces";
import type { RailLabels } from "./shell";
import { MailSkeleton } from "./mail-skeleton";
import { CalendarSkeleton } from "./calendar-skeleton";
import { ContactsSkeleton } from "./contacts-skeleton";
import { FilesSkeleton } from "./files-skeleton";
import { PluginPageSkeleton } from "./plugin-page-skeleton";
import { SettingsSkeleton } from "./settings-skeleton";
import { AdminSkeleton } from "./admin-skeleton";
import { ProSkeleton } from "./pro-skeleton";
import { AdminLoginSkeleton, LoginSkeleton } from "./login-skeleton";
import { SetupSkeleton } from "./setup-skeleton";

interface RouteSkeletonProps {
  surface: BootSurface;
  label?: string;
  labels?: RailLabels;
}

/**
 * The skeleton of a whole page, picked by surface. Used where the page is not
 * the one drawing it: a connector link (its destination), the protocol
 * handlers, a Lite page waiting for its message catalog, loading.tsx.
 */
export function RouteSkeleton({ surface, label, labels }: RouteSkeletonProps) {
  switch (surface) {
    case "mail":
      return <MailSkeleton label={label} labels={labels} />;
    case "calendar":
      return <CalendarSkeleton label={label} labels={labels} />;
    case "contacts":
      return <ContactsSkeleton label={label} labels={labels} />;
    case "files":
      return <FilesSkeleton label={label} labels={labels} />;
    case "apps":
      return <PluginPageSkeleton label={label} labels={labels} />;
    case "settings":
      return <SettingsSkeleton label={label} labels={labels} />;
    case "pro":
      return <ProSkeleton label={label} />;
    case "admin":
      return <AdminSkeleton label={label} labels={labels} />;
    case "admin-login":
      return <AdminLoginSkeleton label={label} />;
    case "login":
      return <LoginSkeleton label={label} />;
    case "setup":
      return <SetupSkeleton label={label} />;
  }
}
