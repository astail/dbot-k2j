import { describe, expect, it } from "vitest";
import {
  escapeDiscord,
  hasHangul,
  isBackchannel,
  isUsableTranscript,
} from "../src/util/filter.js";

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

  it("内容のある短い返事は通す", () => {
    expect(isUsableTranscript("감사합니다.")).toBe(true);
    expect(isUsableTranscript("아니요.")).toBe(true);
    expect(isUsableTranscript("몰라.")).toBe(true);
  });

  it("笑い声以外のハングル字母略語は通す", () => {
    expect(isUsableTranscript("ㄴㄴ")).toBe(true);
    expect(isUsableTranscript("ㅈㅅ")).toBe(true);
    expect(isUsableTranscript("ㄱㄱ")).toBe(true);
  });

  it("相槌だけの発話は破棄する", () => {
    for (const text of [
      "네.",
      "응",
      "으음...",
      "흐음...",
      "아하!",
      "그래",
      "맞아.",
      "그렇지",
      "오케이~",
      "우와!",
      "ㅋㅋㅋ",
      "네, 네",
      "아... 네.",
    ]) {
      expect(isUsableTranscript(text), text).toBe(false);
    }
  });

  it("丁寧形や頻出表記の相槌も破棄する", () => {
    for (const text of [
      "그래요",
      "맞아요",
      "맞습니다",
      "그렇죠",
      "그렇습니다",
      "그러게요",
      "그러네요",
      "알겠습니다",
      "알았습니다",
      "넵",
      "넹",
      "옙",
      "넵넵",
    ]) {
      expect(isUsableTranscript(text), text).toBe(false);
    }
  });

  it("相槌から始まっても内容が続けば通す", () => {
    expect(isUsableTranscript("네, 오늘 갈게요.")).toBe(true);
    expect(isUsableTranscript("맞아, 그 게임 재미있었어.")).toBe(true);
    expect(isUsableTranscript("아예 안 갈래.")).toBe(true);
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

describe("isBackchannel", () => {
  it("Unicode と句読点を正規化して判定する", () => {
    expect(isBackchannel("　네！ 네～ ")).toBe(true);
    expect(isBackchannel("오케이, 알겠어요")).toBe(true);
    expect(isBackchannel("")).toBe(false);
    expect(isBackchannel("네 오늘 갈게요")).toBe(false);
  });
});

describe("escapeDiscord", () => {
  it("markdown 記号をエスケープする", () => {
    expect(escapeDiscord("*bold* _it_ `code` |sp| ~~s~~")).toBe(
      "\\*bold\\* \\_it\\_ \\`code\\` \\|sp\\| \\~\\~s\\~\\~",
    );
  });
});
