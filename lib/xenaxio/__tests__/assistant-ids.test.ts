import { describe, expect, it } from "vitest";
import { assistantIds, messageRouteId } from "../assistant";

describe("assistant ids (step 31)", () => {
  it("names mail of a shared mailbox with its account, own mail as it is", () => {
    expect(assistantIds({ id: "e1", threadId: "t1", mailboxIds: { a: true } })).toEqual({ emailId: "e1", threadId: "t1" });
    expect(assistantIds({ id: "e1", threadId: "t1", mailboxIds: { "f:a": true } })).toEqual({ emailId: "f:e1", threadId: "f:t1" });
    expect(assistantIds({ id: "e1", threadId: "t1" })).toEqual({ emailId: "e1", threadId: "t1" });
  });

  it("opens a cited email by the web client's own id", () => {
    expect(messageRouteId("f:e1")).toBe("e1");
    expect(messageRouteId("e1")).toBe("e1");
  });
});
