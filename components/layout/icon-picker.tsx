'use client';

import { useState, useMemo, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { icons as lucideIcons, type LucideIcon } from 'lucide-react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

// Curated list of commonly useful icons, organized by category
const POPULAR_ICONS = [
  // Communication
  'Globe', 'Rss', 'Radio', 'Podcast', 'MessageCircle', 'MessageSquare', 'MessagesSquare',
  'Phone', 'Video', 'Webcam', 'Headphones', 'Mic',
  // Productivity
  'FileText', 'FileSpreadsheet', 'Notebook', 'BookOpen', 'ClipboardList',
  'ListTodo', 'CheckSquare', 'SquareKanban', 'Kanban', 'Trello',
  'PenLine', 'Pencil', 'Edit', 'NotebookPen',
  // Dev / Tech
  'Code', 'Terminal', 'Braces', 'Bug', 'Database', 'Server', 'Cpu',
  'HardDrive', 'Monitor', 'Laptop', 'Smartphone', 'Tablet',
  'Wifi', 'Cloud', 'CloudDownload', 'CloudUpload',
  // Social / People
  'Users', 'UserPlus', 'UserCircle', 'Contact', 'PersonStanding',
  'Heart', 'ThumbsUp', 'Star', 'Award', 'Trophy', 'Crown',
  // Media
  'Image', 'Camera', 'Film', 'Music', 'Play', 'Tv', 'Youtube', 'Clapperboard',
  'Palette', 'Paintbrush', 'Brush',
  // Navigation / Location
  'Map', 'MapPin', 'Navigation', 'Compass', 'Home', 'Building', 'Building2',
  'Landmark', 'Store', 'Warehouse',
  // Finance
  'DollarSign', 'Euro', 'CreditCard', 'Wallet', 'Receipt', 'PiggyBank',
  'TrendingUp', 'BarChart', 'BarChart3', 'LineChart', 'PieChart',
  // Security
  'Shield', 'ShieldCheck', 'Lock', 'Unlock', 'Key', 'Fingerprint', 'Eye',
  // Science / Health
  'Beaker', 'Atom', 'Dna', 'Microscope', 'Stethoscope', 'HeartPulse', 'Pill',
  'Syringe', 'Thermometer',
  // Nature
  'Sun', 'Moon', 'CloudSun', 'Snowflake', 'Zap', 'Flame',
  'TreePine', 'Flower', 'Leaf', 'Mountain', 'Waves',
  // Tools
  'Wrench', 'Hammer', 'Scissors', 'Ruler', 'Magnet',
  'Package', 'Gift', 'Box', 'Archive',
  // Transport
  'Car', 'Bike', 'Bus', 'Train', 'Plane', 'Ship', 'Rocket',
  // Food
  'Coffee', 'Wine', 'Beer', 'Pizza', 'Apple', 'Cake', 'CookingPot',
  // Misc
  'Gamepad2', 'Dice5', 'Puzzle', 'Sparkles', 'Wand2', 'Bot', 'BrainCircuit',
  'Lightbulb', 'Bookmark', 'Flag', 'Bell', 'Clock', 'Timer',
  'Link', 'ExternalLink', 'QrCode', 'Scan', 'LayoutGrid', 'Layers',
  'Aperture', 'CircleDot', 'Target', 'Crosshair',
];

interface IconPickerProps {
  value: string;
  onChange: (iconName: string) => void;
  className?: string;
}

export function IconPicker({ value, onChange, className }: IconPickerProps) {
  const t = useTranslations('sidebar_apps');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // Get all available icon names
  const allIconNames = useMemo(() => {
    return Object.keys(lucideIcons).filter(
      k => /^[A-Z]/.test(k) && k !== 'createLucideIcon' && k !== 'Icon'
    ).sort();
  }, []);

  const filteredIcons = useMemo(() => {
    const source = showAll ? allIconNames : POPULAR_ICONS.filter(name => name in lucideIcons);
    if (!search.trim()) return source;
    const q = search.toLowerCase();
    return source.filter(name => name.toLowerCase().includes(q));
  }, [search, showAll, allIconNames]);

  const renderIcon = useCallback((name: string) => {
    const IconComponent = lucideIcons[name as keyof typeof lucideIcons] as LucideIcon | undefined;
    if (!IconComponent) return null;
    return <IconComponent className="w-5 h-5" />;
  }, []);

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('search_icons')}
            className="ps-8 h-8 text-xs"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowAll(!showAll)}
          className={cn(
            'text-xs px-2 py-1 rounded-md border transition-colors whitespace-nowrap',
            showAll
              ? 'bg-primary/10 text-primary border-primary/30'
              : 'bg-muted text-muted-foreground border-border hover:text-foreground'
          )}
        >
          {showAll ? t('show_popular') : t('show_all')}
        </button>
      </div>
      <div
        ref={gridRef}
        className="grid grid-cols-8 gap-1 max-h-[200px] overflow-y-auto p-1 border rounded-md bg-muted/30"
      >
        {filteredIcons.map(name => (
          <button
            key={name}
            type="button"
            onClick={() => onChange(name)}
            title={name}
            className={cn(
              'flex items-center justify-center w-8 h-8 rounded-md transition-colors',
              value === name
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-muted text-muted-foreground hover:text-foreground'
            )}
          >
            {renderIcon(name)}
          </button>
        ))}
        {filteredIcons.length === 0 && (
          <p className="col-span-8 py-4 text-center text-xs text-muted-foreground">
            {t('no_icons_found')}
          </p>
        )}
      </div>
    </div>
  );
}
