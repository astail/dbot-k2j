import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type { Translator } from "./index.js";

const SYSTEM_PROMPT = [
  "あなたは韓国語→日本語の同時通訳者です。",
  "入力は Discord ボイスチャットの発話を音声認識した韓国語テキストで、認識ミスや口語・ゲームスラングを含みます。",
  "文脈から自然に補い、日本語の話し言葉に翻訳してください。",
  "訳文のみを出力し、説明・注釈・引用符は一切付けないでください。",
].join("\n");

export class AnthropicTranslator implements Translator {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(cfg: Config) {
    // リアルタイム用途のため SDK 既定 (タイムアウト10分・リトライ2回) を短く上書きする
    this.client = new Anthropic({ apiKey: cfg.anthropicApiKey, timeout: 15_000, maxRetries: 1 });
    this.model = cfg.anthropicModel;
    this.name = `Claude (${cfg.anthropicModel})`;
  }

  async translate(koText: string): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: koText }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) {
      throw new Error(`Claude が訳文を返しませんでした (stop_reason: ${res.stop_reason})`);
    }
    return text;
  }

  async usage(): Promise<string | null> {
    return null;
  }
}
