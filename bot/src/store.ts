import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GuildSettings {
  /** 韓国語話者として指定されたユーザー ID */
  userIds: string[];
  /** 字幕の投稿先。省略時は参加中 VC のテキストチャット */
  subtitleChannelId?: string;
  /** ギルド毎の読み上げ ON/OFF。省略時は env の TTS_ENABLED */
  tts?: boolean;
}

interface StoreFile {
  guilds: Record<string, GuildSettings>;
}

/** ギルド毎設定の JSON 永続化。書き込みは tmp ファイル経由の atomic rename */
export class SettingsStore {
  private readonly path: string;
  private readonly tmpPath: string;
  private data: StoreFile = { guilds: {} };

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "settings.json");
    this.tmpPath = `${this.path}.tmp`;
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, "utf8")) as StoreFile;
        this.data.guilds ??= {};
      } catch (e) {
        // 破損ファイルで起動不能 (再起動ループ) にならないよう、退避して空設定で続行する
        const backup = `${this.path}.corrupt-${Date.now()}`;
        renameSync(this.path, backup);
        this.data = { guilds: {} };
        console.error(
          `[store] settings.json が壊れているため ${backup} に退避し、空の設定で起動します:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  guild(guildId: string): GuildSettings {
    return (this.data.guilds[guildId] ??= { userIds: [] });
  }

  save(): void {
    writeFileSync(this.tmpPath, JSON.stringify(this.data, null, 2));
    renameSync(this.tmpPath, this.path);
  }
}
