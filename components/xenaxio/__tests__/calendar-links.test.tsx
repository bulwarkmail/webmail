import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useLocale: () => "de" }));
vi.mock("@/lib/xenaxio/bff", async (orig) => ({ ...(await orig<typeof import("@/lib/xenaxio/bff")>()), XENAXIO_BFF: true }));

const api = vi.hoisted(() => ({
  calendarSubscriptions: vi.fn(),
  addCalendarSubscription: vi.fn(),
  updateCalendarSubscription: vi.fn(),
  removeCalendarSubscription: vi.fn(),
  refreshCalendarSubscription: vi.fn(),
  calendarFeeds: vi.fn(),
  setCalendarFeed: vi.fn(),
  rotateCalendarFeed: vi.fn(),
  removeCalendarFeed: vi.fn(),
}));
vi.mock("@/lib/xenaxio/api", async (orig) => ({ ...(await orig<typeof import("@/lib/xenaxio/api")>()), xenaxio: api }));

import { XenaxioApiError } from "@/lib/xenaxio/api";
import { translate } from "@/lib/xenaxio/i18n";
import { CalendarLinksSettings, subscriptionError } from "../calendar-links";

const sub = {
  id: "s1",
  name: "Google privat",
  color: "#3b82f6",
  host: "calendar.google.com",
  calendarId: "cal-sub",
  refreshedAt: "2026-10-27T10:00:00Z",
  error: null,
  failures: 0,
  paused: false,
};
const feed = { calendarId: "cal1", mode: "full" as const, url: "https://app.xenaxio.com/api/ical/tok.ics", createdAt: "2026-10-27T10:00:00Z", lastFetchedAt: null };

describe("step 48: calendars from Google, Outlook & co.", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.calendarSubscriptions.mockResolvedValue({ subscriptions: [sub] });
    api.calendarFeeds.mockResolvedValue({ feeds: [] });
  });

  it("lists subscriptions and subscribes to a new one; the subscription's own calendar is not offered as a link", async () => {
    const onChanged = vi.fn();
    api.addCalendarSubscription.mockResolvedValue({ subscription: { ...sub, id: "s2", name: "Outlook", host: "outlook.office365.com", calendarId: "cal-2" } });
    render(<CalendarLinksSettings calendars={[{ id: "cal1", name: "Kalender" }, { id: "cal-sub", name: "Google privat" }]} onChanged={onChanged} />);
    expect(await screen.findByText("Google privat", { selector: "span" })).toBeTruthy();
    expect(screen.getByText(/calendar\.google\.com · Aktualisiert:/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("iCal-Adresse"), { target: { value: "webcal://outlook.office365.com/owa/calendar/x/reachcalendar.ics" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Outlook" } });
    fireEvent.click(screen.getByText("Abonnieren"));
    await waitFor(() => expect(api.addCalendarSubscription).toHaveBeenCalledWith({ url: "webcal://outlook.office365.com/owa/calendar/x/reachcalendar.ics", name: "Outlook", color: "#3b82f6" }));
    expect(await screen.findByText("Outlook")).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();

    const select = screen.getByLabelText("Kalender") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["cal1"]);
  });

  it("shows why a link was refused", async () => {
    api.addCalendarSubscription.mockRejectedValue(new XenaxioApiError(400, "https_required"));
    render(<CalendarLinksSettings calendars={[]} onChanged={() => undefined} />);
    fireEvent.change(await screen.findByLabelText("iCal-Adresse"), { target: { value: "http://x.example/a.ics" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "X" } });
    fireEvent.click(screen.getByText("Abonnieren"));
    expect(await screen.findByText("Die Adresse muss mit https:// (oder webcal://) beginnen.")).toBeTruthy();
  });

  it("creates a calendar link, shows it with copy, and replaces it after asking", async () => {
    api.calendarSubscriptions.mockResolvedValue({ subscriptions: [] });
    api.setCalendarFeed.mockResolvedValue({ feed });
    api.rotateCalendarFeed.mockResolvedValue({ feed: { ...feed, url: "https://app.xenaxio.com/api/ical/new.ics" } });
    render(<CalendarLinksSettings calendars={[{ id: "cal1", name: "Kalender" }]} onChanged={() => undefined} />);
    fireEvent.click(await screen.findByText("Link erstellen"));
    expect(await screen.findByText(feed.url)).toBeTruthy();
    expect(api.setCalendarFeed).toHaveBeenCalledWith("cal1", "full");
    expect(screen.getByText(/Google aktualisiert abonnierte Kalender selbst/)).toBeTruthy();

    fireEvent.click(screen.getByText("Neu erstellen"));
    expect(screen.getByText(/Der bisherige Link funktioniert dann nicht mehr/)).toBeTruthy();
    fireEvent.click(screen.getAllByText("Neu erstellen")[1]!);
    expect(await screen.findByText("https://app.xenaxio.com/api/ical/new.ics")).toBeTruthy();
  });

  it("explains stored errors", () => {
    const t = (key: string, values?: Record<string, string | number>) => translate("de", key, values);
    expect(subscriptionError(t, "feed_http_error:404")).toBe("Der Server des Kalenders hat einen Fehler gemeldet. (HTTP 404)");
    expect(subscriptionError(t, "events_failed:3")).toBe("3 Termine konnten nicht übernommen werden.");
    expect(subscriptionError(t, "something_new")).toBe(translate("de", "errors.internal"));
  });
});
