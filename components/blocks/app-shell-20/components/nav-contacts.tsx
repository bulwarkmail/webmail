import { cn } from "@/lib/cn"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/reui/avatar"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/reui/sidebar"
import { MAIL_CONTACTS } from "./data"
import { PlusIcon } from "lucide-react"

export function NavContacts() {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Direct Messages</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {MAIL_CONTACTS.map((contact) => (
            <SidebarMenuItem key={contact.id}>
              <SidebarMenuButton asChild>
                <a href="#">
                  <span className="relative flex shrink-0">
                    <Avatar className="size-5">
                      {contact.src && (
                        <AvatarImage src={contact.src} alt={contact.name} />
                      )}
                      <AvatarFallback
                        className={cn(
                          "text-[9px] font-semibold text-white",
                          contact.color
                        )}
                      >
                        {contact.initials}
                      </AvatarFallback>
                    </Avatar>
                    {contact.online && (
                      <span
                        className="border-background absolute -end-0.5 -bottom-0.5 size-2 rounded-full border-2 bg-emerald-500"
                        aria-label="Online"
                      />
                    )}
                  </span>
                  <span className="truncate">
                    {contact.name}
                    {contact.you && (
                      <span className="text-muted-foreground"> (You)</span>
                    )}
                  </span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="text-muted-foreground">
              <a href="#">
                <span className="flex size-5 shrink-0 items-center justify-center [&_svg]:size-3.5">
                  <PlusIcon aria-hidden="true" />
                </span>
                <span>Add Teammates</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}