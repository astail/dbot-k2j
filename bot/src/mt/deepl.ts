import type { Config } from "../config.js";
import type { Translator } from "./index.js";

export class DeepLTranslator implements Translator {
  readonly name = "DeepL";
  private readonly base: string;

  constructor(private readonly cfg: Config) {
    // 無料プランのキーは ":fx" で終わる (DeepL の仕様) ので、エンドポイントを自動判別
    this.base = cfg.deeplApiKey.endsWith(":fx")
      ? "https://api-free.deepl.com/v2"
      : "https://api.deepl.com/v2";
  }

  async translate(koText: string): Promise<string> {
    const res = await fetch(`${this.base}/translate`, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${this.cfg.deeplApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: [koText], source_lang: "KO", target_lang: "JA" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`DeepL ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { translations: { text: string }[] };
    return json.translations[0]?.text ?? "";
  }

  async usage(): Promise<string | null> {
    try {
      const res = await fetch(`${this.base}/usage`, {
        headers: { Authorization: `DeepL-Auth-Key ${this.cfg.deeplApiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { character_count: number; character_limit: number };
      return `DeepL 使用量: ${j.character_count.toLocaleString()} / ${j.character_limit.toLocaleString()} 文字`;
    } catch {
      return null;
    }
  }
}
