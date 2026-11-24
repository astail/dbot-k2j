import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore, setSpeakerLang, speakerLang, type GuildSettings } from "../src/store.js";

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

  it("旧形式 (jaUserIds なし) の設定は全員韓国語話者として読める", () => {
    const g: GuildSettings = { userIds: ["a"] };
    expect(speakerLang(g, "a")).toBe("ko");
    expect(speakerLang(g, "b")).toBeNull();
  });
});

describe("setSpeakerLang", () => {
  it("言語を切り替えるともう片方のリストから外れる", () => {
    const g: GuildSettings = { userIds: [] };
    expect(setSpeakerLang(g, "a", "ko")).toBe(true);
    expect(setSpeakerLang(g, "a", "ko")).toBe(false);
    expect(setSpeakerLang(g, "a", "ja")).toBe(true);
    expect(g).toEqual({ userIds: [], jaUserIds: ["a"] });
    expect(speakerLang(g, "a")).toBe("ja");
    expect(setSpeakerLang(g, "a", null)).toBe(true);
    expect(g).toEqual({ userIds: [] });
    expect(setSpeakerLang(g, "a", null)).toBe(false);
  });
});
