import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryStatus } from "../delivery-status";

const delivery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/xenaxio/bff", async (orig) => ({ ...(await orig<typeof import("@/lib/xenaxio/bff")>()), XENAXIO_BFF: true }));
vi.mock("next-intl", () => ({ useLocale: () => "de" }));
vi.mock("@/lib/xenaxio/api", () => ({ xenaxio: { delivery } }));

describe("DeliveryStatus (step 15)", () => {
  beforeEach(() => delivery.mockReset());

  it("says delivered and stays closed when everyone got it", async () => {
    delivery.mockResolvedValue({ recipients: [{ address: "lea@firma.de", state: "delivered", at: "2026-10-22T10:00:00Z" }] });
    await act(async () => render(<DeliveryStatus emailId="m1" />));
    expect(screen.getByText("Zugestellt")).toBeTruthy();
    expect(screen.queryByText("lea@firma.de")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("lea@firma.de")).toBeTruthy();
  });

  it("opens by itself and explains a failure", async () => {
    delivery.mockResolvedValue({
      recipients: [
        { address: "lea@firma.de", state: "delivered", server: "mx.firma.de" },
        { address: "x@tippfehler.de", state: "failed", reply: "DNS lookup failed: no MX record found.", reason: "no_domain" },
        { address: "ic@kunde.de", state: "failed", reply: "550 5.1.2 Mailbox does not exist.", reason: "no_mailbox", server: "local" },
      ],
    });
    await act(async () => render(<DeliveryStatus emailId="m2" />));
    expect(screen.getByText("Nicht zugestellt: 2 von 3 Empfängern")).toBeTruthy();
    // Which server answered: the recipient's or ours.
    expect(screen.getByText("Antwort von: mx.firma.de")).toBeTruthy();
    expect(screen.getByText("Antwort von: diesem Server (xenaxio)")).toBeTruthy();
    expect(screen.getByText(/vermutlich ein Tippfehler/)).toBeTruthy();
    expect(screen.getByText("DNS lookup failed: no MX record found.")).toBeTruthy();
  });

  it("asks again while a message is still on its way", async () => {
    vi.useFakeTimers();
    try {
      delivery
        .mockResolvedValueOnce({ recipients: [{ address: "lea@firma.de", state: "queued" }] })
        .mockResolvedValueOnce({ recipients: [{ address: "lea@firma.de", state: "delivered" }] });
      await act(async () => render(<DeliveryStatus emailId="m3" />));
      expect(screen.getByText("Wird zugestellt …")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(screen.getByText("Zugestellt")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(delivery).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows nothing when the platform knows no recipients", async () => {
    delivery.mockResolvedValue({ recipients: [] });
    const { container } = await act(async () => render(<DeliveryStatus emailId="m4" />));
    expect(container.textContent).toBe("");
  });
});
