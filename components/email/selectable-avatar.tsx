"use client";

import type { ComponentProps } from "react";
import { Check } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

type SelectableAvatarProps = ComponentProps<typeof Avatar> & {
  /** Whether the underlying message/thread is currently selected. */
  checked: boolean;
  /** Toggle selection. The wrapper stops propagation so the row is not opened. */
  onToggle: () => void;
  /** Accessible label for the selection control. */
  selectLabel?: string;
};

/**
 * Avatar that doubles as a selection control, Thunderbird-style: clicking the
 * avatar toggles the message/thread into the current selection instead of
 * opening it. A check overlay appears on hover (hinting it is clickable) and
 * stays visible while the row is selected.
 */
export function SelectableAvatar({
  checked,
  onToggle,
  selectLabel,
  className,
  ...avatarProps
}: SelectableAvatarProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={selectLabel}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "group/select relative shrink-0 rounded-full outline-none",
        "focus-visible:ring-2 focus-visible:ring-primary/60",
        className,
      )}
    >
      <Avatar {...avatarProps} />
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 flex items-center justify-center rounded-full",
          "bg-primary text-primary-foreground transition-opacity duration-150",
          checked ? "opacity-100" : "opacity-0 group-hover/select:opacity-100",
        )}
      >
        <Check className="h-4 w-4" />
      </span>
    </button>
  );
}
