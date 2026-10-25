import {
  DiscordAPIError,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
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
import { guessLang, needsChatTranslation } from "../util/filter.js";
import { RateLimiter } from "../util/rateLimit.js";
import type { TranslationIndex } from "./translationIndex.js";

const MAX_MESSAGE_LENGTH = 2000;
const LANG_FLAGS: Record<Lang, string> = { ko: "🇰🇷", ja: "🇯🇵" };
/** リアクション追加の記録 (行き違い検出用) を保持する時間 */
const RECENT_ADD_MS = 60_000;

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

/** 文字 (コードポイント) 単位で切り詰める。絵文字のサロゲートペアを分断しない */
export function truncateChars(text: string, max: number): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  return chars.length > max
    ? { text: chars.slice(0, max).join(""), truncated: true }
    : { text, truncated: false };
}

/**
 * 翻訳メッセージの本文。Discord の文字数上限に収まるよう訳文を切り詰める。
 * partial は翻訳元が長すぎて先頭のみ翻訳したことを示す
 */
export function formatTranslation(translated: string, lang: Lang, partial = false): string {
  const footer = `\n-# ${LANG_FLAGS[lang]} ${LANG_NAMES[lang]}訳${partial ? " (先頭のみ)" : ""}`;
  const max = MAX_MESSAGE_LENGTH - footer.length;
  if (translated.length <= max) return translated + footer;
  // 上限は UTF-16 長で数えるが、切る位置はコードポイント単位にする ("…" の 1 文字分を残す)
  let body = "";
  for (const ch of translated) {
    if (body.length + ch.length > max - 1) break;
    body += ch;
  }
  return `${body}…${footer}`;
}

/** 翻訳元テキスト。転送メッセージは本文が空なので転送元の本文を使う */
function sourceText(message: Message): string {
  return (message.content || message.messageSnapshots.first()?.content || "").trim();
}

/** 対象のメッセージ (またはチャンネル) が既に存在しない */
function isGone(e: unknown): boolean {
  return (
    e instanceof DiscordAPIError &&
    (e.code === RESTJSONErrorCodes.UnknownMessage || e.code === RESTJSONErrorCodes.UnknownChannel)
  );
}

function logError(scope: string) {
  return (e: unknown) => console.error(`[reaction] ${scope}:`, e instanceof Error ? e.message : e);
}

interface Job {
  /** reaction: リアクションが全て外れた (付け直されたら取り消しを撤回) / deleted: 元メッセージ削除 */
  cancel: "reaction" | "deleted" | null;
}

/**
 * テキストチャットで国旗リアクションが付いたメッセージを翻訳して返信する。
 * - 🇰🇷 → 韓国語へ / 🇯🇵 → 日本語へ (絵文字は env で変更可)
 * - 元メッセージの削除・該当リアクションが全て外れた → 翻訳も削除
 * - 元メッセージの編集 → 翻訳も更新
 */
export class ReactionTranslator {
  /** 処理中のジョブ (`${messageId}:${lang}`)。取り消されたら投稿しない/投稿後に消す */
  private readonly pending = new Map<string, Job>();
  /** リアクション追加の通し番号 (`${messageId}:${lang}` → 最後の追加)。削除判定との行き違い検出用 */
  private readonly lastAdd = new Map<string, { seq: number; at: number }>();
  private addSeq = 0;
  /** 編集中の最新本文 (messageId)。古い編集の翻訳で上書きしないため */
  private readonly latestEdit = new Map<string, string>();
  private readonly limiter: RateLimiter;

  constructor(
    private readonly client: Client,
    private readonly cfg: Config,
    private readonly mt: Translator,
    private readonly index: TranslationIndex,
  ) {
    this.limiter = new RateLimiter(cfg.reactionRatePerMin, 60_000);
  }

  register(): void {
    const c = this.client;
    c.on(Events.MessageReactionAdd, (r, u) => void this.onReactionAdd(r, u).catch(logError("翻訳に失敗")));
    c.on(Events.MessageReactionRemove, (r) => void this.onReactionRemove(r).catch(logError("リアクション削除の処理に失敗")));
    c.on(Events.MessageReactionRemoveEmoji, (r) => void this.onReactionRemove(r).catch(logError("リアクション削除の処理に失敗")));
    c.on(Events.MessageReactionRemoveAll, (m) => void this.deleteTranslations(m, null, "reaction").catch(logError("翻訳の削除に失敗")));
    c.on(Events.MessageDelete, (m) => void this.onMessageDelete(m).catch(logError("翻訳の削除に失敗")));
    c.on(Events.MessageBulkDelete, (messages) => {
      for (const m of messages.values()) void this.onMessageDelete(m).catch(logError("翻訳の削除に失敗"));
    });
    c.on(Events.MessageUpdate, (_old, m) => void this.onMessageUpdate(m).catch(logError("翻訳の更新に失敗")));
  }

  /**
   * キャッシュに無ければ翻訳する (userId の回数制限を消費)。
   * 制限超過なら null
   */
  private async translate(
    originalId: string,
    text: string,
    to: Lang,
    userId: string,
  ): Promise<string | null> {
    const cached = this.index.cachedTranslation(originalId, to, text);
    if (cached) return cached;
    if (!this.limiter.tryTake(userId)) {
      console.warn(`[reaction] ユーザー ${userId} の翻訳回数が上限 (${this.cfg.reactionRatePerMin}/分) に達したためスキップ`);
      return null;
    }
    // 判別できた場合だけ元言語を指定し、英語などはエンジンの自動判定に任せる
    const translated = (await this.mt.translate(text, { from: guessLang(text), to, source: "chat" })).trim();
    if (translated) this.index.cacheTranslation(originalId, to, text, translated);
    return translated || null;
  }

  private async onReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    const lang = emojiLang(reaction.emoji, this.cfg.reactionEmojis);
    if (!lang || user.bot) return;
    const key = `${reaction.message.id}:${lang}`;
    this.markAdded(key);
    const running = this.pending.get(key);
    if (running) {
      // 処理中に外して付け直した → 取り消しを撤回 (元メッセージ削除による取り消しは撤回しない)
      if (running.cancel === "reaction") running.cancel = null;
      return;
    }
    // 以降の await 中に来たリアクション追加・削除を正しく扱うため、先にジョブを登録する
    const job: Job = { cancel: null };
    this.pending.set(key, job);
    try {
      await this.translateAndPost(reaction, user, lang, job);
    } finally {
      this.pending.delete(key);
    }
  }

  private async translateAndPost(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    lang: Lang,
    job: Job,
  ): Promise<void> {
    if ((user.partial ? await user.fetch() : user).bot) return;
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    // 自分の投稿 (字幕・翻訳) は翻訳しない
    if (!message.inGuild() || message.author.id === this.client.user?.id) return;

    const existing = this.index.get(message.id, lang);
    if (existing) {
      // 翻訳済み。ただしボット停止中に翻訳が手動削除されていたら対応を忘れて投稿し直す
      const alive = await message.channel.messages.fetch(existing.translationId).catch((e: unknown) => {
        if (isGone(e)) return null;
        throw e;
      });
      if (alive) return;
      this.index.forgetTranslation(existing.translationId);
    }

    const full = sourceText(message);
    if (!full || !needsChatTranslation(full, lang)) return;
    // 投稿できないチャンネルで翻訳 API の料金だけかからないよう、先に権限を確認する
    const me = message.guild.members.me ?? this.client.user!;
    const perms = message.channel.permissionsFor(me);
    const send = message.channel.isThread()
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages;
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, send])) {
      console.warn(`[reaction] #${message.channel.name} に返信する権限が無いため翻訳しません`);
      return;
    }
    if (job.cancel) return;

    const { text, truncated } = truncateChars(full, this.cfg.reactionMaxChars);
    const translated = await this.translate(message.id, text, lang, user.id);
    if (!translated || job.cancel) return;
    // 元メッセージが翻訳中に消えていたら reply は失敗する (= 何も残らない)
    const reply = await message.reply({
      content: formatTranslation(translated, lang, truncated),
      allowedMentions: { parse: [], repliedUser: false },
      flags: MessageFlags.SuppressNotifications,
    });
    if (job.cancel) {
      await this.deleteMessage(message.channelId, reply.id);
      return;
    }
    this.index.set(message.id, lang, { translationId: reply.id, sourceText: full });
  }

  private markAdded(key: string): void {
    const now = Date.now();
    this.lastAdd.set(key, { seq: ++this.addSeq, at: now });
    if (this.lastAdd.size > 1_000) {
      for (const [k, v] of this.lastAdd) if (now - v.at > RECENT_ADD_MS) this.lastAdd.delete(k);
    }
  }

  private async onReactionRemove(reaction: MessageReaction | PartialMessageReaction): Promise<void> {
    const lang = emojiLang(reaction.emoji, this.cfg.reactionEmojis);
    if (!lang) return;
    const { message } = reaction;
    const key = `${message.id}:${lang}`;
    if (!this.index.get(message.id, lang) && !this.pending.has(key)) return;
    // キャッシュの件数は部分的なことがあるので、API から最新のリアクションを取り直して判定する
    const seqAtCheck = this.addSeq;
    const data = (await this.client.rest
      .get(Routes.channelMessage(message.channelId, message.id))
      .catch(() => null)) as APIMessage | null;
    if (!data) return; // 元メッセージが消えた → MessageDelete 側で処理
    const remaining = (data.reactions ?? []).some(
      (r) => r.count > 0 && emojiLang(r.emoji, this.cfg.reactionEmojis) === lang,
    );
    // 確認中に付け直された場合、取得した件数は古い可能性があるので消さない
    if (remaining || (this.lastAdd.get(key)?.seq ?? 0) > seqAtCheck) return;
    await this.deleteTranslations(message, lang, "reaction");
  }

  private async onMessageDelete(message: Message | PartialMessage): Promise<void> {
    this.index.forgetTranslation(message.id);
    await this.deleteTranslations(message, null, "deleted");
  }

  /** lang が null なら全言語の翻訳を削除 (処理中のジョブは取り消す) */
  private async deleteTranslations(
    message: Message | PartialMessage,
    lang: Lang | null,
    reason: NonNullable<Job["cancel"]>,
  ): Promise<void> {
    const langs = lang ? [lang] : (["ko", "ja"] as const);
    for (const l of langs) {
      const job = this.pending.get(`${message.id}:${l}`);
      if (job && job.cancel !== "deleted") job.cancel = reason;
    }
    const entries = this.index.entries(message.id).filter(([l]) => langs.includes(l));
    await Promise.all(
      entries.map(async ([, e]) => {
        // 削除できた (または既に無い) ときだけ対応を忘れる。失敗時は次の機会に再試行できるよう残す
        if (await this.deleteMessage(message.channelId, e.translationId)) {
          this.index.forgetTranslation(e.translationId);
        }
      }),
    );
  }

  /** チャンネルのキャッシュに依存せず削除する。削除済み・既に無いなら true */
  private async deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    try {
      await this.client.rest.delete(Routes.channelMessage(channelId, messageId));
      return true;
    } catch (e) {
      if (isGone(e)) return true;
      logError("翻訳メッセージの削除に失敗")(e);
      return false;
    }
  }

  private async onMessageUpdate(updated: Message | PartialMessage): Promise<void> {
    if (this.index.entries(updated.id).length === 0) return;
    const message = updated.partial ? await updated.fetch() : updated;
    const full = sourceText(message);
    this.latestEdit.set(message.id, full);
    try {
      // リンクの埋め込み展開などでも Update は飛ぶので、本文が変わったときだけ再翻訳する
      for (const [lang, entry] of this.index.entries(message.id)) {
        if (entry.sourceText === full) continue;
        await this.updateTranslation(message, lang, entry.translationId, full).catch(
          logError("翻訳の更新に失敗"),
        );
      }
    } finally {
      if (this.latestEdit.get(message.id) === full) this.latestEdit.delete(message.id);
    }
  }

  private async updateTranslation(
    message: Message,
    lang: Lang,
    translationId: string,
    full: string,
  ): Promise<void> {
    if (!full || !needsChatTranslation(full, lang)) {
      await this.deleteTranslations(message, lang, "reaction");
      return;
    }
    const { text, truncated } = truncateChars(full, this.cfg.reactionMaxChars);
    const translated = await this.translate(message.id, text, lang, message.author.id);
    if (!translated) return; // 回数制限。本文は更新しないので次の編集で再試行される
    // 翻訳中にさらに編集された / 翻訳が削除・差し替えされたなら、古い訳文で上書きしない
    if (
      this.latestEdit.get(message.id) !== full ||
      this.index.get(message.id, lang)?.translationId !== translationId
    ) {
      return;
    }
    try {
      await this.client.rest.patch(Routes.channelMessage(message.channelId, translationId), {
        body: {
          content: formatTranslation(translated, lang, truncated),
          allowed_mentions: { parse: [], replied_user: false },
        },
      });
    } catch (e) {
      if (isGone(e)) {
        this.index.forgetTranslation(translationId); // 翻訳が手動削除されていた
        return;
      }
      throw e;
    }
    // 編集に成功してから本文を記録する (失敗時は次の Update で再試行される)
    this.index.updateSource(message.id, lang, full);
  }
}
