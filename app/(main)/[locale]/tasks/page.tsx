import { CalendarApp } from "@/components/calendar/calendar-app";
import { AppErrorBoundary } from "@/components/error/app-error-boundary";

// The Tasks app (#1698): the calendar's task list as an app of its own, shown
// in the app rail with Settings > Calendar > Tasks as their own app.
export default function TasksRoute() {
  return (
    <AppErrorBoundary>
      <CalendarApp surface="tasks" />
    </AppErrorBoundary>
  );
}
