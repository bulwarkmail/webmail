import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Step 119: comments on a record (where its type has them).
const api = vi.hoisted(() => ({
  comments: vi.fn(),
  addComment: vi.fn(),
  editComment: vi.fn(),
  deleteComment: vi.fn(),
}));
vi.mock("@/lib/xenaxio/projects", async (orig) => {
  const real = await orig<typeof import("@/lib/xenaxio/projects")>();
  return { ...real, projectsApi: { ...real.projectsApi, ...api } };
});
vi.mock("next-intl", async (orig) => ({ ...(await orig<typeof import("next-intl")>()), useLocale: () => "en" }));

import { RecordComments } from "../projects/record-comments";

const c = (id: string, body: string, can = { edit: false, delete: false }) => ({ id, author: { id: "u2", name: "Max Weber", email: "max@acme.de" }, body, createdAt: "2026-11-07T10:00:00Z", editedAt: null, can });

describe("record comments", () => {
  it("lists comments, adds one, and offers edit and delete only where allowed", async () => {
    api.comments.mockResolvedValue({ comments: [c("1", "TÜV im März", { edit: true, delete: true }), c("2", "Ok")] });
    api.addComment.mockResolvedValue({ comments: [c("1", "TÜV im März", { edit: true, delete: true }), c("2", "Ok"), c("3", "Reifen neu")] });
    render(<RecordComments objectId="o1" archived={false} />);
    expect(await screen.findByText("TÜV im März")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /edit/i })).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Reifen neu" } });
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    await waitFor(() => expect(api.addComment).toHaveBeenCalledWith("o1", "Reifen neu"));
    expect(await screen.findByText("Reifen neu")).toBeTruthy();
  });

  it("shows no input on an archived record", async () => {
    api.comments.mockResolvedValue({ comments: [] });
    render(<RecordComments objectId="o2" archived />);
    await waitFor(() => expect(api.comments).toHaveBeenCalledWith("o2"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
