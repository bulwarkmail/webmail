import { describe, expect, it } from "vitest";
import { attachedFileLink, chatFileProblem, MAX_CHAT_FILE_BYTES, MAX_CHAT_IMAGE_BYTES, pastedName } from "../assistant";

describe("files in the assistant chat (step 33)", () => {
  it("refuses files the platform would not take, and pictures the model could not see", () => {
    expect(chatFileProblem({ size: 1000, type: "application/pdf" })).toBeNull();
    expect(chatFileProblem({ size: MAX_CHAT_FILE_BYTES + 1, type: "application/pdf" })).toBe("attach_too_large");
    expect(chatFileProblem({ size: MAX_CHAT_IMAGE_BYTES, type: "image/png" })).toBeNull();
    expect(chatFileProblem({ size: MAX_CHAT_IMAGE_BYTES + 1, type: "image/jpeg" })).toBe("attach_image_too_large");
    // Not a picture for the model (HEIC): only the general limit applies.
    expect(chatFileProblem({ size: MAX_CHAT_IMAGE_BYTES + 1, type: "image/heic" })).toBeNull();
  });

  it("names a pasted screenshot by date and type", () => {
    const at = new Date(2026, 9, 25, 14, 3);
    expect(pastedName("Bild", "image/png", at)).toBe("Bild 2026-10-25 14-03.png");
    expect(pastedName("Image", "image/jpeg", at)).toBe("Image 2026-10-25 14-03.jpg");
  });

  it("links own files to their folder in Files, never shared or deleted ones", () => {
    const file = { id: "f1", name: "Bild 1.png", type: "image/png", size: 5, path: "/KI-Chat/Bild 1.png" };
    expect(attachedFileLink(file)).toBe("/files/KI-Chat?preview=Bild%201.png");
    expect(attachedFileLink({ ...file, path: "/Notiz.txt", name: "Notiz.txt" })).toBe("/files?preview=Notiz.txt");
    expect(attachedFileLink({ ...file, deleted: true })).toBeNull();
    expect(attachedFileLink({ ...file, id: "acc-anna:f1" })).toBeNull();
    expect(attachedFileLink({ id: "f2", name: "x.txt", type: "text/plain", size: 1 })).toBeNull();
  });
});
