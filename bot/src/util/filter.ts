const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏]/;

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
  /^음[.…\s]*$/, // フィラー単体 ("うーん")
  // 注意: "네" (はい) や "감사합니다" (ありがとう) 単体は実会話でも使われるため
  // ここには入れない。ノイズ由来のものは RMS ゲートと連続重複除去が弾く。
];

export function hasHangul(text: string): boolean {
  return HANGUL_RE.test(text);
}

/** STT 結果として採用してよいか。false なら破棄 */
export function isUsableTranscript(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (!hasHangul(t)) return false; // 韓国語話者の発話なのにハングル無し = 誤認識か雑音
  if (t.length <= 30 && HALLUCINATION_RES.some((re) => re.test(t))) return false;
  return true;
}

/** Discord メッセージに埋め込む際の markdown 崩れを防ぐ */
export function escapeDiscord(text: string): string {
  return text.replace(/[\\`*_~|]/g, "\\$&");
}
