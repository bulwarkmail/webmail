/**
 * The admin panel as it loads (components/admin/admin-shell.tsx): the rail
 * with Admin current, the page list with its group headings, and the
 * content column; on phones the top bar, the page list or a page, and the
 * bottom bar. Page names, group headings and page descriptions are fixed
 * English text in lib/admin/admin-nav.ts, so they are drawn for real; the
 * rest is placeholders.
 */
import { ArrowLeft, ChevronRight, KeyRound, LogOut, Search, Shield } from "@/components/icons";
import { ADMIN_GROUPS, ADMIN_GROUP_LABELS, ADMIN_PAGE_ICONS } from "@/components/admin/admin-page-icons";
import { ADMIN_PAGES, type AdminPageDef, type AdminPageId } from "@/lib/admin/admin-nav";
import { cn } from "@/lib/cn";
import { Block, SkeletonRegion, repeat, textWidth } from "./kit";
import { TextLine } from "./login-skeleton";
import { BottomBarSkeleton, RailSkeleton, type RailLabels } from "./shell";

const GROUPS = ADMIN_GROUPS.map((group) => ({
  group,
  label: ADMIN_GROUP_LABELS[group],
  pages: ADMIN_PAGES.filter((page) => page.group === group),
}));

function pageDef(id: AdminPageId | null | undefined): AdminPageDef | null {
  return id ? ADMIN_PAGES.find((page) => page.id === id) ?? null : null;
}

/** The search field above the page list (an Input at h-9 with the icon inside). */
function SearchField({ placeholder }: { placeholder?: string }) {
  return (
    <span aria-hidden="true" className="relative block">
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <span className="flex h-9 w-full items-center rounded-md border border-input bg-background ps-9 pe-3 text-sm text-muted-foreground">
        {placeholder}
      </span>
    </span>
  );
}

/**
 * "Change password" and "Sign out of admin", which a password admin gets
 * once the session check is done. Drawn while it runs (here and in the
 * shell), so the foot of the list doesn't grow under the pointer then; a
 * Stalwart admin signed in automatically loses them.
 */
export function AdminSessionLinksSkeleton({ mobile }: { mobile: boolean }) {
  const item = cn("flex w-full items-center gap-2.5 rounded-md text-sm text-foreground", mobile ? "px-3 py-2.5" : "px-3 py-2");
  return (
    <>
      <span aria-hidden="true" className={item}>
        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
        Change password
      </span>
      <span aria-hidden="true" className={item}>
        <LogOut className="h-4 w-4 shrink-0 text-muted-foreground" />
        Sign out of admin
      </span>
    </>
  );
}

/** The about card at the foot of the list (AboutFooter): logo, name and version, source link. */
function AboutFooterSkeleton() {
  return (
    <div aria-hidden="true" className="px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Block className="w-7 h-7 shrink-0" />
          <div className="min-w-0 flex-1">
            <TextLine className="text-xs font-medium" w="5rem" />
            <TextLine className="text-[0.6875rem]" w="7rem" />
          </div>
        </div>
        <TextLine className="shrink-0 text-[0.6875rem] w-12" w="100%" />
      </div>
    </div>
  );
}

/**
 * The top of an admin page and placeholders for its sections: what the
 * content column shows while the admin session is checked. `page` gives the
 * real title and description (the title is desktop-only, as in
 * AdminPageHeader); left out, bars. `status` is announced; the boot
 * skeleton leaves it out, its region carries the one status message.
 */
export function AdminContentSkeleton({ page, status }: { page?: AdminPageId | null; status?: string }) {
  const def = pageDef(page ?? "dashboard");
  return (
    <div>
      <div aria-hidden="true" className="mb-6 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3 min-w-0">
            <div className="min-w-0">
              {def && page !== undefined ? (
                <>
                  <span className="hidden lg:block text-xl font-semibold text-foreground leading-tight">{def.label}</span>
                  <span className="block text-sm text-muted-foreground mt-1">{def.description}</span>
                </>
              ) : (
                <>
                  <TextLine className="text-xl font-semibold leading-tight hidden lg:block" w="10rem" />
                  <TextLine className="text-sm mt-1" w="22rem" />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <AdminBodySkeleton status={status} />
    </div>
  );
}

/**
 * Placeholders for a page's sections (SettingsSection: a heading and rows of
 * settings), below its header: the pages show it while they fetch, so the
 * boot skeleton's shapes stay where they are. `status` is announced.
 */
export function AdminBodySkeleton({ status }: { status?: string }) {
  return (
    <div data-testid="admin-body-skeleton">
      {status ? <span role="status" className="sr-only">{status}</span> : null}
      <div aria-hidden="true" className="space-y-10">
        {repeat(2, (s) => (
          <div className="space-y-4">
            <TextLine className="text-lg font-medium" w={s === 0 ? "8rem" : "11rem"} />
            <div className="space-y-4">
              {repeat(s === 0 ? 4 : 3, (i) => (
                <div className="flex items-center justify-between gap-4 py-1">
                  <div className="min-w-0 flex-1 space-y-1">
                    <TextLine className="text-sm" w={textWidth(i + s * 4, 25, 25)} />
                    <TextLine className="text-xs" w={textWidth(i + s * 4 + 2, 40, 35)} />
                  </div>
                  <Block className={i % 2 === 0 ? "h-6 w-11 rounded-full shrink-0" : "h-9 w-48 shrink-0"} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface AdminSkeletonProps {
  /** common.loading */
  label?: string;
  /**
   * The open page, as the shell reads it from the URL: null for /admin.
   * Leave it out where the URL isn't the admin's own (a connector link):
   * then the boot script's data-boot-pane picks the phone list or a page.
   */
  page?: AdminPageId | null;
  /** settings.back_to_mail, for the box above the page list. */
  backLabel?: string;
  /** shell.admin_search, the search field's placeholder. */
  searchLabel?: string;
  /** The phone bottom bar's labels. */
  labels?: RailLabels;
  className?: string;
}

export function AdminSkeleton({ label, page, backLabel, searchLabel, labels, className }: AdminSkeletonProps) {
  const active: AdminPageId | null = page === undefined ? null : page ?? "dashboard";
  const def = pageDef(page);
  // Phone: the list at /admin, the page below it.
  const showIndex = page === undefined ? "boot-open:hidden" : page === null ? "" : "hidden";
  const showPage = page === undefined ? "hidden boot-open:block" : page === null ? "hidden" : "";

  return (
    <SkeletonRegion
      surface="admin"
      label={label}
      className={cn("h-dvh bg-background pt-[env(safe-area-inset-top)]", className)}
    >
      {/* Desktop */}
      <div className="hidden lg:flex h-full">
        <RailSkeleton active="admin" className="flex" />

        <div aria-hidden="true" className="flex w-64 shrink-0 flex-col border-e border-border bg-secondary">
          <div className="border-b border-border">
            <div className="flex h-14 items-center px-2">
              <span className="flex h-9 w-full items-center rounded-md px-3 text-sm font-medium text-foreground">
                <ArrowLeft className="me-2 h-4 w-4" />
                {backLabel ?? <TextLine className="flex-1" w="6rem" />}
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-hidden py-2">
            <div className="px-3 pb-1 pt-1"><SearchField placeholder={searchLabel} /></div>
            <div className="space-y-0.5 px-2">
              {GROUPS.map(({ group, label: heading, pages }, groupIndex) => (
                <div key={group}>
                  {groupIndex > 0 && <div className="mx-1 my-2 border-t border-border" />}
                  {heading && (
                    <div className="px-3 pb-1 pt-2.5">
                      <span className="text-[0.6875rem] font-semibold text-muted-foreground">{heading}</span>
                    </div>
                  )}
                  {pages.map((p) => {
                    const Icon = ADMIN_PAGE_ICONS[p.id];
                    const on = active === p.id || (page === undefined && p.id === "dashboard");
                    return (
                      <div key={p.id}>
                        <span
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-md py-2 pe-3 ps-3 text-start text-sm",
                            on ? "bg-accent font-medium text-accent-foreground" : "text-foreground",
                          )}
                        >
                          <Icon className={cn("h-4 w-4 shrink-0", on ? "text-accent-foreground" : "text-muted-foreground")} />
                          <span className="truncate">{p.label}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-border px-1 py-1">
            <div className="space-y-0.5 px-1 py-1"><AdminSessionLinksSkeleton mobile={false} /></div>
            <AboutFooterSkeleton />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-hidden">
            <div className="mx-auto max-w-3xl px-6 py-6">
              <AdminContentSkeleton page={page} />
            </div>
          </div>
        </div>
      </div>

      {/* Phone and tablet */}
      <div className="flex lg:hidden h-full flex-col">
        <div aria-hidden="true" className="flex h-14 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-md text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </span>
          <div className={cn("flex min-w-0 items-center gap-2", showIndex)}>
            <Shield className="h-5 w-5 text-muted-foreground" />
            <span className="truncate text-lg font-semibold">Admin</span>
          </div>
          <div className={cn("min-w-0 items-center gap-2", page === undefined ? "hidden boot-open:flex" : page === null ? "hidden" : "flex")}>
            {def ? (
              <span className="truncate text-lg font-semibold">{def.label}</span>
            ) : (
              <TextLine className="text-lg font-semibold w-32" w="100%" />
            )}
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          <div aria-hidden="true" className={showIndex}>
            <div className="px-4 pb-1 pt-3"><SearchField placeholder={searchLabel} /></div>
            <div className="py-2">
              {GROUPS.map(({ group, label: heading, pages }, groupIndex) => (
                <div key={group}>
                  {groupIndex > 0 && <div className="mx-5 my-2 border-t border-border" />}
                  {heading && (
                    <div className="px-5 pb-1.5 pt-3">
                      <span className="text-xs font-semibold text-muted-foreground">{heading}</span>
                    </div>
                  )}
                  {pages.map((p) => {
                    const Icon = ADMIN_PAGE_ICONS[p.id];
                    return (
                      <div key={p.id}>
                        <span className="flex w-full items-center justify-between py-3.5 pe-5 ps-5 text-sm text-foreground">
                          <span className="flex items-center gap-3">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                            {p.label}
                          </span>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className={cn("p-4 pb-6", showPage)}>
            <AdminContentSkeleton page={page} />
          </div>
        </div>

        <BottomBarSkeleton active="admin" labels={labels} className="flex" />
      </div>
    </SkeletonRegion>
  );
}
