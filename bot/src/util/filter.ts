const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏]/;

/**
 * 翻訳しても会話の情報量が増えない、単独の相槌・フィラー・笑い声。
 * 句読点で区切られた複数の相槌も、全要素がこの条件を満たす場合だけ破棄する。
 */
const BACKCHANNEL_WORDS = new Set([
  "아하",
  "와",
  "우와",
  "헐",
  "그래",
  "그래요",
  "맞아",
  "맞아요",
  "맞습니다",
  "그렇지",
  "그렇죠",
  "그렇습니다",
  "그러게",
  "그러게요",
  "그러네요",
  "알겠어",
  "알겠어요",
  "알겠습니다",
  "알았어",
  "알았어요",
  "알았습니다",
  "오케이",
]);
const BACKCHANNEL_SOUND_RE =
  /^(?:아+|어+|(?:으+|흐+)?음+|흠+|응+|네+에*|예+에*|넵+|넹+|옙+|오+|[\u110f\u1112]+|하하+)$/;
const BACKCHANNEL_SEPARATOR_RE = /[\s.,!?…~。！？、，"'“”‘’()[\]{}<>:;·]+/u;

/** テキスト全体が相槌などの短い反応だけなら true */
export function isBackchannel(text: string): boolean {
  const parts = text
    .normalize("NFKC")
    .toLowerCase()
    .split(BACKCHANNEL_SEPARATOR_RE)
    .filter(Boolean);
  return (
    parts.length > 0 &&
    parts.every((part) => BACKCHANNEL_WORDS.has(part) || BACKCHANNEL_SOUND_RE.test(part))
  );
}

/**
 * Whisper が無音や環境音から生成しがちな定型句 (韓国語 YouTube 字幕由来の
 * ハルシネーション)。短いテキストがこれらに一致したら破棄する。
 */
const HALLUCINATION_RES: RegExp[] = [
  /시청.{0,6}감사/, // ご視聴ありがとうございます
  /구독.{0,6}(좋아요|부탁)/, // チャンネル登録・高評価
  /(MBC|KBS|SBS)\s*뉴스/,
  /다음\s*(영상|시간)에\s*만나/,
  /자막\s*(제공|by)/i,
];

export function hasHangul(text: string): boolean {
  return HANGUL_RE.test(text);
}

/** STT 結果として採用してよいか。false なら破棄 */
export function isUsableTranscript(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (!hasHangul(t)) return false; // 韓国語話者の発話なのにハングル無し = 誤認識か雑音
  if (isBackchannel(t)) return false;
  if (t.length <= 30 && HALLUCINATION_RES.some((re) => re.test(t))) return false;
  return true;
}

/** Discord メッセージに埋め込む際の markdown 崩れを防ぐ */
export function escapeDiscord(text: string): string {
  return text.replace(/[\\`*_~|]/g, "\\$&");
}
