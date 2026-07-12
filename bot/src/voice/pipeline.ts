import type { Config } from "../config.js";
import type { Translator } from "../mt/index.js";
import type { SttClient } from "../stt/openaiCompat.js";
import type { VoicevoxClient } from "../tts/voicevox.js";
import { isUsableTranscript } from "../util/filter.js";
import { pcm48kStereoToWav16kMono, pcmRms } from "./wav.js";

/** パイプラインが外界 (Discord) へ出力するためのフック。index.ts が実装する */
export interface PipelineOutput {
  postSubtitle(guildId: string, userId: string, ko: string, ja: string): Promise<void>;
  playTts(guildId: string, pcm: Buffer): void;
  ttsEnabled(guildId: string): boolean;
  notifyError(guildId: string, message: string): void;
}

export interface PipelineStats {
  processed: number;
  dropped: number;
  errors: number;
  lastLatencyMs: number | null;
}

/**
 * 発話 PCM → STT → フィルタ → 翻訳 → 字幕/TTS の一連の流れ。
 * ユーザー毎に処理順序を保証しつつ、STT はグローバルに同時実行数を制限する。
 */
export class Pipeline {
  private readonly stats = new Map<string, PipelineStats>();
  private readonly userChains = new Map<string, Promise<void>>();
  private readonly lastText = new Map<string, { text: string; at: number }>();
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly cfg: Config,
    private readonly stt: SttClient,
    private readonly mt: Translator,
    private readonly tts: VoicevoxClient,
    private readonly out: PipelineOutput,
  ) {}

  private statsOf(guildId: string): PipelineStats {
    let s = this.stats.get(guildId);
    if (!s) {
      s = { processed: 0, dropped: 0, errors: 0, lastLatencyMs: null };
      this.stats.set(guildId, s);
    }
    return s;
  }

  /** VoiceSession から発話を受け取るエントリポイント */
  handleUtterance(guildId: string, userId: string, pcm: Buffer): void {
    const durationMs = (pcm.length / 4 / 48_000) * 1000;
    if (durationMs < this.cfg.minUtteranceMs || pcmRms(pcm) < this.cfg.rmsThreshold) {
      this.statsOf(guildId).dropped++;
      return;
    }
    const key = `${guildId}:${userId}`;
    const prev = this.userChains.get(key) ?? Promise.resolve();
    const next = prev.then(() =>
      this.process(guildId, userId, pcm).catch((e: unknown) => {
        this.statsOf(guildId).errors++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[pipeline]", msg);
        this.out.notifyError(guildId, `翻訳処理に失敗しました: ${msg.slice(0, 200)}`);
      }),
    );
    this.userChains.set(key, next);
  }

  private async process(guildId: string, userId: string, pcm: Buffer): Promise<void> {
    const started = Date.now();
    const stats = this.statsOf(guildId);
    const wav = pcm48kStereoToWav16kMono(pcm);

    const ko = await this.withSttSlot(() => this.stt.transcribe(wav));
    if (!isUsableTranscript(ko)) {
      stats.dropped++;
      return;
    }
    // 同一テキストの短時間連続 (ハルシネーションの典型パターン) は破棄
    const last = this.lastText.get(userId);
    const now = Date.now();
    if (last && last.text === ko && now - last.at < 5_000) {
      stats.dropped++;
      return;
    }
    this.lastText.set(userId, { text: ko, at: now });

    const ja = (await this.mt.translate(ko)).trim();
    if (!ja) {
      stats.dropped++;
      return;
    }

    // 字幕と読み上げは独立に処理する: 片方の失敗がもう片方を止めない。
    // 並列に走らせることで発話→読み上げの体感遅延も短縮する。
    const subtitlePosted = this.out.postSubtitle(guildId, userId, ko, ja).catch((e: unknown) => {
      console.error("[subtitle]", e instanceof Error ? e.message : e);
    });
    if (this.out.ttsEnabled(guildId)) {
      // 極端に長い訳文は VOICEVOX の URL 長制限と再生キューを守るため切り詰める (字幕は全文)
      const ttsText =
        ja.length > this.cfg.ttsMaxChars ? `${ja.slice(0, this.cfg.ttsMaxChars)}。以下省略` : ja;
      try {
        this.out.playTts(guildId, await this.tts.synthesize(ttsText));
      } catch (e) {
        console.error("[tts]", e instanceof Error ? e.message : e);
      }
    }
    await subtitlePosted;
    stats.processed++;
    stats.lastLatencyMs = Date.now() - started;
  }

  /** STT の同時実行数を制限する簡易セマフォ */
  private async withSttSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.cfg.sttConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  statsFor(guildId: string): Readonly<PipelineStats> {
    return this.statsOf(guildId);
  }
}
