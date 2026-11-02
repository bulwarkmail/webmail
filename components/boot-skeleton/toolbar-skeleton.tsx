/**
 * Header-row pieces shared by the contacts, files and plugin page skeletons,
 * drawn at the sizes of the real controls in components/ui/toolbar.tsx and
 * components/layout/phone-header-actions.tsx. Plain spans: nothing here is
 * focusable, and the caller's region is aria-hidden.
 */
import type { ComponentType } from "react";
import { MoreVertical, Search } from "@/components/icons";
import { cn } from "@/lib/cn";
import { Bar, Circle } from "./kit";

type Icon = ComponentType<{ className?: string }>;

/** A 32px toolbar icon button (ToolbarButton, IconButton icon-sm). */
export function ToolIcon({ icon: Icon, className }: { icon: Icon; className?: string }) {
  return (
    <span className={cn("grid place-items-center w-8 h-8 shrink-0 rounded-md text-muted-foreground", className)}>
      <Icon className="w-4 h-4" />
    </span>
  );
}

/**
 * The 32px search field (ToolbarSearch): the magnifier, a placeholder bar,
 * the "/" key cap where there is a keyboard, and an optional trailing icon.
 */
export function SearchFieldSkeleton({ trailing, className }: { trailing?: Icon; className?: string }) {
  const Trailing = trailing;
  return (
    <span className={cn("relative flex items-center h-8 rounded-md border border-input bg-background ps-8", className)}>
      <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
      <Bar className="h-3" w="6rem" />
      <span className="absolute end-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
        <span className="mx-1 rounded border border-border px-1.5 font-sans text-[0.6875rem] leading-4 text-muted-foreground pointer-coarse:hidden">
          /
        </span>
        {Trailing ? (
          <span className="p-1 rounded-md text-muted-foreground">
            <Trailing className="w-4 h-4" />
          </span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * The end of a phone header (PhoneHeaderActions): the overflow menu and the
 * account avatar. `className` decides at which widths it shows.
 */
export function PhoneActionsSkeleton({ className }: { className?: string }) {
  return (
    <span className={cn("items-center gap-1 flex-shrink-0 ms-auto", className)}>
      <span className="grid place-items-center w-11 h-11 rounded-md text-muted-foreground">
        <MoreVertical className="w-5 h-5" />
      </span>
      <span className="flex items-center justify-center w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11">
        <Circle className="w-8 h-8" />
      </span>
    </span>
  );
}
