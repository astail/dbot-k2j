const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏]/;
const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/;
/** 仮名または漢字 (日本語話者の STT 結果に含まれるべき文字) */
const JAPANESE_RE = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f\u3400-\u4dbf\u4e00-\u9fff]/;
/** カスタム絵文字・メンション・URL (翻訳対象の文字として数えない) */
const NON_TEXT_TOKEN_RE = /<a?:\w+:\d+>|<(?:[@#]|@!|@&)\d+>|https?:\/\/\S+/g;

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

/** 日本語の相槌 (カタカナはひらがなに寄せてから照合する) */
const JA_BACKCHANNEL_WORDS = new Set([
  "なるほど",
  "そうだね",
  "そうだよね",
  "そうですね",
  "そうそう",
  "そっか",
  "そうか",
  "そうなんだ",
  "たしかに",
  "確かに",
  "了解",
  "了解です",
  "りょうかい",
  "おっけー",
  "おけ",
  "わかった",
  "わかりました",
  "分かった",
  "分かりました",
  "いいね",
  "まじか",
  "まじで",
]);
const JA_BACKCHANNEL_SOUND_RE =
  /^(?:(?:はー?い)+|(?:う+ー*ん+)+|え+ー*|あ+ー*|お+ー*|へ+ー*|ふ+ー*ん|ほ+ー*|ん+ー*|(?:は|あ)(?:は|あ)+|w+|笑+)$/;

function katakanaToHiragana(text: string): string {
  return text.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** テキスト全体が相槌などの短い反応だけなら true */
export function isBackchannel(text: string, lang: "ko" | "ja" = "ko"): boolean {
  const normalized = text.normalize("NFKC").toLowerCase();
  const parts = (lang === "ja" ? katakanaToHiragana(normalized) : normalized)
    .split(BACKCHANNEL_SEPARATOR_RE)
    .filter(Boolean);
  const words = lang === "ja" ? JA_BACKCHANNEL_WORDS : BACKCHANNEL_WORDS;
  const sound = lang === "ja" ? JA_BACKCHANNEL_SOUND_RE : BACKCHANNEL_SOUND_RE;
  return parts.length > 0 && parts.every((part) => words.has(part) || sound.test(part));
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

/** 日本語 YouTube 字幕由来の定型ハルシネーション */
const JA_HALLUCINATION_RES: RegExp[] = [
  /ご視聴.{0,6}ありがとう/,
  /チャンネル登録/,
  /高評価/,
  /字幕.{0,4}(提供|作成|by)/i,
  /次回.{0,8}(お楽しみ|お会い)/,
];

export function hasHangul(text: string): boolean {
  return HANGUL_RE.test(text);
}

/**
 * 文字種から韓国語/日本語を推定する。ハングルのみ → ko、仮名のみ → ja、
 * 判別できない (両方含む・漢字のみ・英語など) 場合は null
 */
export function guessLang(text: string): "ko" | "ja" | null {
  const ko = HANGUL_RE.test(text);
  const ja = KANA_RE.test(text);
  if (ko === ja) return null;
  return ko ? "ko" : "ja";
}

/** チャット発言を target 言語へ翻訳する意味があるか (既に target 言語・文字なしなら false) */
export function needsChatTranslation(text: string, target: "ko" | "ja"): boolean {
  const body = text.replace(NON_TEXT_TOKEN_RE, "");
  if (!/\p{L}/u.test(body)) return false;
  return guessLang(body) !== target;
}

/** STT 結果として採用してよいか。lang は話者の言語。false なら破棄 */
export function isUsableTranscript(text: string, lang: "ko" | "ja" = "ko"): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // 話者の言語の文字が無い = 誤認識か雑音
  if (lang === "ko" ? !hasHangul(t) : !JAPANESE_RE.test(t)) return false;
  if (isBackchannel(t, lang)) return false;
  const hallucinations = lang === "ko" ? HALLUCINATION_RES : JA_HALLUCINATION_RES;
  if (t.length <= 30 && hallucinations.some((re) => re.test(t))) return false;
  return true;
}

/** Discord メッセージに埋め込む際の markdown 崩れを防ぐ */
export function escapeDiscord(text: string): string {
  return text.replace(/[\\`*_~|]/g, "\\$&");
}
