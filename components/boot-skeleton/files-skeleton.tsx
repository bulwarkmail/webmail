import {
  ArrowUpDown,
  FolderOpen,
  HardDrive,
  LayoutGrid,
  LayoutList,
  Menu,
  MoreVertical,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "@/components/icons";
import { FILE_LIST_COLUMNS } from "@/components/files/file-list-layout";
import { cn } from "@/lib/cn";
import { Bar, Block, Circle, repeat, textWidth } from "./kit";
import { MV_CARD_ROW } from "./contacts-skeleton";
import { AppShellSkeleton, type RailLabels } from "./shell";
import { PhoneActionsSkeleton, SearchFieldSkeleton, ToolIcon } from "./toolbar-skeleton";

export interface FilesSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

const SIDEBAR_ROW = { paddingBlock: "var(--density-sidebar-py, 4px)", paddingInlineStart: "12px" } as const;
/** An unticked SelectBox (file-views.tsx). */
const SELECT_BOX = "block w-4 h-4 shrink-0 rounded border border-muted-foreground/50 bg-background";
/** A row's or tile's ⋮ button (IconButton icon-sm). */
function MoreButton({ className }: { className?: string }) {
  return (
    <span className={cn("grid place-items-center w-8 h-8 shrink-0 text-muted-foreground", className)}>
      <MoreVertical className="w-4 h-4" />
    </span>
  );
}

/**
 * The list view (FileListView): the column header and h-10 rows on the
 * shared column grid; a phone with a touch screen gets the taller two-line
 * rows without a select column.
 */
function FileListSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" data-testid="files-list-skeleton" className={cn("text-sm", className)}>
      <div className={cn(FILE_LIST_COLUMNS, "border-b border-border px-4 h-9 text-xs")}>
        <div className="flex items-center">
          <span className={SELECT_BOX} />
        </div>
        <Bar className="h-2.5" w="2.5rem" />
        <div className="hidden md:block">
          <Bar className="h-2.5" w="3.5rem" />
        </div>
        <div className="hidden sm:flex justify-end">
          <Bar className="h-2.5" w="2rem" />
        </div>
        <div className="w-[4.75rem]" />
      </div>
      {repeat(18, (i) => (
        <div className={cn(FILE_LIST_COLUMNS, "px-4 border-b border-border/60 h-10 max-md:pointer-coarse:h-auto max-md:pointer-coarse:min-h-[52px] max-md:pointer-coarse:py-1.5")}>
          <div className={"flex items-center max-md:pointer-coarse:hidden"}>
            <span className={cn(SELECT_BOX, "opacity-0 pointer-coarse:opacity-100")} />
          </div>
          <div className={"flex items-center gap-3 min-w-0 max-md:pointer-coarse:col-span-2"}>
            <Block className="w-5 h-5 rounded" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center h-5">
                <Bar className="h-3.5" w={textWidth(i, 25, 35)} />
              </div>
              <div className={"hidden items-center h-4 max-md:pointer-coarse:flex"}>
                <Bar className="h-3" w="6rem" />
              </div>
            </div>
          </div>
          <div className="hidden md:block">
            <Bar className="h-3" w="3.5rem" />
          </div>
          <div className="hidden sm:flex justify-end">
            <Bar className="h-3" w="2.5rem" />
          </div>
          <div className="flex items-center justify-end gap-0.5 w-[4.75rem]">
            <MoreButton />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The grid view (FileGridView): folder tiles, then file tiles with their previews. */
function FileGridSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" data-testid="files-grid-skeleton" className={cn("p-4 space-y-5", className)}>
      <div>
        <div className="flex items-center h-4 mb-2 px-0.5">
          <Bar className="h-2.5" w="3.5rem" />
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
          {repeat(4, (i) => (
            <div className="flex items-center gap-2.5 h-11 ps-3 pe-1 rounded-lg border border-border bg-background">
              <Block className="w-5 h-5 rounded" />
              <span className="flex-1 min-w-0">
                <Bar className="h-3.5" w={textWidth(i, 40, 40)} />
              </span>
              <MoreButton className="opacity-0" />
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="flex items-center h-4 mb-2 px-0.5">
          <Bar className="h-2.5" w="2.5rem" />
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
          {repeat(8, (i) => (
            <div className="flex flex-col rounded-lg border border-border bg-background overflow-hidden">
              <div className="aspect-[4/3] bg-muted/50 flex items-center justify-center border-b border-border/60">
                <Block className="w-14 h-14 rounded-lg" />
              </div>
              <div className="flex items-center gap-1 ps-2.5 pe-1 py-1.5 min-w-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center h-5">
                    <Bar className="h-3.5" w={textWidth(i, 45, 40)} />
                  </div>
                  <div className="flex items-center h-4">
                    <Bar className="h-3" w="60%" />
                  </div>
                </div>
                <MoreButton className="opacity-0 max-md:pointer-coarse:opacity-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The listing while the first folder listing loads, in the view the user
 * picked. Shared by the page skeleton and FileBrowser's own loading state.
 * Without `view` (the server HTML) the boot script's data-boot-files-view
 * picks it.
 */
export function FilesListingSkeleton({ view }: { view?: "list" | "grid" }) {
  if (view === "grid") return <FileGridSkeleton />;
  if (view === "list") return <FileListSkeleton />;
  return (
    <>
      <FileListSkeleton className="boot-files-grid:hidden" />
      <FileGridSkeleton className="hidden boot-files-grid:block" />
    </>
  );
}

/** The folder sidebar (files-sidebar.tsx) before its folders are listed: My files and Trash. */
function FilesSidebarSkeleton() {
  const row = "w-full flex items-center gap-2 pe-3 text-sm min-h-8 pointer-coarse:min-h-11";
  return (
    <div className="flex flex-col h-full bg-secondary">
      <div className="px-3 h-14 box-content border-b border-border flex items-center justify-between flex-shrink-0">
        <Bar className="h-3.5" w="3rem" />
        <span className="grid place-items-center w-8 h-8 shrink-0">
          <Plus className="w-4 h-4" />
        </span>
      </div>
      <div className="flex-1 overflow-hidden py-1">
        <div className={cn(row, "bg-accent text-accent-foreground")} style={SIDEBAR_ROW}>
          <span className="w-3.5 -ms-1 shrink-0" />
          <HardDrive className="w-4 h-4 shrink-0" />
          <span className="flex items-center h-5">
            <Bar className="h-3" w="4rem" />
          </span>
        </div>
        <div className="mt-3">
          <div className={cn(row, "text-muted-foreground")} style={SIDEBAR_ROW}>
            <span className="w-3.5 -ms-1 shrink-0" />
            <Trash2 className="w-4 h-4 shrink-0" />
            <span className="flex items-center h-5">
              <Bar className="h-3" w="2.5rem" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * FilesHeader (files-header.tsx): the drawer button on narrow panes, the
 * breadcrumb, then search (an icon on a phone), sort, the list/grid switch,
 * refresh (not on a phone), the details toggle and the phone actions. The
 * Pro account picker shows the breadcrumb alone.
 */
function FilesHeaderSkeleton({ picker }: { picker: boolean }) {
  const on = "bg-primary/10 text-primary";
  return (
    <div className="flex items-center gap-1 px-3 h-14 box-content border-b border-border min-w-0 flex-shrink-0">
      {picker ? null : <ToolIcon icon={Menu} className="lg:hidden" />}
      <div className="flex-1 min-w-0 flex items-center text-sm">
        <span className="flex items-center px-1.5 py-1 h-7">
          <Bar className="h-3.5" w="4rem" />
        </span>
      </div>
      {picker ? null : (
        <div className="flex items-center gap-1 shrink-0">
          <ToolIcon icon={Search} className="md:hidden" />
          <SearchFieldSkeleton className="hidden md:flex w-56" />
          <ToolIcon icon={ArrowUpDown} />
          <span className="flex items-center h-8 rounded-md border border-input p-0.5 shrink-0">
            <span className={cn("h-full w-7 grid place-items-center rounded", on, "boot-files-grid:bg-transparent boot-files-grid:text-muted-foreground")}>
              <LayoutList className="w-4 h-4" />
            </span>
            <span className="h-full w-7 grid place-items-center rounded text-muted-foreground boot-files-grid:bg-primary/10 boot-files-grid:text-primary">
              <LayoutGrid className="w-4 h-4" />
            </span>
          </span>
          <ToolIcon icon={RefreshCw} className="hidden md:grid" />
          <ToolIcon icon={PanelRight} className="boot-files-details:bg-primary/10 boot-files-details:text-primary" />
          <PhoneActionsSkeleton className="flex md:hidden" />
        </div>
      )}
    </div>
  );
}

/** FileDetailsPanel with nothing selected: the open folder's summary. */
function FileDetailsSkeleton() {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "hidden boot-files-details:flex flex-col flex-shrink-0 bg-background border-s border-border",
        "lg:w-72 max-lg:absolute max-lg:inset-y-0 max-lg:end-0 max-lg:z-30 max-lg:w-80 max-lg:max-w-[85%] max-lg:shadow-xl",
      )}
    >
      <div className="flex items-center justify-between px-4 h-11 border-b border-border flex-shrink-0">
        <Bar className="h-3.5" w="3.5rem" />
        <span className="grid place-items-center h-7 w-7 -me-1.5 text-muted-foreground">
          <X className="w-4 h-4" />
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="p-4 space-y-5">
          <div className="aspect-[4/3] rounded-lg bg-muted/50 flex items-center justify-center">
            <FolderOpen className="w-14 h-14 text-primary" />
          </div>
          <div>
            <div className="flex items-center h-6">
              <Bar className="h-4" w="6rem" />
            </div>
            <div className="flex items-center h-5">
              <Bar className="h-3" w="8rem" />
            </div>
          </div>
          <div className="space-y-3">
            {repeat(2, (i) => (
              <div>
                <div className="flex items-center h-4">
                  <Bar className="h-2.5" w="2.5rem" />
                </div>
                <div className="flex items-center h-5">
                  <Bar className="h-3" w={i === 0 ? "3rem" : "1rem"} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The Pro account picker (FileBrowser accountPickerMode): a heading and account cards. */
function AccountPickerSkeleton() {
  return (
    <div aria-hidden="true" className="p-4">
      <div className="flex items-center h-4 mb-2 px-0.5">
        <Bar className="h-2.5" w="7rem" />
      </div>
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]">
        {repeat(2, (i) => (
          <div className="flex items-center gap-3 p-3 rounded-lg border border-border min-w-0">
            <Circle className="w-10 h-10" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center h-5">
                <Bar className="h-3.5" w={textWidth(i, 50, 30)} />
              </div>
              <div className="flex items-center h-4">
                <Bar className="h-3" w="75%" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The files page's own content: everything in the row next to the rail.
 * `embedded` is the variant drawn inside a Pro pane (useIsEmbedded()), which
 * has no rail, no Mountain View shell and fills its pane (h-full); there the
 * page opens on the account picker, without a sidebar or tools.
 *
 * Desktop: sidebar, header, listing and, when left open, the details panel.
 * Below 64rem the sidebar is a closed drawer, the header gets its Menu button,
 * the details panel lies over the listing and a create button floats.
 */
export function FilesSkeletonBody({ embedded = false }: { embedded?: boolean }) {
  return (
    <div aria-hidden="true" className={cn("flex flex-col flex-1 min-w-0", embedded && "h-full")} data-embedded={embedded ? "" : undefined}>
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        {embedded ? null : (
          <div className="hidden lg:block border-e border-border flex-shrink-0 w-[var(--boot-files-sidebar-w,256px)]">
            <FilesSidebarSkeleton />
          </div>
        )}
        <div className="flex flex-col flex-1 min-w-0">
          <FilesHeaderSkeleton picker={embedded} />
          <div className="relative flex flex-1 min-h-0">
            <div className="relative flex-1 min-w-0 overflow-hidden">
              {embedded ? <AccountPickerSkeleton /> : <FilesListingSkeleton />}
            </div>
            {embedded ? null : (
              <>
                <div className="hidden max-lg:boot-files-details:block absolute inset-0 z-20 bg-black/30" />
                <FileDetailsSkeleton />
                <span className="lg:hidden absolute bottom-4 end-4 z-20 grid place-items-center w-11 h-11 rounded-full shadow-lg bg-primary text-primary-foreground">
                  <Plus className="w-5 h-5" />
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Skeleton of the files page. */
export function FilesSkeleton({ label, labels }: FilesSkeletonProps) {
  return (
    <AppShellSkeleton
      surface="files"
      label={label}
      labels={labels}
      railBelow="md"
      active="files"
      mvMenu={false}
      rowClassName={MV_CARD_ROW}
    >
      <FilesSkeletonBody />
    </AppShellSkeleton>
  );
}
