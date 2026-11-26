import { describe, expect, it } from "vitest";
import { privateActor } from "./private-actor.js";

describe("privateActor", () => {
  it("returns the actor only in the user's own private chat", () => {
    expect(privateActor({ chat: { type: "private", id: 7 }, from: { id: 7 } })).toEqual({ telegramId: "7", chatId: "7" });
    expect(privateActor({ chat: { type: "private", id: 8 }, from: { id: 7 } })).toBeNull();
    expect(privateActor({ chat: { type: "group", id: -7 }, from: { id: 7 } })).toBeNull();
    expect(privateActor({ chat: { type: "private", id: 7 } })).toBeNull();
    expect(privateActor({})).toBeNull();
  });
});
