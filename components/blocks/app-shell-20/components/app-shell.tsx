"use client"

import { type CSSProperties } from "react"
import { cn } from "@/lib/cn"

import { Card } from "@/components/reui/card"
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/reui/sidebar"
import { TooltipProvider } from "@/components/reui/tooltip"

import { AppAside } from "./app-aside"
import { AppSidebar } from "./app-sidebar"
import { MailList } from "./mail-list"
import { MailView } from "./mail-view"

export function AppShell() {
  return (
    <TooltipProvider delayDuration={0}>
      <SidebarProvider
        className={cn(
          "h-svh",
          "[--sidebar-accent:color-mix(in_oklab,var(--color-primary)_5%,transparent)]",
          "[--sidebar-accent-foreground:var(--color-primary)]"
        )}
        style={
          {
            "--sidebar-width": "240px",
            "--header-height": "52px",
          } as CSSProperties
        }
      >
        {/* Sidebar */}
        <AppSidebar />

        <SidebarInset className="m-0! rounded-none border-0 bg-transparent shadow-none!">
          <div className="flex h-full min-h-0 gap-3 py-3 pr-2">
            {/* Message list */}
            <Card className="flex w-full shrink-0 flex-col overflow-hidden p-0 md:w-80 xl:w-96">
              <MailList />
            </Card>

            {/* Reading pane */}
            <Card className="hidden min-w-0 flex-1 flex-col overflow-hidden p-0 md:flex">
              <MailView />
            </Card>
          </div>
        </SidebarInset>

        {/* App rail */}
        <AppAside />
      </SidebarProvider>
    </TooltipProvider>
  )
}