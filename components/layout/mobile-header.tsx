"use client";

import { Menu, ArrowLeft, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUIStore } from "@/stores/ui-store";
import { useIsDesktop } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { AccountSwitcher } from "@/components/layout/account-switcher";

interface MobileHeaderProps {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
  onCompose?: () => void;
  onSearch?: () => void;
  className?: string;
  /** Id of the sidebar this header's menu button toggles. */
  sidebarId?: string;
  /**
   * When set, the mailbox title is replaced by a tappable search field and
   * this fires instead. The folder name stays visible in the drawer, so the
   * bar spends its width on the thing you act on rather than a label.
   */
  onOpenSearch?: () => void;
  /** Placeholder shown inside the search field. */
  searchPlaceholder?: string;
  /** Clears the active query without opening the search panel. */
  onClearSearch?: () => void;
  /** Whether a query is currently applied, which reveals the clear button. */
  searchActive?: boolean;
}

export function MobileHeader({
  title,
  showBack = false,
  onBack,
  onCompose,
  onSearch,
  className,
  sidebarId,
  onOpenSearch,
  searchPlaceholder,
  onClearSearch,
  searchActive = false,
}: MobileHeaderProps) {
  const t = useTranslations('sidebar');
  const { toggleSidebar, goBack, sidebarOpen } = useUIStore();
  // Pane-aware: in Pro split mode the viewport is desktop-wide while the
  // pane is narrow. The Tailwind `lg:hidden` variant alone would never fire
  // there, so we additionally hide via JS when the surrounding pane is
  // desktop-sized. Outside of Pro this still returns the viewport value.
  const isPaneDesktop = useIsDesktop();
  if (isPaneDesktop) return null;

  const handleLeftAction = () => {
    if (showBack && onBack) {
      onBack();
    } else if (showBack) {
      goBack();
    } else {
      toggleSidebar();
    }
  };

  return (
    <header
      className={cn(
        "flex items-center justify-between px-4 h-14 border-b border-border bg-background shrink-0",
        className
      )}
    >
      {/* Left action: Menu or Back button */}
      <div className="flex items-center gap-2 min-w-0 flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleLeftAction}
          className={cn(
            "h-11 w-11",
            !showBack && sidebarOpen && "bg-accent"
          )}
          data-sidebar-toggle={!showBack ? "" : undefined}
          aria-label={showBack ? t('mobile.go_back') : t('mobile.toggle_menu')}
          aria-expanded={!showBack ? sidebarOpen : undefined}
          aria-controls={!showBack ? sidebarId : undefined}
        >
          {showBack ? (
            <ArrowLeft className="h-5 w-5" />
          ) : sidebarOpen ? (
            <X className="h-5 w-5" />
          ) : (
            <Menu className="h-5 w-5" />
          )}
        </Button>

        {/* Title, unless the bar is in search-first mode */}
        {!onOpenSearch && <h1 className="font-semibold text-lg truncate">{title}</h1>}
      </div>

      {onOpenSearch && (
        /* Not a single button: the clear control is a button of its own, and
           nesting one inside another is invalid markup. */
        <div className="flex-1 min-w-0 h-10 mx-1 flex items-center rounded-full bg-muted ps-3 pe-1">
          <button
            type="button"
            onClick={onOpenSearch}
            className="flex-1 min-w-0 h-full flex items-center gap-2 text-start text-muted-foreground"
            aria-label={searchPlaceholder || title}
          >
            <Search className="h-4 w-4 flex-shrink-0" />
            <span className="truncate text-sm">{searchPlaceholder || title}</span>
          </button>
          {searchActive && onClearSearch && (
            <button
              type="button"
              onClick={onClearSearch}
              className="h-8 w-8 flex-shrink-0 grid place-items-center rounded-full text-muted-foreground hover:bg-background/60"
              aria-label={t('clear_search')}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {/* Right actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {onSearch && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onSearch}
            className="h-11 w-11"
            aria-label={t('mobile.search')}
          >
            <Search className="h-5 w-5" />
          </Button>
        )}
        {onCompose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onCompose}
            className="h-11 w-11 text-primary"
            aria-label={t('mobile.compose')}
          >
            <Plus className="h-5 w-5" />
          </Button>
        )}

        {/* Which account you are reading is otherwise only visible after
            opening the drawer. Last in this group so it sits on the far
            edge — opposite the menu button, and mirrored under RTL because
            the header is laid out with flex rather than fixed sides. */}
        <AccountSwitcher variant="header" />
      </div>
    </header>
  );
}

/**
 * Viewer header for mobile - shows when viewing an email
 */
interface MobileViewerHeaderProps {
  subject?: string;
  onBack: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  className?: string;
}

export function MobileViewerHeader({
  subject,
  onBack,
  onDelete: _onDelete,
  onArchive: _onArchive,
  className,
}: MobileViewerHeaderProps) {
  const t = useTranslations('sidebar');
  const isPaneDesktop = useIsDesktop();
  if (isPaneDesktop) return null;

  return (
    <header
      className={cn(
        "flex items-center justify-between px-2 h-14 border-b border-border bg-background shrink-0",
        className
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={onBack}
        className="h-11 w-11"
        aria-label={t('mobile.go_back')}
      >
        <ArrowLeft className="h-5 w-5" />
      </Button>

      <h1 className="flex-1 font-medium text-sm truncate px-2 text-center">
        {subject || "(No Subject)"}
      </h1>

      <div className="flex items-center">
        {/* Placeholder for additional actions - kept minimal */}
        <div className="w-10" />
      </div>
    </header>
  );
}
