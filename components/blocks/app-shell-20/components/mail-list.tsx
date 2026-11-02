import { IconStack } from "@/components/reui/icon-stack"

import { Button } from "@/components/reui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/reui/empty"
import { Input } from "@/components/reui/input"
import { ScrollArea } from "@/components/reui/scroll-area"
import { SidebarTrigger } from "@/components/reui/sidebar"
import { CategorySelector } from "./category-selector"
import { SearchIcon, RefreshCwIcon, InboxIcon } from "lucide-react"

function MailListHeader() {
  return (
    <div className="flex shrink-0 items-center gap-1 px-2 py-2">
      <SidebarTrigger className="text-muted-foreground shrink-0" />
      <div className="relative min-w-0 flex-1">
        <SearchIcon className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden="true" />
        <Input
          placeholder="Search..."
          className="pl-8"
          aria-label="Search mail"
        />
      </div>
      <CategorySelector />
      <Button
        variant="ghost"
        size="icon"
        aria-label="Refresh"
        className="text-muted-foreground shrink-0"
      >
        <RefreshCwIcon aria-hidden="true" />
      </Button>
    </div>
  )
}

export function MailList() {
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <MailListHeader />
      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full [&>[data-slot=scroll-area-viewport]>div]:h-full">
          <div className="flex min-h-full items-center justify-center p-6">
            <Empty className="max-w-sm flex-none gap-6 rounded-none border-0 bg-transparent p-0">
              <EmptyHeader className="items-center gap-5 text-center">
                <EmptyMedia className="mb-0">
                  <IconStack aria-hidden="true">
                    <InboxIcon strokeWidth="1.9" aria-hidden="true" />
                  </IconStack>
                </EmptyMedia>
                <div className="flex flex-col items-center gap-1.5">
                  <EmptyTitle className="text-lg font-semibold tracking-tight">
                    It's empty here
                  </EmptyTitle>
                  <EmptyDescription className="max-w-72">
                    Search for another email or{" "}
                    <a
                      href="#"
                      className="text-foreground hover:text-primary underline underline-offset-2"
                    >
                      clear filters
                    </a>
                  </EmptyDescription>
                </div>
              </EmptyHeader>
            </Empty>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}