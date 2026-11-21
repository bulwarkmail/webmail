import { describe, it, expect, vi } from "vitest";
import { render, screen, act, renderHook } from "@testing-library/react";
import { realAttachments, ListAttachmentChips, useListHasAttachment, attachmentIcon, listRowShowsChips } from "../attachment-chips";
import type { Attachment, Email } from "@/lib/jmap/types";
import type { LoadListAttachments } from "@/lib/list-attachments";

function att(over: Partial<Attachment>): Attachment {
  return { partId: "1", blobId: "b1", size: 100, type: "application/pdf", name: "doc.pdf", ...over };
}

describe("realAttachments", () => {
  it("returns nothing when the message has no attachments", () => {
    expect(realAttachments(undefined)).toEqual([]);
    expect(realAttachments([])).toEqual([]);
  });

  it("drops parts marked inline", () => {
    const kept = att({ name: "invoice.pdf" });
    const out = realAttachments([
      kept,
      att({ partId: "2", blobId: "b2", name: "image001.png", type: "image/png", disposition: "inline" }),
    ]);
    expect(out).toEqual([kept]);
  });

  it("drops parts referenced by Content-ID even without a disposition", () => {
    // Outlook signature images arrive as cid: references; six of them on one
    // message would otherwise fill the row with 180-byte spacers.
    const out = realAttachments([
      att({ partId: "2", blobId: "b2", name: "image001.png", type: "image/png", cid: "image001.png@01DD" }),
    ]);
    expect(out).toEqual([]);
  });

  it("drops parts with no filename, which cannot be labelled or saved", () => {
    expect(realAttachments([att({ name: undefined })])).toEqual([]);
  });

  it("drops the report part of a bounce, which the reader does not list either", () => {
    // A forwarded bounce: both parts named "attachment" by the forward, but
    // only the original message is something the reader shows.
    const original = att({ partId: "3", blobId: "b3", name: "attachment", type: "message/rfc822" });
    const out = realAttachments([
      att({ partId: "2", blobId: "b2", name: "attachment", type: "message/delivery-status" }),
      original,
      att({ partId: "4", blobId: "b4", name: "receipt", type: "Message/Disposition-Notification" }),
    ]);
    expect(out).toEqual([original]);
  });

  it("keeps genuine attachments in order", () => {
    const a = att({ partId: "1", blobId: "b1", name: "a.pdf" });
    const b = att({ partId: "2", blobId: "b2", name: "b.xlsx", type: "application/vnd.ms-excel" });
    expect(realAttachments([a, b])).toEqual([a, b]);
  });
});

// #1089: list requests no longer carry `attachments`; rows load their own.
describe("ListAttachmentChips", () => {
  const row = (over: Partial<Email>) => ({ id: "m1", hasAttachment: true, ...over }) as Email;

  it("uses attachments the email already carries without loading", () => {
    const load = vi.fn(() => () => {});
    render(<ListAttachmentChips email={row({ attachments: [att({ name: "have.pdf" })] })} load={load} onOpen={vi.fn()} />);
    expect(screen.getByTitle("have.pdf")).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
  });

  it("draws Gmail's pill with a filled type badge in Mountain View", () => {
    const attachments = [att({ name: "invoice.pdf" })];
    const { rerender } = render(<ListAttachmentChips email={row({ attachments })} onOpen={vi.fn()} variant="mountain-view" />);
    const chip = screen.getByTitle("invoice.pdf");
    expect(chip.className).toContain("rounded-full");
    expect(chip.querySelector(".bg-red-600 svg")).toBeTruthy();

    rerender(<ListAttachmentChips email={row({ attachments })} onOpen={vi.fn()} />);
    expect(screen.getByTitle("invoice.pdf").className).not.toContain("rounded-full");
    expect(screen.getByTitle("invoice.pdf").querySelector(".bg-red-600")).toBeNull();
  });

  it("does not load for a row without a paperclip", () => {
    const load = vi.fn(() => () => {});
    render(<ListAttachmentChips email={row({ hasAttachment: false })} load={load} onOpen={vi.fn()} />);
    expect(load).not.toHaveBeenCalled();
  });

  it("loads the parts of a row with a paperclip and shows them", () => {
    let deliver!: (a: Attachment[]) => void;
    const cancel = vi.fn();
    const load = vi.fn((_email: Email, onLoad: (a: Attachment[]) => void) => { deliver = onLoad; return cancel; });
    const { unmount } = render(<ListAttachmentChips email={row({})} load={load} onOpen={vi.fn()} />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button")).toBeNull();
    act(() => deliver([att({ name: "late.pdf" })]));
    expect(screen.getByTitle("late.pdf")).toBeTruthy();
    unmount();
    expect(cancel).toHaveBeenCalled();
  });

  // A virtualised list remounts rows as they scroll back in; one that grew a
  // frame after mounting made the list correct the scroll position mid-scroll.
  it("draws a cached answer in the first render", () => {
    const cached = [att({ name: "cached.pdf" })];
    let chipBeforeEffect: Element | null = null;
    const load: LoadListAttachments = Object.assign(
      (_email: Email, onLoad: (a: Attachment[]) => void) => {
        chipBeforeEffect = document.querySelector('[title="cached.pdf"]');
        onLoad(cached);
        return () => {};
      },
      { peek: () => cached },
    );
    render(<ListAttachmentChips email={row({})} load={load} onOpen={vi.fn()} />);
    expect(chipBeforeEffect).toBeTruthy();
    expect(screen.getByTitle("cached.pdf")).toBeTruthy();
  });

  it("drops a peeked answer the loader does not confirm", () => {
    const load: LoadListAttachments = Object.assign(vi.fn(() => () => {}), {
      peek: () => [att({ name: "other-account.pdf" })],
    });
    render(<ListAttachmentChips email={row({})} load={load} onOpen={vi.fn()} />);
    expect(screen.queryByTitle("other-account.pdf")).toBeNull();
  });

  it("holds the chip row's space while the parts load", () => {
    let deliver!: (a: Attachment[]) => void;
    const load = vi.fn((_email: Email, onLoad: (a: Attachment[]) => void) => { deliver = onLoad; return () => {}; });
    const { container } = render(<ListAttachmentChips email={row({})} load={load} onOpen={vi.fn()} className="mt-1.5" />);
    expect(container.querySelector('[aria-hidden="true"].mt-1\\.5')).toBeTruthy();
    act(() => deliver([att({ name: "image001.png", type: "image/png", disposition: "inline" })]));
    expect(container.firstChild).toBeNull();
  });

  it("does not show one message's parts on another", () => {
    let deliver!: (a: Attachment[]) => void;
    const load = vi.fn((_email: Email, onLoad: (a: Attachment[]) => void) => { deliver = onLoad; return () => {}; });
    const { rerender } = render(<ListAttachmentChips email={row({ id: "m1" })} load={load} onOpen={vi.fn()} />);
    act(() => deliver([att({ name: "first.pdf" })]));
    rerender(<ListAttachmentChips email={row({ id: "m2" })} load={load} onOpen={vi.fn()} />);
    expect(screen.queryByTitle("first.pdf")).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

// Stalwart flags a message whose only parts are inline images (a logo in a
// notification mail) with hasAttachment; the viewer then lists nothing.
describe("useListHasAttachment", () => {
  const row = (over: Partial<Email>) => ({ id: "m1", hasAttachment: true, ...over }) as Email;
  const deferred = () => {
    let deliver!: (a: Attachment[]) => void;
    const load = vi.fn((_email: Email, onLoad: (a: Attachment[]) => void) => { deliver = onLoad; return () => {}; });
    return { load, deliver: (a: Attachment[]) => deliver(a) };
  };

  it("trusts the server flag until the parts arrive", () => {
    const { load } = deferred();
    const { result } = renderHook(() => useListHasAttachment(row({}), load));
    expect(result.current).toBe(true);
  });

  it("drops the paperclip when every part is an inline image", () => {
    const { load, deliver } = deferred();
    const { result } = renderHook(() => useListHasAttachment(row({}), load));
    act(() => deliver([
      att({ name: "logo.png", type: "image/png", disposition: "inline", cid: "logo" }),
      att({ partId: "2", blobId: "b2", name: "github.png", type: "image/png", cid: "gh" }),
    ]));
    expect(result.current).toBe(false);
  });

  it("keeps the paperclip when a real attachment is among the parts", () => {
    const { load, deliver } = deferred();
    const { result } = renderHook(() => useListHasAttachment(row({}), load));
    act(() => deliver([
      att({ name: "logo.png", type: "image/png", disposition: "inline", cid: "logo" }),
      att({ partId: "2", blobId: "b2", name: "invoice.pdf" }),
    ]));
    expect(result.current).toBe(true);
  });

  it("uses parts the email already carries", () => {
    const load = vi.fn(() => () => {});
    const { result } = renderHook(() => useListHasAttachment(
      row({ attachments: [att({ name: "logo.png", type: "image/png", disposition: "inline" })] }), load,
    ));
    expect(result.current).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("shows nothing for a message the server did not flag", () => {
    const load = vi.fn(() => () => {});
    const { result } = renderHook(() => useListHasAttachment(row({ hasAttachment: false }), load));
    expect(result.current).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("attachmentIcon", () => {
  it("takes the type from the MIME type", () => {
    expect(attachmentIcon("application/tlsrpt+gzip", "report.json.gz").className).toContain("text-amber-600");
    expect(attachmentIcon("application/pdf", "scan").className).toContain("text-red-600");
  });

  it("falls back to the extension for octet-stream parts", () => {
    expect(attachmentIcon("application/octet-stream", "invoice.PDF").className).toContain("text-red-600");
    expect(attachmentIcon(undefined, "photos.zip").className).toContain("text-amber-600");
  });

  it("matches the extension only, not words inside the name", () => {
    // "startup" contains "tar" and "pdf-notes" contains "pdf".
    expect(attachmentIcon("application/octet-stream", "startup.docx").className).toContain("text-sky-600");
    expect(attachmentIcon("", "pdf-notes.bin").className).toBe("text-muted-foreground");
  });
});

describe("listRowShowsChips", () => {
  const email = { id: "e1", hasAttachment: true } as Email;
  const loader = (cached?: Attachment[]) => {
    const load = (() => () => {}) as LoadListAttachments;
    load.peek = () => cached;
    return load;
  };

  it("counts the room a row holds while its parts load", () => {
    expect(listRowShowsChips(email, loader(undefined))).toBe(true);
  });

  it("drops the chip row once the parts turn out to be inline images", () => {
    // The list guesses row heights by this; a chip row it no longer draws
    // made it guess the chip height from a row without one.
    const logo = att({ partId: "2", blobId: "b2", name: "logo.png", type: "image/png", disposition: "inline" });
    expect(listRowShowsChips(email, loader([logo]))).toBe(false);
  });

  it("keeps the chip row when the loaded parts include a real attachment", () => {
    expect(listRowShowsChips(email, loader([att({})]))).toBe(true);
  });
});
