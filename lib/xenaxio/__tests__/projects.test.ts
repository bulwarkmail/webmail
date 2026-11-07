import { describe, expect, it } from "vitest";
import { dayText, filterTasks, isOverdue, localToday, projectHref, type TaskSummary } from "@/lib/xenaxio/projects";

// Step 118: helpers of the Projects section.
const task = (over: Partial<TaskSummary>): TaskSummary => ({
  id: "t",
  objectId: "p",
  columnId: "c1",
  title: "Task",
  assignee: null,
  dueOn: null,
  priority: null,
  labels: [],
  done: false,
  doneAt: null,
  hasDescription: false,
  comments: 0,
  updatedAt: "2026-11-07T10:00:00Z",
  ...over,
});

describe("projects helpers", () => {
  it("links a project and a task in the query (static export)", () => {
    expect(projectHref()).toBe("/projects");
    expect(projectHref("p1")).toBe("/projects?id=p1");
    expect(projectHref("p1", "t 2")).toBe("/projects?id=p1&task=t%202");
  });

  it("shows due days in the user's language and marks overdue open work", () => {
    expect(dayText("2026-11-20", "de")).toBe("20.11.2026");
    expect(dayText("2026-11-20", "en")).toBe("2026-11-20");
    expect(isOverdue("2026-11-06", false, "2026-11-07")).toBe(true);
    expect(isOverdue("2026-11-06", true, "2026-11-07")).toBe(false);
    expect(isOverdue("2026-11-07", false, "2026-11-07")).toBe(false);
    expect(localToday(new Date(2026, 10, 7, 23, 30))).toBe("2026-11-07");
  });

  it("filters tasks by assignee, due date, label and words", () => {
    const anna = { id: "u1", name: "Anna Schmidt", email: "anna@acme.de" };
    const list = [
      task({ id: "a", title: "Flyer drucken", assignee: anna, dueOn: "2026-11-05", labels: ["Messe"] }),
      task({ id: "b", title: "Stand buchen", dueOn: "2026-11-08" }),
      task({ id: "c", title: "Rechnung", dueOn: "2026-11-20", done: true }),
    ];
    const today = "2026-11-07"; // a Saturday: the week ends tomorrow
    const ids = (f: Parameters<typeof filterTasks>[1]) => filterTasks(list, f, today).map((t) => t.id);
    expect(ids({})).toEqual(["a", "b", "c"]);
    expect(ids({ assignee: "u1" })).toEqual(["a"]);
    expect(ids({ assignee: "none" })).toEqual(["b", "c"]);
    expect(ids({ due: "overdue" })).toEqual(["a"]);
    expect(ids({ due: "week" })).toEqual(["a", "b"]);
    expect(ids({ label: "Messe" })).toEqual(["a"]);
    expect(ids({ text: "anna flyer" })).toEqual(["a"]);
  });
});
