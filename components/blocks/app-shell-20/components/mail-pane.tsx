"use client"

import type { ComponentPropsWithoutRef } from "react"
import { Card } from "@/components/reui/card"
import { cn } from "@/lib/cn"

/**
 * App-shell-20's pane composition, connected to the host's live mail regions.
 * The host owns width, visibility and resizing; the shipped Card owns its look.
 * Keep one inner flex child so Card's section gap never separates virtual rows.
 */
export function MailPane({ enhanced, className, children, ...props }: ComponentPropsWithoutRef<"section"> & { enhanced: boolean }) {
  if (!enhanced) return <section className={className} {...props}>{children}</section>
  return <Card role="region" className={cn("flex w-full shrink-0 flex-col overflow-hidden p-0", className)} {...props}>
    <div className="flex h-full min-h-0 flex-1 flex-col">{children}</div>
  </Card>
}
