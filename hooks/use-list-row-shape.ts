import { useSettingsStore, effectiveMailLayout } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

export interface ListRowShape {
  /** Sender, subject and date on one line instead of stacked. */
  oneLine: boolean;
  /** One-line rows laid out in fixed From / Subject / Date / Size columns. */
  columns: boolean;
}

/**
 * How the message list draws its rows.
 *
 * The focused list and the bottom reading pane both give the list the full
 * width, so their rows run on one line. Phones fall back to stacked rows.
 * A window too narrow for the split layout's two panes keeps its stacked rows
 * (useDrawnMailLayout): the list is as narrow as the window.
 * Columns are a table on top of the one-line rows (#262); Mountain View rows
 * are shaped after Gmail and never take them.
 */
export function useListRowShape(): ListRowShape {
  const mailLayout = useSettingsStore((state) => effectiveMailLayout(state.mailLayout, state.interfaceLayout, state.simpleMode));
  const mountainView = useSettingsStore((state) => state.interfaceLayout === 'mountain-view');
  const listColumns = useSettingsStore((state) => state.listColumns);
  const isMobile = useUIStore((state) => state.isMobile);
  const oneLine = !isMobile && (mailLayout === 'focus' || mailLayout === 'horizontal');
  return { oneLine, columns: oneLine && listColumns && !mountainView };
}

/**
 * Column widths, shared by the rows and the header above them so the two
 * line up. The subject column takes whatever is left.
 */
export const LIST_COLUMN_CLASS = {
  from: 'w-40 shrink-0 lg:w-56',
  date: 'w-28 shrink-0 text-end',
  size: 'w-16 shrink-0 text-end',
} as const;

/**
 * Whether a stacked row puts its preview after the subject, on the subject's
 * line, instead of on a line of its own (mail-15). The regular density does
 * on a computer, which brings a row from about 96 px to about 68 px, so a
 * 1366×768 screen lists about ten. Comfortable keeps two preview lines, and
 * phones keep the preview under the subject, where the line is too short.
 */
export function showsPreviewOnSubjectLine(options: {
  showPreview: boolean;
  density: string;
  isMobile: boolean;
  mountainView: boolean;
}): boolean {
  return options.showPreview && options.density === 'regular' && !options.isMobile && !options.mountainView;
}
