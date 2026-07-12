import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import { Readable } from "node:stream";
import type { Config } from "../config.js";
import { captureUtterance } from "./capture.js";

interface TtsJob {
  pcm: Buffer;
  enqueuedAt: number;
}

export interface VoiceSessionHooks {
  /** このユーザーを翻訳対象にするか (韓国語話者リスト) */
  isTarget(userId: string): boolean;
  /** 1 発話分の 48kHz stereo PCM を受け取る */
  onUtterance(guildId: string, userId: string, pcm: Buffer): void;
  /** 接続が失われた・破棄された時に呼ばれる (セッション管理側の後始末用) */
  onClosed(guildId: string): void;
}

/** ギルド 1 つ分の VC 接続。音声受信と TTS 再生キューを持つ */
export class VoiceSession {
  readonly guildId: string;
  private readonly initialChannelId: string;
  private readonly connection: VoiceConnection;
  private readonly player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  private readonly capturing = new Set<string>();
  private readonly ttsQueue: TtsJob[] = [];
  private destroyed = false;

  constructor(
    channel: VoiceBasedChannel,
    private readonly cfg: Config,
    private readonly hooks: VoiceSessionHooks,
  ) {
    this.guildId = channel.guild.id;
    this.initialChannelId = channel.id;
    this.connection = joinVoiceChannel({
      guildId: channel.guild.id,
      channelId: channel.id,
      adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: false, // 受信するため必須
      selfMute: false,
    });
    this.connection.subscribe(this.player);
    this.player.on(AudioPlayerStatus.Idle, () => this.playNext());
    this.player.on("error", (e) => console.error("[tts] 再生エラー:", e.message));

    this.connection.receiver.speaking.on("start", (userId) => this.startCapture(userId));

    // 一時切断は少し待って再接続、無理なら破棄 (@discordjs/voice 推奨パターン)
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });
    this.connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.destroyed = true;
      this.hooks.onClosed(this.guildId);
    });
    this.connection.on("error", (e) => console.error("[voice] 接続エラー:", e.message));
  }

  /** 現在接続中の VC。bot が別チャンネルへ移動させられた場合も追従する */
  get channelId(): string {
    return this.connection.joinConfig.channelId ?? this.initialChannelId;
  }

  /** 接続完了まで待つ。失敗したら破棄して throw */
  async ready(): Promise<void> {
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (e) {
      this.destroy();
      throw new Error("VC への接続がタイムアウトしました", { cause: e });
    }
  }

  private startCapture(userId: string): void {
    if (this.destroyed || this.capturing.has(userId) || !this.hooks.isTarget(userId)) return;
    this.capturing.add(userId);
    captureUtterance(this.connection.receiver, userId, {
      silenceMs: this.cfg.silenceMs,
      maxUtteranceMs: this.cfg.maxUtteranceMs,
    })
      .then((u) => {
        if (!this.destroyed && u.pcm.length > 0) {
          this.hooks.onUtterance(this.guildId, userId, u.pcm);
        }
      })
      .catch((e) => console.error(`[voice] キャプチャ失敗 (user=${userId}):`, e?.message ?? e))
      .finally(() => {
        this.capturing.delete(userId);
        // 上限で区切った後もまだ話し続けている場合は続きを拾う
        if (!this.destroyed && this.connection.receiver.speaking.users.has(userId)) {
          this.startCapture(userId);
        }
      });
  }

  /** 合成済み PCM (48kHz stereo s16le) を再生キューへ */
  enqueueTts(pcm: Buffer): void {
    if (this.destroyed) return;
    this.ttsQueue.push({ pcm, enqueuedAt: Date.now() });
    if (this.player.state.status === AudioPlayerStatus.Idle) this.playNext();
  }

  private playNext(): void {
    if (this.destroyed) return;
    let job = this.ttsQueue.shift();
    // 滞留しすぎた読み上げはスキップ (字幕は投稿済みなので情報は失われない)
    while (job && Date.now() - job.enqueuedAt > this.cfg.ttsMaxQueueAgeMs) {
      console.warn("[tts] キュー滞留のため読み上げを 1 件スキップしました");
      job = this.ttsQueue.shift();
    }
    if (!job) return;
    this.player.play(createAudioResource(Readable.from(job.pcm), { inputType: StreamType.Raw }));
  }

  get queueLength(): number {
    return this.ttsQueue.length;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.connection.destroy();
    } catch {
      /* already destroyed */
    }
    this.hooks.onClosed(this.guildId);
  }
}
