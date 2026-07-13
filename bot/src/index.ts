import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Guild,
  type SendableChannels,
  type VoiceBasedChannel,
} from "discord.js";
import { loadConfig } from "./config.js";
import { handleK2j, k2jCommand } from "./commands.js";
import type { BotContext } from "./context.js";
import { createTranslator } from "./mt/index.js";
import { SettingsStore } from "./store.js";
import { SttClient } from "./stt/openaiCompat.js";
import { VoicevoxClient } from "./tts/voicevox.js";
import { Pipeline, type PipelineOutput } from "./voice/pipeline.js";
import { VoiceSession } from "./voice/session.js";
import { escapeDiscord } from "./util/filter.js";

const cfg = loadConfig();
const store = new SettingsStore(cfg.dataDir);
const stt = new SttClient(cfg);
const mt = createTranslator(cfg);
const tts = new VoicevoxClient(cfg);
const sessions = new Map<string, VoiceSession>();

const client = new Client({
  // 音声のみ扱うので特権 Intent (Message Content 等) は不要
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

async function resolveSubtitleChannel(guildId: string): Promise<SendableChannels | null> {
  const channelId = store.guild(guildId).subtitleChannelId ?? sessions.get(guildId)?.channelId;
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel?.isSendable() ? channel : null;
}

async function displayName(guildId: string, userId: string): Promise<string> {
  const guild = client.guilds.cache.get(guildId);
  const member = await guild?.members.fetch(userId).catch(() => null);
  return member?.displayName ?? "不明なユーザー";
}

const lastErrorNotifiedAt = new Map<string, number>();

const output: PipelineOutput = {
  async postSubtitle(guildId, userId, ko, ja) {
    const channel = await resolveSubtitleChannel(guildId);
    if (!channel) return;
    const name = await displayName(guildId, userId);
    const message = await channel.send({
      content: `**${escapeDiscord(name)}**：${escapeDiscord(ja)}\n-# ${escapeDiscord(ko)}`,
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressNotifications,
    });
    // 一定時間後に字幕を自動削除してチャンネルを流し過ぎない (0 なら残す)
    if (cfg.subtitleTtlMs > 0) {
      setTimeout(() => {
        void message.delete().catch(() => {});
      }, cfg.subtitleTtlMs).unref?.();
    }
  },
  playTts(guildId, pcm) {
    sessions.get(guildId)?.enqueueTts(pcm);
  },
  ttsEnabled(guildId) {
    return store.guild(guildId).tts ?? cfg.ttsEnabled;
  },
  notifyError(guildId, message) {
    // 連続エラーで字幕チャンネルを埋めないよう 30 秒に 1 回まで
    const now = Date.now();
    if (now - (lastErrorNotifiedAt.get(guildId) ?? 0) < 30_000) return;
    lastErrorNotifiedAt.set(guildId, now);
    void resolveSubtitleChannel(guildId).then(async (ch) => {
      if (!ch) return;
      await ch.send({ content: `⚠ ${message}`, allowedMentions: { parse: [] } }).catch(() => {});
    });
  },
};

const pipeline = new Pipeline(cfg, stt, mt, tts, output);

async function joinChannel(channel: VoiceBasedChannel): Promise<VoiceSession> {
  sessions.get(channel.guild.id)?.destroy();
  const session = new VoiceSession(channel, cfg, {
    isTarget: (userId) => store.guild(channel.guild.id).userIds.includes(userId),
    onUtterance: (guildId, userId, pcm) => pipeline.handleUtterance(guildId, userId, pcm),
    onClosed: (guildId) => {
      if (sessions.get(guildId) === session) sessions.delete(guildId);
    },
  });
  sessions.set(channel.guild.id, session);
  await session.ready();
  console.log(`[voice] ${channel.guild.name} / ${channel.name} に接続しました`);
  return session;
}

const ctx: BotContext = { cfg, store, stt, mt, tts, pipeline, sessions, joinChannel };

async function registerCommands(guild: Guild): Promise<void> {
  try {
    await guild.commands.set([k2jCommand.toJSON()]);
  } catch (e) {
    console.error(`[cmd] ${guild.name} へのコマンド登録に失敗:`, e instanceof Error ? e.message : e);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`ログインしました: ${c.user.tag}`);
  console.log(
    `招待URL: https://discord.com/api/oauth2/authorize?client_id=${c.user.id}&permissions=3214336&scope=bot%20applications.commands`,
  );
  await Promise.all(c.guilds.cache.map((g) => registerCommands(g)));
  console.log(`/k2j コマンドを ${c.guilds.cache.size} サーバーに登録しました`);
});

client.on(Events.GuildCreate, (guild) => void registerCommands(guild));

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "k2j") return;
  try {
    await handleK2j(ctx, interaction);
  } catch (e) {
    console.error("[cmd]", e instanceof Error ? e.stack : e);
    const message = "エラーが発生しました。ログを確認してください。";
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message);
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
    } catch {
      /* interaction expired */
    }
  }
});

// VC が無人になったら即座に自動退出 (VC に居座って API を無駄にしない)
const emptyTimers = new Map<string, NodeJS.Timeout>();
client.on(Events.VoiceStateUpdate, (oldState) => {
  const guild = oldState.guild;
  const session = sessions.get(guild.id);
  if (!session) return;
  const channel = guild.channels.cache.get(session.channelId);
  if (!channel?.isVoiceBased()) return;
  const humans = channel.members.filter((m) => !m.user.bot).size;
  if (humans === 0) {
    if (emptyTimers.has(guild.id)) return;
    emptyTimers.set(
      guild.id,
      setTimeout(() => {
        emptyTimers.delete(guild.id);
        const s = sessions.get(guild.id);
        const ch = s && guild.channels.cache.get(s.channelId);
        if (s && ch?.isVoiceBased() && ch.members.filter((m) => !m.user.bot).size === 0) {
          console.log(`[voice] 無人になったため ${guild.name} の VC から退出します`);
          s.destroy();
        }
      }, 0),
    );
  } else {
    const timer = emptyTimers.get(guild.id);
    if (timer) {
      clearTimeout(timer);
      emptyTimers.delete(guild.id);
    }
  }
});

function shutdown(): void {
  console.log("シャットダウンします...");
  for (const s of [...sessions.values()]) s.destroy();
  store.save();
  void client.destroy().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// 24時間稼働のデーモンとしての安全網: 取りこぼした Promise 拒否は記録して継続、
// 例外は状態が不定なため記録して終了 (compose の restart ポリシーが再起動する)
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] 未処理の Promise 拒否:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] 未捕捉の例外:", err);
  process.exit(1);
});

client.login(cfg.discordToken).catch((e) => {
  console.error("Discord へのログインに失敗しました:", e instanceof Error ? e.message : e);
  process.exit(1);
});
