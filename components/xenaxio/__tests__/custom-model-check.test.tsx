import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CustomModelCheckResult } from "../custom-model-check";
import type { CustomModelCheck } from "@/lib/xenaxio/api";

vi.mock("next-intl", () => ({ useLocale: () => "de" }));

const passed: CustomModelCheck = { ok: true, models: ["qwen3.6:35b-a3b", "gemma4:31b"], stream: true, tools: true, usage: true, firstTokenMs: 1800, error: null, status: null };

describe("CustomModelCheckResult (step 44)", () => {
  it("says the own model can be switched on when every point passed", () => {
    render(<CustomModelCheckResult check={passed} model="qwen3.6:35b-a3b" />);
    expect(screen.getByText(/Verbindung funktioniert/)).toBeTruthy();
    expect(screen.getByText("Modell ruft Werkzeuge auf")).toBeTruthy();
    expect(screen.getByText(/qwen3.6:35b-a3b, gemma4:31b/)).toBeTruthy();
    expect(screen.getByText("Erste Antwort nach 1,8 s")).toBeTruthy();
    expect(screen.queryByText(/nicht in der Liste/)).toBeNull();
  });

  it("names the reason and the missing tool calling", () => {
    render(<CustomModelCheckResult check={{ ...passed, ok: false, tools: false, usage: false }} model="llama3" />);
    expect(screen.getByText("Der Test ist fehlgeschlagen.")).toBeTruthy();
    expect(screen.getByText(/Ohne Werkzeuge kann der Assistent/)).toBeTruthy();
    expect(screen.getByText(/„llama3“ ist nicht in der Liste/)).toBeTruthy();
  });

  it("explains a refused request with its status", () => {
    render(<CustomModelCheckResult check={{ ...passed, ok: false, stream: false, tools: false, usage: false, models: null, firstTokenMs: null, error: "unauthorized", status: 403 }} model="m" />);
    expect(screen.getByText("Zugriff verweigert (403). Prüfen Sie den API-Schlüssel oder die Header.")).toBeTruthy();
    // Without an answer, no hints about tools or token counts.
    expect(screen.queryByText(/Ohne Werkzeuge/)).toBeNull();
  });
});
