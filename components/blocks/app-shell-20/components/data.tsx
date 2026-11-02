import { type ReactNode } from "react"
import { InboxIcon, FileTextIcon, SendIcon, ArchiveIcon, ClockIcon, TriangleAlertIcon, Trash2Icon, Headphones, SettingsIcon, MessageSquareIcon, UserCircle, BarChart3Icon, UsersIcon, ShieldCheckIcon } from "lucide-react"

// ── Types ──

export type MailFolder = {
  id: string
  label: string
  icon: ReactNode
  count?: number
}

export type MailLabel = {
  id: string
  label: string
  icon: ReactNode
  count?: number
}

export type MailContact = {
  id: string
  name: string
  initials: string
  color: string
  src?: string
  online?: boolean
  you?: boolean
}

export type AsideItem = {
  id: string
  label: string
  icon: ReactNode
}

export type SecondaryItem = {
  id: string
  label: string
  icon: ReactNode
}

export type MailCategory = {
  id: string
  label: string
  defaultChecked?: boolean
}

// ── Account ──

export const USER = {
  name: "Nick Bold",
  email: "nick@reui.io",
  initials: "NB",
  avatar:
    "https://images.unsplash.com/photo-1543299750-19d1d6297053?w=96&h=96&dpr=2&q=80",
} as const

// ── Mail folders ──

export const MAIL_FOLDERS: MailFolder[] = [
  {
    id: "inbox",
    label: "Inbox",
    icon: (
      <InboxIcon aria-hidden="true" />
    ),
    count: 3,
  },
  {
    id: "draft",
    label: "Draft",
    icon: (
      <FileTextIcon aria-hidden="true" />
    ),
    count: 45,
  },
  {
    id: "sent",
    label: "Sent",
    icon: (
      <SendIcon aria-hidden="true" />
    ),
    count: 9,
  },
]

// ── Labels ──

export const MAIL_LABELS: MailLabel[] = [
  {
    id: "archive",
    label: "Archive",
    icon: (
      <ArchiveIcon aria-hidden="true" />
    ),
    count: 12,
  },
  {
    id: "snoozed",
    label: "Snoozed",
    icon: (
      <ClockIcon aria-hidden="true" />
    ),
    count: 4,
  },
  {
    id: "spam",
    label: "Spam",
    icon: (
      <TriangleAlertIcon aria-hidden="true" />
    ),
    count: 3,
  },
  {
    id: "trash",
    label: "Trash",
    icon: (
      <Trash2Icon aria-hidden="true" />
    ),
    count: 34,
  },
]

// ── Direct messages ──

export const MAIL_CONTACTS: MailContact[] = [
  {
    id: "you",
    name: "Nick Bold",
    src: "https://images.unsplash.com/photo-1543299750-19d1d6297053?w=96&h=96&dpr=2&q=80",
    initials: "NB",
    color: "bg-primary",
    online: true,
    you: true,
  },
  {
    id: "sarah",
    name: "Sarah Chen",
    src: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=96&h=96&dpr=2&q=80",
    initials: "SC",
    color: "bg-violet-500",
  },
  {
    id: "marcus",
    name: "Marcus Lee",
    src: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=96&h=96&dpr=2&q=80",
    initials: "ML",
    color: "bg-emerald-500",
  },
]

// ── Footer nav ──

export const NAV_SECONDARY: SecondaryItem[] = [
  {
    id: "support",
    label: "Support",
    icon: (
      <Headphones aria-hidden="true" />
    ),
  },
  {
    id: "settings",
    label: "Settings",
    icon: (
      <SettingsIcon aria-hidden="true" />
    ),
  },
  {
    id: "feedback",
    label: "Feedback",
    icon: (
      <MessageSquareIcon aria-hidden="true" />
    ),
  },
]

// ── App rail (right aside) ──

export const ASIDE_ITEMS: AsideItem[] = [
  {
    id: "profile",
    label: "Profile",
    icon: (
      <UserCircle aria-hidden="true" />
    ),
  },
  {
    id: "dashboard",
    label: "Dashboard",
    icon: (
      <BarChart3Icon aria-hidden="true" />
    ),
  },
  {
    id: "account",
    label: "Account",
    icon: (
      <SettingsIcon aria-hidden="true" />
    ),
  },
  {
    id: "network",
    label: "Network",
    icon: (
      <UsersIcon aria-hidden="true" />
    ),
  },
  {
    id: "security",
    label: "Authentication",
    icon: (
      <ShieldCheckIcon aria-hidden="true" />
    ),
  },
]

// ── List categories ──

export const MAIL_CATEGORIES: MailCategory[] = [
  { id: "primary", label: "Primary", defaultChecked: true },
  { id: "social", label: "Social" },
  { id: "promotions", label: "Promotions" },
  { id: "updates", label: "Updates", defaultChecked: true },
  { id: "forums", label: "Forums" },
  { id: "shopping", label: "Shopping" },
  { id: "travel", label: "Travel" },
  { id: "finance", label: "Finance" },
  { id: "newsletters", label: "Newsletters" },
  { id: "spam", label: "Spam" },
]