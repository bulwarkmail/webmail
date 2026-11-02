import { ScrollArea } from "@/components/reui/scroll-area"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/reui/sidebar"

import { ComposeDialog } from "./compose-dialog"
import { NAV_SECONDARY } from "./data"
import { NavContacts } from "./nav-contacts"
import { NavFolders } from "./nav-folders"
import { NavLabels } from "./nav-labels"
import { UserPanel } from "./user-panel"

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="gap-2 pt-1">
        {/* Account */}
        <UserPanel />
        {/* Compose */}
        <ComposeDialog />
      </SidebarHeader>

      <SidebarContent className="overflow-hidden">
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2">
            <NavFolders />
            <NavLabels />
            <NavContacts />
          </div>
        </ScrollArea>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {NAV_SECONDARY.map((item) => (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                size="sm"
                tooltip={item.label}
                asChild
                className="[&_svg]:size-3.5"
              >
                <a href="#">
                  {item.icon}
                  <span>{item.label}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}