import { useState } from "react"

import { Button } from "@/components/reui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/reui/dropdown-menu"
import { MAIL_CATEGORIES } from "./data"
import { ChevronDownIcon } from "lucide-react"

export function CategorySelector() {
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      MAIL_CATEGORIES.map((c) => [c.id, Boolean(c.defaultChecked)])
    )
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground shrink-0"
        >
          Categories
          <ChevronDownIcon className="size-3.5 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Filter by Category</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {MAIL_CATEGORIES.map((category) => (
            <DropdownMenuCheckboxItem
              key={category.id}
              checked={checked[category.id]}
              onCheckedChange={(value) =>
                setChecked((prev) => ({ ...prev, [category.id]: value }))
              }
            >
              {category.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}