/**
 * The mail page as a skeleton: folder sidebar, message list and reading pane,
 * in each layout the app has (split, horizontal, focus, Mountain View, the
 * compact desktop, phone). Class lists follow the real components (components/mail/mail-app.tsx,
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
  ChevronsRight,
  Filter,
  Mail,
  Menu,
  MoreVertical,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  Square,
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
    // On the sidebar's panel colour, which dark themes share with the shapes.
    <div aria-hidden="true" className="sk-lift-dark">
      {repeat(count, (i) => (
        <div
          className={cn(
            "w-full flex items-center tap:min-h-[44px] text-sm pe-2 border-s-2 border-transparent",
            "mv:min-h-[var(--mv-nav-row-h)] mv:me-3 mv:pe-4 mv:border-s-0",
          )}
          style={{ paddingBlock: "var(--density-sidebar-py)" }}
        >
          <span className="flex-shrink-0 desk:max-lg:hidden" style={{ width: FOLDER_ROW_PX_BASE + FOLDER_CHEVRON_SLOT }} />
          <span className="flex items-center gap-2 mv:gap-[18px] min-w-0 flex-1 desk:max-lg:justify-center">
            <span className="flex items-center justify-center flex-shrink-0 w-4 h-4 mv:w-5 mv:h-5">
              <Block className="w-full h-full rounded" />
            </span>
            <TextLine className="flex-1 desk:max-lg:hidden" w={textWidth(i, 35, 30)} />
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
        // Dark themes draw the panel in the shapes' own colour: lift them off it.
        "sk-lift-dark",
        !embedded && "desk:mv:bg-[var(--mv-canvas)] desk:mv:border-transparent",
      )}
    >
      {/* Header: collapse button and account switcher. Hidden in a Pro pane and under Mountain View. */}
      {!embedded && (
        <div className="border-b border-border desk:mv:hidden">
          <div className="flex items-center h-14 gap-1 px-2 desk:max-lg:justify-center">
            <span className="hidden desk:flex items-center justify-center h-8 w-8 flex-shrink-0 text-muted-foreground">
              <ChevronsLeft className="w-4 h-4 desk:max-lg:hidden" />
              {/* A compact desktop folds the sidebar to its icons (sidebarFolded). */}
              <ChevronsRight className="w-4 h-4 hidden desk:max-lg:block" />
            </span>
            <span className="flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 desk:max-lg:hidden">
              <Circle className="w-9 h-9" />
              <span className="min-w-0 flex-1">
                <TextLine className="text-sm" w="70%" />
                <TextLine className="text-xs" w="85%" bar="h-2.5" />
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            </span>
          </div>
          {/* The folded sidebar's Compose button. */}
          <div className="hidden desk:max-lg:flex justify-center pb-2">
            <Block className="w-10 h-10 rounded-md" />
          </div>
        </div>
      )}
      {/* Mountain View: the Compose button heads the navigation. */}
      {!embedded && (
        <div className="hidden desk:mv:block pt-2 pb-3 px-3">
          <span className="flex w-fit items-center gap-3 ps-4 pe-6 h-[var(--mv-compose-h,56px)] rounded-2xl bg-[var(--mv-compose-bg)] text-[var(--mv-compose-fg)]">
            <Pencil className="w-6 h-6 flex-shrink-0" />
            <TextLine className="text-sm w-14 desk:max-lg:hidden" w="100%" />
          </span>
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        {/* Mountain View lists the folders without a heading. */}
        <FolderSectionHeaderSkeleton className={cn("desk:max-lg:hidden", !embedded && "desk:mv:hidden")} />
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
  if (o.density === undefined) return "boot-density-xc:hidden";
  return o.density === "extra-compact" ? null : "";
}

/** Classes for the two preview lines, or null where the row has none. */
function previewClass(o: RowOptions): string | null {
  if (o.density === undefined) return "boot-dense:hidden boot-no-preview:hidden";
  return o.preview === false || o.density === "compact" || o.density === "extra-compact" ? null : "";
}

/** Classes for the preview's second line, which only comfortable rows have (mail-15). */
function secondPreviewLineClass(o: RowOptions): string | null {
  if (o.density === undefined) return "boot-one-preview-line:hidden";
  return o.density === "comfortable" ? "" : null;
}

/*
 * The rows below are drawn dozens of times, so they use the short classes in
 * app/boot-skeleton.css (mail section) for what every row repeats: sk-mrow
 * (the row and its rule), sk-mcell (the cell: the density's padding and gap,
 * and its minimum height), sk-mav (the avatar's column) and sk-ml (a line of
 * text, with its bar).
 */

/** One line of row text, as tall as the real line; `w` is the bar's width. */
function L({ className, w }: { className?: string; w: string }) {
  return (
    <span className={cn("sk-ml", className)}>
      <span className="sk-shape" style={{ width: w }} />
    </span>
  );
}

/** A stacked row (ThreadListItem on phones and in the split list). */
function StackedRow({ i, o }: { i: number; o: RowOptions }) {
  const avatar = avatarClass(o);
  const preview = previewClass(o);
  const secondLine = secondPreviewLineClass(o);
  return (
    <div className="sk-mrow max-desk:mv:border-b-transparent">
      <div className="sk-mcell sk-mcell-min">
        {avatar !== null && (
          <span className={cn("sk-mav", avatar)}>
            <span className="sk-shape block rounded-full w-10 h-10" />
          </span>
        )}
        <span className="block flex-1 min-w-0">
          <span className="flex items-center justify-between gap-2 mb-1">
            <L className="text-sm flex-1" w={textWidth(i, 30, 30)} />
            <L className="text-xs w-10" w="100%" />
          </span>
          <L className="mb-1 text-sm" w={textWidth(i + 3, 55, 35)} />
          {preview !== null && (
            <span className={cn("block", preview)}>
              {/* Mountain View's phone rows keep the preview to one line, beside a 32px star. */}
              <L className="text-sm leading-relaxed max-desk:mv:h-8" w="95%" />
              {secondLine !== null && (
                <L className={cn("text-sm leading-relaxed max-desk:mv:hidden", secondLine)} w={textWidth(i + 5, 45, 40)} />
              )}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/** A one-line row (the focused list and the bottom reading pane on a desktop). */
function OneLineRow({ i, o }: { i: number; o: RowOptions }) {
  const avatar = avatarClass(o);
  return (
    <div className="sk-mrow">
      <div className="sk-mcell items-center">
        {avatar !== null && (
          <span className={cn("sk-mav", avatar)}>
            <span className="sk-shape block rounded-full w-8 h-8" />
          </span>
        )}
        <span className="flex flex-1 min-w-0 gap-3">
          <L className="w-32 lg:w-40 text-sm" w={textWidth(i, 50, 40)} />
          <L className="flex-1 text-sm" w={textWidth(i + 2, 35, 45)} />
          <L className="w-10 text-xs self-center" w="100%" />
        </span>
      </div>
    </div>
  );
}

/** Mountain View's row on a tablet or desktop: check box and star, then one 40px line. */
function MvRow({ i }: { i: number }) {
  return (
    <div className="sk-mrow">
      <div className="sk-mcell items-center py-0 min-h-10">
        {/* The check box and the star, 26px each (an 18px icon in p-1). */}
        <span className="flex flex-shrink-0 items-center gap-[2px]">
          <span className="block w-3.5 h-3.5 m-[6px] rounded-[3px] border-2 border-muted-foreground/70" />
          <span className="sk-shape block w-3.5 h-3.5 m-[6px] rounded-full" />
        </span>
        <span className="flex flex-1 min-w-0 gap-3">
          <L className="w-32 lg:w-40 text-sm" w={textWidth(i, 45, 40)} />
          <L className="flex-1 text-sm" w={textWidth(i + 2, 35, 45)} />
          <L className="w-10 text-xs self-center" w="100%" />
        </span>
      </div>
    </div>
  );
}

/** Enough rows of each shape to fill a tall viewport. */
const ROWS: Record<MailRowShape, number> = { stacked: 16, "one-line": 32, mv: 22 };

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
      <div className="desk:boot-focus:hidden desk:boot-horizontal:hidden desk:mv:hidden">
        {repeat(ROWS.stacked, (i) => <StackedRow i={i} o={o} />)}
      </div>
      <div className="hidden desk:boot-std:boot-focus:block desk:boot-std:boot-horizontal:block">
        {repeat(ROWS["one-line"], (i) => <OneLineRow i={i} o={o} />)}
      </div>
      <div className="hidden desk:mv:block">{repeat(ROWS.mv, (i) => <MvRow i={i} />)}</div>
    </div>
  );
}

/** The list header row: select toggle, search field, folder menu (mail-app.tsx). */
function ListToolbarSkeleton({ embedded }: { embedded: boolean }) {
  const icon = "flex items-center justify-center h-8 w-8 shrink-0 text-muted-foreground";
  const round = "grid place-items-center w-10 h-10 rounded-full shrink-0 text-muted-foreground";
  return (
    <div className="border-b border-border bg-background max-desk:hidden">
      <div className={cn("px-3 h-14 flex items-center", !embedded && "desk:mv:hidden")}>
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
        <div className="hidden desk:mv:flex items-center gap-1 h-12 ps-[5px] pe-2 shrink-0">
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
        "desk:hidden flex items-center justify-between h-14 shrink-0",
        "border-b border-border bg-background px-4",
        "mv:mx-2 mv:mt-2 mv:mb-1 mv:rounded-full mv:border-0 mv:bg-muted mv:px-2 mv:shadow-sm",
        // Mountain View's pill is the shapes' own colour: lift them off it.
        "sk-lift-mv",
      )}
    >
      <span className="flex items-center gap-2 min-w-0 flex-shrink-0">
        <span className="flex items-center justify-center h-11 w-11">
          <Menu className="h-5 w-5" />
        </span>
        <TextLine className="max-desk:hidden w-28 font-semibold text-lg" w="100%" bar="h-4" />
      </span>
      <span className="desk:hidden flex-1 min-w-0 h-10 flex items-center gap-2 rounded-full pe-1 mx-1 bg-muted ps-3 mv:mx-0 mv:bg-transparent mv:ps-2 text-muted-foreground sk-lift">
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
/**
 * The reader's top toolbar while a message loads. The loaded reader lifts its
 * toolbar above the message row on a tablet or desktop (EmailViewer's
 * `liftToolbar`); its loading state draws this there too, so the row below
 * doesn't move when the message arrives. `end` is a real control at the end
 * of the row (the reader's plugin panel button), where the loaded toolbar has it.
 */
export function MailMessageToolbarSkeleton({ end }: { end?: ReactNode } = {}) {
  const button = "h-8 w-20 rounded-md";
  return (
    <div className="bg-background flex-shrink-0 border-b border-border">
      <div data-window-row-right="" className="px-2 sm:px-4 lg:px-6 flex items-center h-14">
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
            {/* Back to the list, where the reader has the list's place (focus, or a window too narrow for two panes). */}
            <span className="hidden desk:boot-onepane:flex items-center justify-center h-9 w-9 -ms-1 flex-shrink-0">
              <ArrowLeft className="w-5 h-5" />
            </span>
            <Block className={button} />
            <Block className={button} />
            <Block className={button} />
          </div>
          <div className="flex items-center gap-2">
            <Block className={button} />
            <Block className={button} />
            <Block className={cn(button, "max-desk:hidden")} />
            <Block className="h-8 w-8 rounded-md" />
            {end}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MailMessageSkeleton({ className, toolbar = true }: { className?: string; toolbar?: boolean }) {
  return (
    <div aria-hidden="true" className={cn("flex-1 min-w-0 flex flex-col h-full bg-background overflow-hidden", className)}>
      {toolbar ? <MailMessageToolbarSkeleton /> : null}
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
    <div aria-hidden="true" className="hidden desk:mv:flex boot-no-mv-side:hidden w-14 shrink-0 flex-col items-center gap-2 pt-3">
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
      {/* Folders: in the flow on a desktop (folded to icons on a compact one),
          a closed drawer on a phone. */}
      <div
        aria-hidden="true"
        className="flex-shrink-0 h-full max-desk:hidden max-lg:w-12! max-lg:mv:w-[72px]!"
        style={{ width: "var(--boot-mail-sidebar-w, 256px)" }}
      >
        <SidebarSkeleton embedded={embedded} />
      </div>
      {/* AppMain. Under Mountain View the rounded card inset from the canvas. */}
      <div
        className={cn(
          "flex flex-col flex-1 min-w-0 h-full",
          !embedded && "desk:mv:h-auto desk:mv:mb-4 desk:mv:me-4 desk:mv:rounded-[var(--mv-card-radius)] desk:mv:bg-background desk:mv:overflow-hidden",
        )}
      >
        <div className={cn("relative flex flex-1 min-h-0", !embedded && "desk:boot-horizontal:flex-col")}>
          {/* The message list. */}
          <div
            className={cn(
              "relative flex flex-col bg-background min-w-0 h-full border-e border-border",
              // Phones give an open message the whole width.
              "max-desk:flex-1 max-desk:border-e-0 max-desk:boot-open:hidden",
              "desk:flex-shrink-0 desk:shadow-sm desk:w-[var(--boot-mail-list-w,384px)]",
              embedded && "desk:max-w-[max(220px,55%)]",
              // Focus (and split in a window too narrow for two panes): the
              // list takes the width while nothing is open and makes way for the reader.
              "desk:boot-onepane:w-auto desk:boot-onepane:flex-1 desk:boot-onepane:border-e-0 desk:boot-onepane:boot-open:hidden",
              // Horizontal (desktop only): the list on top, full width.
              !embedded && [
                "desk:boot-horizontal:w-full desk:boot-horizontal:h-auto desk:boot-horizontal:border-e-0 desk:boot-horizontal:shadow-none",
                "desk:boot-horizontal:flex-1 desk:boot-horizontal:min-h-0",
                "desk:boot-horizontal:boot-open:flex-none desk:boot-horizontal:boot-open:h-[var(--boot-mail-list-h,320px)]",
                "desk:boot-horizontal:boot-open:shadow-[0_8px_12px_-6px_rgba(0,0,0,0.18)] dark:desk:boot-horizontal:boot-open:shadow-[0_8px_14px_-6px_rgba(0,0,0,0.55)]",
              ],
            )}
          >
            {!embedded && <MobileHeaderSkeleton />}
            <ListToolbarSkeleton embedded={embedded} />
            <div className="flex-1 min-h-0 flex flex-col">
              <div className={cn("flex-1 overflow-hidden bg-background relative pb-20", !embedded && "desk:mv:pb-0")}>
                <MailListRowsSkeleton />
              </div>
            </div>
            {/* The round Compose button (Mountain View's sits in its navigation). */}
            <Circle
              className={cn(
                "absolute z-40 shadow-lg bottom-4 end-4 h-12 w-12 max-desk:h-14 max-desk:w-14",
                "max-desk:mv:w-36 max-desk:mv:rounded-2xl",
                // A desktop has Compose in the folder sidebar; a Pro pane keeps the round one.
                !embedded && "desk:hidden",
              )}
            />
          </div>
          {/* The reading pane. */}
          <div
            className={cn(
              "flex flex-col bg-background flex-1 min-w-0 h-full desk:relative",
              "max-desk:hidden max-desk:boot-open:flex",
              "desk:boot-onepane:hidden desk:boot-onepane:boot-open:flex",
              !embedded && "desk:boot-horizontal:hidden desk:boot-horizontal:boot-open:flex desk:boot-horizontal:h-auto desk:boot-horizontal:min-h-0",
            )}
          >
            <ReaderFrame>
              <EmptyReaderSkeleton className="boot-open:hidden" />
              {/* A conversation link opens the conversation view on a phone, its newest message elsewhere. */}
              <MailMessageSkeleton className="hidden boot-open:flex max-desk:boot-thread:hidden" />
              <MailConversationSkeleton className="hidden max-desk:boot-thread:flex" />
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
      active="mail"
      mvSearch
      bottomBarClassName="max-desk:boot-open:hidden"
    >
      <MailSkeletonBody />
    </AppShellSkeleton>
  );
}
