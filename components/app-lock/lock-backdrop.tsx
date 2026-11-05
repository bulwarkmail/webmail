import { MailSkeletonBody } from "@/components/boot-skeleton/mail-skeleton";
import { BottomBarSkeleton, MvTopBarSkeleton, RailSkeleton } from "@/components/boot-skeleton/shell";

/**
 * What lies behind the lock card: the mail page as the boot skeleton draws it (rail,
 * folders, list, reading pane), dimmed and blurred in app/app-lock.css. Shapes only.
 * It reads nothing: no store, no storage, nothing of the app's DOM. The layout comes
 * from the attributes the boot script put on <html> before the first paint (split,
 * horizontal or focus, Mountain View, phone), so it is the user's or the default.
 * The bottom bar gets no labels, so it draws bars there too: no text at all.
 *
 * Not the boot skeleton's own root (AppShellSkeleton): that carries a status message
 * and the data-boot-skeleton mark the probes count, and draws the login card for a
 * signed-out start.
 */
export function LockBackdrop() {
  return (
    <div aria-hidden="true" inert data-app-lock-backdrop="" className="absolute inset-0 overflow-hidden pointer-events-none select-none">
      <div className="flex h-full flex-col overflow-hidden pt-[var(--app-top-inset)] bg-background desk:mv:bg-[var(--mv-canvas)]">
        <MvTopBarSkeleton search className="hidden desk:mv:flex" />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <RailSkeleton active="mail" className="hidden desk:flex desk:mv:hidden" />
          <MailSkeletonBody />
        </div>
        <BottomBarSkeleton active="mail" className="flex desk:hidden max-desk:boot-open:hidden" />
      </div>
    </div>
  );
}
