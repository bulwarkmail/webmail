import { MailIcon, PlusIcon } from "lucide-react"
import { IconStack } from "@/components/reui/icon-stack"
import { Button } from "@/components/reui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/reui/empty"

/** The block's reader empty state with host translations and a real compose action. */
export function MailEmptyState({ title, description, composeLabel, onCompose }: {
  title: string; description: string; composeLabel: string; onCompose?: () => void;
}) {
  return <div className="flex min-h-full flex-1 items-center justify-center p-6">
    <Empty className="max-w-md flex-none gap-6 rounded-none border-0 bg-transparent p-0">
      <EmptyHeader className="items-center gap-5 text-center">
        <EmptyMedia className="mb-0"><IconStack aria-hidden="true"><MailIcon strokeWidth="1.9" aria-hidden="true" /></IconStack></EmptyMedia>
        <div className="flex flex-col items-center gap-1.5">
          <EmptyTitle className="text-lg font-semibold tracking-tight"><h2>{title}</h2></EmptyTitle>
          <EmptyDescription className="max-w-80">{description}</EmptyDescription>
        </div>
      </EmptyHeader>
      {onCompose && <EmptyContent className="flex-row flex-wrap justify-center gap-2"><Button type="button" variant="outline" size="sm" onClick={onCompose}><PlusIcon aria-hidden="true" />{composeLabel}</Button></EmptyContent>}
    </Empty>
  </div>
}
