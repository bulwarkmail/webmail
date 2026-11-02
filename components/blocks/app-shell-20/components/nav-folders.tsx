import { useState } from "react"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/reui/sidebar"

import { MAIL_FOLDERS } from "./data"

export function NavFolders() {
  const [activeId, setActiveId] = useState("inbox")

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Mail</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.25">
          {MAIL_FOLDERS.map((folder) => (
            <SidebarMenuItem key={folder.id}>
              <SidebarMenuButton
                tooltip={folder.label}
                isActive={activeId === folder.id}
                onClick={() => setActiveId(folder.id)}
              >
                {folder.icon}
                <span>{folder.label}</span>
              </SidebarMenuButton>
              {folder.count !== undefined && folder.count > 0 && (
                <SidebarMenuBadge>{folder.count}</SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}