import { describe, expect, it } from "vitest";
import { mailtoComposerDraft } from "../mailto-draft";

const base = { to: ["bob@example.com"], cc: [], bcc: ["x@example.com"], subject: "Hi", body: "Line 1\nLine 2" };

describe("mailtoComposerDraft", () => {
  it("keeps a mailto: request as before: plain body, format from the setting", () => {
    const plain = mailtoComposerDraft(base, true);
    expect(plain).toEqual(expect.objectContaining({
      to: "bob@example.com", bcc: "x@example.com", showBcc: true, subject: "Hi", body: "Line 1\nLine 2", mode: "compose",
    }));
    expect(plain).not.toHaveProperty("plainTextMode");
    expect(plain).not.toHaveProperty("attachments");
    expect(mailtoComposerDraft(base, false).body).not.toBe(base.body);
  });

  it("opens a plugin's HTML body in HTML mode, even with plain text on", () => {
    const draft = mailtoComposerDraft({ ...base, htmlBody: "<p>Hello <b>you</b></p>" }, true);
    expect(draft.body).toBe("<p>Hello <b>you</b></p>");
    expect(draft.plainTextMode).toBe(false);
  });

  it("carries the link's parameters for plugins, and none when it had none", () => {
    const linkParams = { "x-akte-case": "01/2026" };
    expect(mailtoComposerDraft({ ...base, linkParams }, false).linkParams).toEqual(linkParams);
    expect(mailtoComposerDraft(base, false)).not.toHaveProperty("linkParams");
  });

  it("carries a plugin's uploaded attachments", () => {
    const attachments = [{ blobId: "b1", name: "a.pdf", type: "application/pdf", size: 10 }];
    expect(mailtoComposerDraft({ ...base, attachments }, false).attachments).toEqual(attachments);
  });
});
