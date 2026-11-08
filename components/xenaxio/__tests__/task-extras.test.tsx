import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Step 124: the checklist (A), the history (F) and the comment field with @mentions (C).
vi.mock("next-intl", async (orig) => ({ ...(await orig<typeof import("next-intl")>()), useLocale: () => "en" }));

import { Checklist, CommentBody, History, MentionInput, mentionsIn } from "../projects/task-extras";

const people = [
  { id: "u1", name: "Anna Weber", email: "anna@acme.de" },
  { id: "u2", name: "Max Braun", email: "max@acme.de" },
];

describe("task checklist", () => {
  it("shows progress, ticks, removes, adds and turns an item into a task", async () => {
    const onSave = vi.fn();
    const onToTask = vi.fn();
    const items = [
      { id: "a", text: "Angebote", done: true },
      { id: "b", text: "Buchen", done: false },
    ];
    render(<Checklist items={items} canEdit onSave={onSave} onToTask={onToTask} />);
    expect(screen.getByText("1 of 2 done")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Buchen" }));
    expect(onSave).toHaveBeenLastCalledWith([items[0], { ...items[1], done: true }]);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove item" })[0]!);
    expect(onSave).toHaveBeenLastCalledWith([items[1]]);
    fireEvent.click(screen.getAllByRole("button", { name: "Make a task" })[1]!);
    expect(onToTask).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Checklist item" }), { target: { value: "Bestätigung" } });
    fireEvent.submit(screen.getByRole("textbox", { name: "Checklist item" }).closest("form")!);
    expect(onSave).toHaveBeenLastCalledWith([...items, { text: "Bestätigung", done: false }]);
  });

  it("is read-only without edit rights and hidden when empty", () => {
    const { container } = render(<Checklist items={[]} canEdit={false} onSave={vi.fn()} onToTask={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});

describe("task history", () => {
  it("names who changed what, newest first", () => {
    render(
      <History
        events={[
          { id: "1", author: people[0]!, field: "created", from: null, to: "Hotel", createdAt: "2026-11-07T10:00:00Z" },
          { id: "2", author: people[1]!, field: "done", from: "open", to: "done", createdAt: "2026-11-07T11:00:00Z" },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Max Braun changed the state: open → done");
    expect(items[1]!.textContent).toContain("Anna Weber created the task");
  });
});

describe("mentions", () => {
  it("keeps only the names still in the text", () => {
    expect(mentionsIn("@Anna Weber bitte prüfen", people)).toEqual(["u1"]);
    expect(mentionsIn("ohne Erwähnung", people)).toEqual([]);
  });

  it("offers people after @ and sends their ids", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(<MentionInput people={people} onSend={onSend} />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "Bitte @ma", selectionStart: 9 } });
    const option = await screen.findByRole("option", { name: /Max Braun/ });
    fireEvent.mouseDown(option.querySelector("button")!);
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("Bitte @Max Braun "));
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Bitte @Max Braun", ["u2"]));
  });

  it("stresses mentioned names in a comment", () => {
    const { container } = render(<CommentBody body="Danke @Anna Weber!" people={people} />);
    expect(container.querySelector("span")?.textContent).toBe("@Anna Weber");
  });
});
