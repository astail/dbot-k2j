import {
  Events,
  MessageFlags,
  Routes,
  type APIMessage,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import type { Config } from "../config.js";
import { LANG_NAMES, type Lang, type Translator } from "../mt/index.js";
import { needsChatTranslation } from "../util/filter.js";
import { TranslationIndex } from "./translationIndex.js";

const MAX_MESSAGE_LENGTH = 2000;
const LANG_FLAGS: Record<Lang, string> = { ko: "🇰🇷", ja: "🇯🇵" };

/** リアクション絵文字に対応する翻訳先言語。対象外なら null */
export function emojiLang(
  emoji: { id: string | null; name: string | null },
  emojis: Config["reactionEmojis"],
): Lang | null {
  for (const lang of ["ko", "ja"] as const) {
    if (emojis[lang].some((e) => e === emoji.name || e === emoji.id)) return lang;
  }
  return null;
}

/** 翻訳メッセージの本文。Discord の文字数上限に収まるよう訳文を切り詰める */
export function formatTranslation(translated: string, lang: Lang): string {
  const footer = `\n-# ${LANG_FLAGS[lang]} ${LANG_NAMES[lang]}訳`;
  const max = MAX_MESSAGE_LENGTH - footer.length;
  const body = translated.length > max ? `${translated.slice(0, max - 1)}…` : translated;
  return body + footer;
}

/** 翻訳元テキスト。転送メッセージは本文が空なので転送元の本文を使う */
function sourceText(message: Message): string {
  return (message.content || message.messageSnapshots.first()?.content || "").trim();
}

function logError(scope: string) {
  return (e: unknown) => console.error(`[reaction] ${scope}:`, e instanceof Error ? e.message : e);
}

/**
 * テキストチャットで国旗リアクションが付いたメッセージを翻訳して返信する。
 * - 🇰🇷 → 韓国語へ / 🇯🇵 → 日本語へ (絵文字は env で変更可)
 * - 元メッセージの削除・該当リアクションが全て外れた → 翻訳も削除
 * - 元メッセージの編集 → 翻訳も更新
 */
export class ReactionTranslator {
  private readonly index = new TranslationIndex();
  /** 翻訳中のジョブ (`${messageId}:${lang}`)。翻訳中に取り消されたら投稿後に消す */
  private readonly pending = new Map<string, { cancelled: boolean }>();

  constructor(
    private readonly client: Client,
    private readonly cfg: Config,
    private readonly mt: Translator,
  ) {}

  register(): void {
    const c = this.client;
    c.on(Events.MessageReactionAdd, (r, u) => void this.onReactionAdd(r, u).catch(logError("翻訳に失敗")));
    c.on(Events.MessageReactionRemove, (r) => void this.onReactionRemove(r).catch(logError("リアクション削除の処理に失敗")));
    c.on(Events.MessageReactionRemoveEmoji, (r) => void this.onReactionRemove(r).catch(logError("リアクション削除の処理に失敗")));
    c.on(Events.MessageReactionRemoveAll, (m) => void this.deleteTranslations(m, null).catch(logError("翻訳の削除に失敗")));
    c.on(Events.MessageDelete, (m) => void this.onMessageDelete(m).catch(logError("翻訳の削除に失敗")));
    c.on(Events.MessageBulkDelete, (messages) => {
      for (const m of messages.values()) void this.onMessageDelete(m).catch(logError("翻訳の削除に失敗"));
    });
    c.on(Events.MessageUpdate, (_old, m) => void this.onMessageUpdate(m).catch(logError("翻訳の更新に失敗")));
  }

  private translate(text: string, to: Lang): Promise<string> {
    const from: Lang = to === "ko" ? "ja" : "ko";
    return this.mt.translate(text, { from, to, source: "chat" }).then((t) => t.trim());
  }

  private async onReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    const lang = emojiLang(reaction.emoji, this.cfg.reactionEmojis);
    if (!lang) return;
    if ((user.partial ? await user.fetch() : user).bot) return;
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    // 自分の投稿 (字幕・翻訳) は翻訳しない
    if (!message.inGuild() || message.author.id === this.client.user?.id) return;

    const key = `${message.id}:${lang}`;
    if (this.index.get(message.id, lang) || this.pending.has(key)) return; // 翻訳済み/翻訳中
    const text = sourceText(message);
    if (!text || !needsChatTranslation(text, lang)) return;

    const job = { cancelled: false };
    this.pending.set(key, job);
    try {
      const translated = await this.translate(text, lang);
      if (!translated || job.cancelled) return;
      // 元メッセージが翻訳中に消えていたら reply は失敗する (= 何も残らない)
      const reply = await message.reply({
        content: formatTranslation(translated, lang),
        allowedMentions: { parse: [], repliedUser: false },
        flags: MessageFlags.SuppressNotifications,
      });
      if (job.cancelled) {
        await reply.delete().catch(() => {});
        return;
      }
      this.index.set(message.id, lang, { translationId: reply.id, sourceText: text });
    } finally {
      this.pending.delete(key);
    }
  }

  private async onReactionRemove(reaction: MessageReaction | PartialMessageReaction): Promise<void> {
    const lang = emojiLang(reaction.emoji, this.cfg.reactionEmojis);
    if (!lang) return;
    const { message } = reaction;
    const job = this.pending.get(`${message.id}:${lang}`);
    if (!this.index.get(message.id, lang) && !job) return;
    // キャッシュの件数は部分的なことがあるので、API から最新のリアクションを取り直して判定する
    const data = (await this.client.rest
      .get(Routes.channelMessage(message.channelId, message.id))
      .catch(() => null)) as APIMessage | null;
    if (!data) return; // 元メッセージが消えた → MessageDelete 側で処理
    const remaining = (data.reactions ?? []).some(
      (r) => r.count > 0 && emojiLang(r.emoji, this.cfg.reactionEmojis) === lang,
    );
    if (!remaining) await this.deleteTranslations(message, lang);
  }

  private async onMessageDelete(message: Message | PartialMessage): Promise<void> {
    this.index.forgetTranslation(message.id);
    await this.deleteTranslations(message, null);
  }

  /** lang が null なら全言語の翻訳を削除 (翻訳中のものは投稿後に取り消す) */
  private async deleteTranslations(message: Message | PartialMessage, lang: Lang | null): Promise<void> {
    for (const l of lang ? [lang] : (["ko", "ja"] as const)) {
      const job = this.pending.get(`${message.id}:${l}`);
      if (job) job.cancelled = true;
    }
    const entries = lang
      ? [this.index.remove(message.id, lang)].filter((e) => e !== undefined)
      : this.index.removeAll(message.id);
    await Promise.all(
      entries.map((e) => message.channel.messages.delete(e.translationId).catch(() => {})),
    );
  }

  private async onMessageUpdate(updated: Message | PartialMessage): Promise<void> {
    if (this.index.entries(updated.id).length === 0) return;
    const message = updated.partial ? await updated.fetch() : updated;
    const text = sourceText(message);
    // リンクの埋め込み展開などでも Update は飛ぶので、本文が変わったときだけ再翻訳する
    for (const [lang, entry] of this.index.entries(message.id)) {
      if (entry.sourceText === text) continue;
      if (!text || !needsChatTranslation(text, lang)) {
        await this.deleteTranslations(message, lang);
        continue;
      }
      entry.sourceText = text;
      const translated = await this.translate(text, lang);
      if (!translated || this.index.get(message.id, lang) !== entry) continue; // 翻訳中に削除された
      await message.channel.messages.edit(entry.translationId, {
        content: formatTranslation(translated, lang),
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
  }
}
