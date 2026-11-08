import { describe, expect, it } from "vitest";
import { taskDueDayKey } from "@/lib/calendar-tasks";
import { noticeHref } from "@/lib/xenaxio/notifications";
import { isProjectTask, projectTaskOf, toCalendarTask } from "@/lib/xenaxio/project-calendar";
import type { MyTask } from "@/lib/xenaxio/projects";

// Step 124 E: project tasks as a layer of the calendar; C: links of notices.
const mine: MyTask = {
  id: "t1",
  objectId: "p1",
  columnId: "c1",
  number: 7,
  ref: "P-12-7",
  title: "Hotel buchen",
  assignee: null,
  dueOn: "2026-11-20",
  priority: "high",
  labels: [],
  done: false,
  doneAt: null,
  hasDescription: false,
  comments: 0,
  checklist: { done: 0, total: 0 },
  attachments: 0,
  updatedAt: "2026-11-07T10:00:00Z",
  object: { id: "p1", ref: "P-12", title: "Messe" },
  column: "Offen",
};

describe("project tasks in the calendar", () => {
  it("become all-day tasks on their due day, with the reference in the title", () => {
    const c = toCalendarTask(mine);
    expect(taskDueDayKey(c)).toBe("2026-11-20");
    expect(c).toMatchObject({ title: "P-12-7 · Hotel buchen", showWithoutTime: true, progress: "needs-action", priority: 1 });
    expect(isProjectTask(c)).toBe(true);
    expect(projectTaskOf(c)).toEqual({ objectId: "p1", taskId: "t1" });
    expect(isProjectTask({ id: "jmap-1" })).toBe(false);
  });

  it("notice links open as client paths", () => {
    expect(noticeHref("/projects/?id=p1&task=t1")).toBe("/projects?id=p1&task=t1");
    expect(noticeHref("/objects/?type=vehicle&id=o1&task=t1")).toBe("/objects?type=vehicle&id=o1&task=t1");
  });
});
