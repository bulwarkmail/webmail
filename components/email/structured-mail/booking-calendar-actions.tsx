"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
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
import { isDocumentRTL } from '@/i18n/direction';
import type { Email } from '@/lib/jmap/types';
import type { StructuredCard } from '@/lib/structured-mail';
import { useBookingCalendar } from './use-booking-calendar';
import { useCollectionNames } from "@/hooks/use-collection-names";

const BUTTON = 'inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors min-h-[36px] disabled:opacity-50';
const PICKER_WIDTH = 208;
const EDGE = 8;

interface PickerPosition { top: number; left?: number; right?: number; maxHeight: number }

/** Where the picker goes: under the trigger, flipped above when there's no room, always inside the viewport. */
function pickerPosition(rect: DOMRect, count: number): PickerPosition {
  const width = Math.min(PICKER_WIDTH, window.innerWidth - 2 * EDGE);
  const wanted = Math.min(36 * count + 40, 320);
  const below = window.innerHeight - rect.bottom - 4 - EDGE;
  const above = rect.top - 4 - EDGE;
  const placeBelow = below >= wanted || below >= above;
  const maxHeight = Math.max(120, Math.min(wanted, placeBelow ? below : above));
  const top = placeBelow ? rect.bottom + 4 : Math.max(EDGE, rect.top - 4 - maxHeight);
  const clamp = (value: number) => Math.max(EDGE, Math.min(value, window.innerWidth - width - EDGE));
  return isDocumentRTL()
    ? { top, right: clamp(window.innerWidth - rect.right), maxHeight }
    : { top, left: clamp(rect.left), maxHeight };
}

/**
 * The calendar part of a booking card's action row: "Add to calendar" (with
 * a calendar picker when there is more than one calendar to choose from),
 * "Update in calendar", "Remove from calendar", the "In your calendar" pill
 * and "View in calendar". Renders nothing when the booking has no calendar
 * action (see useBookingCalendar).
 */
export function BookingCalendarActions({ booking, email }: { booking: StructuredCard; email: Pick<Email, 'from' | 'subject'> }) {
  const shownName = useCollectionNames();
  const t = useTranslations('structured_mail_calendar');
  const calendar = useBookingCalendar(booking, email);
  const { status, calendars, busy, error, notice } = calendar;
  const [picker, setPicker] = useState<PickerPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // An action was started from here: once it is done, focus goes to its
  // outcome instead of being lost with the button or picker that vanished.
  const focusAfterAction = useRef(false);

  const closePicker = useCallback(() => setPicker(null), []);
  const pickerOpen = picker !== null;

  useEffect(() => {
    if (!pickerOpen) return;
    pickerRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (pickerRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closePicker();
    };
    // Scrolling the list itself must not close it; scrolling the page moves the trigger away.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && pickerRef.current?.contains(event.target)) return;
      closePicker();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePicker();
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', closePicker);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', closePicker);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen, closePicker]);

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

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(pickerRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
    else if (event.key === 'ArrowUp') next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Tab') closePicker();
    if (next === null) return;
    event.preventDefault();
    items[next].focus();
  };

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
    if (picker) {
      closePicker();
      return;
    }
    if (triggerRef.current) setPicker(pickerPosition(triggerRef.current.getBoundingClientRect(), calendars.length));
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
            aria-expanded={calendars.length > 1 ? Boolean(picker) : undefined}
            className={BUTTON}
          >
            <CalendarPlus className="w-3.5 h-3.5" />
            {t('add_to_calendar')}
            {calendars.length > 1 && <ChevronDown className="w-3 h-3" />}
          </button>
          {picker && calendars.length > 1 && typeof document !== 'undefined' && createPortal(
            <div
              ref={pickerRef}
              role="menu"
              aria-label={t('select_calendar')}
              onKeyDown={onMenuKey}
              className="fixed bg-background rounded-lg shadow-lg border border-border z-50 py-1 overflow-y-auto"
              style={{ top: picker.top, left: picker.left, right: picker.right, maxHeight: picker.maxHeight, width: `min(${PICKER_WIDTH}px, calc(100vw - ${2 * EDGE}px))` }}
            >
              <div role="presentation" className="px-3 py-1.5 text-xs font-medium text-muted-foreground">{t('select_calendar')}</div>
              {calendars.map((cal) => (
                <button
                  key={cal.id}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    closePicker();
                    act(() => calendar.add(cal.id));
                  }}
                  className="w-full px-3 py-1.5 text-sm text-start hover:bg-muted focus:bg-muted focus:outline-none flex items-center gap-2 min-h-[36px]"
                >
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: sanitizeColor(cal.color) }} />
                  <span className="truncate text-foreground">{shownName.calendar(cal)}</span>
                </button>
              ))}
            </div>,
            document.body,
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
