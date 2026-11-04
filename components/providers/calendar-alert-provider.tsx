"use client";

import { MissedRemindersDialog } from '@/components/calendar/missed-reminders-dialog';
import { useCalendarAlerts } from '@/hooks/use-calendar-alerts';
import { useStoreReminders } from '@/hooks/use-store-reminders';
import { ToastContainer } from '@/components/ui/toast';
import { LiveRegions } from '@/components/ui/live-regions';
import { useToastStore } from '@/stores/toast-store';

export function CalendarAlertProvider({ children }: { children: React.ReactNode }) {
  useCalendarAlerts();
  useStoreReminders();

  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  return (
    <>
      {children}
      <ToastContainer toasts={toasts} onClose={removeToast} />
      <MissedRemindersDialog />
      <LiveRegions />
    </>
  );
}
