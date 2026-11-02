import { useId, useState } from "react"

import { Button } from "@/components/reui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/reui/dialog"
import { Input } from "@/components/reui/input"
import { Label } from "@/components/reui/label"
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/reui/sidebar"
import { MAIL_LABELS } from "./data"
import { PlusIcon } from "lucide-react"

function CreateLabelDialog() {
  const [open, setOpen] = useState(false)
  const nameId = useId()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <SidebarGroupAction aria-label="Create label" title="Create label">
          <PlusIcon aria-hidden="true" />
        </SidebarGroupAction>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Create Label</DialogTitle>
          <DialogDescription>
            Group related mail under a label.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={nameId}>Name</Label>
          <Input id={nameId} placeholder="Receipts" autoFocus />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={() => setOpen(false)}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function NavLabels() {
  const [activeId, setActiveId] = useState<string | null>(null)

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Labels</SidebarGroupLabel>
      <CreateLabelDialog />
      <SidebarGroupContent>
        <SidebarMenu>
          {MAIL_LABELS.map((label) => (
            <SidebarMenuItem key={label.id}>
              <SidebarMenuButton
                tooltip={label.label}
                isActive={activeId === label.id}
                onClick={() => setActiveId(label.id)}
              >
                {label.icon}
                <span>{label.label}</span>
              </SidebarMenuButton>
              {label.count !== undefined && label.count > 0 && (
                <SidebarMenuBadge>{label.count}</SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}