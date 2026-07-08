import { describe, it, expect } from "vitest";
import { localizeMailboxName } from "@/lib/mailbox-label";

// Stand-in translator mirroring the `sidebar.mailboxes` namespace.
const RU: Record<string, string> = {
  inbox: "Входящие",
  sent: "Отправленные",
  drafts: "Черновики",
  trash: "Корзина",
  archive: "Архив",
  spam: "Спам",
  important: "Важные",
  starred: "Помечённые",
  all_mail: "Вся почта",
};
const translate = (key: string) => RU[key] ?? `MISSING:${key}`;

describe("localizeMailboxName", () => {
  it("localizes special-use folders by JMAP role, ignoring the server name", () => {
    expect(localizeMailboxName("inbox", "Inbox", translate)).toBe("Входящие");
    expect(localizeMailboxName("sent", "Sent", translate)).toBe("Отправленные");
    expect(localizeMailboxName("drafts", "Drafts", translate)).toBe("Черновики");
    expect(localizeMailboxName("trash", "Deleted Items", translate)).toBe("Корзина");
    expect(localizeMailboxName("archive", "Archive", translate)).toBe("Архив");
    expect(localizeMailboxName("important", "Important", translate)).toBe("Важные");
  });

  it("maps junk/flagged/all onto reused translation keys", () => {
    expect(localizeMailboxName("junk", "Junk", translate)).toBe("Спам");
    expect(localizeMailboxName("flagged", "Flagged", translate)).toBe("Помечённые");
    expect(localizeMailboxName("all", "All Mail", translate)).toBe("Вся почта");
  });

  it("leaves user-created folders (no role) untouched", () => {
    expect(localizeMailboxName(undefined, "Projects", translate)).toBe("Projects");
    expect(localizeMailboxName(null, "Работа", translate)).toBe("Работа");
    expect(localizeMailboxName("", "Receipts", translate)).toBe("Receipts");
  });

  it("falls back to the server name for unknown roles", () => {
    expect(localizeMailboxName("subscribed", "Subscribed", translate)).toBe("Subscribed");
  });
});
