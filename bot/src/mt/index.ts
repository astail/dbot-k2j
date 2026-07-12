import type { Config } from "../config.js";
import { AnthropicTranslator } from "./anthropic.js";
import { DeepLTranslator } from "./deepl.js";

export interface Translator {
  /** /k2j status に表示する名前 */
  readonly name: string;
  /** 韓国語テキストを日本語に翻訳する */
  translate(koText: string): Promise<string>;
  /** 使用量情報 (DeepL の文字数など)。提供が無ければ null */
  usage(): Promise<string | null>;
}

export function createTranslator(cfg: Config): Translator {
  return cfg.mtProvider === "deepl" ? new DeepLTranslator(cfg) : new AnthropicTranslator(cfg);
}
