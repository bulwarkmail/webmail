import { Button } from "@/components/reui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/reui/tooltip"
import { ASIDE_ITEMS } from "./data"
import { PlusIcon } from "lucide-react"

export function AppAside() {
  return (
    <aside className="hidden w-11 shrink-0 flex-col items-center gap-2.5 pt-4 pr-2 pb-4 lg:flex">
      <TooltipProvider>
        {ASIDE_ITEMS.map((item) => (
          <Tooltip key={item.id}>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={item.label}
                className="text-muted-foreground hover:text-foreground shadow-sm shadow-black/5"
              >
                {item.icon}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{item.label}</TooltipContent>
          </Tooltip>
        ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Add shortcut"
              className="text-muted-foreground hover:text-foreground mt-1 shadow-sm shadow-black/5"
            >
              <PlusIcon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Add Shortcut</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </aside>
  )
}