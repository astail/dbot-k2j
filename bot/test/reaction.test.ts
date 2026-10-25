import { describe, expect, it } from "vitest";
import { emojiLang, formatTranslation } from "../src/text/reactionTranslate.js";
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
  });
});

describe("TranslationIndex", () => {
  it("元メッセージごとに言語別の翻訳を保持・削除できる", () => {
    const idx = new TranslationIndex();
    idx.set("m1", "ko", { translationId: "t1", sourceText: "a" });
    idx.set("m1", "ja", { translationId: "t2", sourceText: "a" });
    expect(idx.get("m1", "ko")?.translationId).toBe("t1");
    expect(idx.remove("m1", "ko")?.translationId).toBe("t1");
    expect(idx.get("m1", "ko")).toBeUndefined();
    expect(idx.removeAll("m1").map((e) => e.translationId)).toEqual(["t2"]);
    expect(idx.size).toBe(0);
  });

  it("翻訳メッセージが消されたら対応を忘れる (再リアクションで再投稿できる)", () => {
    const idx = new TranslationIndex();
    idx.set("m1", "ko", { translationId: "t1", sourceText: "a" });
    idx.forgetTranslation("t1");
    expect(idx.get("m1", "ko")).toBeUndefined();
    idx.forgetTranslation("unknown"); // 無関係な ID は無視
  });

  it("上限を超えたら古い元メッセージから忘れる", () => {
    const idx = new TranslationIndex(2);
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
});
