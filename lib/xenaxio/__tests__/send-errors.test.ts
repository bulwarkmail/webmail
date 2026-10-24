import { describe, expect, it } from "vitest";
import { isForeignFromRefusal } from "../send-errors";

describe("isForeignFromRefusal", () => {
  it("recognises the server's refusal of a From address that is not the sender's", () => {
    expect(isForeignFromRefusal(new Error("Server rejected DATA: 550 5.7.1 The From address must be your own address (anna@firma.de)."))).toBe(true);
    expect(isForeignFromRefusal(new Error("Server rejected DATA: 550 5.7.1 Only one From address is allowed."))).toBe(true);
  });

  it("leaves other failures alone", () => {
    expect(isForeignFromRefusal(new Error("forbiddenToSend"))).toBe(false);
    expect(isForeignFromRefusal(new Error("550 5.7.1 Relaying denied"))).toBe(false);
    expect(isForeignFromRefusal("5.7.1 The From address must be your own address")).toBe(false);
  });
});
