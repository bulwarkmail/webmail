// Memail's primary interface glyphs: direct SSR imports keep the full icon catalog out of the bundle.
import { forwardRef } from 'react';
import type { Icon } from '@phosphor-icons/react';
import type { IconProps, TablerIcon } from '@tabler/icons-react';
import { ArchiveIcon as GlyphArchive } from "@phosphor-icons/react/dist/ssr/Archive";
import { ArrowBendUpLeftIcon as GlyphArrowBendUpLeft } from "@phosphor-icons/react/dist/ssr/ArrowBendUpLeft";
import { ArrowBendUpRightIcon as GlyphArrowBendUpRight } from "@phosphor-icons/react/dist/ssr/ArrowBendUpRight";
import { ArrowsClockwiseIcon as GlyphArrowsClockwise } from "@phosphor-icons/react/dist/ssr/ArrowsClockwise";
import { BellSimpleIcon as GlyphBellSimple } from "@phosphor-icons/react/dist/ssr/BellSimple";
import { BookmarkSimpleIcon as GlyphBookmarkSimple } from "@phosphor-icons/react/dist/ssr/BookmarkSimple";
import { CalendarBlankIcon as GlyphCalendarBlank } from "@phosphor-icons/react/dist/ssr/CalendarBlank";
import { CalendarDotsIcon as GlyphCalendarDots } from "@phosphor-icons/react/dist/ssr/CalendarDots";
import { CaretDoubleLeftIcon as GlyphCaretDoubleLeft } from "@phosphor-icons/react/dist/ssr/CaretDoubleLeft";
import { CaretDoubleRightIcon as GlyphCaretDoubleRight } from "@phosphor-icons/react/dist/ssr/CaretDoubleRight";
import { CaretDownIcon as GlyphCaretDown } from "@phosphor-icons/react/dist/ssr/CaretDown";
import { CaretLeftIcon as GlyphCaretLeft } from "@phosphor-icons/react/dist/ssr/CaretLeft";
import { CaretRightIcon as GlyphCaretRight } from "@phosphor-icons/react/dist/ssr/CaretRight";
import { CaretUpIcon as GlyphCaretUp } from "@phosphor-icons/react/dist/ssr/CaretUp";
import { CheckIcon as GlyphCheck } from "@phosphor-icons/react/dist/ssr/Check";
import { ClockIcon as GlyphClock } from "@phosphor-icons/react/dist/ssr/Clock";
import { DotsThreeIcon as GlyphDotsThree } from "@phosphor-icons/react/dist/ssr/DotsThree";
import { DotsThreeVerticalIcon as GlyphDotsThreeVertical } from "@phosphor-icons/react/dist/ssr/DotsThreeVertical";
import { EnvelopeSimpleIcon as GlyphEnvelopeSimple } from "@phosphor-icons/react/dist/ssr/EnvelopeSimple";
import { EnvelopeSimpleOpenIcon as GlyphEnvelopeSimpleOpen } from "@phosphor-icons/react/dist/ssr/EnvelopeSimpleOpen";
import { EyeIcon as GlyphEye } from "@phosphor-icons/react/dist/ssr/Eye";
import { EyeSlashIcon as GlyphEyeSlash } from "@phosphor-icons/react/dist/ssr/EyeSlash";
import { FileTextIcon as GlyphFileText } from "@phosphor-icons/react/dist/ssr/FileText";
import { FolderSimpleIcon as GlyphFolderSimple } from "@phosphor-icons/react/dist/ssr/FolderSimple";
import { FunnelIcon as GlyphFunnel } from "@phosphor-icons/react/dist/ssr/Funnel";
import { GearSixIcon as GlyphGearSix } from "@phosphor-icons/react/dist/ssr/GearSix";
import { KeyboardIcon as GlyphKeyboard } from "@phosphor-icons/react/dist/ssr/Keyboard";
import { LightningIcon as GlyphLightning } from "@phosphor-icons/react/dist/ssr/Lightning";
import { LinkSimpleIcon as GlyphLinkSimple } from "@phosphor-icons/react/dist/ssr/LinkSimple";
import { ListIcon as GlyphList } from "@phosphor-icons/react/dist/ssr/List";
import { MagnifyingGlassIcon as GlyphMagnifyingGlass } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { NotePencilIcon as GlyphNotePencil } from "@phosphor-icons/react/dist/ssr/NotePencil";
import { PaperPlaneTiltIcon as GlyphPaperPlaneTilt } from "@phosphor-icons/react/dist/ssr/PaperPlaneTilt";
import { PaperclipIcon as GlyphPaperclip } from "@phosphor-icons/react/dist/ssr/Paperclip";
import { PencilSimpleIcon as GlyphPencilSimple } from "@phosphor-icons/react/dist/ssr/PencilSimple";
import { PlusIcon as GlyphPlus } from "@phosphor-icons/react/dist/ssr/Plus";
import { ProhibitIcon as GlyphProhibit } from "@phosphor-icons/react/dist/ssr/Prohibit";
import { RowsIcon as GlyphRows } from "@phosphor-icons/react/dist/ssr/Rows";
import { ShieldIcon as GlyphShield } from "@phosphor-icons/react/dist/ssr/Shield";
import { SidebarSimpleIcon as GlyphSidebarSimple } from "@phosphor-icons/react/dist/ssr/SidebarSimple";
import { SignOutIcon as GlyphSignOut } from "@phosphor-icons/react/dist/ssr/SignOut";
import { StarIcon as GlyphStar } from "@phosphor-icons/react/dist/ssr/Star";
import { TagIcon as GlyphTag } from "@phosphor-icons/react/dist/ssr/Tag";
import { TagSimpleIcon as GlyphTagSimple } from "@phosphor-icons/react/dist/ssr/TagSimple";
import { TrashIcon as GlyphTrash } from "@phosphor-icons/react/dist/ssr/Trash";
import { TrayIcon as GlyphTray } from "@phosphor-icons/react/dist/ssr/Tray";
import { UsersThreeIcon as GlyphUsersThree } from "@phosphor-icons/react/dist/ssr/UsersThree";
import { XIcon as GlyphX } from "@phosphor-icons/react/dist/ssr/X";

function glyph(Glyph: Icon, name: string): TablerIcon {
  const Component = forwardRef<SVGSVGElement, IconProps>(function MemailGlyph({stroke, strokeWidth, color, fill, ...props}, ref) {
    const bold = Number(strokeWidth ?? (typeof stroke === 'number' ? stroke : 0)) >= 2.5;
    return <Glyph ref={ref} size={24} weight={fill === 'none' ? (bold ? 'bold' : 'regular') : fill === 'currentColor' ? 'fill' : bold ? 'bold' : 'duotone'} color={typeof stroke === 'string' ? stroke : color ?? 'currentColor'} data-memail-glyph="" data-memail-icon={name} {...(fill && fill !== 'none' ? {fill} : {})} {...props} />;
  });
  Component.displayName = `Memail${name}`;
  return Component;
}
export const Mail = /* @__PURE__ */ glyph(GlyphEnvelopeSimple, "Mail");
export const MailOpen = /* @__PURE__ */ glyph(GlyphEnvelopeSimpleOpen, "MailOpen");
export const Inbox = /* @__PURE__ */ glyph(GlyphTray, "Inbox");
export const CalendarDays = /* @__PURE__ */ glyph(GlyphCalendarDots, "CalendarDays");
export const CalendarEvent = /* @__PURE__ */ glyph(GlyphCalendarBlank, "CalendarEvent");
export const Users = /* @__PURE__ */ glyph(GlyphUsersThree, "Users");
export const Folder = /* @__PURE__ */ glyph(GlyphFolderSimple, "Folder");
export const Settings = /* @__PURE__ */ glyph(GlyphGearSix, "Settings");
export const Keyboard = /* @__PURE__ */ glyph(GlyphKeyboard, "Keyboard");
export const Plus = /* @__PURE__ */ glyph(GlyphPlus, "Plus");
export const Search = /* @__PURE__ */ glyph(GlyphMagnifyingGlass, "Search");
export const Archive = /* @__PURE__ */ glyph(GlyphArchive, "Archive");
export const Send = /* @__PURE__ */ glyph(GlyphPaperPlaneTilt, "Send");
export const File = /* @__PURE__ */ glyph(GlyphFileText, "File");
export const FileText = /* @__PURE__ */ glyph(GlyphFileText, "FileText");
export const Trash = /* @__PURE__ */ glyph(GlyphTrash, "Trash");
export const Trash2 = /* @__PURE__ */ glyph(GlyphTrash, "Trash2");
export const Ban = /* @__PURE__ */ glyph(GlyphProhibit, "Ban");
export const Star = /* @__PURE__ */ glyph(GlyphStar, "Star");
export const Tag = /* @__PURE__ */ glyph(GlyphTagSimple, "Tag");
export const Tags = /* @__PURE__ */ glyph(GlyphTag, "Tags");
export const Shield = /* @__PURE__ */ glyph(GlyphShield, "Shield");
export const Reply = /* @__PURE__ */ glyph(GlyphArrowBendUpLeft, "Reply");
export const Forward = /* @__PURE__ */ glyph(GlyphArrowBendUpRight, "Forward");
export const PenSquare = /* @__PURE__ */ glyph(GlyphNotePencil, "PenSquare");
export const Pencil = /* @__PURE__ */ glyph(GlyphPencilSimple, "Pencil");
export const Bookmark = /* @__PURE__ */ glyph(GlyphBookmarkSimple, "Bookmark");
export const Rows3 = /* @__PURE__ */ glyph(GlyphRows, "Rows3");
export const List = /* @__PURE__ */ glyph(GlyphList, "List");
export const PanelRight = /* @__PURE__ */ glyph(GlyphSidebarSimple, "PanelRight");
export const MoreHorizontal = /* @__PURE__ */ glyph(GlyphDotsThree, "MoreHorizontal");
export const MoreVertical = /* @__PURE__ */ glyph(GlyphDotsThreeVertical, "MoreVertical");
export const Filter = /* @__PURE__ */ glyph(GlyphFunnel, "Filter");
export const ChevronDown = /* @__PURE__ */ glyph(GlyphCaretDown, "ChevronDown");
export const ChevronUp = /* @__PURE__ */ glyph(GlyphCaretUp, "ChevronUp");
export const ChevronLeft = /* @__PURE__ */ glyph(GlyphCaretLeft, "ChevronLeft");
export const ChevronRight = /* @__PURE__ */ glyph(GlyphCaretRight, "ChevronRight");
export const ChevronsLeft = /* @__PURE__ */ glyph(GlyphCaretDoubleLeft, "ChevronsLeft");
export const ChevronsRight = /* @__PURE__ */ glyph(GlyphCaretDoubleRight, "ChevronsRight");
export const LogOut = /* @__PURE__ */ glyph(GlyphSignOut, "LogOut");
export const Bell = /* @__PURE__ */ glyph(GlyphBellSimple, "Bell");
export const RefreshCw = /* @__PURE__ */ glyph(GlyphArrowsClockwise, "RefreshCw");
export const Paperclip = /* @__PURE__ */ glyph(GlyphPaperclip, "Paperclip");
export const Link = /* @__PURE__ */ glyph(GlyphLinkSimple, "Link");
export const Eye = /* @__PURE__ */ glyph(GlyphEye, "Eye");
export const EyeOff = /* @__PURE__ */ glyph(GlyphEyeSlash, "EyeOff");
export const X = /* @__PURE__ */ glyph(GlyphX, "X");
export const Check = /* @__PURE__ */ glyph(GlyphCheck, "Check");
export const Zap = /* @__PURE__ */ glyph(GlyphLightning, "Zap");
export const Clock = /* @__PURE__ */ glyph(GlyphClock, "Clock");

import { ArrowBendDoubleUpLeftIcon } from "@phosphor-icons/react/dist/ssr/ArrowBendDoubleUpLeft";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/ssr/FolderOpen";
export const ReplyAll = /* @__PURE__ */ glyph(ArrowBendDoubleUpLeftIcon, "ReplyAll");
export const FolderOpen = /* @__PURE__ */ glyph(FolderOpenIcon, "FolderOpen");

import { CalendarDotsIcon as GlyphSidebarCalendarDots } from "@phosphor-icons/react/dist/ssr/CalendarDots";
export const CalendarClock = /* @__PURE__ */ glyph(GlyphSidebarCalendarDots, "CalendarClock");

import { BellSlashIcon as GlyphSidebarBellSlash } from "@phosphor-icons/react/dist/ssr/BellSlash";
export const BellOff = /* @__PURE__ */ glyph(GlyphSidebarBellSlash, "BellOff");

import { UserCircleIcon as GlyphSidebarUserCircle } from "@phosphor-icons/react/dist/ssr/UserCircle";
export const User = /* @__PURE__ */ glyph(GlyphSidebarUserCircle, "User");

import { NotebookIcon as GlyphSidebarNotebook } from "@phosphor-icons/react/dist/ssr/Notebook";
export const NotebookPen = /* @__PURE__ */ glyph(GlyphSidebarNotebook, "NotebookPen");

import { EnvelopeIcon as GlyphSidebarEnvelope } from "@phosphor-icons/react/dist/ssr/Envelope";
export const Mails = /* @__PURE__ */ glyph(GlyphSidebarEnvelope, "Mails");

import { NotePencilIcon as GlyphSidebarNotePencil } from "@phosphor-icons/react/dist/ssr/NotePencil";
export const FilePenLine = /* @__PURE__ */ glyph(GlyphSidebarNotePencil, "FilePenLine");

import { WarningIcon as GlyphSidebarWarning } from "@phosphor-icons/react/dist/ssr/Warning";
export const AlertTriangle = /* @__PURE__ */ glyph(GlyphSidebarWarning, "AlertTriangle");
