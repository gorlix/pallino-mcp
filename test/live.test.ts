import { describe, expect, it } from "vitest";
import { PallinoClient } from "../src/client.js";

const key = process.env.PALLINO_LIVE_KEY;

describe.skipIf(!key)("live Pallino (read-only)", () => {
  it("list_spaces returns an array", async () => {
    const r = await new PallinoClient(key, process.env.PALLINO_BASE_URL).request<unknown>("GET", "v1/agent/spaces");
    expect(Array.isArray((r as { spaces?: unknown }).spaces)).toBe(true);
  });
});
