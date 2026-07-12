import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { BotContext } from "./context.js";

export const k2jCommand = new SlashCommandBuilder()
  .setName("k2j")
  .setDescription("韓国語→日本語 音声翻訳ボットの操作")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s.setName("join").setDescription("あなたが参加中のボイスチャンネルに接続して翻訳を開始"),
  )
  .addSubcommand((s) => s.setName("leave").setDescription("ボイスチャンネルから切断"))
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("韓国語話者として指定 (要: サーバー管理権限)")
      .addUserOption((o) => o.setName("user").setDescription("対象ユーザー").setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("韓国語話者の指定を解除 (要: サーバー管理権限)")
      .addUserOption((o) => o.setName("user").setDescription("対象ユーザー").setRequired(true)),
  )
  .addSubcommand((s) => s.setName("list").setDescription("指定中の韓国語話者を表示"))
  .addSubcommand((s) =>
    s
      .setName("tts")
      .setDescription("日本語読み上げの ON/OFF (要: サーバー管理権限)")
      .addStringOption((o) =>
        o
          .setName("mode")
          .setDescription("on: 読み上げ+字幕 / off: 字幕のみ")
          .setRequired(true)
          .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("subtitle")
      .setDescription("字幕の投稿先を設定 (要: サーバー管理権限)")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("省略すると VC 内蔵のテキストチャットに戻す")
          .addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((s) => s.setName("status").setDescription("設定と稼働状況を表示"));

const ADMIN_SUBCOMMANDS = new Set(["add", "remove", "tts", "subtitle"]);

export async function handleK2j(
  ctx: BotContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "サーバー内でのみ使用できます。", flags: MessageFlags.Ephemeral });
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (
    ADMIN_SUBCOMMANDS.has(sub) &&
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.reply({
      content: "このコマンドにはサーバー管理権限が必要です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  switch (sub) {
    case "join":
      return join(ctx, interaction);
    case "leave":
      return leave(ctx, interaction);
    case "add":
      return addUser(ctx, interaction);
    case "remove":
      return removeUser(ctx, interaction);
    case "list":
      return listUsers(ctx, interaction);
    case "tts":
      return setTts(ctx, interaction);
    case "subtitle":
      return setSubtitle(ctx, interaction);
    case "status":
      return status(ctx, interaction);
  }
}

async function join(ctx: BotContext, i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await i.guild!.members.fetch(i.user.id);
  const channel = member.voice.channel;
  if (!channel) {
    await i.editReply("先にボイスチャンネルへ参加してから `/k2j join` を実行してください。");
    return;
  }
  if (!channel.joinable) {
    await i.editReply(`「${channel.name}」に接続する権限がありません。`);
    return;
  }
  if (!(await ctx.stt.healthy())) {
    await i.editReply(
      `音声認識サービスに接続できません (${ctx.cfg.sttBaseUrl})。\n` +
        "ローカル STT の場合: `.env` の `COMPOSE_PROFILES=local-stt` と stt コンテナの起動を確認してください。",
    );
    return;
  }
  const settings = ctx.store.guild(i.guildId!);
  const warnings: string[] = [];
  if ((settings.tts ?? ctx.cfg.ttsEnabled) && !(await ctx.tts.healthy())) {
    warnings.push("⚠ VOICEVOX に接続できないため読み上げは失敗する可能性があります (字幕は投稿されます)。");
  }
  if (settings.userIds.length === 0) {
    warnings.push("⚠ 韓国語話者が未指定です。`/k2j add` で指定するまで何も翻訳されません。");
  }
  await ctx.joinChannel(channel);
  await i.editReply(
    [
      `✅ 「${channel.name}」に接続しました。指定話者 ${settings.userIds.length} 名の韓国語を日本語に翻訳します。`,
      ...warnings,
    ].join("\n"),
  );
}

async function leave(ctx: BotContext, i: ChatInputCommandInteraction): Promise<void> {
  const session = ctx.sessions.get(i.guildId!);
  if (!session) {
    await i.reply({ content: "ボイスチャンネルに接続していません。", flags: MessageFlags.Ephemeral });
    return;
  }
  session.destroy();
  await i.reply({ content: "切断しました。", flags: MessageFlags.Ephemeral });
}

async function addUser(ctx: BotContext, i: ChatInputCommandInteraction): Promise<void> {
  const user = i.options.getUser("user", true);
  if (user.bot) {
    await i.reply({ content: "ボットは指定できません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const settings = ctx.store.guild(i.guildId!);
  if (!settings.userIds.includes(user.id)) {
    settings.userIds.push(user.id);
    ctx.store.save();
  }
  await i.reply({
    content: `${user} を韓国語話者として指定しました (現在 ${settings.userIds.length} 名)。`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function removeUser(ctx: BotContext, i: ChatInputCommandInteraction): Promise<void> {
  const user = i.options.getUser("user", true);
  const settings = ctx.store.guild(i.guildId!);
  const before = settings.userIds.length;
  settings.userIds = settings.userIds.filter((id) => id !== user.id);
  if (settings.userIds.length !== before) ctx.store.save();
  await i.reply({
    content:
      settings.userIds.length !== before
        ? `${user} の指定を解除しました (現在 ${settings.userIds.length} 名)。`
        : `${user} は指定されていません。`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function listUsers(ctx: BotContext, i: ChatInputCommandInteraction): Promise<void> {
  const { userIds } = ctx.store.guild(i.guildId!);
  await i.reply({
    content:
      userIds.length === 0
        ? "韓国語話者は指定されていません。`/k2j add` で指定してください。"
        : `指定中の韓国語話者 (${userIds.length} 名):\n${userIds.map((id) => `- <@${id}>`).join("\n")}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function setTts(ctx: BotContext, i: ChatInputCommandInteraction): Promise<void> {
  const on = i.options.getString("mode", true) === "on";
  ctx.store.guild(i.guildId!).tts = on;
  ctx.store.save();
  await i.reply({
    content: on ? "読み上げを ON にしました (字幕+音声)。" : "読み上げを OFF にしました (字幕のみ)。",
    flags: MessageFlags.Ephemeral,
  });
}

async function setSubtitle(ctx: BotContext, i: ChatInputCommandInteraction): Promise<void> {
  const channel = i.options.getChannel("channel");
  const settings = ctx.store.guild(i.guildId!);
  if (channel) {
    settings.subtitleChannelId = channel.id;
  } else {
    delete settings.subtitleChannelId;
  }
  ctx.store.save();
  await i.reply({
    content: channel
      ? `字幕の投稿先を <#${channel.id}> に設定しました。`
      : "字幕の投稿先を VC 内蔵のテキストチャットに戻しました。",
    flags: MessageFlags.Ephemeral,
  });
}

async function status(ctx: BotContext, i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = ctx.store.guild(i.guildId!);
  const session = ctx.sessions.get(i.guildId!);
  const stats = ctx.pipeline.statsFor(i.guildId!);
  const ttsOn = settings.tts ?? ctx.cfg.ttsEnabled;
  const lines = [
    "**dbot-k2j 稼働状況**",
    `翻訳エンジン: ${ctx.mt.name}`,
    `音声認識: ${ctx.cfg.sttModel} (${ctx.cfg.sttBaseUrl})`,
    `読み上げ: ${ttsOn ? `ON (VOICEVOX speaker ${ctx.cfg.voicevoxSpeaker})` : "OFF (字幕のみ)"}`,
    `字幕投稿先: ${settings.subtitleChannelId ? `<#${settings.subtitleChannelId}>` : "VC のテキストチャット"}`,
    `指定話者: ${settings.userIds.length} 名`,
    `VC: ${session ? `接続中 (<#${session.channelId}>)` : "未接続"}`,
    `処理済 ${stats.processed} 件 / 破棄 ${stats.dropped} 件 / エラー ${stats.errors} 件` +
      (stats.lastLatencyMs !== null ? ` / 直近レイテンシ ${(stats.lastLatencyMs / 1000).toFixed(1)} 秒` : ""),
  ];
  const usage = await ctx.mt.usage();
  if (usage) lines.push(usage);
  await i.editReply(lines.join("\n"));
}
