'use client';

// Icons chosen by name at runtime: sidebar apps, message-list tabs (a plugin
// API), and the admin's default apps. Names are stored as `tabler:<name>`.
// Names saved before the switch to Tabler are Lucide names (`"Globe"`); they
// are translated on read, so old settings and existing plugins keep working.
//
// The popular icons ship in the main bundle. Any other name loads the full
// Tabler set once, lazily, the first time it is rendered or the picker's
// "show all" list opens.

import { forwardRef, useEffect, useState } from 'react';
import type { TablerIcon } from '@tabler/icons-react';
import {
  IconAddressBook,
  IconAperture,
  IconApple,
  IconArchive,
  IconAtom,
  IconAward,
  IconBeer,
  IconBell,
  IconBike,
  IconBolt,
  IconBook,
  IconBookmark,
  IconBox,
  IconBraces,
  IconBrain,
  IconBrandTrello,
  IconBrandYoutube,
  IconBrush,
  IconBug,
  IconBuilding,
  IconBuildingBank,
  IconBuildingStore,
  IconBuildingWarehouse,
  IconBulb,
  IconBus,
  IconCake,
  IconCalendar,
  IconCamera,
  IconCar,
  IconChartBar,
  IconChartColumn,
  IconChartLine,
  IconChartPie,
  IconChecklist,
  IconChristmasTree,
  IconCircleDot,
  IconClipboardList,
  IconClock,
  IconCloud,
  IconCloudDownload,
  IconCloudUpload,
  IconCode,
  IconCoffee,
  IconCompass,
  IconCpu,
  IconCreditCard,
  IconCrosshair,
  IconCrown,
  IconCurrencyDollar,
  IconCurrencyEuro,
  IconDatabase,
  IconDeviceComputerCamera,
  IconDeviceDesktop,
  IconDeviceGamepad2,
  IconDeviceLaptop,
  IconDeviceMobile,
  IconDeviceTablet,
  IconDeviceTv,
  IconDice5,
  IconDna,
  IconEdit,
  IconExternalLink,
  IconEye,
  IconFileSpreadsheet,
  IconFileText,
  IconFingerprint,
  IconFlag,
  IconFlame,
  IconFlask2,
  IconFlower,
  IconFolder,
  IconGift,
  IconGlass,
  IconHammer,
  IconHeadphones,
  IconHeart,
  IconHeartbeat,
  IconHome,
  IconInbox,
  IconKey,
  IconLayoutGrid,
  IconLayoutKanban,
  IconLeaf,
  IconLink,
  IconLock,
  IconLockOpen,
  IconMagnet,
  IconMail,
  IconMan,
  IconMap,
  IconMapPin,
  IconMessage,
  IconMessageCircle,
  IconMessages,
  IconMicrophone,
  IconMicrophone2,
  IconMicroscope,
  IconMoon,
  IconMountain,
  IconMovie,
  IconMusic,
  IconNavigation,
  IconNotebook,
  IconPackage,
  IconPalette,
  IconPencil,
  IconPhone,
  IconPhoto,
  IconPigMoney,
  IconPill,
  IconPizza,
  IconPlane,
  IconPlayerPlay,
  IconPuzzle,
  IconQrcode,
  IconRadio,
  IconReceipt,
  IconRipple,
  IconRobot,
  IconRocket,
  IconRss,
  IconRuler,
  IconScan,
  IconScissors,
  IconServer,
  IconServer2,
  IconShield,
  IconShieldCheck,
  IconShip,
  IconSnowflake,
  IconSoup,
  IconSparkles,
  IconSquareCheck,
  IconStack,
  IconStar,
  IconStethoscope,
  IconStopwatch,
  IconSun,
  IconSunWind,
  IconTag,
  IconTarget,
  IconTerminal,
  IconThermometer,
  IconThumbUp,
  IconTool,
  IconTrain,
  IconTrendingUp,
  IconTrophy,
  IconUserCircle,
  IconUserPlus,
  IconUsers,
  IconVaccine,
  IconVideo,
  IconWallet,
  IconWand,
  IconWifi,
  IconWorld,
} from '@tabler/icons-react';

export const TABLER_ICON_PREFIX = 'tabler:';

/** Tabler names shown first in the icon picker. */
export const POPULAR_ICON_NAMES: readonly string[] = ["world","rss","radio","microphone-2","message-circle","message","messages","phone","video","device-computer-camera","headphones","microphone","file-text","file-spreadsheet","notebook","book","clipboard-list","checklist","square-check","layout-kanban","brand-trello","pencil","edit","code","terminal","braces","bug","database","server","cpu","server-2","device-desktop","device-laptop","device-mobile","device-tablet","wifi","cloud","cloud-download","cloud-upload","users","user-plus","user-circle","address-book","man","heart","thumb-up","star","award","trophy","crown","photo","camera","movie","music","player-play","device-tv","brand-youtube","palette","brush","map","map-pin","navigation","compass","home","building","building-bank","building-store","building-warehouse","currency-dollar","currency-euro","credit-card","wallet","receipt","pig-money","trending-up","chart-bar","chart-column","chart-line","chart-pie","shield","shield-check","lock","lock-open","key","fingerprint","eye","flask-2","atom","dna","microscope","stethoscope","heartbeat","pill","vaccine","thermometer","sun","moon","sun-wind","snowflake","bolt","flame","christmas-tree","flower","leaf","mountain","ripple","tool","hammer","scissors","ruler","magnet","package","gift","box","archive","car","bike","bus","train","plane","ship","rocket","coffee","glass","beer","pizza","apple","cake","soup","device-gamepad-2","dice-5","puzzle","sparkles","wand","robot","brain","bulb","bookmark","flag","bell","clock","stopwatch","link","external-link","qrcode","scan","layout-grid","stack","aperture","circle-dot","target","crosshair"];

const CURATED: Record<string, TablerIcon> = {
  'address-book': IconAddressBook,
  'aperture': IconAperture,
  'apple': IconApple,
  'archive': IconArchive,
  'atom': IconAtom,
  'award': IconAward,
  'beer': IconBeer,
  'bell': IconBell,
  'bike': IconBike,
  'bolt': IconBolt,
  'book': IconBook,
  'bookmark': IconBookmark,
  'box': IconBox,
  'braces': IconBraces,
  'brain': IconBrain,
  'brand-trello': IconBrandTrello,
  'brand-youtube': IconBrandYoutube,
  'brush': IconBrush,
  'bug': IconBug,
  'building': IconBuilding,
  'building-bank': IconBuildingBank,
  'building-store': IconBuildingStore,
  'building-warehouse': IconBuildingWarehouse,
  'bulb': IconBulb,
  'bus': IconBus,
  'cake': IconCake,
  'calendar': IconCalendar,
  'camera': IconCamera,
  'car': IconCar,
  'chart-bar': IconChartBar,
  'chart-column': IconChartColumn,
  'chart-line': IconChartLine,
  'chart-pie': IconChartPie,
  'checklist': IconChecklist,
  'christmas-tree': IconChristmasTree,
  'circle-dot': IconCircleDot,
  'clipboard-list': IconClipboardList,
  'clock': IconClock,
  'cloud': IconCloud,
  'cloud-download': IconCloudDownload,
  'cloud-upload': IconCloudUpload,
  'code': IconCode,
  'coffee': IconCoffee,
  'compass': IconCompass,
  'cpu': IconCpu,
  'credit-card': IconCreditCard,
  'crosshair': IconCrosshair,
  'crown': IconCrown,
  'currency-dollar': IconCurrencyDollar,
  'currency-euro': IconCurrencyEuro,
  'database': IconDatabase,
  'device-computer-camera': IconDeviceComputerCamera,
  'device-desktop': IconDeviceDesktop,
  'device-gamepad-2': IconDeviceGamepad2,
  'device-laptop': IconDeviceLaptop,
  'device-mobile': IconDeviceMobile,
  'device-tablet': IconDeviceTablet,
  'device-tv': IconDeviceTv,
  'dice-5': IconDice5,
  'dna': IconDna,
  'edit': IconEdit,
  'external-link': IconExternalLink,
  'eye': IconEye,
  'file-spreadsheet': IconFileSpreadsheet,
  'file-text': IconFileText,
  'fingerprint': IconFingerprint,
  'flag': IconFlag,
  'flame': IconFlame,
  'flask-2': IconFlask2,
  'flower': IconFlower,
  'folder': IconFolder,
  'gift': IconGift,
  'glass': IconGlass,
  'hammer': IconHammer,
  'headphones': IconHeadphones,
  'heart': IconHeart,
  'heartbeat': IconHeartbeat,
  'home': IconHome,
  'inbox': IconInbox,
  'key': IconKey,
  'layout-grid': IconLayoutGrid,
  'layout-kanban': IconLayoutKanban,
  'leaf': IconLeaf,
  'link': IconLink,
  'lock': IconLock,
  'lock-open': IconLockOpen,
  'magnet': IconMagnet,
  'mail': IconMail,
  'man': IconMan,
  'map': IconMap,
  'map-pin': IconMapPin,
  'message': IconMessage,
  'message-circle': IconMessageCircle,
  'messages': IconMessages,
  'microphone': IconMicrophone,
  'microphone-2': IconMicrophone2,
  'microscope': IconMicroscope,
  'moon': IconMoon,
  'mountain': IconMountain,
  'movie': IconMovie,
  'music': IconMusic,
  'navigation': IconNavigation,
  'notebook': IconNotebook,
  'package': IconPackage,
  'palette': IconPalette,
  'pencil': IconPencil,
  'phone': IconPhone,
  'photo': IconPhoto,
  'pig-money': IconPigMoney,
  'pill': IconPill,
  'pizza': IconPizza,
  'plane': IconPlane,
  'player-play': IconPlayerPlay,
  'puzzle': IconPuzzle,
  'qrcode': IconQrcode,
  'radio': IconRadio,
  'receipt': IconReceipt,
  'ripple': IconRipple,
  'robot': IconRobot,
  'rocket': IconRocket,
  'rss': IconRss,
  'ruler': IconRuler,
  'scan': IconScan,
  'scissors': IconScissors,
  'server': IconServer,
  'server-2': IconServer2,
  'shield': IconShield,
  'shield-check': IconShieldCheck,
  'ship': IconShip,
  'snowflake': IconSnowflake,
  'soup': IconSoup,
  'sparkles': IconSparkles,
  'square-check': IconSquareCheck,
  'stack': IconStack,
  'star': IconStar,
  'stethoscope': IconStethoscope,
  'stopwatch': IconStopwatch,
  'sun': IconSun,
  'sun-wind': IconSunWind,
  'tag': IconTag,
  'target': IconTarget,
  'terminal': IconTerminal,
  'thermometer': IconThermometer,
  'thumb-up': IconThumbUp,
  'tool': IconTool,
  'train': IconTrain,
  'trending-up': IconTrendingUp,
  'trophy': IconTrophy,
  'user-circle': IconUserCircle,
  'user-plus': IconUserPlus,
  'users': IconUsers,
  'vaccine': IconVaccine,
  'video': IconVideo,
  'wallet': IconWallet,
  'wand': IconWand,
  'wifi': IconWifi,
  'world': IconWorld,
};

/** Lucide names (pre-Tabler settings, plugin tab definitions) -> Tabler names. */
export const LEGACY_LUCIDE: Readonly<Record<string, string>> ={"Activity":"activity","AlertCircle":"alert-circle","AlertTriangle":"alert-triangle","AlignCenter":"align-center","AlignLeft":"align-left","AlignRight":"align-right","Aperture":"aperture","Apple":"apple","Archive":"archive","ArrowDown":"arrow-down","ArrowDownAZ":"sort-a-z","ArrowLeft":"arrow-left","ArrowLeftRight":"arrow-left-right","ArrowRight":"arrow-right","ArrowUp":"arrow-up","ArrowUpCircle":"circle-arrow-up","ArrowUpRight":"arrow-up-right","Atom":"atom","Award":"award","Ban":"ban","BarChart":"chart-bar","BarChart3":"chart-column","Baseline":"baseline","Beaker":"flask-2","Beer":"beer","Bell":"bell","BellOff":"bell-off","Bike":"bike","Bold":"bold","Book":"book-2","Bookmark":"bookmark","BookmarkPlus":"bookmark-plus","BookOpen":"book","BookPlus":"book-2","BookUser":"address-book","Bot":"robot","Box":"box","Braces":"braces","Brain":"brain","BrainCircuit":"brain","Briefcase":"briefcase","Brush":"brush","Bug":"bug","Building":"building","Building2":"building","Bus":"bus","Cake":"cake","Calendar":"calendar","CalendarArrowUp":"calendar-up","CalendarCheck":"calendar-check","CalendarClock":"calendar-clock","CalendarDays":"calendar-month","CalendarX":"calendar-x","Camera":"camera","Car":"car","Check":"check","CheckCheck":"checks","CheckCircle":"circle-check","CheckCircle2":"circle-check","CheckSquare":"square-check","ChevronDown":"chevron-down","ChevronLeft":"chevron-left","ChevronRight":"chevron-right","ChevronsLeft":"chevrons-left","ChevronsRight":"chevrons-right","ChevronUp":"chevron-up","Circle":"circle","CircleDot":"circle-dot","Clapperboard":"movie","Clipboard":"clipboard","ClipboardCopy":"clipboard-copy","ClipboardList":"clipboard-list","Clock":"clock","Clock3":"clock-hour-3","Cloud":"cloud","CloudDownload":"cloud-download","CloudSun":"sun-wind","CloudUpload":"cloud-upload","Code":"code","Code2":"code","Coffee":"coffee","Columns3":"columns-3","Compass":"compass","Contact":"address-book","CookingPot":"soup","Copy":"copy","CopyPlus":"copy-plus","CornerDownLeft":"corner-down-left","Cpu":"cpu","CreditCard":"credit-card","Crosshair":"crosshair","Crown":"crown","Database":"database","Dice5":"dice-5","Dna":"dna","DollarSign":"currency-dollar","Download":"download","Edit":"edit","EditIcon":"edit","Ellipsis":"dots","Eraser":"eraser","Euro":"currency-euro","ExternalLink":"external-link","Eye":"eye","EyeOff":"eye-off","File":"file","FileArchive":"file-zip","FileAudio":"file-music","FileCode":"file-code","FileImage":"photo","FilePlus":"file-plus","FileSpreadsheet":"file-spreadsheet","FileText":"file-text","FileVideo":"video","Film":"movie","Filter":"filter","Fingerprint":"fingerprint","Flag":"flag","Flame":"flame","FlaskConical":"flask","Flower":"flower","Folder":"folder","FolderInput":"folder-down","FolderOpen":"folder-open","FolderPlus":"folder-plus","FolderSync":"folders","FolderUp":"folder-up","FolderX":"folder-x","Forward":"arrow-forward-up","Gamepad2":"device-gamepad-2","Gift":"gift","Globe":"world","GripVertical":"grip-vertical","Hammer":"hammer","HardDrive":"server-2","Heading1":"h-1","Heading2":"h-2","Headphones":"headphones","Heart":"heart","HeartPulse":"heartbeat","HelpCircle":"help-circle","Highlighter":"highlight","Home":"home","Image":"photo","ImageIcon":"photo","Inbox":"inbox","Info":"info-circle","Italic":"italic","Kanban":"layout-kanban","Key":"key","Keyboard":"keyboard","KeyRound":"key","Landmark":"building-bank","Languages":"language","Laptop":"device-laptop","Layers":"stack","LayoutDashboard":"layout-dashboard","LayoutGrid":"layout-grid","LayoutList":"layout-list","Leaf":"leaf","Lightbulb":"bulb","LineChart":"chart-line","Link":"link","List":"list","ListOrdered":"list-numbers","ListTodo":"checklist","Loader2":"loader-2","Lock":"lock","LockKeyhole":"lock","LockOpen":"lock-open","LogIn":"login","LogOut":"logout","Magnet":"magnet","Mail":"mail","MailCheck":"mail-check","MailOpen":"mail-opened","Mails":"inbox","MailX":"mail-x","Map":"map","MapPin":"map-pin","Maximize2":"maximize","Menu":"menu-2","MessageCircle":"message-circle","MessageSquare":"message","MessagesSquare":"messages","Mic":"microphone","Microscope":"microscope","Minimize2":"minimize","Minus":"minus","Monitor":"device-desktop","Moon":"moon","MoreHorizontal":"dots","MoreVertical":"dots-vertical","Mountain":"mountain","Music":"music","Navigation":"navigation","Notebook":"notebook","NotebookPen":"notebook","Package":"package","PackageCheck":"package","Paintbrush":"brush","Palette":"palette","Palmtree":"beach","PalmtreeIcon":"beach","PanelLeftClose":"layout-sidebar-left-collapse","PanelRight":"layout-sidebar-right","PanelRightClose":"layout-sidebar-right-collapse","PanelRightOpen":"layout-sidebar-right-expand","Paperclip":"paperclip","Pencil":"pencil","PenLine":"pencil","PenSquare":"edit","PenTool":"vector","PersonStanding":"man","Phone":"phone","PieChart":"chart-pie","PiggyBank":"pig-money","Pill":"pill","Pin":"pinned","PinOff":"pinned-off","Pizza":"pizza","Plane":"plane","Play":"player-play","PlayCircle":"player-play","Plus":"plus","Podcast":"microphone-2","Power":"power","PowerOff":"power","Presentation":"presentation","Printer":"printer","Puzzle":"puzzle","QrCode":"qrcode","Quote":"quote","Radio":"radio","Receipt":"receipt","Redo":"arrow-forward","RefreshCw":"refresh","RemoveFormatting":"clear-formatting","Repeat":"repeat","Reply":"arrow-back-up","ReplyAll":"arrow-back-up-double","Rocket":"rocket","RotateCcw":"rotate","RotateCw":"rotate-clockwise","Rows3":"layout-rows","Rss":"rss","Ruler":"ruler","Save":"device-floppy","Scale":"scale","Scan":"scan","Scissors":"scissors","ScrollText":"file-text","Search":"search","SearchX":"search-off","Send":"send","Server":"server","Settings":"settings","Share2":"share-2","Shield":"shield","ShieldAlert":"shield-exclamation","ShieldCheck":"shield-check","Ship":"ship","Shuffle":"arrows-shuffle","Smartphone":"device-mobile","Snowflake":"snowflake","Sparkles":"sparkles","Square":"square","SquareKanban":"layout-kanban","SquarePen":"edit","Star":"star","Stethoscope":"stethoscope","StickyNote":"note","Store":"building-store","Strikethrough":"strikethrough","Sun":"sun","SwatchBook":"color-swatch","Syringe":"vaccine","Table":"table","Tablet":"device-tablet","Tag":"tag","Tags":"tags","Target":"target","Terminal":"terminal","Thermometer":"thermometer","ThumbsUp":"thumb-up","Timer":"stopwatch","Train":"train","Trash":"trash","Trash2":"trash","TreePine":"christmas-tree","Trello":"brand-trello","TrendingUp":"trending-up","TriangleAlert":"alert-triangle","Trophy":"trophy","Tv":"device-tv","Type":"typography","Underline":"underline","Undo":"arrow-back","Unlock":"lock-open","Upload":"upload","User":"user","UserCircle":"user-circle","UserMinus":"user-minus","UserPen":"user-edit","UserPlus":"user-plus","Users":"users","UsersRound":"users","Video":"video","Volume2":"volume-2","Wallet":"wallet","Wand2":"wand","Warehouse":"building-warehouse","Waves":"ripple","Webcam":"device-computer-camera","Wifi":"wifi","Wine":"glass","Wrench":"tool","X":"x","XCircle":"circle-x","Youtube":"brand-youtube","Zap":"bolt","ZoomIn":"zoom-in","ZoomOut":"zoom-out"};

const TABLER_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LUCIDE_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** Stored form of a Tabler icon name. */
export function toStoredIconName(tablerName: string): string {
  return TABLER_ICON_PREFIX + tablerName;
}

/**
 * Resolve a stored icon name to a Tabler name: `tabler:<name>` as is, a
 * known Lucide name through the table, any other Lucide name by converting
 * its PascalCase to kebab-case (most Lucide and Tabler names agree).
 */
export function toTablerName(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith(TABLER_ICON_PREFIX)) {
    const name = stored.slice(TABLER_ICON_PREFIX.length);
    return TABLER_NAME_RE.test(name) ? name : null;
  }
  if (LEGACY_LUCIDE[stored]) return LEGACY_LUCIDE[stored];
  // A bare Tabler name, as an admin might type it.
  if (TABLER_NAME_RE.test(stored)) return stored;
  if (!LUCIDE_NAME_RE.test(stored)) return null;
  return stored.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Za-z])(\d)/g, '$1-$2').toLowerCase();
}

const componentKey = (name: string) =>
  'Icon' + name.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

let allIcons: Record<string, TablerIcon> | null = null;
let allIconsPromise: Promise<Record<string, TablerIcon>> | null = null;

function loadAllIcons(): Promise<Record<string, TablerIcon>> {
  allIconsPromise ??= import('@tabler/icons-react').then((m) => {
    allIcons = m.icons as unknown as Record<string, TablerIcon>;
    return allIcons;
  });
  return allIconsPromise;
}

/** Every outline icon name in Tabler, for the picker's "show all" list. */
export async function loadAllIconNames(): Promise<string[]> {
  const m = await import('@tabler/icons-react');
  return m.iconsList.default.filter((n) => !n.endsWith('-filled'));
}

const lazyIcons = new Map<string, TablerIcon>();

function lazyIcon(name: string): TablerIcon {
  const LazyIcon = forwardRef<SVGSVGElement, Parameters<TablerIcon>[0]>(function LazyIcon(props, ref) {
    const [Resolved, setResolved] = useState<TablerIcon | null>(
      () => (allIcons ? allIcons[componentKey(name)] ?? IconWorld : null),
    );
    useEffect(() => {
      if (Resolved) return;
      let live = true;
      loadAllIcons().then((icons) => {
        if (live) setResolved(() => icons[componentKey(name)] ?? IconWorld);
      });
      return () => {
        live = false;
      };
    }, [Resolved]);
    if (!Resolved) {
      const size = props.size ?? 24;
      return <svg ref={ref} width={size} height={size} className={props.className} aria-hidden="true" />;
    }
    return <Resolved ref={ref} {...props} />;
  });
  return LazyIcon as unknown as TablerIcon;
}

/**
 * The component for a stored icon name, or undefined when there is no usable
 * name. Unknown names render the world icon once the full set has loaded.
 */
export function iconForName(stored: string | null | undefined): TablerIcon | undefined {
  const name = toTablerName(stored);
  if (!name) return undefined;
  const curated = CURATED[name];
  if (curated) return curated;
  let icon = lazyIcons.get(name);
  if (!icon) {
    icon = lazyIcon(name);
    lazyIcons.set(name, icon);
  }
  return icon;
}
