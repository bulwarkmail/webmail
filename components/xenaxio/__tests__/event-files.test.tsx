import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarLink } from "@/lib/jmap/types";
import { EventFiles, eventFiles } from "../event-files";

const downloadBlob = vi.hoisted(() => vi.fn());

vi.mock("next-intl", () => ({ useLocale: () => "de" }));
vi.mock("@/stores/auth-store", () => ({ useAuthStore: (pick: (s: unknown) => unknown) => pick({ client: { downloadBlob } }) }));

const link = (over: Partial<CalendarLink> & { blobId?: string }): CalendarLink =>
  ({ "@type": "Link", href: "cid:x@acme.de", cid: null, contentType: "application/pdf", size: 8, rel: "enclosure", display: null, title: "Angebot.pdf", ...over }) as CalendarLink;

describe("EventFiles (step 32)", () => {
  beforeEach(() => downloadBlob.mockReset());

  it("keeps only file links, in a stable order", () => {
    const files = eventFiles({ b: link({ title: "B.pdf" }), a: link({ title: "A.pdf" }), alt: link({ rel: "alternate", title: "Web" }) });
    expect(files.map((f) => f.title)).toEqual(["A.pdf", "B.pdf"]);
    expect(eventFiles(null)).toEqual([]);
  });

  it("renders nothing without files", () => {
    const { container } = render(<EventFiles links={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("downloads the organizer's file and names the ones from an invitation", async () => {
    render(<EventFiles links={{ f1: link({ blobId: "b1" }), f2: link({ title: "Agenda.md", contentType: "text/markdown" }), f3: link({ href: "https://example.com/plan.pdf", title: "Plan.pdf" }) }} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Angebot.pdf" })));
    expect(downloadBlob).toHaveBeenCalledWith("b1", "Angebot.pdf", "application/pdf");
    expect(screen.getByText("(in der Einladungs-E-Mail)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Plan.pdf" }).getAttribute("href")).toBe("https://example.com/plan.pdf");
  });

  it("says so when the file is gone", async () => {
    downloadBlob.mockRejectedValue(new Error("404"));
    render(<EventFiles links={{ f1: link({ blobId: "b1" }) }} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Angebot.pdf" })));
    expect(screen.getByText(/Die Datei konnte nicht geladen werden/)).toBeTruthy();
  });
});
