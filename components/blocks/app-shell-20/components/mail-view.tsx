import { Badge } from "@/components/reui/badge"
import { IconStack } from "@/components/reui/icon-stack"

import { Button } from "@/components/reui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/reui/empty"
import { ScrollArea } from "@/components/reui/scroll-area"
import { ChevronLeftIcon, ChevronRightIcon, EyeIcon, CornerUpLeftIcon, FileTextIcon, FlagIcon, StarIcon, CopyIcon, Trash2Icon, MoreHorizontalIcon, MailIcon, SparklesIcon, PlusIcon } from "lucide-react"

function MailViewToolbar() {
  return (
    <div className="flex shrink-0 items-center gap-1 px-2 py-2">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous message"
        className="text-muted-foreground"
      >
        <ChevronLeftIcon aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next message"
        className="text-muted-foreground"
      >
        <ChevronRightIcon aria-hidden="true" />
      </Button>
      <Badge variant="secondary" className="ml-1">
        Normal
      </Badge>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Mark as read"
        className="text-muted-foreground"
      >
        <EyeIcon aria-hidden="true" />
      </Button>

      <div className="ml-auto flex items-center gap-0.5">
        <Button variant="outline" size="sm" className="hidden sm:inline-flex">
          <CornerUpLeftIcon aria-hidden="true" />
          Reply All
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Notes"
          className="text-muted-foreground hidden md:inline-flex"
        >
          <FileTextIcon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Flag message"
          className="text-muted-foreground"
        >
          <FlagIcon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Star message"
          className="text-muted-foreground"
        >
          <StarIcon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy"
          className="text-muted-foreground hidden md:inline-flex"
        >
          <CopyIcon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Delete message"
          className="text-destructive hover:bg-destructive/10"
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="More options"
          className="text-muted-foreground"
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

export function MailView() {
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <MailViewToolbar />
      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full [&>[data-slot=scroll-area-viewport]>div]:h-full">
          <div className="flex min-h-full items-center justify-center p-6">
            <Empty className="max-w-md flex-none gap-6 rounded-none border-0 bg-transparent p-0">
              <EmptyHeader className="items-center gap-5 text-center">
                <EmptyMedia className="mb-0">
                  <IconStack aria-hidden="true">
                    <MailIcon strokeWidth="1.9" aria-hidden="true" />
                  </IconStack>
                </EmptyMedia>
                <div className="flex flex-col items-center gap-1.5">
                  <EmptyTitle className="text-lg font-semibold tracking-tight">
                    It's empty here
                  </EmptyTitle>
                  <EmptyDescription className="max-w-80">
                    Choose an email to view details
                  </EmptyDescription>
                </div>
              </EmptyHeader>
              <EmptyContent className="flex-row flex-wrap justify-center gap-2">
                <Button variant="outline" size="sm">
                  <SparklesIcon aria-hidden="true" />
                  Ask AI
                </Button>
                <Button variant="outline" size="sm">
                  <MailIcon aria-hidden="true" />
                  Send Email
                </Button>
                <Button variant="outline" size="sm">
                  <PlusIcon aria-hidden="true" />
                  New Email
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}