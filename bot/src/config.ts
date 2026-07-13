export interface Config {
  discordToken: string;
  mtProvider: "deepl" | "anthropic";
  deeplApiKey: string;
  anthropicApiKey: string;
  anthropicModel: string;
  sttBaseUrl: string;
  sttApiKey: string;
  sttModel: string;
  /** "ko" 固定運用を推奨。"auto" で Whisper の言語自動判定 */
  sttLanguage: string;
  /** グローバル既定。ギルド毎の /k2j tts 設定が優先される */
  ttsEnabled: boolean;
  voicevoxUrl: string;
  voicevoxSpeaker: number;
  /** 読み上げに回す訳文の最大文字数 (超過分は切り詰め。字幕は全文) */
  ttsMaxChars: number;
  /** 字幕メッセージを自動削除するまでの時間(ms)。0 で削除しない */
  subtitleTtlMs: number;
  dataDir: string;
  rmsThreshold: number;
  silenceMs: number;
  minUtteranceMs: number;
  maxUtteranceMs: number;
  sttConcurrency: number;
  ttsMaxQueueAgeMs: number;
}

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function numEnv(name: string, fallback: number, min = 0): number {
  const raw = env(name);
  if (raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) {
    throw new Error(`${name} の値が不正です: ${raw}`);
  }
  return v;
}

export function loadConfig(): Config {
  const discordToken = env("DISCORD_TOKEN");
  if (!discordToken) {
    throw new Error("DISCORD_TOKEN が設定されていません (.env を確認してください)");
  }
  const mtProvider = env("MT_PROVIDER", "deepl");
  if (mtProvider !== "deepl" && mtProvider !== "anthropic") {
    throw new Error(`MT_PROVIDER は deepl か anthropic を指定してください (現在: ${mtProvider})`);
  }
  const cfg: Config = {
    discordToken,
    mtProvider,
    deeplApiKey: env("DEEPL_API_KEY"),
    anthropicApiKey: env("ANTHROPIC_API_KEY"),
    anthropicModel: env("ANTHROPIC_MODEL", "claude-haiku-4-5"),
    sttBaseUrl: env("STT_BASE_URL", "http://stt:8000/v1").replace(/\/+$/, ""),
    sttApiKey: env("STT_API_KEY"),
    sttModel: env("STT_MODEL", "Systran/faster-whisper-small"),
    sttLanguage: env("STT_LANGUAGE", "ko"),
    ttsEnabled: env("TTS_ENABLED", "true").toLowerCase() !== "false",
    voicevoxUrl: env("VOICEVOX_URL", "http://voicevox:50021").replace(/\/+$/, ""),
    voicevoxSpeaker: numEnv("VOICEVOX_SPEAKER", 3),
    ttsMaxChars: numEnv("TTS_MAX_CHARS", 300, 1),
    subtitleTtlMs: numEnv("SUBTITLE_TTL_MS", 30_000),
    dataDir: env("DATA_DIR", "/data"),
    rmsThreshold: numEnv("RMS_THRESHOLD", 250),
    silenceMs: numEnv("SILENCE_MS", 800, 100),
    minUtteranceMs: numEnv("MIN_UTTERANCE_MS", 400),
    maxUtteranceMs: numEnv("MAX_UTTERANCE_MS", 30_000, 1_000),
    sttConcurrency: numEnv("STT_CONCURRENCY", 2, 1),
    ttsMaxQueueAgeMs: numEnv("TTS_MAX_QUEUE_AGE_MS", 15_000, 1_000),
  };
  if (cfg.mtProvider === "deepl" && !cfg.deeplApiKey) {
    throw new Error("MT_PROVIDER=deepl ですが DEEPL_API_KEY が未設定です");
  }
  if (cfg.mtProvider === "anthropic" && !cfg.anthropicApiKey) {
    throw new Error("MT_PROVIDER=anthropic ですが ANTHROPIC_API_KEY が未設定です");
  }
  return cfg;
}
