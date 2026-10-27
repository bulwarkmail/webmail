import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProposalSummary } from "@/lib/xenaxio/assistant";
import { formatDue, TaskCard, taskCardKind, type TaskProposal } from "../task-card";
import { emailPathFromDescription, TaskEmailLink } from "../task-email-link";

vi.mock("next-intl", () => ({ useLocale: () => "de" }));
vi.mock("@/i18n/navigation", () => ({ Link: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

const proposal = (tool: string, summary: ProposalSummary, state = "pending"): TaskProposal => ({ id: "p1", tool, summary, state });

describe("TaskCard (step 46)", () => {
  it("formats due dates as the platform sends them", () => {
    expect(formatDue("2026-10-30", "de")).toBe("Fr., 30.10.2026");
    expect(formatDue("2026-10-30T09:00", "de")).toBe("Fr., 30.10.2026, 09:00");
    expect(formatDue(null, "de")).toBe("");
  });

  it("tells a new task, marking done and other changes apart", () => {
    expect(taskCardKind("create_task", {})).toBe("create");
    expect(taskCardKind("update_task", { changes: ["done"] })).toBe("done");
    expect(taskCardKind("update_task", { changes: ["due", "done"] })).toBe("update");
  });

  it("shows a new task from an email and confirms it", () => {
    const decide = vi.fn();
    render(
      <TaskCard
        proposal={proposal("create_task", { title: "Müller antworten", due: "2026-10-30T09:00", priority: "high", reminder: true, description: "Preis klären", email: { subject: "Angebot Fenster", from: "Max Müller <max@kunde.de>" } })}
        locale="de"
        onDecide={decide}
      />,
    );
    expect(screen.getByText("Aufgabe anlegen")).toBeTruthy();
    expect(screen.getByText("Müller antworten")).toBeTruthy();
    expect(screen.getByText("Fr., 30.10.2026, 09:00")).toBeTruthy();
    expect(screen.getByText("Hoch")).toBeTruthy();
    expect(screen.getByText("Zur Fälligkeit")).toBeTruthy();
    expect(screen.getByText("Angebot Fenster")).toBeTruthy();
    expect(screen.getByText(/Aufgaben-Apps/)).toBeTruthy();
    fireEvent.click(screen.getByText("Bestätigen"));
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), true);
  });

  it("shows marking done with the old status, and the link to all tasks once done", () => {
    const summary: ProposalSummary = { title: "Mueller antworten", due: "2026-10-30", status: "done", changes: ["done"], before: { title: "Mueller antworten", due: "2026-10-30", status: "open" } };
    const { rerender } = render(<TaskCard proposal={proposal("update_task", summary)} locale="de" onDecide={() => {}} />);
    expect(screen.getByText("Als erledigt markieren")).toBeTruthy();
    expect(screen.getByText("Erledigt")).toBeTruthy();
    expect(screen.getByText("Offen").className).toContain("line-through");
    expect(screen.queryByText("Alle Aufgaben")).toBeNull();
    rerender(<TaskCard proposal={proposal("update_task", summary, "done")} locale="de" onDecide={() => {}} />);
    expect(screen.getByText("Aufgabe erledigt.")).toBeTruthy();
    expect(screen.getByText("Alle Aufgaben").getAttribute("href")).toBe("/calendar/tasks");
    expect(screen.queryByText("Bestätigen")).toBeNull();
  });

  it("strikes through the old due date of a moved task", () => {
    render(<TaskCard proposal={proposal("update_task", { title: "Steuer", due: null, changes: ["due"], before: { due: "2026-11-03" } })} locale="de" onDecide={() => {}} />);
    expect(screen.getByText("Aufgabe ändern")).toBeTruthy();
    expect(screen.getByText("ohne Datum")).toBeTruthy();
    expect(screen.getByText("Di., 03.11.2026").className).toContain("line-through");
  });
});

describe("TaskEmailLink (step 46)", () => {
  it("finds the email link of a task and keeps only its path", () => {
    const text = "Preis klären\n\nE-Mail: Angebot\nÖffnen: https://acme.xenaxio.com/de/mail/message/m1";
    expect(emailPathFromDescription(text)).toBe("/mail/message/m1");
    expect(emailPathFromDescription("Öffnen: https://acme.xenaxio.com/en/mail/message/m%3A2?account=c9")).toBe("/mail/message/m%3A2?account=c9");
    expect(emailPathFromDescription("https://evil.example/de/files")).toBeNull();
    expect(emailPathFromDescription("Kein Link")).toBeNull();
    expect(emailPathFromDescription(null)).toBeNull();
  });

  it("renders the link only for a task from an email", () => {
    const { container, rerender } = render(<TaskEmailLink description="Nur eine Notiz" />);
    expect(container.innerHTML).toBe("");
    rerender(<TaskEmailLink description="Öffnen: https://acme.xenaxio.com/de/mail/message/m1" />);
    expect(screen.getByText("E-Mail öffnen").closest("a")?.getAttribute("href")).toBe("/mail/message/m1");
  });
});
