"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A conversation message's sender: the name, then the address in angle
 * brackets when both fit on the line (mail-p3-13). The pair is a one-line box
 * that wraps: an address that doesn't fit whole moves to a second line, which
 * the box clips, so it is never cut in the middle of the domain and the name
 * gets the room up to the date. A name too long on its own ends in "…". The
 * whole pair is the tooltip. A badge (the verified-brand check) sits right
 * after the name and stays when the name is cut.
 */
export function SenderNameLine({ name, address, nameNode, addressNode, badge, className }: {
  name: string;
  /** Shown only when the sender has a name as well. */
  address?: string | null;
  /** The name as a control of its own (the open message's contact button). */
  nameNode?: ReactNode;
  /** The address as a control of its own. */
  addressNode?: ReactNode;
  /** Right after the name, before the address. */
  badge?: ReactNode;
  className?: string;
}) {
  const showAddress = !!address && !!name && address !== name;
  return (
    <span
      className={cn("flex flex-wrap items-baseline gap-x-2 min-w-0 h-5 overflow-hidden", className)}
      title={showAddress ? `${name} <${address}>` : undefined}
      data-sender-line=""
    >
      <span className="flex min-w-0 max-w-full items-center gap-1 leading-5" data-sender-name="">
        <span dir="auto" className="min-w-0 truncate leading-5">{nameNode ?? name}</span>
        {badge}
      </span>
      {showAddress && (
        <span className="text-xs font-normal text-muted-foreground whitespace-nowrap leading-5" data-sender-address="">
          &lt;{addressNode ?? address}&gt;
        </span>
      )}
    </span>
  );
}
