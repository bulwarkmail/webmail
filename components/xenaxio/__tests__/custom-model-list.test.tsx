import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CustomModelList } from "../custom-model-list";
import type { CustomModel, CustomModelCheck } from "@/lib/xenaxio/api";

vi.mock("next-intl", () => ({ useLocale: () => "de" }));

const ok: CustomModelCheck = { ok: true, models: null, stream: true, tools: true, usage: true, firstTokenMs: 900, error: null, status: null };
const base: CustomModel = {
  baseUrl: "https://llm.firma.de/v1",
  profile: "openai",
  model: "qwen3.6:35b-a3b",
  models: [
    { name: "qwen3.6:35b-a3b", check: ok, checkedAt: "2026-10-27T08:00:00Z" },
    { name: "gemma4:31b", check: null, checkedAt: null },
    { name: "llama3", check: { ...ok, ok: false, tools: false }, checkedAt: "2026-10-27T08:00:00Z" },
  ],
  apiKeySet: false,
  headers: [],
  fallback: false,
  check: ok,
  checkedAt: "2026-10-27T08:00:00Z",
  health: { status: "ok", since: "2026-10-27T08:00:00Z", error: null, checkedAt: "2026-10-27T08:15:00Z" },
};

describe("CustomModelList (step 45)", () => {
  it("shows each model with its check; only a tested one can be used", () => {
    render(<CustomModelList custom={base} platformConfigured onChanged={async () => {}} />);
    expect(screen.getByText("Aktiv")).toBeTruthy();
    expect(screen.getByText("Nicht getestet")).toBeTruthy();
    expect(screen.getByText("Test fehlgeschlagen")).toBeTruthy();
    const use = screen.getAllByRole("button", { name: "Verwenden" }) as HTMLButtonElement[];
    expect(use).toHaveLength(2);
    expect(use.every((b) => b.disabled)).toBe(true);
    expect(screen.getByText(/Erreichbar, zuletzt geprüft/)).toBeTruthy();
  });

  it("offers the fallback only with a platform model", () => {
    const { unmount } = render(<CustomModelList custom={base} platformConfigured onChanged={async () => {}} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false);
    unmount();
    render(<CustomModelList custom={base} platformConfigured={false} onChanged={async () => {}} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/keine KI von xenaxio als Ersatz/)).toBeTruthy();
  });

  it("says since when the model is down, without an empty status", () => {
    render(<CustomModelList custom={{ ...base, health: { status: "down", since: "2026-10-27T09:00:00Z", error: "unauthorized", checkedAt: null } }} platformConfigured onChanged={async () => {}} />);
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toContain("antwortet seit");
    expect(text).toContain("Zugriff verweigert.");
    expect(text).not.toContain("()");
  });
});
