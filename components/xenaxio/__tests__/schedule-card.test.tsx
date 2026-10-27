import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleInfo } from "@/lib/xenaxio/api";
import type { ProposalSummary } from "@/lib/xenaxio/assistant";

const api = vi.hoisted(() => ({
  schedules: vi.fn(),
  pauseSchedule: vi.fn(async () => ({})),
  resumeSchedule: vi.fn(async () => ({})),
  runSchedule: vi.fn(async () => ({ started: true, conversationId: "c1" })),
  deleteSchedule: vi.fn(async () => ({ ok: true })),
}));
const push = vi.hoisted(() => vi.fn());

vi.mock("next-intl", () => ({ useLocale: () => "de" }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => <a href={href} className={className}>{children}</a>,
  useRouter: () => ({ push }),
}));
vi.mock("@/lib/xenaxio/api", async (orig) => ({ ...(await orig<typeof import("@/lib/xenaxio/api")>()), xenaxio: api }));

const { formatRun, ScheduleCard, scheduleCardKind } = await import("../schedule-card");
const { ScheduleList, scheduleState } = await import("../schedule-list");

const proposal = (tool: string, summary: ProposalSummary, state = "pending") => ({ id: "p1", tool, summary, state });

describe("ScheduleCard (step 49)", () => {
  it("formats runs and tells the kinds of proposals apart", () => {
    expect(formatRun("2026-10-29T08:00", "de")).toBe("Do., 29.10.2026, 08:00");
    expect(scheduleCardKind("schedule_task", {})).toBe("create");
    expect(scheduleCardKind("delete_schedule", {})).toBe("delete");
    expect(scheduleCardKind("update_schedule", { changes: ["status"], status: "paused" })).toBe("pause");
    expect(scheduleCardKind("update_schedule", { changes: ["status"], status: "active" })).toBe("resume");
    expect(scheduleCardKind("update_schedule", { changes: ["rule", "status"], status: "active" })).toBe("update");
  });

  it("shows a new task with its runs, the email copy and who it may write to", () => {
    const decide = vi.fn();
    render(
      <ScheduleCard
        proposal={proposal("schedule_task", { title: "Mahnung Müller", instruction: "Erinnere Müller an die Rechnung", when: "jede Woche Fr um 09:00", timeZone: "Europe/Berlin", nextRuns: ["2026-10-30T09:00", "2026-11-06T09:00"], emailCopy: true, maySend: true, sendTo: ["jan@mueller.de"] })}
        locale="de"
        onDecide={decide}
      />,
    );
    expect(screen.getByText("Geplante Aufgabe")).toBeTruthy();
    expect(screen.getByText("Erinnere Müller an die Rechnung")).toBeTruthy();
    expect(screen.getByText("Fr., 30.10.2026, 09:00 · Fr., 06.11.2026, 09:00")).toBeTruthy();
    expect(screen.getByText("darf selbst senden an jan@mueller.de")).toBeTruthy();
    expect(screen.getByText(/sendet dann ohne Rückfrage/)).toBeTruthy();
    expect(screen.getByText(/Kalender „KI-Aufgaben“/)).toBeTruthy();
    fireEvent.click(screen.getByText("Bestätigen"));
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), true);
  });

  it("shows a change with what it was, and the limit when it is reached", () => {
    const summary: ProposalSummary = { title: "Morgen", when: "Mo–Fr um 07:30", status: "active", emailCopy: false, maySend: false, sendTo: [], changes: ["rule"], before: { title: "Morgen", when: "jeden Tag um 08:00" } };
    const { rerender } = render(<ScheduleCard proposal={proposal("update_schedule", summary)} locale="de" onDecide={() => {}} />);
    expect(screen.getByText("Geplante Aufgabe ändern")).toBeTruthy();
    expect(screen.getByText("jeden Tag um 08:00").className).toContain("line-through");
    expect(screen.getByText("nein, nur Entwürfe")).toBeTruthy();
    rerender(<ScheduleCard proposal={proposal("schedule_task", { title: "x", when: "y" }, "schedule_limit")} locale="de" onDecide={() => {}} />);
    expect(screen.getByText(/so viele aktive Aufgaben, wie Ihre Firma erlaubt/)).toBeTruthy();
    expect(screen.queryByText("Bestätigen")).toBeNull();
  });
});

const schedule = (over: Partial<ScheduleInfo> = {}): ScheduleInfo => ({
  id: "s1",
  title: "Morgen-Überblick",
  instruction: "Neue E-Mails zusammenfassen",
  when: "Mo–Fr um 08:00",
  timeZone: "Europe/Berlin",
  status: "active",
  nextRun: "2026-10-29T08:00",
  lastRun: "2026-10-28T08:00",
  lastStatus: "done",
  emailCopy: true,
  maySend: false,
  sendTo: [],
  conversationId: "c1",
  createdAt: "2026-10-27T10:00:00Z",
  ...over,
});

describe("ScheduleList (step 49)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.schedules.mockResolvedValue({ timeZone: "Europe/Berlin", schedules: [schedule(), schedule({ id: "s2", title: "Mahnung", status: "paused", pausedReason: "failures", nextRun: null, lastRun: null, lastStatus: null, conversationId: null })], maxSchedules: 20, maxRunsPerDay: 24 });
  });

  it("says why a task is paused or when it runs next", () => {
    const t = (key: string, values?: Record<string, string | number>) => `${key}${values ? JSON.stringify(values) : ""}`;
    expect(scheduleState(schedule(), t, "de")).toBe('schedules.next{"when":"Do., 29.10.2026, 08:00"}');
    expect(scheduleState(schedule({ status: "paused", pausedReason: "no_access" }), t, "de")).toBe("schedules.paused_no_access");
    expect(scheduleState(schedule({ status: "ended" }), t, "de")).toBe("schedules.ended");
  });

  it("lists the tasks and pauses, resumes, runs, opens and deletes them", async () => {
    render(<ScheduleList />);
    expect(await screen.findByText("Geplante Aufgaben (1 von 20 aktiv)")).toBeTruthy();
    expect(screen.getByText(/Ihre Firma erlaubt höchstens 24 Läufe pro Tag, eine Aufgabe höchstens alle 1 Std\./)).toBeTruthy();
    expect(screen.getByText("Nächster Lauf: Do., 29.10.2026, 08:00 · letzter Lauf Mi., 28.10.2026, 08:00")).toBeTruthy();
    expect(screen.getByText("Pausiert nach drei Fehlern in Folge.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("Pausieren")));
    expect(api.pauseSchedule).toHaveBeenCalledWith("s1");
    await act(async () => fireEvent.click(screen.getByText("Fortsetzen")));
    expect(api.resumeSchedule).toHaveBeenCalledWith("s2");
    await act(async () => fireEvent.click(screen.getAllByText("Jetzt ausführen")[0]!));
    expect(api.runSchedule).toHaveBeenCalledWith("s1");
    expect(await screen.findByText(/Läuft – das Ergebnis erscheint gleich/)).toBeTruthy();
    fireEvent.click(screen.getByText("Im Chat öffnen"));
    expect(push).toHaveBeenCalledWith("/mail/?assistant=c1");
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    await act(async () => fireEvent.click(screen.getAllByText("Löschen")[1]!));
    expect(api.deleteSchedule).toHaveBeenCalledWith("s2");
  });

  it("step 50: says what the company set and why a task is paused; off, nothing can be resumed or run", async () => {
    api.schedules.mockResolvedValue({
      timeZone: "Europe/Berlin",
      schedules: [schedule({ status: "paused", pausedReason: "company_off", nextRun: null, maySend: true, sendTo: ["jan@mueller.de"] })],
      maxSchedules: 5,
      maxRunsPerDay: 12,
      minIntervalMinutes: 15,
      enabled: false,
      sendAllowed: false,
    });
    render(<ScheduleList />);
    expect(await screen.findByText(/Ihre Firma hat geplante Aufgaben ausgeschaltet\. Bestehende/)).toBeTruthy();
    expect(screen.getByText(/höchstens alle 15 Min\./)).toBeTruthy();
    expect(screen.getByText(/^Pausiert: Ihre Firma hat geplante Aufgaben ausgeschaltet\./)).toBeTruthy();
    expect(screen.queryByText("Fortsetzen")).toBeNull();
    expect(screen.queryByText("Jetzt ausführen")).toBeNull();
    expect(screen.getByText("Löschen")).toBeTruthy();
  });
});

describe("ScheduleSettings in Verwaltung → KI (step 50)", () => {
  const value = { enabled: true, sendAllowed: true, maxPerUser: 20, runsPerDay: 24, minIntervalMinutes: 60, caps: { maxPerUser: 50, runsPerDay: 96, minIntervalMinutes: 15 }, active: 3, paused: 1 };

  it("saves the company's limits and says how many tasks were paused", async () => {
    const save = vi.fn(async () => ({ paused: 2, schedules: value }));
    (api as unknown as { saveScheduleSettings: typeof save }).saveScheduleSettings = save;
    const saved = vi.fn(async () => {});
    const { ScheduleSettings, intervalLabel } = await import("../schedule-settings");
    const t = (key: string, values?: Record<string, string | number>) => `${key}${values ? JSON.stringify(values) : ""}`;
    expect([15, 120, 1440].map((m) => intervalLabel(m, t))).toEqual(['aiadmin.schedules_interval_minutes{"n":15}', 'aiadmin.schedules_interval_hours{"n":2}', "aiadmin.schedules_interval_day"]);
    render(<ScheduleSettings value={value} onSaved={saved} />);
    expect(screen.getByText("Zurzeit 3 aktiv, 1 pausiert.")).toBeTruthy();
    const interval = screen.getByLabelText("Höchstens alle") as HTMLSelectElement;
    expect([...interval.options].map((o) => o.textContent)).toEqual(["15 Min.", "30 Min.", "1 Std.", "2 Std.", "4 Std.", "1 Tag"]);
    fireEvent.change(interval, { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("Aufgaben pro Person"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Läufe pro Tag und Person"), { target: { value: "48" } });
    fireEvent.click(screen.getByLabelText(/^Selbst senden erlauben/));
    await act(async () => fireEvent.click(screen.getByText("Speichern")));
    expect(save).toHaveBeenCalledWith({ enabled: true, sendAllowed: false, maxPerUser: 5, runsPerDay: 48, minIntervalMinutes: 15 });
    expect(screen.getByText(/2 Aufgaben wurden pausiert/)).toBeTruthy();
    expect(saved).toHaveBeenCalled();
    // Off: the other settings wait until it is on again.
    fireEvent.click(screen.getByLabelText(/^Geplante Aufgaben erlauben/));
    expect((screen.getByLabelText("Aufgaben pro Person") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("the KI-Aufgaben calendar shows once a task is set up (step 49)", () => {
  it("is added to the ticked calendars, unless none is chosen yet (then all show)", async () => {
    const { withCalendar } = await import("@/lib/xenaxio/calendar-visibility");
    expect(withCalendar(["b"], "k")).toEqual(["b", "k"]);
    const same = ["b", "k"];
    expect(withCalendar(same, "k")).toBe(same);
    const none: string[] = [];
    expect(withCalendar(none, "k")).toBe(none);
    expect(withCalendar(["__birthday-calendar__"], "k")).toEqual(["__birthday-calendar__"]);
  });
});
