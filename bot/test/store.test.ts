import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../src/store.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("保存した設定を再読み込みできる", () => {
    dir = mkdtempSync(join(tmpdir(), "k2j-store-"));
    const store = new SettingsStore(dir);
    const g = store.guild("guild-1");
    g.userIds.push("user-a", "user-b");
    g.tts = false;
    g.subtitleChannelId = "ch-1";
    store.save();

    const reloaded = new SettingsStore(dir);
    expect(reloaded.guild("guild-1")).toEqual({
      userIds: ["user-a", "user-b"],
      tts: false,
      subtitleChannelId: "ch-1",
    });
    // 未知のギルドは空設定を返す
    expect(reloaded.guild("guild-2")).toEqual({ userIds: [] });
  });
});
