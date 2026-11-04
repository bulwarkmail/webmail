import { ArrowLeft, Book, BookUser, ChevronDown, Filter, Menu, Plus, Printer, Square, X } from "@/components/icons";
import type { Density } from "@/lib/density";
import { cn } from "@/lib/cn";
import { Bar, Block, Circle, repeat, textWidth } from "./kit";
import { AppShellSkeleton, type RailLabels } from "./shell";
import { PhoneActionsSkeleton, SearchFieldSkeleton, ToolIcon } from "./toolbar-skeleton";

export interface ContactsSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/**
 * Mountain View's content card on a desktop: the data-mv-card row of the
 * contacts, files and plugin pages, inset 16px from the canvas.
 */
export const MV_CARD_ROW = "desk:mv:mb-4 desk:mv:mx-4 desk:mv:rounded-[var(--mv-card-radius)] desk:mv:bg-background";

const SIDEBAR_ROW_PY = { paddingBlock: "var(--density-sidebar-py, 4px)" } as const;
const CONTACT_ROW_STYLE = {
  gap: "var(--density-item-gap)",
  paddingInline: "16px",
  paddingBlock: "var(--density-item-py)",
} as const;

/**
 * Contact rows as ContactListItem draws them (components/contacts/
 * contact-list-item.tsx): the density's padding and gap, a 32px avatar, a
 * name line and an email line; extra compact drops the avatar and the email.
 * Shared by the page skeleton and the list's own loading state, so the one
 * hands over to the other without a jump.
 *
 * `density` comes from the settings store once the app runs; without it (the
 * server HTML) the boot script's data-boot-density picks the variant. With
 * `letters`, a letter heading leads, as when the list groups by letter.
 */
export function ContactRowsSkeleton({
  density,
  letters = true,
  count = 18,
}: {
  density?: Density;
  letters?: boolean;
  count?: number;
}) {
  const compactHide = density === undefined ? "boot-density-xc:hidden" : density === "extra-compact" ? "hidden" : undefined;
  return (
    <div aria-hidden="true" data-testid="contact-list-skeleton">
      {letters ? (
        // A block, not a flex box: the shape sits on a line of the heading's
        // own font size, so the heading is as tall as a real letter.
        <div className="px-4 py-0.5 text-[0.6875rem] font-medium">
          <span className="sk-shape inline-block align-middle w-2 h-2 rounded-sm" />
        </div>
      ) : null}
      {repeat(count, (i) => (
        <div className="w-full flex items-center border-b border-border" style={CONTACT_ROW_STYLE}>
          <Circle className={cn("w-8 h-8", compactHide)} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center h-5">
              <Bar className="h-3.5" w={textWidth(i, 35, 30)} />
            </div>
            <div className={cn("flex items-center h-4", compactHide)}>
              <Bar className="h-3" w={textWidth(i + 3, 45, 30)} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The categories sidebar (components/contacts/contacts-sidebar.tsx). */
function ContactsSidebarSkeleton() {
  return (
    <div className="flex flex-col h-full bg-secondary">
      <div className="px-3 h-14 box-content border-b border-border flex items-center justify-between flex-shrink-0">
        <Bar className="h-3.5" w="4.5rem" />
        <span className="grid place-items-center w-8 h-8 shrink-0">
          <Plus className="w-4 h-4" />
        </span>
      </div>
      <div className="flex-1 overflow-hidden py-1">
        {/* All contacts: always first, and selected on arrival. */}
        <div
          className="w-full flex items-center gap-2 px-3 text-sm min-h-8 pointer-coarse:min-h-11 bg-accent text-accent-foreground"
          style={SIDEBAR_ROW_PY}
        >
          <BookUser className="w-4 h-4 flex-shrink-0" />
          <span className="flex items-center h-5 flex-1 min-w-0">
            <Bar className="h-3" w="2.5rem" />
          </span>
          <Bar className="h-2.5" w="1rem" />
        </div>
        <div className="mt-2">
          <div className="flex items-center gap-1 px-3 py-1 min-h-10 text-muted-foreground">
            <ChevronDown className="w-3 h-3" />
            <Bar className="h-2.5" w="6rem" />
          </div>
          {repeat(3, (i) => (
            <div className="flex items-center gap-2 ps-5 pe-3 min-h-10 text-muted-foreground">
              <Book className="w-4 h-4 flex-shrink-0" />
              <Bar className="h-3" w={textWidth(i, 30, 30)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The list's toolbar (contact-list.tsx): menu on narrow panes, select, search, print, phone actions. */
function ContactListToolbarSkeleton({ embedded }: { embedded: boolean }) {
  return (
    <div className="border-b border-border bg-background">
      <div className="px-3 h-14 flex items-center">
        <div className="flex items-center gap-1 w-full">
          <ToolIcon icon={Menu} className={embedded ? "hidden" : "lg:hidden"} />
          <ToolIcon icon={Square} />
          <SearchFieldSkeleton trailing={Filter} className="flex-1 min-w-0" />
          <ToolIcon icon={Printer} className={embedded ? undefined : "hidden md:grid"} />
          {embedded ? null : <PhoneActionsSkeleton className="flex desk:hidden" />}
        </div>
      </div>
    </div>
  );
}

/** ContactDetail with nothing open (contact-detail.tsx). */
function EmptyDetailSkeleton() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
      <BookUser className="w-16 h-16 mb-4 opacity-20" />
      <span className="flex items-center h-5">
        <Bar className="h-3.5" w="12rem" />
      </span>
    </div>
  );
}

/**
 * ContactForm for a new contact (contact-form.tsx): its title bar, the photo
 * row, the first fields and the Cancel/Save footer. /contacts/new opens it at
 * once, without waiting for any data.
 */
function NewContactFormSkeleton() {
  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
        <span className="flex items-center h-7">
          <Bar className="h-4" w="7rem" />
        </span>
        <span className="grid place-items-center w-8 h-8 text-muted-foreground">
          <X className="w-4 h-4" />
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="px-6 py-4 max-w-3xl">
          <div className="flex items-center gap-4 pb-4">
            <Circle className="w-20 h-20" />
            <span className="flex items-center h-4 flex-1 min-w-0">
              <Bar className="h-3" w="60%" />
            </span>
          </div>
          <div className="py-5 space-y-3">
            <span className="flex items-center gap-2 h-5">
              <Bar className="h-3.5" w="8rem" />
            </span>
            {repeat(3, () => (
              <div className="space-y-1.5">
                <Bar className="h-3" w="5rem" />
                <Block className="h-10 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border flex-shrink-0">
        <Block className="h-10" w="5.5rem" />
        <Block className="h-10" w="5rem" />
      </div>
    </div>
  );
}

/**
 * The contacts page's own content: everything in the row next to the rail.
 * `embedded` is the variant drawn inside a Pro pane (useIsEmbedded()), which
 * has no rail, no Mountain View shell and fills its pane (h-full).
 *
 * Desktop: sidebar, list and the empty detail. Tablet: the sidebar is a
 * closed drawer and the list toolbar gets its Menu button. Phone: the list
 * with its create button, or, with a contact (data-boot-pane="detail") or the
 * new-contact form ("create") in the URL, the detail with its back bar.
 */
export function ContactsSkeletonBody({ embedded = false }: { embedded?: boolean }) {
  return (
    <div aria-hidden="true" className={cn("flex flex-col flex-1 min-w-0 min-h-0", embedded && "h-full")} data-embedded={embedded ? "" : undefined}>
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        <div
          className={cn(
            "flex-col flex-shrink-0 border-e border-border bg-background w-[var(--boot-contacts-sidebar-w,256px)]",
            embedded ? "flex" : "hidden lg:flex",
          )}
        >
          <ContactsSidebarSkeleton />
        </div>
        <div className="relative flex flex-1 min-w-0 min-h-0">
          <div
            className={cn(
              "relative border-e border-border bg-background flex flex-col flex-shrink-0",
              embedded
                ? "w-[var(--boot-contacts-list-w,384px)]"
                : "max-desk:w-full max-desk:boot-open:hidden desk:w-[var(--boot-contacts-list-w,384px)]",
            )}
          >
            <ContactListToolbarSkeleton embedded={embedded} />
            <div className="flex-1 overflow-hidden">
              <ContactRowsSkeleton />
            </div>
            {embedded ? null : (
              <span className="desk:hidden absolute bottom-4 end-4 z-20 grid place-items-center w-11 h-11 rounded-full shadow-lg bg-primary text-primary-foreground">
                <Plus className="w-5 h-5" />
              </span>
            )}
          </div>
          <div className={cn("flex-1 min-w-0 flex flex-col", !embedded && "max-desk:[:root:not([data-boot-pane])_&]:hidden")}>
            {embedded ? null : (
              <div className="hidden max-desk:block px-3 py-2 border-b border-border">
                <span className="flex items-center h-9 px-3">
                  <ArrowLeft className="w-4 h-4 me-2" />
                  <Bar className="h-3.5" w="7rem" />
                </span>
              </div>
            )}
            <div className={cn("flex-1 min-h-0", !embedded && "boot-create:hidden")}>
              <EmptyDetailSkeleton />
            </div>
            {embedded ? null : (
              <div className="hidden flex-1 min-h-0 boot-create:block">
                <NewContactFormSkeleton />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Skeleton of the contacts page. */
export function ContactsSkeleton({ label, labels }: ContactsSkeletonProps) {
  return (
    <AppShellSkeleton
      surface="contacts"
      label={label}
      labels={labels}
      active="contacts"
      mvMenu={false}
      rowClassName={MV_CARD_ROW}
    >
      <ContactsSkeletonBody />
    </AppShellSkeleton>
  );
}
