import { describe, expect, it } from "vitest";
import { escapeDiscord, hasHangul, isUsableTranscript } from "../src/util/filter.js";

describe("hasHangul", () => {
  it("ハングルを検出する", () => {
    expect(hasHangul("안녕하세요")).toBe(true);
    expect(hasHangul("hello 안녕")).toBe(true);
    expect(hasHangul("こんにちは")).toBe(false);
    expect(hasHangul("hello world")).toBe(false);
  });
});

describe("isUsableTranscript", () => {
  it("通常の韓国語発話は通す", () => {
    expect(isUsableTranscript("오늘 게임 진짜 재밌었어")).toBe(true);
    expect(isUsableTranscript("내일 몇 시에 할까?")).toBe(true);
  });

  it("実会話で使う短い返事は通す (네 / 감사합니다)", () => {
    expect(isUsableTranscript("네.")).toBe(true);
    expect(isUsableTranscript("감사합니다.")).toBe(true);
  });

  it("空・非ハングルは破棄する", () => {
    expect(isUsableTranscript("")).toBe(false);
    expect(isUsableTranscript("   ")).toBe(false);
    expect(isUsableTranscript("...")).toBe(false);
    expect(isUsableTranscript("Thank you for watching")).toBe(false);
  });

  it("Whisper の定型ハルシネーションを破棄する", () => {
    expect(isUsableTranscript("시청해주셔서 감사합니다")).toBe(false);
    expect(isUsableTranscript("구독과 좋아요 부탁드립니다")).toBe(false);
    expect(isUsableTranscript("MBC 뉴스 김철수입니다")).toBe(false);
  });

  it("定型句を含む長い実発話は通す", () => {
    expect(
      isUsableTranscript("어제 방송 보다가 시청자가 감사하다고 해서 기분이 좋았어 진짜로"),
    ).toBe(true);
  });
});

describe("escapeDiscord", () => {
  it("markdown 記号をエスケープする", () => {
    expect(escapeDiscord("*bold* _it_ `code` |sp| ~~s~~")).toBe(
      "\\*bold\\* \\_it\\_ \\`code\\` \\|sp\\| \\~\\~s\\~\\~",
    );
  });
});
