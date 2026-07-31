"use client";

import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useKeywordFormat } from "@/hooks/use-keyword-format";
import { useShortenedText } from "@/hooks/use-shortened-text";

/**
 * How much room the surface has for a tag.
 * - `badge` names the tag; `dot` only identifies it by colour.
 */
export type TagBadgeVariant = "badge" | "dot";

/**
 * The lozenge shape, shared so anything standing next to a tag lines up with
 * it rather than approximating its padding and text size.
 */
export const TAG_LOZENGE_CLASS =
  "inline-flex min-w-0 shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium";

/**
 * The row a group of tags sits in. Using it for neighbouring lozenges too keeps
 * the spacing between them the same as the spacing within them - a wider gap on
 * one side is what makes a neighbour look indented.
 */
export const TAG_GROUP_CLASS = "flex shrink-0 items-center gap-1";

/**
 * A tag, drawn the one way tags are drawn.
 *
 * The lozenge carries the colour in its border and text rather than pairing a
 * swatch with plain text: the name is the tag, and the colour is how you pick
 * it out of a row at a glance. That also matches every other coloured pill in
 * the app, all of which set a text colour alongside the background.
 *
 * A deep name shortens to fit its own box (`Work/../Acme`) before the browser
 * clips it, so the outermost and innermost levels survive.
 */
export function TagBadge({
  tagId,
  variant,
  onRemove,
  className,
}: {
  tagId: string;
  variant: TagBadgeVariant;
  /**
   * Takes the tag off the message. Only the named form offers it - a dot is the
   * size of the control it would have to hold.
   */
  onRemove?: () => void;
  className?: string;
}) {
  const t = useTranslations("email_viewer");
  const { tagName, tagNameCandidates, tagColor } = useKeywordFormat();
  const [labelRef, shortenedName] = useShortenedText(tagNameCandidates(tagId));
  const color = tagColor(tagId);
  const name = tagName(tagId);

  if (variant === "dot") {
    return (
      <span
        className={cn("h-2.5 w-2.5 shrink-0 rounded-full", color.dot, className)}
        title={name}
        aria-label={name}
      />
    );
  }

  return (
    <span
      className={cn(
        TAG_LOZENGE_CLASS,
        "max-w-[12rem] border",
        color.fill,
        color.border,
        color.text,
        className,
      )}
      title={name}
    >
      <span ref={labelRef} className="min-w-0 truncate">
        {shortenedName}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ms-0.5 shrink-0 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
          title={t("remove_tag")}
          aria-label={t("remove_tag")}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}
