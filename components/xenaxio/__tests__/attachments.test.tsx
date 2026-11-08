import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Step 127 A, 124 B: files of a record or a task.
const api = vi.hoisted(() => ({ files: vi.fn(), deleteFile: vi.fn() }));
const upload = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xenaxio/projects", async (orig) => {
  const real = await orig<typeof import("@/lib/xenaxio/projects")>();
  return { ...real, projectsApi: { ...real.projectsApi, ...api }, uploadObjectFile: upload };
});
vi.mock("@/components/ui/confirm-dialog", () => ({ ConfirmDialog: () => null }));
vi.mock("next-intl", async (orig) => ({ ...(await orig<typeof import("next-intl")>()), useLocale: () => "en" }));

import { Attachments, fileSize } from "../projects/attachments";

const file = (id: string, name: string, type: string, del = false) => ({ id, taskId: null, name, type, size: 2048, createdBy: { id: "u1", name: "Anna" }, createdAt: "2026-11-08T10:00:00Z", can: { delete: del } });

describe("attachments", () => {
  it("lists files with a preview for pictures; PDFs open, others download; delete only where allowed", async () => {
    api.files.mockResolvedValue({ files: [file("f1", "Foto.jpg", "image/jpeg"), file("f2", "Vertrag.pdf", "application/pdf", true), file("f3", "Liste.xlsx", "application/vnd.ms-excel")] });
    const { container } = render(<Attachments objectId="o1" canEdit />);
    expect(await screen.findByText("Vertrag.pdf")).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toContain("/api/objects/o1/files/f1?inline=1");
    expect(screen.getByText("Vertrag.pdf").closest("a")?.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("Liste.xlsx").closest("a")?.getAttribute("download")).toBe("Liste.xlsx");
    expect(screen.getAllByRole("button", { name: /Delete file/ })).toHaveLength(1);
  });

  it("uploads chosen files to the task and reads the list again", async () => {
    api.files.mockResolvedValue({ files: [] });
    upload.mockResolvedValue(file("f9", "Plan.txt", "text/plain"));
    const onChanged = vi.fn();
    render(<Attachments objectId="o1" taskId="t1" canEdit onChanged={onChanged} />);
    const input = (await screen.findByLabelText("Add files")) as HTMLInputElement;
    const plan = new File(["Halle 3"], "Plan.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [plan] } });
    await waitFor(() => expect(upload).toHaveBeenCalledWith("o1", plan, "t1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.files).toHaveBeenLastCalledWith("o1", "t1");
  });

  it("shows nothing to people who cannot change the record when there are no files", async () => {
    api.files.mockResolvedValue({ files: [] });
    const { container } = render(<Attachments objectId="o2" canEdit={false} />);
    await waitFor(() => expect(api.files).toHaveBeenCalledWith("o2", undefined));
    expect(container.textContent).toBe("");
    expect(fileSize(1536, "en")).toBe("1.5 KB");
  });
});
