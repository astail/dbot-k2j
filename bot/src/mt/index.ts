import type { Config } from "../config.js";
import { AnthropicTranslator } from "./anthropic.js";
import { DeepLTranslator } from "./deepl.js";

export type Lang = "ko" | "ja";

export const LANG_NAMES: Record<Lang, string> = { ko: "韓国語", ja: "日本語" };

export interface TranslateOptions {
  from: Lang;
  to: Lang;
  /** voice: 音声認識結果 (認識ミスを含む) / chat: テキストチャットの発言 */
  source: "voice" | "chat";
}

/** 音声パイプラインの既定: 韓国語の発話を日本語へ */
export const VOICE_KO_JA: TranslateOptions = { from: "ko", to: "ja", source: "voice" };

export interface Translator {
  /** /k2j status に表示する名前 */
  readonly name: string;
  /** テキストを翻訳する (省略時は音声の韓国語→日本語) */
  translate(text: string, opts?: TranslateOptions): Promise<string>;
  /** 使用量情報 (DeepL の文字数など)。提供が無ければ null */
  usage(): Promise<string | null>;
}

export function createTranslator(cfg: Config): Translator {
  return cfg.mtProvider === "deepl" ? new DeepLTranslator(cfg) : new AnthropicTranslator(cfg);
}
