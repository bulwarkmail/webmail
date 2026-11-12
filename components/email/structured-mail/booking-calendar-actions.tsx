"use client";

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  Calendar as CalendarIcon,
  CalendarCheck,
  CalendarPlus,
  CalendarX,
  ChevronDown,
  Loader2,
} from '@/components/icons';
import { sanitizeColor } from '@/components/calendar/event-card';
import { ContextMenu, ContextMenuHeader, ContextMenuItem } from '@/components/ui/context-menu';
import { useContextMenu } from '@/hooks/use-context-menu';
import { cn } from '@/lib/utils';
import type { Email } from '@/lib/jmap/types';
import type { StructuredCard } from '@/lib/structured-mail';
import { useBookingCalendar } from './use-booking-calendar';
import { useCollectionNames } from "@/hooks/use-collection-names";

const BUTTON = 'inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors min-h-[36px] disabled:opacity-50';
/** A calendar's colour as a menu row's icon, one component per colour. */
const dots = new Map<string, React.ComponentType<{ className?: string }>>();
function colorDot(color: string): React.ComponentType<{ className?: string }> {
  let Dot = dots.get(color);
  if (!Dot) {
    Dot = function CalendarDot({ className }: { className?: string }) {
      return <span className={cn(className, "rounded-full")} style={{ backgroundColor: color }} aria-hidden="true" />;
    };
    dots.set(color, Dot);
  }
  return Dot;
}

/**
 * The calendar part of a booking card's action row: "Add to calendar" (with
 * a calendar picker when there is more than one calendar to choose from),
 * "Update in calendar", "Remove from calendar", the "In your calendar" pill
 * and "View in calendar". Renders nothing when the booking has no calendar
 * action (see useBookingCalendar).
 */
export function BookingCalendarActions({ booking, email }: { booking: StructuredCard; email: Pick<Email, 'from' | 'subject' | 'sourceClientAccountId'> }) {
  const shownName = useCollectionNames();
  const t = useTranslations('structured_mail_calendar');
  const calendar = useBookingCalendar(booking, email);
  const { status, calendars, busy, error, notice } = calendar;
  const picker = useContextMenu<null>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // An action was started from here: once it is done, focus goes to its
  // outcome instead of being lost with the button or picker that vanished.
  const focusAfterAction = useRef(false);

  const closePicker = picker.closeContextMenu;
  const pickerOpen = picker.contextMenu.isOpen;

  useEffect(() => {
    if (busy || !focusAfterAction.current) return;
    focusAfterAction.current = false;
    const row = rowRef.current;
    if (!row) return;
    const target = row.querySelector<HTMLElement>('[role="alert"]')
      ?? row.querySelector<HTMLElement>('[role="status"]')
      ?? row.querySelector<HTMLElement>('button');
    target?.focus();
  }, [busy, status, notice, error]);

  const act = (action: () => Promise<void>) => {
    focusAfterAction.current = true;
    void action();
  };

  if (status === 'hidden' || status === 'loading') return null;
  // A cancelled booking with nothing in the calendar has no action; only the
  // confirmation of a removal just done stays.
  if (status === 'cancelled' && notice !== 'removed') return null;

  const onAdd = () => {
    if (calendars.length <= 1) {
      act(() => calendar.add(calendars[0]?.id));
      return;
    }
    if (pickerOpen) {
      closePicker();
      return;
    }
    if (triggerRef.current) picker.openContextMenuFrom(triggerRef.current, null, 'start');
  };

  const noticeText = notice === 'added' ? t('added') : notice === 'updated' ? t('updated') : notice === 'removed' ? t('removed') : null;
  const blocked = notice === 'blocked';
  const showView = status === 'in-calendar' || status === 'update';

  return (
    <div ref={rowRef} className="flex flex-wrap items-center gap-1.5">
      {status === 'add' && (
        <>
          <button
            ref={triggerRef}
            type="button"
            onClick={onAdd}
            disabled={busy}
            aria-haspopup={calendars.length > 1 ? 'menu' : undefined}
            aria-expanded={calendars.length > 1 ? pickerOpen : undefined}
            className={BUTTON}
          >
            <CalendarPlus className="w-3.5 h-3.5" />
            {t('add_to_calendar')}
            {calendars.length > 1 && <ChevronDown className="w-3 h-3" />}
          </button>
          {calendars.length > 1 && (
            <ContextMenu
              ref={picker.menuRef}
              isOpen={pickerOpen}
              position={picker.contextMenu.position}
              onClose={closePicker}
              label={t('select_calendar')}
            >
              <ContextMenuHeader>{t('select_calendar')}</ContextMenuHeader>
              {calendars.map((cal) => (
                <ContextMenuItem
                  key={cal.id}
                  icon={colorDot(sanitizeColor(cal.color))}
                  label={shownName.calendar(cal)}
                  onClick={() => {
                    closePicker();
                    act(() => calendar.add(cal.id));
                  }}
                />
              ))}
            </ContextMenu>
          )}
        </>
      )}

      {status === 'update' && (
        <button type="button" onClick={() => act(calendar.update)} disabled={busy} className={BUTTON}>
          <CalendarCheck className="w-3.5 h-3.5" />
          {t('update_in_calendar')}
        </button>
      )}

      {status === 'remove' && (
        <button
          type="button"
          onClick={() => act(calendar.remove)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-destructive px-3 py-1.5 rounded-md border border-border hover:border-destructive/30 hover:bg-destructive/10 transition-colors min-h-[36px] disabled:opacity-50"
        >
          <CalendarX className="w-3.5 h-3.5" />
          {t('remove_from_calendar')}
        </button>
      )}

      {status === 'in-calendar' && !noticeText && (
        <span className="rounded-full bg-success/15 px-2 py-0.5 text-[0.6875rem] font-medium text-success">{t('in_calendar')}</span>
      )}

      {noticeText && (
        <span role="status" tabIndex={-1} className="rounded-full bg-success/15 px-2 py-0.5 text-[0.6875rem] font-medium text-success focus:outline-none">{noticeText}</span>
      )}

      {blocked && (
        <span role="status" tabIndex={-1} className="rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] font-medium text-muted-foreground focus:outline-none">{t('blocked')}</span>
      )}

      {showView && (
        <button
          type="button"
          onClick={calendar.viewInCalendar}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md hover:bg-muted transition-colors min-h-[36px]"
        >
          <CalendarIcon className="w-3.5 h-3.5" />
          {t('view_in_calendar')}
          <ArrowRight className="w-3 h-3" />
        </button>
      )}

      {busy && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}

      {error && (
        <p role="alert" tabIndex={-1} className="basis-full text-xs text-destructive focus:outline-none">{error}</p>
      )}
    </div>
  );
}
