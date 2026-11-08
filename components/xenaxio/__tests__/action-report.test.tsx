import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionReportView } from "../action-report";

vi.mock("next-intl", () => ({ useLocale: () => "de" }));

// Step 101: "Was ich getan habe" under every answer.
describe("ActionReportView", () => {
  it("is one line when closed and lists the steps when opened, ending with what changed", () => {
    render(
      <ActionReportView
        report={{
          steps: [
            { tool: "search_mail", kind: "read", status: "ok", args: { query: "Müller" }, count: 3 },
            { tool: "set_signature", kind: "write-confirm", status: "proposed", proposalId: "p1" },
          ],
          changed: false,
          claimMismatch: false,
        }}
        live={{ p1: "done" }}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Was ich getan habe/ });
    expect(toggle.textContent).toContain("2 Schritte");
    expect(toggle.textContent).toContain("Geändert: Signatur ändern");
    expect(screen.queryByText(/E-Mails durchsuchen/)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("E-Mails durchsuchen: „Müller“ — 3 gefunden")).toBeTruthy();
    expect(screen.getByText("Signatur ändern: von Ihnen bestätigt und ausgeführt")).toBeTruthy();
  });

  it("step 120: a helper's work shows as one line with its name", () => {
    render(
      <ActionReportView
        report={{
          steps: [
            { tool: "search_files", kind: "read", status: "ok", args: { query: "Müller" }, count: 2, agent: "file_research" },
            { tool: "delegate", kind: "read", status: "ok", agent: "file_research", args: { what: "Datei-Recherche" } },
          ],
          changed: false,
          claimMismatch: false,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Was ich getan habe/ }));
    expect(screen.getByText("Hilfsagenten: „Datei-Recherche“")).toBeTruthy();
    expect(screen.getAllByText("Nichts geändert").length).toBeGreaterThan(0);
  });

  it("says plainly that nothing changed, and opens with a warning when the answer claims otherwise", () => {
    render(<ActionReportView report={{ steps: [{ tool: "set_display_name", kind: "unknown", status: "error" }], changed: false, claimMismatch: true }} />);
    expect(screen.getByRole("button", { name: /Was ich getan habe/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/In dieser Antwort wurde aber nichts geändert/)).toBeTruthy();
    expect(screen.getByText("„set_display_name“: dieses Werkzeug gibt es nicht, nichts passiert")).toBeTruthy();
    expect(screen.getAllByText("Nichts geändert").length).toBeGreaterThan(0);
  });
});
