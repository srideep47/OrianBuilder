import { describe, it, expect } from "vitest";
import {
  markFactoryBuildChat,
  isFactoryBuildChat,
  clearFactoryBuildChat,
} from "./factory_build_registry";

describe("factory_build_registry", () => {
  it("marks, reports, and clears factory build chats", () => {
    expect(isFactoryBuildChat(4242)).toBe(false);
    markFactoryBuildChat(4242);
    expect(isFactoryBuildChat(4242)).toBe(true);
    // unrelated chats are unaffected
    expect(isFactoryBuildChat(4243)).toBe(false);
    clearFactoryBuildChat(4242);
    expect(isFactoryBuildChat(4242)).toBe(false);
  });
});
