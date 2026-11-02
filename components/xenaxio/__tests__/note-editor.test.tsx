import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileResource } from "@/stores/file-store";
import { NoteEditor } from "../notes/note-editor";

// The file store as the editor uses it: through getState(), with a client
// whose save answers what the test says.
const store = vi.hoisted(() => ({
  content: "",
  answer: { blobId: "b2" } as { blobId: string } | "conflict" | "gone",
  saves: [] as { id: string; text: string; expected: string | null }[],
  uploads: [] as string[],
  resources: [] as { name: string; blobId: string | null; isDirectory: boolean }[],
}));

vi.mock("@/components/xenaxio/chat/code.css", () => ({}));
vi.mock("next-intl", () => ({ useLocale: () => "de", useTranslations: () => (key: string) => key }));
vi.mock("@/stores/toast-store", () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock("@/stores/file-store", () => ({
  useFileStore: {
    getState: () => ({
      resources: store.resources,
      getFileContent: async () => ({ blob: new Blob([store.content]), contentType: "text/markdown" }),
      refresh: async () => {},
      uploadFile: async (file: File) => {
        store.uploads.push(file.name);
        store.resources = [...store.resources, { name: file.name, blobId: "c1", isDirectory: false }];
      },
      client: {
        replaceFileNodeContent: async (id: string, file: File, expected: string | null) => {
          store.saves.push({ id, text: await file.text(), expected });
          return store.answer;
        },
      },
    }),
  },
}));

const note = (over: Partial<FileResource> = {}): FileResource => ({
  id: "n1", name: "Plan.md", serverName: "Plan.md", isDirectory: false, contentType: "text/markdown",
  contentLength: 10, lastModified: "", blobId: "b1", parentId: null, ...over,
});

function setup(over: Partial<FileResource> = {}) {
  const onClose = vi.fn();
  const onOpenOther = vi.fn();
  const resource = note(over);
  store.resources = [{ name: resource.name, blobId: resource.blobId, isDirectory: false }];
  render(<NoteEditor resource={resource} onClose={onClose} onOpenOther={onOpenOther} />);
  return { onClose, onOpenOther };
}

const type = (text: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
const ctrlS = () => fireEvent.keyDown(window, { key: "s", ctrlKey: true });

describe("NoteEditor (step 115)", () => {
  beforeEach(() => {
    store.content = "";
    store.answer = { blobId: "b2" };
    store.saves = [];
    store.uploads = [];
  });

  it("opens a note with text as it reads, and an empty one for writing", async () => {
    store.content = "# Plan\n\n- [ ] Angebot";
    setup();
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Ansicht" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Bearbeiten" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("# Plan\n\n- [ ] Angebot");
  });

  it("saves on Ctrl+S with the version it opened, then with the new one", async () => {
    setup();
    await screen.findByRole("textbox");
    type("Hallo");
    ctrlS();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Gespeichert"));
    expect(store.saves).toEqual([{ id: "n1", text: "Hallo", expected: "b1" }]);
    type("Hallo Welt");
    ctrlS();
    await waitFor(() => expect(store.saves).toHaveLength(2));
    expect(store.saves[1]).toEqual({ id: "n1", text: "Hallo Welt", expected: "b2" });
  });

  it("saves by itself after a pause in typing", async () => {
    setup();
    await screen.findByRole("textbox");
    type("Notiz");
    expect(screen.getByRole("status").textContent).toBe("Ungespeicherte Änderungen");
    await waitFor(() => expect(store.saves).toHaveLength(1), { timeout: 3500 });
    expect(store.saves[0].text).toBe("Notiz");
  });

  it("never overwrites a colleague's version: the text goes into a copy", async () => {
    setup();
    await screen.findByRole("textbox");
    store.answer = "conflict";
    type("meine Fassung");
    ctrlS();
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Die Datei wurde inzwischen geändert")).toBeTruthy();
    // Ending the dialog does not bring it back by itself: only a save does.
    fireEvent.click(screen.getByRole("button", { name: "Weiter bearbeiten" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    ctrlS();
    await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Als Kopie speichern" }));
    });
    expect(store.uploads).toEqual(["Plan (Kopie).md"]);
  });

  it("closing saves first", async () => {
    const { onClose } = setup();
    await screen.findByRole("textbox");
    type("zu");
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(store.saves.map((s) => s.text)).toEqual(["zu"]);
  });

  it("closing after a failed save asks before dropping the text", async () => {
    const { onClose } = setup();
    await screen.findByRole("textbox");
    store.answer = "gone";
    type("weg");
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(await screen.findByText("Die Datei gibt es nicht mehr")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("only shows a file the user may not change", async () => {
    store.content = "# Nur Ansicht";
    setup({ myRights: { mayRead: true, mayAddChildren: false, mayRename: false, mayDelete: false, mayModifyContent: false, mayShare: false } });
    expect(await screen.findByRole("heading", { name: "Nur Ansicht" })).toBeTruthy();
    expect(screen.getByText("Nur lesen")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Bearbeiten" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Speichern/ })).toBeNull();
    ctrlS();
    expect(store.saves).toEqual([]);
  });

  it("continues a list on Enter and formats with the buttons", async () => {
    setup();
    const area = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    type("- Milch");
    area.setSelectionRange(7, 7);
    fireEvent.keyDown(area, { key: "Enter" });
    expect(area.value).toBe("- Milch\n- ");
    type("Wort");
    area.setSelectionRange(0, 4);
    fireEvent.click(screen.getByRole("button", { name: "Fett (Strg+B)" }));
    expect(area.value).toBe("**Wort**");
  });

  it("a .txt file opens as text with clickable links, and is edited without Markdown tools", async () => {
    store.content = "# kein Titel\nInfos: https://xenaxio.com.";
    setup({ name: "liste.txt", contentType: "text/plain" });
    const link = await screen.findByRole("link", { name: "https://xenaxio.com" });
    expect(link.getAttribute("href")).toBe("https://xenaxio.com");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Bearbeiten" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("# kein Titel\nInfos: https://xenaxio.com.");
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("Tab indents in a code file instead of leaving the field", async () => {
    setup({ name: "deploy.yml", contentType: "text/plain" });
    const area = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    type("a:\nb");
    area.setSelectionRange(3, 3);
    fireEvent.keyDown(area, { key: "Tab" });
    expect(area.value).toBe("a:\n  b");
  });

  it("a CSV opens as a table, ';' separated as in Germany", async () => {
    store.content = "Name;Seite\nAnna;https://anna.example\n";
    setup({ name: "kontakte.csv", contentType: "text/csv" });
    expect(await screen.findByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Anna" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://anna.example" })).toBeTruthy();
  });

  it("a JSON opens formatted, and a broken one says the line", async () => {
    store.content = '{"a":1}';
    setup({ name: "config.json", contentType: "application/json" });
    await waitFor(() => expect(document.querySelector("pre")?.textContent).toBe('{\n  "a": 1\n}'));
  });

  it("a broken JSON says where", async () => {
    store.content = '{\n  "a": 1\n  "b": 2\n}';
    setup({ name: "config.json", contentType: "application/json" });
    expect((await screen.findByRole("alert")).textContent).toContain("Zeile 3");
  });

  it("an HTML file shows as a page in a locked frame", async () => {
    store.content = "<h1>Hallo</h1><script>alert(1)</script>";
    setup({ name: "seite.html", contentType: "text/html" });
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-popups allow-popups-to-escape-sandbox");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Hallo</h1>");
    expect(frame.getAttribute("srcdoc")).not.toContain("<script");
  });
});
