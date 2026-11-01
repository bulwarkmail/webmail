import type { BootSurface } from "@/lib/boot-skeleton/surfaces";
import { MailSkeletonBody } from "./mail-skeleton";
import { CalendarSkeletonBody } from "./calendar-skeleton";
import { ContactsSkeletonBody } from "./contacts-skeleton";
import { FilesSkeletonBody } from "./files-skeleton";
import { SettingsSkeletonBody } from "./settings-skeleton";

/**
 * A surface's content without its frame, for the Pro shell's panes, which
 * host the apps embedded (no rail, no Mountain View shell).
 */
export function SkeletonBody({ surface, embedded = true }: { surface: BootSurface; embedded?: boolean }) {
  switch (surface) {
    case "calendar":
      return <CalendarSkeletonBody embedded={embedded} />;
    case "contacts":
      return <ContactsSkeletonBody embedded={embedded} />;
    case "files":
      return <FilesSkeletonBody embedded={embedded} />;
    case "settings":
      return <SettingsSkeletonBody embedded={embedded} />;
    default:
      return <MailSkeletonBody embedded={embedded} />;
  }
}
