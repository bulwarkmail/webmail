import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Board } from "../projects/board";
import { linkHref } from "../projects/project-view";

vi.mock("next-intl", async (orig) => ({ ...(await orig<typeof import("next-intl")>()), useLocale: () => "en" }));

// Step 118, part C: the board lays out cards in their lanes (columns or statuses).
describe("projects board", () => {
  it("puts each card in its lane, counts them and says when a lane is empty", () => {
    render(
      <Board
        label="Board"
        lanes={[
          { id: "todo", title: "To do" },
          { id: "doing", title: "In progress" },
          { id: "done", title: "Done", done: true },
        ]}
        items={[
          { id: "t1", laneId: "todo" },
          { id: "t2", laneId: "todo" },
          { id: "t3", laneId: "done" },
        ]}
        render={(id) => <span>card {id}</span>}
        onMove={() => undefined}
        emptyText="No tasks"
      />,
    );
    const todo = screen.getByRole("region", { name: "To do" });
    expect(within(todo).getByText("card t1")).toBeTruthy();
    expect(within(todo).getByText("card t2")).toBeTruthy();
    expect(within(todo).getByText("2")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "In progress" })).getByText("No tasks")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Done" })).getByText("card t3")).toBeTruthy();
  });

  it("opens linked emails, files, channels and projects in the app", () => {
    expect(linkHref({ kind: "email", ref: "M1", account: "acc" })).toBe("/mail/message/M1?account=acc");
    expect(linkHref({ kind: "file", ref: "F1", account: "fa" })).toBe("/files?node=F1&account=fa");
    expect(linkHref({ kind: "channel", ref: "!r:acme.de", account: null })).toBe("/chat?room=!r%3Aacme.de");
    expect(linkHref({ kind: "object", ref: "p2", account: null })).toBe("/projects?id=p2");
  });
});
