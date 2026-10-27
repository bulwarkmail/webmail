import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProposalSeriesNote, ProposalSeriesRows } from "../proposal-series";

vi.mock("next-intl", () => ({ useLocale: () => "de" }));

const rows = (summary: Parameters<typeof ProposalSeriesRows>[0]["summary"]) =>
  render(
    <dl>
      <ProposalSeriesRows summary={summary} locale="de" />
    </dl>,
  );

describe("ProposalSeriesRows (step 45)", () => {
  it("shows nothing for a meeting that does not repeat", () => {
    const { container } = rows({ title: "Abstimmung" });
    expect(container.querySelector("dl")!.innerHTML).toBe("");
  });

  it("shows how a new series repeats", () => {
    rows({ title: "Jour fixe", repeatText: "wöchentlich am Montag, 4-mal" });
    expect(screen.getByText("Wiederholung")).toBeTruthy();
    expect(screen.getByText("wöchentlich am Montag, 4-mal")).toBeTruthy();
  });

  it("says that only one occurrence changes", () => {
    rows({ scope: "occurrence", occurrence: "2027-03-22T10:00", changes: ["time"] });
    expect(screen.getByText("Betrifft")).toBeTruthy();
    expect(screen.getByText("Nur den Termin vom 22.03.2027, 10:00")).toBeTruthy();
  });

  it("shows the new and the old rule of the whole series, and the reset", () => {
    rows({ scope: "series", changes: ["repeat"], repeatText: "alle 2 Wochen am Montag", repeatBefore: "wöchentlich am Montag" });
    expect(screen.getByText("Die ganze Serie")).toBeTruthy();
    expect(screen.getByText("wöchentlich am Montag").className).toContain("line-through");
    render(<ProposalSeriesNote summary={{ resetsChangedOccurrences: 2 }} />);
    expect(screen.getByText("Einzeln geänderte Termine der Serie (2) werden dabei auf die Serie zurückgesetzt.")).toBeTruthy();
  });
});
