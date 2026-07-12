import type { VoiceBasedChannel } from "discord.js";
import type { Config } from "./config.js";
import type { Translator } from "./mt/index.js";
import type { SettingsStore } from "./store.js";
import type { SttClient } from "./stt/openaiCompat.js";
import type { VoicevoxClient } from "./tts/voicevox.js";
import type { Pipeline } from "./voice/pipeline.js";
import type { VoiceSession } from "./voice/session.js";

/** commands.ts と index.ts で共有する実行時コンテキスト */
export interface BotContext {
  cfg: Config;
  store: SettingsStore;
  stt: SttClient;
  mt: Translator;
  tts: VoicevoxClient;
  pipeline: Pipeline;
  /** guildId → 接続中セッション */
  sessions: Map<string, VoiceSession>;
  joinChannel(channel: VoiceBasedChannel): Promise<VoiceSession>;
}
