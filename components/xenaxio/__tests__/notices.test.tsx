import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Step 124 C: the platform's notifications in the bell; the task settings in the Notifications tab.
const push = vi.fn();
const api = vi.hoisted(() => ({ list: vi.fn(), count: vi.fn(), read: vi.fn(), prefs: vi.fn(), savePrefs: vi.fn() }));
vi.mock("@/lib/xenaxio/bff", async (orig) => ({ ...(await orig<typeof import("@/lib/xenaxio/bff")>()), XENAXIO_BFF: true }));
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/xenaxio/notifications", async (orig) => ({ ...(await orig<typeof import("@/lib/xenaxio/notifications")>()), notificationsApi: api }));
vi.mock("next-intl", async (orig) => ({ ...(await orig<typeof import("next-intl")>()), useLocale: () => "en", useFormatter: () => ({ relativeTime: () => "1 hour ago" }) }));

import { XenaxioNotices } from "../notices";
import { TaskNotifySettings } from "../task-notify-settings";

const notice = (id: string, read: boolean) => ({
  id,
  kind: "task_mention",
  actor: { id: "u2", name: "Max Braun" },
  title: "P-1-3 · Hotel",
  body: "@Anna bitte prüfen",
  link: "/projects/?id=p1&task=t3",
  objectId: "p1",
  taskId: "t3",
  read,
  createdAt: "2026-11-08T09:00:00Z",
});

describe("notifications in the bell", () => {
  it("lists them; a click marks one read and opens the task", async () => {
    api.list.mockResolvedValue({ notices: [notice("n1", false), notice("n2", true)], unread: 1 });
    api.read.mockResolvedValue({ marked: 1, unread: 0 });
    const onClose = vi.fn();
    render(<XenaxioNotices onClose={onClose} />);
    expect((await screen.findAllByText("P-1-3 · Hotel")).length).toBe(2);
    expect(screen.getAllByText(/Max Braun mentioned you/)).toHaveLength(2);
    fireEvent.click(screen.getAllByText("P-1-3 · Hotel")[0]!);
    await waitFor(() => expect(api.read).toHaveBeenCalledWith(["n1"]));
    expect(onClose).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/projects?id=p1&task=t3");
  });
});

describe("task notification settings", () => {
  it("shows the person's choice and saves a change", async () => {
    api.prefs.mockResolvedValue({ kinds: { task_assigned: "push", task_mention: "push", task_comment: "bell", task_done: "bell", task_due_changed: "bell", task_due: "push" }, assignEmail: true, dueEmail: false, calendarTasks: true });
    api.savePrefs.mockImplementation(async (c) => ({ kinds: { task_assigned: "push", task_mention: "push", task_comment: "off", task_done: "bell", task_due_changed: "bell", task_due: "push" }, assignEmail: true, dueEmail: false, calendarTasks: true, ...c }));
    render(<TaskNotifySettings />);
    expect(await screen.findByText("New comment on a task I watch")).toBeTruthy();
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[2]!, { target: { value: "off" } });
    await waitFor(() => expect(api.savePrefs).toHaveBeenCalledWith({ kinds: { task_comment: "off" } }));
  });
});
