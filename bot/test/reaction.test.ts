import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emojiLang, formatTranslation, truncateChars } from "../src/text/reactionTranslate.js";
import { TranslationIndex } from "../src/text/translationIndex.js";
import { guessLang, needsChatTranslation } from "../src/util/filter.js";

const EMOJIS = { ko: ["🇰🇷", "kr_flag"], ja: ["🇯🇵", "123456789"] };

describe("emojiLang", () => {
  it("Unicode 絵文字・カスタム絵文字の名前/ID から翻訳先を判定する", () => {
    expect(emojiLang({ id: null, name: "🇰🇷" }, EMOJIS)).toBe("ko");
    expect(emojiLang({ id: null, name: "🇯🇵" }, EMOJIS)).toBe("ja");
    expect(emojiLang({ id: "999", name: "kr_flag" }, EMOJIS)).toBe("ko");
    expect(emojiLang({ id: "123456789", name: "jp" }, EMOJIS)).toBe("ja");
    expect(emojiLang({ id: null, name: "👍" }, EMOJIS)).toBeNull();
  });
});

describe("needsChatTranslation", () => {
  it("既に翻訳先の言語なら翻訳しない", () => {
    expect(guessLang("안녕하세요")).toBe("ko");
    expect(guessLang("こんにちは")).toBe("ja");
    expect(needsChatTranslation("안녕하세요", "ko")).toBe(false);
    expect(needsChatTranslation("안녕하세요", "ja")).toBe(true);
    expect(needsChatTranslation("こんにちは", "ja")).toBe(false);
    expect(needsChatTranslation("こんにちは", "ko")).toBe(true);
    // 漢字のみは判別不能なので翻訳する
    expect(needsChatTranslation("了解", "ko")).toBe(true);
  });

  it("URL・メンション・カスタム絵文字だけのメッセージは翻訳しない", () => {
    expect(needsChatTranslation("https://example.com/abc", "ko")).toBe(false);
    expect(needsChatTranslation("<@123456> <:pepe:98765>", "ja")).toBe(false);
    expect(needsChatTranslation("😂😂", "ja")).toBe(false);
    expect(needsChatTranslation("<@123456> 고마워", "ja")).toBe(true);
  });
});

describe("formatTranslation", () => {
  it("訳文に言語表示を付け、2000 文字以内に収める", () => {
    expect(formatTranslation("ありがとう", "ja")).toBe("ありがとう\n-# 🇯🇵 日本語訳");
    const long = formatTranslation("가".repeat(3000), "ko");
    expect(long.length).toBeLessThanOrEqual(2000);
    expect(long.endsWith("…\n-# 🇰🇷 韓国語訳")).toBe(true);
    expect(formatTranslation("x", "ja", true)).toBe("x\n-# 🇯🇵 日本語訳 (先頭のみ)");
  });

  it("絵文字 (サロゲートペア) の途中で切らない", () => {
    const out = formatTranslation("😀".repeat(1500), "ja");
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(truncateChars("😀😀😀", 2)).toEqual({ text: "😀😀", truncated: true });
    expect(truncateChars("abc", 5)).toEqual({ text: "abc", truncated: false });
  });
});

describe("TranslationIndex", () => {
  it("元メッセージごとに言語別の翻訳を保持・削除できる", () => {
    const idx = new TranslationIndex(":memory:");
    idx.set("m1", "ko", { translationId: "t1", sourceText: "a" });
    idx.set("m1", "ja", { translationId: "t2", sourceText: "a" });
    expect(idx.get("m1", "ko")?.translationId).toBe("t1");
    expect(idx.remove("m1", "ko")?.translationId).toBe("t1");
    expect(idx.get("m1", "ko")).toBeUndefined();
    expect(idx.removeAll("m1").map((e) => e.translationId)).toEqual(["t2"]);
    expect(idx.size).toBe(0);
  });

  it("翻訳メッセージが消されたら対応を忘れる (再リアクションで再投稿できる)", () => {
    const idx = new TranslationIndex(":memory:");
    idx.set("m1", "ko", { translationId: "t1", sourceText: "a" });
    idx.forgetTranslation("t1");
    expect(idx.get("m1", "ko")).toBeUndefined();
    idx.forgetTranslation("unknown"); // 無関係な ID は無視
  });

  it("上限を超えたら古い元メッセージから忘れる", () => {
    const idx = new TranslationIndex(":memory:", 2);
    idx.set("m1", "ko", { translationId: "t1", sourceText: "a" });
    idx.set("m2", "ko", { translationId: "t2", sourceText: "a" });
    idx.set("m3", "ko", { translationId: "t3", sourceText: "a" });
    expect(idx.size).toBe(2);
    expect(idx.get("m1", "ko")).toBeUndefined();
    expect(idx.get("m3", "ko")?.translationId).toBe("t3");
    // 忘れた翻訳の逆引きも消えている
    idx.forgetTranslation("t1");
    expect(idx.size).toBe(2);
  });

  it("編集で翻訳元の本文を差し替えられる", () => {
    const idx = new TranslationIndex(":memory:");
    idx.set("m1", "ja", { translationId: "t1", sourceText: "before" });
    idx.updateSource("m1", "ja", "after");
    expect(idx.get("m1", "ja")).toEqual({ translationId: "t1", sourceText: "after" });
  });

  it("同じ本文の訳文をキャッシュから取り出せる", () => {
    const idx = new TranslationIndex(":memory:");
    idx.cacheTranslation("m1", "ko", "こんにちは", "안녕하세요");
    expect(idx.cachedTranslation("m1", "ko", "こんにちは")).toBe("안녕하세요");
    expect(idx.cachedTranslation("m1", "ko", "こんばんは")).toBeUndefined();
    expect(idx.cachedTranslation("m1", "ja", "こんにちは")).toBeUndefined();
  });

  it("再起動 (開き直し) 後も対応が残っている", () => {
    const dir = mkdtempSync(join(tmpdir(), "k2j-index-"));
    try {
      const path = join(dir, "sub", "translations.db");
      const idx = new TranslationIndex(path);
      idx.set("m1", "ko", { translationId: "t1", sourceText: "こんにちは" });
      idx.set("m1", "ja", { translationId: "t2", sourceText: "こんにちは" });
      idx.close();

      const reopened = new TranslationIndex(path);
      expect(reopened.entries("m1")).toEqual([
        ["ja", { translationId: "t2", sourceText: "こんにちは" }],
        ["ko", { translationId: "t1", sourceText: "こんにちは" }],
      ]);
      expect(reopened.removeAll("m1").map((e) => e.translationId).sort()).toEqual(["t1", "t2"]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
