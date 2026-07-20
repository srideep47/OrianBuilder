import { describe, expect, it } from "vitest";
import { isOrionSessionAppId } from "./orion_session";

describe("isOrionSessionAppId", () => {
  it("only matches the durable workspace id saved in settings", () => {
    expect(isOrionSessionAppId(95, { orionSessionAppId: 95 })).toBe(true);
    expect(isOrionSessionAppId(96, { orionSessionAppId: 95 })).toBe(false);
    expect(isOrionSessionAppId(95, {})).toBe(false);
  });
});
