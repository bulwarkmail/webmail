import { useEffect, useState } from "react"
import { cn } from "@/lib/cn"
import { useTheme } from "next-themes"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/reui/avatar"
import { Button } from "@/components/reui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/reui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/reui/sidebar"
import { USER } from "./data"
import { SunIcon, MoonIcon, MonitorIcon, ChevronsUpDownIcon, UserIcon, SettingsIcon, PaletteIcon, LogOutIcon } from "lucide-react"

const THEMES = [
  {
    value: "light",
    label: "Light",
    icon: (
      <SunIcon className="size-3.5" aria-hidden="true" />
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <MoonIcon className="size-3.5" aria-hidden="true" />
    ),
  },
  {
    value: "system",
    label: "System",
    icon: (
      <MonitorIcon className="size-3.5" aria-hidden="true" />
    ),
  },
]

function ThemeSegmentedToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const currentTheme = mounted ? (theme ?? "system") : "system"

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="bg-muted/60 inline-flex items-center gap-0.5 rounded-full p-0.5"
    >
      {THEMES.map(({ value, label, icon }) => {
        const isActive = currentTheme === value
        return (
          <Button
            key={value}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={label}
            variant="ghost"
            size="icon-xs"
            onClick={() => setTheme(value)}
            className={cn(
              "rounded-full",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {icon}
          </Button>
        )
      })}
    </div>
  )
}

export function UserPanel() {
  return (
    <SidebarMenu>
      {/* Sidebar */}
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label="Open account menu"
              className="group-data-[collapsible=icon]:h-12! group-data-[collapsible=icon]:p-0!"
            >
              <Avatar className="size-8">
                <AvatarImage src={USER.avatar} alt={USER.name} />
                <AvatarFallback>{USER.initials}</AvatarFallback>
              </Avatar>
              <div className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="text-foreground truncate text-sm font-medium">
                  {USER.name}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {USER.email}
                </span>
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4 shrink-0 opacity-60" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            side="bottom"
            align="start"
            sideOffset={8}
            className="w-64"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center gap-2.5 py-2">
                <Avatar className="size-8">
                  <AvatarImage src={USER.avatar} alt={USER.name} />
                  <AvatarFallback>{USER.initials}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col">
                  <span className="text-foreground text-sm font-semibold">
                    {USER.name}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {USER.email}
                  </span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem>
                  <UserIcon aria-hidden="true" />
                  Profile
                  <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <SettingsIcon aria-hidden="true" />
                  Settings
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {/* The swatches set a value in place, so the menu outlives the click. */}
                <DropdownMenuItem
                  onSelect={(event) => event.preventDefault()}
                  className="cursor-default focus:bg-transparent!"
                >
                  <PaletteIcon aria-hidden="true" />
                  Theme
                  <div className="ml-auto">
                    <ThemeSegmentedToggle />
                  </div>
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <LogOutIcon aria-hidden="true" />
                Sign Out
                <DropdownMenuShortcut>⇧⌘Q</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}