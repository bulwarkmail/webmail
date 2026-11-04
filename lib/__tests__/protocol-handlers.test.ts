import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMailto } from "../protocol-handlers/mailto";
import { listenForMailtoRequests } from "../protocol-handlers/session";
import { parseWebcal } from "../protocol-handlers/webcal";

const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

function installServiceWorkerMock() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const worker = { postMessage: vi.fn() };
  const serviceWorker = {
    ready: Promise.resolve({ active: worker }),
    controller: worker,
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === "message") listeners.add(listener as (event: MessageEvent) => void);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === "message") listeners.delete(listener as (event: MessageEvent) => void);
    }),
  };

  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: serviceWorker,
  });

  return {
    dispatch(data: unknown) {
      listeners.forEach((listener) => listener(new MessageEvent("message", { data })));
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalServiceWorkerDescriptor) {
    Object.defineProperty(navigator, "serviceWorker", originalServiceWorkerDescriptor);
    return;
  }
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("protocol handlers", () => {
  describe("parseMailto", () => {
    it("parses a single path recipient", () => {
      expect(parseMailto("mailto:alice@example.com")).toEqual({
        to: ["alice@example.com"],
        cc: [],
        bcc: [],
        subject: "",
        body: "",
      });
    });

    it("parses multiple recipients with subject and body", () => {
      expect(parseMailto("mailto:alice@example.com,bob@example.com?subject=Hello&body=Hi")).toMatchObject({
        to: ["alice@example.com", "bob@example.com"],
        subject: "Hello",
        body: "Hi",
      });
    });

    it("parses to, cc, and bcc query recipients", () => {
      expect(parseMailto("mailto:?to=alice@example.com&cc=bob@example.com&bcc=eve@example.com")).toMatchObject({
        to: ["alice@example.com"],
        cc: ["bob@example.com"],
        bcc: ["eve@example.com"],
      });
    });

    it("decodes subject and body values", () => {
      expect(parseMailto("mailto:alice@example.com?subject=Hello%20World&body=line1%0Aline2")).toMatchObject({
        subject: "Hello World",
        body: "line1\nline2",
      });
    });

    it("preserves literal plus signs in query values", () => {
      expect(parseMailto("mailto:?to=user+tag@example.com&subject=C++&body=a+b")).toMatchObject({
        to: ["user+tag@example.com"],
        subject: "C++",
        body: "a+b",
      });
    });

    it("rejects non-mailto URLs", () => {
      expect(parseMailto("https://example.com")).toBeNull();
    });

    it("allows an empty mailto URL", () => {
      expect(parseMailto("mailto:")).toEqual({
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        body: "",
      });
    });

    it("keeps a link with a stray percent sign, decoding what can be decoded", () => {
      // Links written by hand or by older programs: Outlook and Thunderbird open these.
      expect(parseMailto("mailto:alice@example.com?subject=50% off&body=Caf%C3%A9 %ZZ %C3")).toMatchObject({
        to: ["alice@example.com"],
        subject: "50% off",
        body: "Café %ZZ �",
      });
      expect(parseMailto("mailto:bob%40example.com,100%@example.com")?.to).toEqual(["bob@example.com", "100%@example.com"]);
    });

    it("decodes UTF-8 and CRLF line breaks in every field", () => {
      expect(parseMailto("mailto:J%C3%BCrgen%20%3Cj%40example.com%3E?cc=a%40example.com,b%40example.com&subject=Gr%C3%BC%C3%9Fe%20%F0%9F%98%80&body=Zeile%201%0D%0AZeile%202%0D%0A%0D%0A%E2%82%AC%2610")).toEqual({
        to: ["Jürgen <j@example.com>"],
        cc: ["a@example.com", "b@example.com"],
        bcc: [],
        subject: "Grüße 😀",
        body: "Zeile 1\nZeile 2\n\n€&10",
      });
    });

    it("removes control characters and caps recipients", () => {
      const recipients = Array.from({ length: 250 }, (_, index) => `user${index}@example.com`).join(",");
      const parsed = parseMailto(`mailto:${recipients}?subject=Hi%0ABcc:evil@example.com`);
      expect(parsed?.to).toHaveLength(200);
      expect(parsed?.subject).toBe("HiBcc:evil@example.com");
    });
  });

  describe("parseWebcal", () => {
    it("normalizes webcal to https", () => {
      expect(parseWebcal("webcal://example.com/calendar.ics")?.subscriptionUrl).toBe("https://example.com/calendar.ics");
    });

    it("normalizes webcals to https", () => {
      expect(parseWebcal("webcals://example.com/calendar.ics")?.subscriptionUrl).toBe("https://example.com/calendar.ics");
    });

    it("accepts https URLs", () => {
      expect(parseWebcal("https://example.com/calendar.ics")?.subscriptionUrl).toBe("https://example.com/calendar.ics");
    });

    it("rejects unsupported protocols", () => {
      expect(parseWebcal("ftp://example.com/calendar.ics")).toBeNull();
    });

    it("suggests a name from the path", () => {
      expect(parseWebcal("webcal://example.com/team.ics")?.suggestedName).toBe("team");
    });

    it("falls back to hostname for suggested name", () => {
      expect(parseWebcal("webcal://example.com/")?.suggestedName).toBe("example.com");
    });

    it("prefers a name query parameter", () => {
      expect(parseWebcal("webcal://example.com/team.ics?name=Team%20Calendar")?.suggestedName).toBe("Team Calendar");
    });
  });

  describe("listenForMailtoRequests", () => {
    const mailtoValue = {
      to: ["alice@example.com"],
      cc: [],
      bcc: [],
      subject: "Hello",
      body: "Hi",
    };

    it("accepts legacy service-worker mailto messages without a client id", () => {
      const serviceWorker = installServiceWorkerMock();
      const onMailto = vi.fn();
      vi.spyOn(window, "focus").mockImplementation(() => undefined);

      const cleanup = listenForMailtoRequests(onMailto, () => ({ path: "/", standalone: false }));
      serviceWorker.dispatch({ type: "mailto-request", id: "legacy", value: mailtoValue });

      expect(onMailto).toHaveBeenCalledWith(mailtoValue);
      cleanup();
    });

    it("ignores service-worker mailto messages for another client", () => {
      const serviceWorker = installServiceWorkerMock();
      const onMailto = vi.fn();

      const cleanup = listenForMailtoRequests(onMailto, () => ({ path: "/", standalone: false }));
      serviceWorker.dispatch({ type: "mailto-request", id: "targeted", clientId: "other-client", value: mailtoValue });

      expect(onMailto).not.toHaveBeenCalled();
      cleanup();
    });
  });
});
