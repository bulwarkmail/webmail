"use client";

// Entry from the mail app into the xenaxio workspace: "Verwaltung" for company
// admins (domain, people, AI, audit), "Konto" for everyone else (password,
// AI chats). Looks: the desktop rail, the mobile bottom bar and, under the
// Mountain View layout, a round button in its top bar and a tile in its app grid.
import { Link, usePathname } from "@/i18n/navigation";
import { Briefcase } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useXT } from "@/lib/xenaxio/i18n";
import { domainPending, useXenaxioMe } from "@/lib/xenaxio/me-store";

export function WorkspaceNavLink({
  variant,
  onNavigate,
}: {
  variant: "rail" | "bar" | "top" | "grid";
  /** Called on click, e.g. to close the app grid. */
  onNavigate?: () => void;
}) {
  const t = useXT();
  const me = useXenaxioMe();
  const pathname = usePathname();
  if (!me) return null;
  const label = t(me.user.role === "admin" ? "nav.admin" : "nav.user");
  const active = pathname.startsWith("/workspace");
  // A dot while the admin still has to connect the domain.
  const attention = me.user.role === "admin" && domainPending(me);
  const dot = attention && <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background" aria-hidden />;

  if (variant === "top") {
    return (
      <Link
        href="/workspace"
        className={cn(
          "relative grid place-items-center w-12 h-12 rounded-full transition-colors",
          active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        title={label}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        data-testid="workspace-link-top"
      >
        <span className="relative">
          <Briefcase className="w-5 h-5" />
          {dot}
        </span>
      </Link>
    );
  }
  if (variant === "grid") {
    return (
      <Link
        href="/workspace"
        role="menuitem"
        onClick={onNavigate}
        className={cn(
          "flex flex-col items-center gap-1.5 rounded-lg py-3 px-1 text-center transition-colors hover:bg-muted",
          active && "bg-muted",
        )}
      >
        <span className="relative">
          <Briefcase className="w-6 h-6 text-muted-foreground" />
          {dot}
        </span>
        <span className="text-xs truncate max-w-full">{label}</span>
      </Link>
    );
  }
  if (variant === "bar") {
    return (
      <Link
        href="/workspace"
        className={cn(
          "flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] transition-colors duration-150",
          active ? "text-primary" : "text-muted-foreground hover:text-foreground",
        )}
        aria-current={active ? "page" : undefined}
      >
        <span className="relative">
          <Briefcase className="w-5 h-5" />
          {dot}
        </span>
        <span className="text-[10px] font-medium leading-tight truncate max-w-full">{label}</span>
      </Link>
    );
  }
  return (
    <Link
      href="/workspace"
      className={cn(
        "relative flex items-center justify-center w-10 h-10 rounded-md transition-colors",
        active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted",
      )}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
    >
      <span className="relative">
        <Briefcase className="w-[18px] h-[18px]" />
        {dot}
      </span>
    </Link>
  );
}
