/**
 * The mail page as a skeleton: folder sidebar, message list and reading pane,
 * in each layout the app has (split, horizontal, focus, Mountain View, tablet,
 * phone). Class lists follow the real components (components/mail/mail-app.tsx,
 * components/layout/sidebar.tsx, components/layout/mobile-header.tsx,
 * components/email/thread-list-item.tsx, components/email/email-viewer.tsx),
 * so the page fills in over it without anything moving.
 *
 * The pieces with a `density`/`shape` prop are shared with the loaded app's
 * own loading states (the list's skeleton rows, the sidebar before the
 * folders arrive, the viewer while a message loads). Without those props they
 * pick their variant by CSS from the boot attributes, which is what the page
 * skeleton needs; with them they draw exactly the one the app asks for.
 */
import type { ReactNode } from "react";
import {
  ArrowLeft,
  CalendarEvent,
  ChevronLeft,
  ChevronRight,
  Forward,
  Reply,
  ReplyAll,
  ChevronDown,
  ChevronsLeft,
  Filter,
  Mail,
  Menu,
  MoreVertical,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  Square,
  Star,
  Users,
} from "@/components/icons";
import { cn } from "@/lib/cn";
import type { Density } from "@/lib/density";
import { Bar, Block, Circle, SkeletonRegion, repeat, textWidth } from "./kit";
import { AppShellSkeleton, type RailLabels } from "./shell";

export interface MailSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/** Folder row indent: the row's own start padding and the expand chevron's slot (sidebar.tsx). */
export const FOLDER_ROW_PX_BASE = 8;
export const FOLDER_CHEVRON_SLOT = 20;

/**
 * One line of placeholder text that is exactly as tall as a line of the real
 * text (h-lh: one line-height of its own font size and leading), with the bar
 * centred on it. `className` carries the font size and leading.
 */
function TextLine({ className, w, bar = "h-3" }: { className?: string; w: string; bar?: string }) {
  return (
    <span aria-hidden="true" className={cn("relative block h-lh", className)}>
      <Bar className={cn("absolute inset-y-0 start-0 my-auto", bar)} w={w} />
    </span>
  );
}

// --- Sidebar -----------------------------------------------------------------

/**
 * Folder rows as SidebarRow draws them (sidebar.tsx): text-sm, the density's
 * block padding, a 2px leading stripe, the chevron slot and a 16px icon.
 * Under Mountain View the rows are 32px pills with 20px icons, as
 * globals.css makes the real ones.
 */
export function FolderRowsSkeleton({ count = 7 }: { count?: number }) {
  return (
    <div aria-hidden="true">
      {repeat(count, (i) => (
        <div
          className={cn(
            "w-full flex items-center max-lg:min-h-[44px] text-sm pe-2 border-s-2 border-transparent",
            "mv:min-h-[var(--mv-nav-row-h)] mv:me-3 mv:pe-4 mv:border-s-0",
          )}
          style={{ paddingBlock: "var(--density-sidebar-py)" }}
        >
          <span className="flex-shrink-0" style={{ width: FOLDER_ROW_PX_BASE + FOLDER_CHEVRON_SLOT }} />
          <span className="flex items-center gap-2 mv:gap-[18px] min-w-0 flex-1">
            <span className="flex items-center justify-center flex-shrink-0 w-4 h-4 mv:w-5 mv:h-5">
              <Block className="w-full h-full rounded" />
            </span>
            <TextLine className="flex-1" w={textWidth(i, 35, 30)} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The "Folders" section header (SidebarSectionHeader, first). */
function FolderSectionHeaderSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("w-full flex items-center pb-1 px-3 pt-3", className)}>
      <span className="flex flex-1 min-w-0 items-center">
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <TextLine className="ms-1.5 text-sm font-semibold w-16" w="100%" />
      </span>
      <span className="-my-0.5 h-6 w-6 grid place-items-center text-muted-foreground/70">
        <Settings className="w-3.5 h-3.5" />
      </span>
    </div>
  );
}

function SidebarSkeleton({ embedded }: { embedded: boolean }) {
  return (
    <div
      className={cn(
        "relative flex flex-col h-full border-e overflow-hidden bg-secondary border-border",
        !embedded && "lg:mv:bg-[var(--mv-canvas)] lg:mv:border-transparent",
      )}
    >
      {/* Header: collapse button and account switcher. Hidden in a Pro pane and under Mountain View. */}
      {!embedded && (
        <div className="border-b border-border lg:mv:hidden">
          <div className="flex items-center h-14 gap-1 px-2">
            <span className="hidden lg:flex items-center justify-center h-8 w-8 flex-shrink-0 text-muted-foreground">
              <ChevronsLeft className="w-4 h-4" />
            </span>
            <span className="flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5">
              <Circle className="w-9 h-9" />
              <span className="min-w-0 flex-1">
                <TextLine className="text-sm" w="70%" />
                <TextLine className="text-xs" w="85%" bar="h-2.5" />
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            </span>
          </div>
        </div>
      )}
      {/* Mountain View: the Compose button heads the navigation. */}
      {!embedded && (
        <div className="hidden lg:mv:block pt-2 pb-3 px-3">
          <span className="flex w-fit items-center gap-3 ps-4 pe-6 h-[var(--mv-compose-h,56px)] rounded-2xl bg-[var(--mv-compose-bg)] text-[var(--mv-compose-fg)]">
            <Pencil className="w-6 h-6 flex-shrink-0" />
            <TextLine className="text-sm w-14" w="100%" />
          </span>
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        {/* Mountain View lists the folders without a heading. */}
        <FolderSectionHeaderSkeleton className={embedded ? undefined : "lg:mv:hidden"} />
        <FolderRowsSkeleton />
      </div>
    </div>
  );
}

// --- Message list ------------------------------------------------------------

/** How the list draws its rows (useListRowShape, plus Mountain View's own rows). */
export type MailRowShape = "stacked" | "one-line" | "mv";

interface RowOptions {
  /** Live: the density setting. Left out, the boot attributes decide by CSS. */
  density?: Density;
  /** Live: whether rows show a preview (showPreview). */
  preview?: boolean;
}

/** Classes for the avatar, or null where the density has none. */
function avatarClass(o: RowOptions): string | null {
  if (o.density === undefined) return "boot-xc:hidden";
  return o.density === "extra-compact" ? null : "";
}

/** Classes for the two preview lines, or null where the row has none. */
function previewClass(o: RowOptions): string | null {
  if (o.density === undefined) return "boot-dense:hidden boot-no-preview:hidden";
  return o.preview === false || o.density === "compact" || o.density === "extra-compact" ? null : "";
}

/** A stacked row (ThreadListItem on phones and in the split list). */
function StackedRow({ i, o }: { i: number; o: RowOptions }) {
  const avatar = avatarClass(o);
  const preview = previewClass(o);
  return (
    <div className="border-b border-border max-md:mv:border-b-transparent">
      <div className="bg-background" style={{ minHeight: "var(--list-item-height)" }}>
        <div
          className="px-3 flex items-start"
          style={{ gap: "var(--density-item-gap)", paddingBlock: "var(--density-item-py)" }}
        >
          {avatar !== null && (
            <span className={cn("flex flex-shrink-0 items-center self-stretch", avatar)}>
              <Circle className="w-10 h-10" />
            </span>
          )}
          <span className="block flex-1 min-w-0">
            <span className="flex items-center justify-between gap-2 mb-1">
              <TextLine className="text-sm flex-1" w={textWidth(i, 30, 30)} />
              <TextLine className="text-xs w-10 flex-shrink-0" w="100%" />
            </span>
            <TextLine className="mb-1 text-sm" w={textWidth(i + 3, 55, 35)} />
            {preview !== null && (
              <span className={cn("block", preview)}>
                <TextLine className="text-sm leading-relaxed" w="95%" />
                <TextLine className="text-sm leading-relaxed" w={textWidth(i + 5, 45, 40)} />
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/** A one-line row (the focused list and the bottom reading pane on a desktop). */
function OneLineRow({ i, o }: { i: number; o: RowOptions }) {
  const avatar = avatarClass(o);
  return (
    <div className="border-b border-border">
      <div className="bg-background">
        <div
          className="px-3 flex items-center"
          style={{ gap: "var(--density-item-gap)", paddingBlock: "var(--density-item-py)" }}
        >
          {avatar !== null && (
            <span className={cn("flex flex-shrink-0 items-center self-stretch", avatar)}>
              <Circle className="w-8 h-8" />
            </span>
          )}
          <span className="flex flex-1 min-w-0 items-center justify-between gap-3">
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <TextLine className="w-32 shrink-0 text-sm lg:w-40" w={textWidth(i, 50, 40)} />
              <TextLine className="min-w-0 flex-1 text-sm" w={textWidth(i + 2, 35, 45)} />
            </span>
            <TextLine className="w-10 shrink-0 text-xs" w="100%" />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Mountain View's row on a tablet or desktop: check box and star, then one 40px line. */
function MvRow({ i }: { i: number }) {
  return (
    <div className="border-b border-border">
      <div className="bg-[var(--mv-row-read,var(--color-background))]">
        <div className="px-3 flex items-center min-h-10" style={{ gap: "var(--density-item-gap)" }}>
          <span className="flex flex-shrink-0 items-start self-stretch text-muted-foreground">
            <span className="-ms-3 ps-3 pe-0.5 flex h-10 items-center">
              <span className="p-1">
                <Square className="w-[18px] h-[18px]" />
              </span>
            </span>
            <span className="flex h-10 items-center">
              <span className="p-1">
                <Star className="w-[18px] h-[18px] text-muted-foreground/60" />
              </span>
            </span>
          </span>
          <span className="flex flex-1 min-w-0 min-h-10 items-center justify-between gap-3">
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <TextLine className="w-32 shrink-0 text-sm lg:w-40" w={textWidth(i, 45, 40)} />
              <TextLine className="min-w-0 flex-1 text-sm" w={textWidth(i + 2, 35, 45)} />
            </span>
            <TextLine className="w-10 shrink-0 text-xs" w="100%" />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Enough rows of each shape to fill a tall viewport. */
const ROWS: Record<MailRowShape, number> = { stacked: 9, "one-line": 24, mv: 22 };

/**
 * Message list rows. With `shape`, the rows the loaded list is about to draw
 * (EmailList's loading state); without, every shape, shown by CSS from the
 * boot attributes (one-line where useListRowShape says so, Mountain View's
 * rows from a tablet up).
 */
export function MailListRowsSkeleton({
  shape,
  density,
  preview,
  className,
}: { shape?: MailRowShape; className?: string } & RowOptions) {
  const o: RowOptions = { density, preview };
  if (shape) {
    return (
      <div aria-hidden="true" className={className} data-mail-row-skeleton={shape}>
        {repeat(ROWS[shape], (i) =>
          shape === "stacked" ? <StackedRow i={i} o={o} /> : shape === "one-line" ? <OneLineRow i={i} o={o} /> : <MvRow i={i} />,
        )}
      </div>
    );
  }
  return (
    <div aria-hidden="true" className={className}>
      <div className="md:boot-focus:hidden lg:boot-horizontal:hidden md:mv:hidden">
        {repeat(ROWS.stacked, (i) => <StackedRow i={i} o={o} />)}
      </div>
      <div className="hidden md:boot-std:boot-focus:block lg:boot-std:boot-horizontal:block">
        {repeat(ROWS["one-line"], (i) => <OneLineRow i={i} o={o} />)}
      </div>
      <div className="hidden md:mv:block">{repeat(ROWS.mv, (i) => <MvRow i={i} />)}</div>
    </div>
  );
}

/** The list header row: select toggle, search field, folder menu (mail-app.tsx). */
function ListToolbarSkeleton({ embedded }: { embedded: boolean }) {
  const icon = "flex items-center justify-center h-8 w-8 shrink-0 text-muted-foreground";
  const round = "grid place-items-center w-10 h-10 rounded-full shrink-0 text-muted-foreground";
  return (
    <div className="border-b border-border bg-background max-md:hidden">
      <div className={cn("px-3 h-14 flex items-center", !embedded && "lg:mv:hidden")}>
        <div className="flex items-center gap-1 w-full">
          <span className={icon}>
            <Square className="w-4 h-4" />
          </span>
          <span className="relative flex-1 flex items-center h-8 rounded-md border border-input bg-background ps-8 pe-16">
            <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <TextLine className="flex-1 text-sm" w="6rem" />
            <span className="absolute end-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 text-muted-foreground">
              <span className="pointer-coarse:hidden mx-1 rounded border border-border px-1.5 font-sans text-[0.6875rem] leading-4">
                /
              </span>
              <span className="p-1">
                <Filter className="w-4 h-4" />
              </span>
            </span>
          </span>
          <span className={icon}>
            <MoreVertical className="w-4 h-4" />
          </span>
        </div>
      </div>
      {/* Mountain View's list toolbar (MvListToolbar). */}
      {!embedded && (
        <div className="hidden lg:mv:flex items-center gap-1 h-12 ps-[5px] pe-2 shrink-0">
          <span className={round}>
            <Square className="w-[18px] h-[18px]" />
          </span>
          <span className={round}>
            <RefreshCw className="w-[18px] h-[18px]" />
          </span>
          <span className={round}>
            <MoreVertical className="w-[18px] h-[18px]" />
          </span>
          <span className="flex-1 min-w-0" />
          <TextLine className="w-24 text-xs pe-2 shrink-0" w="100%" />
        </div>
      )}
    </div>
  );
}

/**
 * The phone and tablet header (MobileHeader): menu, the search pill on
 * phones or the folder name on tablets, the ⋮ menu and the account.
 */
function MobileHeaderSkeleton() {
  return (
    <div
      className={cn(
        "lg:hidden flex items-center justify-between h-14 shrink-0",
        "border-b border-border bg-background px-4",
        "mv:mx-2 mv:mt-2 mv:mb-1 mv:rounded-full mv:border-0 mv:bg-muted mv:px-2 mv:shadow-sm",
      )}
    >
      <span className="flex items-center gap-2 min-w-0 flex-shrink-0">
        <span className="flex items-center justify-center h-11 w-11">
          <Menu className="h-5 w-5" />
        </span>
        <TextLine className="max-md:hidden w-28 font-semibold text-lg" w="100%" bar="h-4" />
      </span>
      <span className="md:hidden flex-1 min-w-0 h-10 flex items-center gap-2 rounded-full pe-1 mx-1 bg-muted ps-3 mv:mx-0 mv:bg-transparent mv:ps-2 text-muted-foreground">
        <Search className="h-4 w-4 flex-shrink-0" />
        <TextLine className="flex-1 text-sm" w="7rem" />
      </span>
      <span className="flex items-center gap-1 flex-shrink-0">
        <span className="flex items-center justify-center h-11 w-11">
          <MoreVertical className="h-5 w-5" />
        </span>
        <span className="flex items-center justify-center w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11">
          <Circle className="w-8 h-8" />
        </span>
      </span>
    </div>
  );
}

// --- Reading pane --------------------------------------------------------------

/**
 * The viewer while a message loads (EmailViewer's loading state draws this
 * same component): the toolbar, the subject block and the sender block of the
 * default reader, then the message body's tinted sheet.
 */
export function MailMessageSkeleton({ className }: { className?: string }) {
  const button = "h-8 w-20 rounded-md";
  return (
    <div aria-hidden="true" className={cn("flex-1 min-w-0 flex flex-col h-full bg-background overflow-hidden", className)}>
      <div className="bg-background flex-shrink-0 border-b border-border">
        <div className="px-2 sm:px-4 lg:px-6 flex items-center h-14">
          {/* Phones: back, then icon-over-label actions. */}
          <div className="sm:hidden flex items-center justify-between gap-0.5 w-full">
            <span className="flex items-center justify-center h-9 w-9 -ms-1 flex-shrink-0">
              <ArrowLeft className="w-5 h-5" />
            </span>
            {repeat(6, (i) => (
              <span className="flex flex-col items-center gap-1 px-1 flex-1">
                <Block className="w-5 h-5 rounded" />
                <Bar className="h-2" w={i === 5 ? "3.5rem" : "2.25rem"} />
              </span>
            ))}
          </div>
          <div className="max-sm:hidden flex items-center justify-between gap-2 w-full">
            <div className="flex items-center gap-2">
              {/* Back to the list, where the reader has the list's place (tablet, focus). */}
              <span className="hidden md:max-lg:flex md:boot-focus:flex items-center justify-center h-9 w-9 -ms-1 flex-shrink-0">
                <ArrowLeft className="w-5 h-5" />
              </span>
              <Block className={button} />
              <Block className={button} />
              <Block className={button} />
            </div>
            <div className="flex items-center gap-2">
              <Block className={button} />
              <Block className={button} />
              <Block className={cn(button, "max-md:hidden")} />
              <Block className="h-8 w-8 rounded-md" />
            </div>
          </div>
        </div>
      </div>
      <div className="bg-background border-b border-border">
        <div className="px-4 lg:px-6" style={{ paddingBlock: "var(--density-header-py)" }}>
          <div className="flex items-start justify-between gap-2 lg:gap-4">
            <TextLine className="flex-1 min-w-0 text-lg lg:text-xl font-bold" w="70%" bar="h-4 lg:h-5" />
            {/* Date and size. */}
            <span className="w-28 max-sm:hidden flex flex-col items-end">
              <TextLine className="w-full text-sm" w="100%" />
              <TextLine className="w-8 text-xs" w="100%" bar="h-2.5" />
            </span>
          </div>
        </div>
      </div>
      <div className="bg-background px-4 lg:px-6 border-b border-border" style={{ paddingBlock: "var(--density-header-py)" }}>
        <div className="flex items-start" style={{ gap: "var(--density-item-gap)" }}>
          <Circle className="w-10 h-10" />
          <div className="flex-1 min-w-0">
            <TextLine className="font-semibold" w="10rem" />
            <TextLine className="text-sm leading-6" w="13rem" />
            <TextLine className="text-sm leading-6" w="16rem" />
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-hidden bg-muted/30">
        <div className="px-6 pt-4 pb-6">
          <div className="space-y-3">
            <Bar className="h-4 w-full" />
            <Bar className="h-4 w-5/6" />
            <Bar className="h-4 w-4/6" />
            <Bar className="h-4 w-full" />
            <Bar className="h-4 w-3/4" />
          </div>
        </div>
      </div>
      {/* Phones: the reply bar along the bottom (previous, reply, reply all, forward, next). */}
      <div className="sm:hidden flex items-center flex-shrink-0 bg-background border-t border-border pb-[calc(env(safe-area-inset-bottom)/2)] text-muted-foreground">
        {[ChevronLeft, Reply, ReplyAll, Forward, ChevronRight].map((Icon, i) => (
          <span key={i} className="flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px]">
            <Icon className="w-5 h-5" />
            <Bar className="h-2 my-px" w="2.25rem" />
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * A conversation on a phone while it loads (ThreadConversationView): the
 * header with back, subject and count, then the message cards.
 */
export function MailConversationSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("flex-1 min-w-0 flex flex-col h-full bg-background overflow-hidden", className)}>
      <div
        className="flex items-center px-4 border-b border-border bg-background"
        style={{ gap: "var(--density-item-gap)", paddingBlock: "var(--density-header-py)" }}
      >
        <span className="flex items-center justify-center h-11 w-11 -ms-2 flex-shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </span>
        <span className="flex-1 min-w-0">
          <TextLine className="font-semibold" w="80%" />
          <TextLine className="font-semibold" w="45%" />
          <TextLine className="text-sm" w="5rem" />
        </span>
        <span className="flex items-center gap-1 flex-shrink-0">
          {repeat(4, () => <Block className="h-11 w-11 rounded-md" />)}
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="space-y-3" style={{ padding: "var(--density-card-p)" }}>
          {repeat(3, (i) => (
            <div className="rounded-lg border border-border overflow-hidden bg-background shadow-sm">
              <div className="w-full flex items-start" style={{ gap: "var(--density-item-gap)", padding: "var(--density-card-p)" }}>
                <Circle className="w-10 h-10" />
                <span className="flex-1 min-w-0">
                  <TextLine className="mb-0.5" w={textWidth(i, 35, 25)} />
                  <TextLine className="text-sm" w="3rem" />
                </span>
              </div>
              <div className="border-t border-border px-4 py-4 space-y-3">
                <Bar className="h-3.5 w-full" />
                <Bar className="h-3.5 w-5/6" />
                <Bar className="h-3.5" w={textWidth(i + 2, 40, 40)} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The empty reading pane: nothing open (EmailViewer without an email). */
function EmptyReaderSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex-1 min-w-0 flex flex-col items-center justify-center bg-gradient-to-br from-muted/30 to-muted/50",
        className,
      )}
    >
      <div className="flex flex-col items-center text-center p-8">
        <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-background shadow-lg flex items-center justify-center">
          <Mail className="w-10 h-10 text-muted-foreground" />
        </div>
        <TextLine className="text-xl font-semibold mb-2 w-56" w="100%" bar="h-4" />
        <TextLine className="w-72" w="100%" />
        <Block className="mt-6 h-10 w-28" />
      </div>
    </div>
  );
}

/** The reader's frame (EmailViewer's shell()). */
function ReaderFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden relative">
      <div className="flex-1 min-h-0 flex flex-row overflow-hidden relative">{children}</div>
    </div>
  );
}

/** Mountain View's side panel rail (MvSidePanel): calendar and contacts. */
function MvSidePanelSkeleton() {
  return (
    <div aria-hidden="true" className="hidden lg:mv:flex boot-no-mv-side:hidden w-14 shrink-0 flex-col items-center gap-2 pt-3">
      <span className="grid h-10 w-10 place-items-center rounded-full boot-no-calendar:hidden">
        <CalendarEvent className="h-5 w-5 text-[#1a73e8]" />
      </span>
      <span className="grid h-10 w-10 place-items-center rounded-full boot-no-contacts:hidden">
        <Users className="h-5 w-5 text-[#1a73e8]" />
      </span>
      <div className="my-1 h-px w-5 bg-border" />
    </div>
  );
}

// --- The page ------------------------------------------------------------------

/**
 * The mail page's own content: everything in the row next to the rail.
 * `embedded` is the variant drawn inside a Pro pane (useIsEmbedded()), which
 * has no rail, no Mountain View shell and fills its pane (h-full).
 */
export function MailSkeletonBody({ embedded = false }: { embedded?: boolean }) {
  return (
    <>
      {/* Folders: in the flow on a desktop, a closed drawer below that. */}
      <div
        aria-hidden="true"
        className="flex-shrink-0 h-full max-lg:hidden"
        style={{ width: "var(--boot-mail-sidebar-w, 256px)" }}
      >
        <SidebarSkeleton embedded={embedded} />
      </div>
      {/* AppMain. Under Mountain View the rounded card inset from the canvas. */}
      <div
        className={cn(
          "flex flex-col flex-1 min-w-0 h-full",
          !embedded && "lg:mv:h-auto lg:mv:mb-4 lg:mv:me-4 lg:mv:rounded-[var(--mv-card-radius)] lg:mv:bg-background lg:mv:overflow-hidden",
        )}
      >
        <div className={cn("relative flex flex-1 min-h-0", !embedded && "lg:boot-horizontal:flex-col")}>
          {/* The message list. */}
          <div
            className={cn(
              "relative flex flex-col bg-background min-w-0 h-full border-e border-border",
              // Phones and tablets give an open message the whole width.
              "max-md:flex-1 max-md:border-e-0 max-lg:boot-open:hidden",
              "md:flex-shrink-0 md:shadow-sm md:w-[var(--boot-mail-list-w,384px)]",
              embedded && "md:max-w-[max(220px,55%)]",
              // Focus: the list takes the width while nothing is open and makes way for the reader.
              "md:boot-focus:w-auto md:boot-focus:flex-1 md:boot-focus:border-e-0 md:boot-focus:boot-open:hidden",
              // Horizontal (desktop only): the list on top, full width.
              !embedded && [
                "lg:boot-horizontal:w-full lg:boot-horizontal:h-auto lg:boot-horizontal:border-e-0 lg:boot-horizontal:shadow-none",
                "lg:boot-horizontal:flex-1 lg:boot-horizontal:min-h-0",
                "lg:boot-horizontal:boot-open:flex-none lg:boot-horizontal:boot-open:h-[var(--boot-mail-list-h,320px)]",
                "lg:boot-horizontal:boot-open:shadow-[0_8px_12px_-6px_rgba(0,0,0,0.18)] dark:lg:boot-horizontal:boot-open:shadow-[0_8px_14px_-6px_rgba(0,0,0,0.55)]",
              ],
            )}
          >
            {!embedded && <MobileHeaderSkeleton />}
            <ListToolbarSkeleton embedded={embedded} />
            <div className="flex-1 min-h-0 flex flex-col">
              <div className={cn("flex-1 overflow-hidden bg-background relative pb-20", !embedded && "lg:mv:pb-0")}>
                <MailListRowsSkeleton />
              </div>
            </div>
            {/* The round Compose button (Mountain View's sits in its navigation). */}
            <Circle
              className={cn(
                "absolute z-40 shadow-lg bottom-4 end-4 h-12 w-12 max-md:h-14 max-md:w-14",
                "max-md:mv:w-36 max-md:mv:rounded-2xl",
                !embedded && "lg:mv:hidden",
              )}
            />
          </div>
          {/* The reading pane. */}
          <div
            className={cn(
              "flex flex-col bg-background flex-1 min-w-0 h-full md:relative",
              "max-md:hidden max-md:boot-open:flex",
              "md:boot-focus:hidden md:boot-focus:boot-open:flex",
              !embedded && "lg:boot-horizontal:hidden lg:boot-horizontal:boot-open:flex lg:boot-horizontal:h-auto lg:boot-horizontal:min-h-0",
            )}
          >
            <ReaderFrame>
              <EmptyReaderSkeleton className="boot-open:hidden" />
              {/* A conversation link opens the conversation view on a phone, its newest message elsewhere. */}
              <MailMessageSkeleton className="hidden boot-open:flex max-md:boot-thread:hidden" />
              <MailConversationSkeleton className="hidden max-md:boot-thread:flex" />
            </ReaderFrame>
          </div>
        </div>
      </div>
      {!embedded && <MvSidePanelSkeleton />}
    </>
  );
}

/**
 * Skeleton of the mail page. `embedded`: the mail app inside a Pro pane, which
 * draws only its body at the pane's height.
 */
export function MailSkeleton({ label, labels, embedded = false }: MailSkeletonProps & { embedded?: boolean }) {
  if (embedded) {
    return (
      <SkeletonRegion surface="mail" label={label} className="flex h-full overflow-hidden bg-background">
        <MailSkeletonBody embedded />
      </SkeletonRegion>
    );
  }
  return (
    <AppShellSkeleton
      surface="mail"
      label={label}
      labels={labels}
      railBelow="lg"
      active="mail"
      mvSearch
      bottomBarClassName="max-md:boot-open:hidden"
    >
      <MailSkeletonBody />
    </AppShellSkeleton>
  );
}
