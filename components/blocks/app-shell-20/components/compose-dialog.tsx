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
import { Textarea } from "@/components/reui/textarea"
import { SquarePenIcon, PaperclipIcon, SendIcon } from "lucide-react"

export function ComposeDialog() {
  const [open, setOpen] = useState(false)
  const toId = useId()
  const subjectId = useId()
  const bodyId = useId()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          className="w-full justify-center group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:gap-0! group-data-[collapsible=icon]:p-0!"
          aria-label="New mail"
        >
          <SquarePenIcon aria-hidden="true" />
          <span className="max-w-40 overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200 group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:opacity-0">
            New Mail
          </span>
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Message</DialogTitle>
          <DialogDescription>Write and send a new email.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={toId}>To</Label>
            <Input id={toId} type="email" placeholder="name@company.com" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={subjectId}>Subject</Label>
            <Input id={subjectId} placeholder="Project update" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={bodyId}>Message</Label>
            <Textarea
              id={bodyId}
              rows={6}
              placeholder="Write your message..."
              className="resize-none"
            />
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" aria-label="Attach file">
            <PaperclipIcon aria-hidden="true" />
            Attach
          </Button>
          <div className="flex items-center gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Discard</Button>
            </DialogClose>
            <Button onClick={() => setOpen(false)}>
              <SendIcon aria-hidden="true" />
              Send
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}