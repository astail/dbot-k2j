import type { Config } from "../config.js";

type TranscribeAttempt = { ok: true; text: string } | { ok: false; status: number; body: string };

/**
 * OpenAI 互換 STT クライアント。
 * ローカル (speaches) も OpenAI API も同じ /v1/audio/transcriptions なので、
 * STT_BASE_URL / STT_API_KEY / STT_MODEL の差し替えだけで切り替わる。
 */
export class SttClient {
  private installing: Promise<void> | null = null;

  constructor(private readonly cfg: Config) {}

  async transcribe(wav: Buffer): Promise<string> {
    const first = await this.request(wav);
    if (first.ok) return first.text;
    // speaches はモデルを自動ダウンロードしない仕様のため、未インストールなら入れてリトライ
    // (OpenAI はこのメッセージを返さないので、ローカル利用時のみ発動する)
    if (first.status === 404 && first.body.includes("not installed")) {
      await this.installModel();
      const retry = await this.request(wav);
      if (retry.ok) return retry.text;
      throw new Error(`STT ${retry.status}: ${retry.body}`);
    }
    throw new Error(`STT ${first.status}: ${first.body}`);
  }

  private async request(wav: Buffer): Promise<TranscribeAttempt> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("model", this.cfg.sttModel);
    if (this.cfg.sttLanguage && this.cfg.sttLanguage !== "auto") {
      form.append("language", this.cfg.sttLanguage);
    }
    form.append("response_format", "json");

    const res = await fetch(`${this.cfg.sttBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, body: (await res.text()).slice(0, 300) };
    }
    const json = (await res.json()) as { text?: string };
    return { ok: true, text: (json.text ?? "").trim() };
  }

  /** speaches へのモデルインストール。並行発話で多重実行しないよう 1 本化する */
  private installModel(): Promise<void> {
    this.installing ??= (async () => {
      try {
        console.log(`[stt] モデル ${this.cfg.sttModel} をダウンロードしています...`);
        const res = await fetch(`${this.cfg.sttBaseUrl}/models/${this.cfg.sttModel}`, {
          method: "POST",
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(600_000),
        });
        const body = (await res.text()).slice(0, 300);
        if (!res.ok && !body.includes("already")) {
          throw new Error(`STT モデルのインストールに失敗 (${res.status}): ${body}`);
        }
        console.log(`[stt] モデルの準備が完了しました: ${body}`);
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }

  /** /k2j join 時の疎通確認 (ローカル STT の起動忘れをここで検出する) */
  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.sttBaseUrl}/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private authHeaders(): Record<string, string> {
    return this.cfg.sttApiKey ? { Authorization: `Bearer ${this.cfg.sttApiKey}` } : {};
  }
}
