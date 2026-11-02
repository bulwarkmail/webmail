// Memail primary glyphs use Phosphor; specialized icons retain the Lucide adapter.
// Export names and legacy stored/custom icon identifiers remain compatible.
export type { TablerIcon as AppIcon, IconProps as AppIconProps } from '@tabler/icons-react';
export { iconForName, toStoredIconName, toTablerName, POPULAR_ICON_NAMES, loadAllIconNames, TABLER_ICON_PREFIX } from './named';
import { adaptIcon } from './adapt';
import {
  Accessibility as GlyphAccessibility,
  Activity as GlyphActivity,
  AlertCircle as GlyphAlertCircle,
  AlertTriangle as GlyphAlertTriangle,
  AlignCenter as GlyphAlignCenter,
  AlignLeft as GlyphAlignLeft,
  AlignRight as GlyphAlignRight,
  ArrowDown as GlyphArrowDown,
  ArrowDownAZ as GlyphArrowDownAZ,
  ArrowLeft as GlyphArrowLeft,
  ArrowLeftRight as GlyphArrowLeftRight,
  ArrowRight as GlyphArrowRight,
  ArrowUp as GlyphArrowUp,
  ArrowUpDown as GlyphArrowUpDown,
  ArrowUpCircle as GlyphArrowUpCircle,
  BadgeCheck as GlyphBadgeCheck,
  Baseline as GlyphBaseline,
  Bed as GlyphBed,
  BellOff as GlyphBellOff,
  BellRing as GlyphBellRinging,
  Bold as GlyphBold,
  Book as GlyphBook,
  BookOpen as GlyphBookOpen,
  BookPlus as GlyphBookPlus,
  BookUser as GlyphBookUser,
  BookmarkPlus as GlyphBookmarkPlus,
  Box as GlyphBox,
  Brain as GlyphBrain,
  Briefcase as GlyphBriefcase,
  Bug as GlyphBug,
  Building as GlyphBuilding,
  Building2 as GlyphBuilding2,
  Bus as GlyphBus,
  Cake as GlyphCake,
  Calendar as GlyphCalendar,
  CalendarArrowUp as GlyphCalendarArrowUp,
  CalendarCheck as GlyphCalendarCheck,
  CalendarClock as GlyphCalendarClock,
  CalendarPlus as GlyphCalendarPlus,
  CalendarX as GlyphCalendarX,
  Camera as GlyphCamera,
  Car as GlyphCar,
  CheckCheck as GlyphCheckCheck,
  CheckCircle as GlyphCheckCircle,
  CheckCircle2 as GlyphCheckCircle2,
  CheckSquare as GlyphCheckSquare,
  Circle as GlyphCircle,
  Clipboard as GlyphClipboard,
  ClipboardCopy as GlyphClipboardCopy,
  Clock3 as GlyphClock3,
  Cloud as GlyphCloud,
  CloudOff as GlyphCloudOff,
  Code as GlyphCode,
  Columns3 as GlyphColumns3,
  Copy as GlyphCopy,
  CopyPlus as GlyphCopyPlus,
  CornerDownLeft as GlyphCornerDownLeft,
  Database as GlyphDatabase,
  Download as GlyphDownload,
  EditIcon as GlyphEditIcon,
  Ellipsis as GlyphEllipsis,
  Eraser as GlyphEraser,
  ExternalLink as GlyphExternalLink,
  FileArchive as GlyphFileArchive,
  Files as GlyphFiles,
  FileAudio as GlyphFileAudio,
  FileCode as GlyphFileCode,
  FileImage as GlyphFileImage,
  FilePlus as GlyphFilePlus,
  FileSpreadsheet as GlyphFileSpreadsheet,
  FileVideo as GlyphFileVideo,
  Fish as GlyphFish,
  Flag as GlyphFlag,
  FlaskConical as GlyphFlaskConical,
  FoldVertical as GlyphFoldVertical,
  FolderInput as GlyphFolderInput,
  FolderPlus as GlyphFolderPlus,
  FolderSearch as GlyphFolderSearch,
  FolderSync as GlyphFolderSync,
  FolderUp as GlyphFolderUp,
  FolderX as GlyphFolderX,
  Globe as GlyphGlobe,
  Grid3x3 as GlyphGrid3x3,
  GripVertical as GlyphGripVertical,
  Hand as GlyphHand,
  HardDrive as GlyphHardDrive,
  Heading1 as GlyphHeading1,
  Heading2 as GlyphHeading2,
  Heart as GlyphHeart,
  HeartPulse as GlyphHeartRateMonitor,
  HelpCircle as GlyphHelpCircle,
  Highlighter as GlyphHighlighter,
  Home as GlyphHome,
  Image as GlyphImage,
  ImageIcon as GlyphImageIcon,
  Info as GlyphInfo,
  Italic as GlyphItalic,
  Key as GlyphKey,
  KeyRound as GlyphKeyRound,
  Languages as GlyphLanguages,
  Tag as GlyphLabelIcon,
  Layers as GlyphLayers,
  LayoutDashboard as GlyphLayoutDashboard,
  LayoutGrid as GlyphLayoutGrid,
  LayoutList as GlyphLayoutList,
  LayoutTemplate as GlyphLayoutTemplate,
  Lightbulb as GlyphLightbulb,
  Unlink as GlyphLinkOff,
  ListOrdered as GlyphListOrdered,
  ListTodo as GlyphListTodo,
  Loader2 as GlyphLoader2,
  Lock as GlyphLock,
  LockKeyhole as GlyphLockKeyhole,
  LockOpen as GlyphLockOpen,
  LogIn as GlyphLogIn,
  MailCheck as GlyphMailCheck,
  MailX as GlyphMailX,
  Mails as GlyphMails,
  MapPin as GlyphMapPin,
  Maximize2 as GlyphMaximize2,
  Menu as GlyphMenu,
  MessageSquare as GlyphMessageSquare,
  MessagesSquare as GlyphMessagesSquare,
  Minimize2 as GlyphMinimize2,
  Minus as GlyphMinus,
  Monitor as GlyphMonitor,
  Moon as GlyphMoon,
  NotebookPen as GlyphNotebookPen,
  Package as GlyphPackage,
  PackageCheck as GlyphPackageCheck,
  Palette as GlyphPalette,
  Palmtree as GlyphPalmtree,
  PalmtreeIcon as GlyphPalmtreeIcon,
  PanelLeftClose as GlyphPanelLeftClose,
  PanelLeftOpen as GlyphPanelLeftOpen,
  PanelRightClose as GlyphPanelRightClose,
  PanelRightOpen as GlyphPanelRightOpen,
  Pause as GlyphPause,
  Plane as GlyphPlane,
  Utensils as GlyphRestaurant,
  ShoppingBag as GlyphShoppingBag,
  Square as GlyphStop,
  PenLine as GlyphPenLine,
  PenTool as GlyphPenTool,
  Phone as GlyphPhone,
  Pin as GlyphPin,
  PinOff as GlyphPinOff,
  Play as GlyphPlay,
  PlayCircle as GlyphPlayCircle,
  Pointer as GlyphPointer,
  Power as GlyphPower,
  PowerOff as GlyphPowerOff,
  Presentation as GlyphPresentation,
  Printer as GlyphPrinter,
  Puzzle as GlyphPuzzle,
  QrCode as GlyphQrCode,
  Quote as GlyphQuote,
  Redo as GlyphRedo,
  RemoveFormatting as GlyphRemoveFormatting,
  Repeat as GlyphRepeat,
  RotateCcw as GlyphRotateCcw,
  RotateCw as GlyphRotateCw,
  Save as GlyphSave,
  Scale as GlyphScale,
  Scissors as GlyphScissors,
  ScrollText as GlyphScrollText,
  SearchX as GlyphSearchX,
  Server as GlyphServer,
  Share2 as GlyphShare2,
  ShieldAlert as GlyphShieldAlert,
  SlidersHorizontal as GlyphSlidersHorizontal,
  ShieldCheck as GlyphShieldCheck,
  Shield as GlyphShieldFilled,
  Shuffle as GlyphShuffle,
  Smartphone as GlyphSmartphone,
  Sparkles as GlyphSparkles,
  Square as GlyphSquare,
  SquarePen as GlyphSquarePen,
  StarOff as GlyphStarOff,
  StickyNote as GlyphStickyNote,
  Store as GlyphStore,
  Strikethrough as GlyphStrikethrough,
  Sun as GlyphSun,
  SwatchBook as GlyphSwatchBook,
  Table as GlyphTable,
  Terminal as GlyphTerminal,
  Ticket as GlyphTicket,
  Train as GlyphTrain,
  TriangleAlert as GlyphTriangleAlert,
  Truck as GlyphTruck,
  Type as GlyphType,
  Underline as GlyphUnderline,
  Undo as GlyphUndo,
  UnfoldVertical as GlyphUnfoldVertical,
  Unlock as GlyphUnlock,
  Upload as GlyphUpload,
  User as GlyphUser,
  UserCircle as GlyphUserCircle,
  UserMinus as GlyphUserMinus,
  UserPen as GlyphUserPen,
  UserPlus as GlyphUserPlus,
  UsersRound as GlyphUsersRound,
  Video as GlyphVideo,
  Volume2 as GlyphVolume2,
  VolumeOff as GlyphVolumeOff,
  XCircle as GlyphXCircle,
  ZoomIn as GlyphZoomIn,
  ZoomOut as GlyphZoomOut,
} from 'lucide-react';
export const Accessibility = /* @__PURE__ */ adaptIcon(GlyphAccessibility);
export const Activity = /* @__PURE__ */ adaptIcon(GlyphActivity);
export const AlertCircle = /* @__PURE__ */ adaptIcon(GlyphAlertCircle);
export const AlertTriangle = /* @__PURE__ */ adaptIcon(GlyphAlertTriangle);
export const AlignCenter = /* @__PURE__ */ adaptIcon(GlyphAlignCenter);
export const AlignLeft = /* @__PURE__ */ adaptIcon(GlyphAlignLeft);
export const AlignRight = /* @__PURE__ */ adaptIcon(GlyphAlignRight);
export { Archive } from "./memail-glyphs";
export const ArrowDown = /* @__PURE__ */ adaptIcon(GlyphArrowDown);
export const ArrowDownAZ = /* @__PURE__ */ adaptIcon(GlyphArrowDownAZ);
export const ArrowLeft = /* @__PURE__ */ adaptIcon(GlyphArrowLeft);
export const ArrowLeftRight = /* @__PURE__ */ adaptIcon(GlyphArrowLeftRight);
export const ArrowRight = /* @__PURE__ */ adaptIcon(GlyphArrowRight);
export const ArrowUp = /* @__PURE__ */ adaptIcon(GlyphArrowUp);
export const ArrowUpDown = /* @__PURE__ */ adaptIcon(GlyphArrowUpDown);
export const ArrowUpCircle = /* @__PURE__ */ adaptIcon(GlyphArrowUpCircle);
export { Ban } from "./memail-glyphs";
export const BadgeCheck = /* @__PURE__ */ adaptIcon(GlyphBadgeCheck);
export const Baseline = /* @__PURE__ */ adaptIcon(GlyphBaseline);
export const Bed = /* @__PURE__ */ adaptIcon(GlyphBed);
export { Bell } from "./memail-glyphs";
export const BellOff = /* @__PURE__ */ adaptIcon(GlyphBellOff);
export const BellRinging = /* @__PURE__ */ adaptIcon(GlyphBellRinging);
export const Bold = /* @__PURE__ */ adaptIcon(GlyphBold);
export const Book = /* @__PURE__ */ adaptIcon(GlyphBook);
export const BookOpen = /* @__PURE__ */ adaptIcon(GlyphBookOpen);
export const BookPlus = /* @__PURE__ */ adaptIcon(GlyphBookPlus);
export const BookUser = /* @__PURE__ */ adaptIcon(GlyphBookUser);
export { Bookmark } from "./memail-glyphs";
export const BookmarkPlus = /* @__PURE__ */ adaptIcon(GlyphBookmarkPlus);
export const Box = /* @__PURE__ */ adaptIcon(GlyphBox);
export const Brain = /* @__PURE__ */ adaptIcon(GlyphBrain);
export const Briefcase = /* @__PURE__ */ adaptIcon(GlyphBriefcase);
export const Bug = /* @__PURE__ */ adaptIcon(GlyphBug);
export const Building = /* @__PURE__ */ adaptIcon(GlyphBuilding);
export const Building2 = /* @__PURE__ */ adaptIcon(GlyphBuilding2);
export const Bus = /* @__PURE__ */ adaptIcon(GlyphBus);
export const Cake = /* @__PURE__ */ adaptIcon(GlyphCake);
export const Calendar = /* @__PURE__ */ adaptIcon(GlyphCalendar);
export const CalendarArrowUp = /* @__PURE__ */ adaptIcon(GlyphCalendarArrowUp);
export const CalendarCheck = /* @__PURE__ */ adaptIcon(GlyphCalendarCheck);
export const CalendarClock = /* @__PURE__ */ adaptIcon(GlyphCalendarClock);
export { CalendarDays } from "./memail-glyphs";
export { CalendarEvent } from "./memail-glyphs";
export const CalendarPlus = /* @__PURE__ */ adaptIcon(GlyphCalendarPlus);
export const CalendarX = /* @__PURE__ */ adaptIcon(GlyphCalendarX);
export const Camera = /* @__PURE__ */ adaptIcon(GlyphCamera);
export const Car = /* @__PURE__ */ adaptIcon(GlyphCar);
export { Check } from "./memail-glyphs";
export const CheckCheck = /* @__PURE__ */ adaptIcon(GlyphCheckCheck);
export const CheckCircle = /* @__PURE__ */ adaptIcon(GlyphCheckCircle);
export const CheckCircle2 = /* @__PURE__ */ adaptIcon(GlyphCheckCircle2);
export const CheckSquare = /* @__PURE__ */ adaptIcon(GlyphCheckSquare);
export { ChevronDown } from "./memail-glyphs";
export { ChevronLeft } from "./memail-glyphs";
export { ChevronRight } from "./memail-glyphs";
export { ChevronUp } from "./memail-glyphs";
export { ChevronsLeft } from "./memail-glyphs";
export { ChevronsRight } from "./memail-glyphs";
export const Circle = /* @__PURE__ */ adaptIcon(GlyphCircle);
export const Clipboard = /* @__PURE__ */ adaptIcon(GlyphClipboard);
export const ClipboardCopy = /* @__PURE__ */ adaptIcon(GlyphClipboardCopy);
export { Clock } from "./memail-glyphs";
export const Clock3 = /* @__PURE__ */ adaptIcon(GlyphClock3);
export const Cloud = /* @__PURE__ */ adaptIcon(GlyphCloud);
export const CloudOff = /* @__PURE__ */ adaptIcon(GlyphCloudOff);
export const Code = /* @__PURE__ */ adaptIcon(GlyphCode);
export const Columns3 = /* @__PURE__ */ adaptIcon(GlyphColumns3);
export const Copy = /* @__PURE__ */ adaptIcon(GlyphCopy);
export const CopyPlus = /* @__PURE__ */ adaptIcon(GlyphCopyPlus);
export const CornerDownLeft = /* @__PURE__ */ adaptIcon(GlyphCornerDownLeft);
export const Database = /* @__PURE__ */ adaptIcon(GlyphDatabase);
export const Download = /* @__PURE__ */ adaptIcon(GlyphDownload);
export const EditIcon = /* @__PURE__ */ adaptIcon(GlyphEditIcon);
export const Ellipsis = /* @__PURE__ */ adaptIcon(GlyphEllipsis);
export const Eraser = /* @__PURE__ */ adaptIcon(GlyphEraser);
export const ExternalLink = /* @__PURE__ */ adaptIcon(GlyphExternalLink);
export { Eye } from "./memail-glyphs";
export { EyeOff } from "./memail-glyphs";
export { File } from "./memail-glyphs";
export const FileArchive = /* @__PURE__ */ adaptIcon(GlyphFileArchive);
export const Files = /* @__PURE__ */ adaptIcon(GlyphFiles);
export const FileAudio = /* @__PURE__ */ adaptIcon(GlyphFileAudio);
export const FileCode = /* @__PURE__ */ adaptIcon(GlyphFileCode);
export const FileImage = /* @__PURE__ */ adaptIcon(GlyphFileImage);
export const FilePlus = /* @__PURE__ */ adaptIcon(GlyphFilePlus);
export const FileSpreadsheet = /* @__PURE__ */ adaptIcon(GlyphFileSpreadsheet);
export { FileText } from "./memail-glyphs";
export const FileVideo = /* @__PURE__ */ adaptIcon(GlyphFileVideo);
export { Filter } from "./memail-glyphs";
export const Fish = /* @__PURE__ */ adaptIcon(GlyphFish);
export const Flag = /* @__PURE__ */ adaptIcon(GlyphFlag);
export const FlaskConical = /* @__PURE__ */ adaptIcon(GlyphFlaskConical);
export const FoldVertical = /* @__PURE__ */ adaptIcon(GlyphFoldVertical);
export { Folder } from "./memail-glyphs";
export const FolderInput = /* @__PURE__ */ adaptIcon(GlyphFolderInput);
export { FolderOpen } from "./memail-glyphs";
export const FolderPlus = /* @__PURE__ */ adaptIcon(GlyphFolderPlus);
export const FolderSearch = /* @__PURE__ */ adaptIcon(GlyphFolderSearch);
export const FolderSync = /* @__PURE__ */ adaptIcon(GlyphFolderSync);
export const FolderUp = /* @__PURE__ */ adaptIcon(GlyphFolderUp);
export const FolderX = /* @__PURE__ */ adaptIcon(GlyphFolderX);
export { Forward } from "./memail-glyphs";
export const Globe = /* @__PURE__ */ adaptIcon(GlyphGlobe);
export const Grid3x3 = /* @__PURE__ */ adaptIcon(GlyphGrid3x3);
export const GripVertical = /* @__PURE__ */ adaptIcon(GlyphGripVertical);
export const Hand = /* @__PURE__ */ adaptIcon(GlyphHand);
export const HardDrive = /* @__PURE__ */ adaptIcon(GlyphHardDrive);
export const Heading1 = /* @__PURE__ */ adaptIcon(GlyphHeading1);
export const Heading2 = /* @__PURE__ */ adaptIcon(GlyphHeading2);
export const Heart = /* @__PURE__ */ adaptIcon(GlyphHeart);
export const HeartRateMonitor = /* @__PURE__ */ adaptIcon(GlyphHeartRateMonitor);
export const HelpCircle = /* @__PURE__ */ adaptIcon(GlyphHelpCircle);
export const Highlighter = /* @__PURE__ */ adaptIcon(GlyphHighlighter);
export const Home = /* @__PURE__ */ adaptIcon(GlyphHome);
export const Image = /* @__PURE__ */ adaptIcon(GlyphImage);
export const ImageIcon = /* @__PURE__ */ adaptIcon(GlyphImageIcon);
export { Inbox } from "./memail-glyphs";
export const Info = /* @__PURE__ */ adaptIcon(GlyphInfo);
export const Italic = /* @__PURE__ */ adaptIcon(GlyphItalic);
export const Key = /* @__PURE__ */ adaptIcon(GlyphKey);
export const KeyRound = /* @__PURE__ */ adaptIcon(GlyphKeyRound);
export { Keyboard } from "./memail-glyphs";
export const Languages = /* @__PURE__ */ adaptIcon(GlyphLanguages);
export const LabelIcon = /* @__PURE__ */ adaptIcon(GlyphLabelIcon);
export const Layers = /* @__PURE__ */ adaptIcon(GlyphLayers);
export const LayoutDashboard = /* @__PURE__ */ adaptIcon(GlyphLayoutDashboard);
export const LayoutGrid = /* @__PURE__ */ adaptIcon(GlyphLayoutGrid);
export const LayoutList = /* @__PURE__ */ adaptIcon(GlyphLayoutList);
export const LayoutTemplate = /* @__PURE__ */ adaptIcon(GlyphLayoutTemplate);
export const Lightbulb = /* @__PURE__ */ adaptIcon(GlyphLightbulb);
export { Link } from "./memail-glyphs";
export const LinkOff = /* @__PURE__ */ adaptIcon(GlyphLinkOff);
export { List } from "./memail-glyphs";
export const ListOrdered = /* @__PURE__ */ adaptIcon(GlyphListOrdered);
export const ListTodo = /* @__PURE__ */ adaptIcon(GlyphListTodo);
export const Loader2 = /* @__PURE__ */ adaptIcon(GlyphLoader2);
export const Lock = /* @__PURE__ */ adaptIcon(GlyphLock);
export const LockKeyhole = /* @__PURE__ */ adaptIcon(GlyphLockKeyhole);
export const LockOpen = /* @__PURE__ */ adaptIcon(GlyphLockOpen);
export const LogIn = /* @__PURE__ */ adaptIcon(GlyphLogIn);
export { LogOut } from "./memail-glyphs";
export { Mail } from "./memail-glyphs";
export const MailCheck = /* @__PURE__ */ adaptIcon(GlyphMailCheck);
export { MailOpen } from "./memail-glyphs";
export const MailX = /* @__PURE__ */ adaptIcon(GlyphMailX);
export const Mails = /* @__PURE__ */ adaptIcon(GlyphMails);
export const MapPin = /* @__PURE__ */ adaptIcon(GlyphMapPin);
export const Maximize2 = /* @__PURE__ */ adaptIcon(GlyphMaximize2);
export const Menu = /* @__PURE__ */ adaptIcon(GlyphMenu);
export const MessageSquare = /* @__PURE__ */ adaptIcon(GlyphMessageSquare);
export const MessagesSquare = /* @__PURE__ */ adaptIcon(GlyphMessagesSquare);
export const Minimize2 = /* @__PURE__ */ adaptIcon(GlyphMinimize2);
export const Minus = /* @__PURE__ */ adaptIcon(GlyphMinus);
export const Monitor = /* @__PURE__ */ adaptIcon(GlyphMonitor);
export const Moon = /* @__PURE__ */ adaptIcon(GlyphMoon);
export { MoreHorizontal } from "./memail-glyphs";
export { MoreVertical } from "./memail-glyphs";
export const NotebookPen = /* @__PURE__ */ adaptIcon(GlyphNotebookPen);
export const Package = /* @__PURE__ */ adaptIcon(GlyphPackage);
export const PackageCheck = /* @__PURE__ */ adaptIcon(GlyphPackageCheck);
export const Palette = /* @__PURE__ */ adaptIcon(GlyphPalette);
export const Palmtree = /* @__PURE__ */ adaptIcon(GlyphPalmtree);
export const PalmtreeIcon = /* @__PURE__ */ adaptIcon(GlyphPalmtreeIcon);
export const PanelLeftClose = /* @__PURE__ */ adaptIcon(GlyphPanelLeftClose);
export const PanelLeftOpen = /* @__PURE__ */ adaptIcon(GlyphPanelLeftOpen);
export { PanelRight } from "./memail-glyphs";
export const PanelRightClose = /* @__PURE__ */ adaptIcon(GlyphPanelRightClose);
export const PanelRightOpen = /* @__PURE__ */ adaptIcon(GlyphPanelRightOpen);
export { Paperclip } from "./memail-glyphs";
export const Pause = /* @__PURE__ */ adaptIcon(GlyphPause);
export const Plane = /* @__PURE__ */ adaptIcon(GlyphPlane);
export const Restaurant = /* @__PURE__ */ adaptIcon(GlyphRestaurant);
export const ShoppingBag = /* @__PURE__ */ adaptIcon(GlyphShoppingBag);
export const Stop = /* @__PURE__ */ adaptIcon(GlyphStop);
export const PenLine = /* @__PURE__ */ adaptIcon(GlyphPenLine);
export { PenSquare } from "./memail-glyphs";
export const PenTool = /* @__PURE__ */ adaptIcon(GlyphPenTool);
export { Pencil } from "./memail-glyphs";
export const Phone = /* @__PURE__ */ adaptIcon(GlyphPhone);
export const Pin = /* @__PURE__ */ adaptIcon(GlyphPin);
export const PinOff = /* @__PURE__ */ adaptIcon(GlyphPinOff);
export const Play = /* @__PURE__ */ adaptIcon(GlyphPlay);
export const PlayCircle = /* @__PURE__ */ adaptIcon(GlyphPlayCircle);
export { Plus } from "./memail-glyphs";
export const Pointer = /* @__PURE__ */ adaptIcon(GlyphPointer);
export const Power = /* @__PURE__ */ adaptIcon(GlyphPower);
export const PowerOff = /* @__PURE__ */ adaptIcon(GlyphPowerOff);
export const Presentation = /* @__PURE__ */ adaptIcon(GlyphPresentation);
export const Printer = /* @__PURE__ */ adaptIcon(GlyphPrinter);
export const Puzzle = /* @__PURE__ */ adaptIcon(GlyphPuzzle);
export const QrCode = /* @__PURE__ */ adaptIcon(GlyphQrCode);
export const Quote = /* @__PURE__ */ adaptIcon(GlyphQuote);
export const Redo = /* @__PURE__ */ adaptIcon(GlyphRedo);
export { RefreshCw } from "./memail-glyphs";
export const RemoveFormatting = /* @__PURE__ */ adaptIcon(GlyphRemoveFormatting);
export const Repeat = /* @__PURE__ */ adaptIcon(GlyphRepeat);
export { Reply } from "./memail-glyphs";
export { ReplyAll } from "./memail-glyphs";
export const RotateCcw = /* @__PURE__ */ adaptIcon(GlyphRotateCcw);
export const RotateCw = /* @__PURE__ */ adaptIcon(GlyphRotateCw);
export { Rows3 } from "./memail-glyphs";
export const Save = /* @__PURE__ */ adaptIcon(GlyphSave);
export const Scale = /* @__PURE__ */ adaptIcon(GlyphScale);
export const Scissors = /* @__PURE__ */ adaptIcon(GlyphScissors);
export const ScrollText = /* @__PURE__ */ adaptIcon(GlyphScrollText);
export { Search } from "./memail-glyphs";
export const SearchX = /* @__PURE__ */ adaptIcon(GlyphSearchX);
export { Send } from "./memail-glyphs";
export const Server = /* @__PURE__ */ adaptIcon(GlyphServer);
export { Settings } from "./memail-glyphs";
export const Share2 = /* @__PURE__ */ adaptIcon(GlyphShare2);
export { Shield } from "./memail-glyphs";
export const ShieldAlert = /* @__PURE__ */ adaptIcon(GlyphShieldAlert);
export const SlidersHorizontal = /* @__PURE__ */ adaptIcon(GlyphSlidersHorizontal);
export const ShieldCheck = /* @__PURE__ */ adaptIcon(GlyphShieldCheck);
export const ShieldFilled = /* @__PURE__ */ adaptIcon(GlyphShieldFilled, true);
export const Shuffle = /* @__PURE__ */ adaptIcon(GlyphShuffle);
export const Smartphone = /* @__PURE__ */ adaptIcon(GlyphSmartphone);
export const Sparkles = /* @__PURE__ */ adaptIcon(GlyphSparkles);
export const Square = /* @__PURE__ */ adaptIcon(GlyphSquare);
export const SquarePen = /* @__PURE__ */ adaptIcon(GlyphSquarePen);
export { Star } from "./memail-glyphs";
export const StarOff = /* @__PURE__ */ adaptIcon(GlyphStarOff);
export const StickyNote = /* @__PURE__ */ adaptIcon(GlyphStickyNote);
export const Store = /* @__PURE__ */ adaptIcon(GlyphStore);
export const Strikethrough = /* @__PURE__ */ adaptIcon(GlyphStrikethrough);
export const Sun = /* @__PURE__ */ adaptIcon(GlyphSun);
export const SwatchBook = /* @__PURE__ */ adaptIcon(GlyphSwatchBook);
export const Table = /* @__PURE__ */ adaptIcon(GlyphTable);
export { Tag } from "./memail-glyphs";
export { Tags } from "./memail-glyphs";
export const Terminal = /* @__PURE__ */ adaptIcon(GlyphTerminal);
export const Ticket = /* @__PURE__ */ adaptIcon(GlyphTicket);
export const Train = /* @__PURE__ */ adaptIcon(GlyphTrain);
export { Trash } from "./memail-glyphs";
export { Trash2 } from "./memail-glyphs";
export const TriangleAlert = /* @__PURE__ */ adaptIcon(GlyphTriangleAlert);
export const Truck = /* @__PURE__ */ adaptIcon(GlyphTruck);
export const Type = /* @__PURE__ */ adaptIcon(GlyphType);
export const Underline = /* @__PURE__ */ adaptIcon(GlyphUnderline);
export const Undo = /* @__PURE__ */ adaptIcon(GlyphUndo);
export const UnfoldVertical = /* @__PURE__ */ adaptIcon(GlyphUnfoldVertical);
export const Unlock = /* @__PURE__ */ adaptIcon(GlyphUnlock);
export const Upload = /* @__PURE__ */ adaptIcon(GlyphUpload);
export const User = /* @__PURE__ */ adaptIcon(GlyphUser);
export const UserCircle = /* @__PURE__ */ adaptIcon(GlyphUserCircle);
export const UserMinus = /* @__PURE__ */ adaptIcon(GlyphUserMinus);
export const UserPen = /* @__PURE__ */ adaptIcon(GlyphUserPen);
export const UserPlus = /* @__PURE__ */ adaptIcon(GlyphUserPlus);
export { Users } from "./memail-glyphs";
export const UsersRound = /* @__PURE__ */ adaptIcon(GlyphUsersRound);
export const Video = /* @__PURE__ */ adaptIcon(GlyphVideo);
export const Volume2 = /* @__PURE__ */ adaptIcon(GlyphVolume2);
export const VolumeOff = /* @__PURE__ */ adaptIcon(GlyphVolumeOff);
export { X } from "./memail-glyphs";
export const XCircle = /* @__PURE__ */ adaptIcon(GlyphXCircle);
export { Zap } from "./memail-glyphs";
export const ZoomIn = /* @__PURE__ */ adaptIcon(GlyphZoomIn);
export const ZoomOut = /* @__PURE__ */ adaptIcon(GlyphZoomOut);
