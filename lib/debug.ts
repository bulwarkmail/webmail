import { useSettingsStore } from '@/stores/settings-store';
import type { DebugCategory } from '@/stores/settings-store';

/**
 * Check if debug logging is enabled, optionally for a specific category.
 * When a category is provided, both debugMode AND that category must be enabled.
 */
function isEnabled(category?: DebugCategory): boolean {
  const state = useSettingsStore.getState();
  if (!state.debugMode) return false;
  if (!category) return true;
  return state.debugCategories?.[category] !== false;
}

/**
 * Debug logger that respects the debugMode setting and category filters.
 * Use this instead of console.log for conditional debug output.
 *
 * Each method accepts an optional category as the first argument.
 * When a category is provided, the message only logs if that category is enabled
 * in Settings > Advanced > Debug Categories.
 *
 * Usage:
 *   debug.log('calendar', 'Event created', event);  // Only logs when 'calendar' category is on
 *   debug.log('Uncategorized message');               // Logs whenever debugMode is on
 */
export const debug = {
  /**
   * Log a debug message (only when debugMode is enabled and category is active)
   */
  log: (categoryOrMsg: DebugCategory | unknown, ...args: unknown[]) => {
    if (typeof categoryOrMsg === 'string' && isCategoryKey(categoryOrMsg)) {
      if (isEnabled(categoryOrMsg)) {
        console.log(`[DEBUG:${categoryOrMsg}]`, ...args);
      }
    } else if (isEnabled()) {
      console.log('[DEBUG]', categoryOrMsg, ...args);
    }
  },

  /**
   * Log a warning message (only when debugMode is enabled and category is active)
   */
  warn: (categoryOrMsg: DebugCategory | unknown, ...args: unknown[]) => {
    if (typeof categoryOrMsg === 'string' && isCategoryKey(categoryOrMsg)) {
      if (isEnabled(categoryOrMsg)) {
        console.warn(`[DEBUG:${categoryOrMsg}]`, ...args);
      }
    } else if (isEnabled()) {
      console.warn('[DEBUG]', categoryOrMsg, ...args);
    }
  },

  /**
   * Log an error message (always logs, regardless of debugMode)
   */
  error: (...args: unknown[]) => {
    console.error('[ERROR]', ...args);
  },

  /**
   * Start a collapsed console group (only when debugMode is enabled and category is active)
   */
  group: (label: string, category?: DebugCategory) => {
    if (isEnabled(category)) {
      console.group(`[DEBUG${category ? ':' + category : ''}] ${label}`);
    }
  },

  /**
   * End a console group (only when debugMode is enabled)
   */
  groupEnd: () => {
    if (isEnabled()) {
      console.groupEnd();
    }
  },

  /**
   * Start a performance timer (only when debugMode is enabled and category is active)
   */
  time: (label: string, category?: DebugCategory) => {
    if (isEnabled(category)) {
      console.time(`[DEBUG${category ? ':' + category : ''}] ${label}`);
    }
  },

  /**
   * End a performance timer (only when debugMode is enabled)
   */
  timeEnd: (label: string, category?: DebugCategory) => {
    if (isEnabled(category)) {
      console.timeEnd(`[DEBUG${category ? ':' + category : ''}] ${label}`);
    }
  },

  /**
   * Log a table (only when debugMode is enabled and category is active)
   */
  table: (data: unknown, category?: DebugCategory) => {
    if (isEnabled(category)) {
      console.table(data);
    }
  }
};

const CATEGORY_KEYS = new Set<string>(['jmap', 'calendar', 'tasks', 'auth', 'filters', 'email', 'push', 'contacts']);
function isCategoryKey(value: string): value is DebugCategory {
  return CATEGORY_KEYS.has(value);
}
