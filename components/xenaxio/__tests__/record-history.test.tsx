import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Step 127 D: the history of a record in words; sensitive fields only "changed".
const api = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock("@/lib/xenaxio/projects", async (orig) => {
  const real = await orig<typeof import("@/lib/xenaxio/projects")>();
  return { ...real, projectsApi: { ...real.projectsApi, ...api } };
});
vi.mock("next-intl", async (orig) => ({ ...(await orig<typeof import("next-intl")>()), useLocale: () => "en" }));

import { RecordHistory } from "../projects/record-history";
import type { ObjectType } from "@/lib/xenaxio/projects";

const type = {
  key: "vehicle",
  fields: [
    { key: "ort", type: "location", label: { de: "Standort", en: "Location" } },
    { key: "vin", type: "text", label: { de: "FIN", en: "VIN" }, sensitive: true },
  ],
  statuses: [
    { key: "open", name: { de: "Offen", en: "Open" }, color: "blue", closed: false },
    { key: "done", name: { de: "Fertig", en: "Done" }, color: "green", closed: true },
  ],
} as unknown as ObjectType;
const ev = (id: string, field: string, from: string | null, to: string | null, extra: object = {}) => ({ id, author: { id: "u1", name: "Anna", email: "a@x" }, field, from, to, detail: null, masked: false, createdAt: `2026-11-08T10:0${id}:00Z`, ...extra });

describe("record history", () => {
  it("names stages and fields, shows places and masks sensitive values", async () => {
    api.history.mockResolvedValue({
      events: [
        ev("1", "status", "open", "done"),
        ev("2", "field:ort", null, JSON.stringify({ address: "Hauptstr. 1" })),
        ev("3", "field:vin", null, null, { masked: true }),
        ev("4", "file_add", null, "record", { detail: "Schein.pdf" }),
      ],
    });
    render(<RecordHistory objectId="o1" type={type} />);
    expect(await screen.findByText(/changed the stage: Open → Done/)).toBeTruthy();
    expect(screen.getByText(/changed Location: — → Hauptstr. 1/)).toBeTruthy();
    expect(screen.getByText(/changed VIN/).textContent).not.toContain("→");
    expect(screen.getByText(/added the file Schein.pdf/)).toBeTruthy();
  });
});
