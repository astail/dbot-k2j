import { EventEmitter } from "node:events";
import { Events } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { TranslateOptions, Translator } from "../src/mt/index.js";
import { ReactionTranslator } from "../src/text/reactionTranslate.js";
import { TranslationIndex } from "../src/text/translationIndex.js";
import { RateLimiter } from "../src/util/rateLimit.js";

const cfg = {
  reactionEmojis: { ko: ["🇰🇷"], ja: ["🇯🇵"] },
  reactionMaxChars: 1000,
  reactionRatePerMin: 10,
} as unknown as Config;

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/** resolve を外から呼べる翻訳エンジン */
function fakeTranslator() {
  const calls: { text: string; opts?: TranslateOptions; resolve: (s: string) => void }[] = [];
  const mt: Translator = {
    name: "fake",
    translate: (text, opts) => new Promise((resolve) => calls.push({ text, opts, resolve })),
    usage: async () => null,
  };
  return { mt, calls };
}

function setup(content = "こんにちは") {
  const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let reactions: { count: number; emoji: { id: null; name: string } }[] = [];
  const rest = {
    get: vi.fn(async () => ({ reactions })),
    delete: vi.fn(async () => undefined),
    patch: vi.fn(async () => undefined),
  };
  Object.assign(client, { user: { id: "bot" }, rest });
  let replies = 0;
  const message = {
    id: "m1",
    channelId: "c1",
    partial: false,
    content,
    author: { id: "author" },
    messageSnapshots: { first: () => undefined },
    inGuild: () => true,
    guild: { members: { me: {} } },
    channel: {
      name: "general",
      isThread: () => false,
      permissionsFor: () => ({ has: () => true }),
      messages: { fetch: vi.fn(async () => ({})) },
    },
    reply: vi.fn(async () => ({ id: `t${++replies}` })),
    fetch: async () => message,
  };
  const { mt, calls } = fakeTranslator();
  const index = new TranslationIndex(":memory:");
  new ReactionTranslator(client as never, cfg, mt, index).register();
  const reaction = { emoji: { id: null, name: "🇰🇷" }, message };
  const user = { id: "u1", bot: false, partial: false };
  return {
    client,
    rest,
    message,
    calls,
    index,
    add: () => client.emit(Events.MessageReactionAdd, reaction, user),
    remove: () => client.emit(Events.MessageReactionRemove, reaction, user),
    setReactions: (n: number) => {
      reactions = n > 0 ? [{ count: n, emoji: { id: null, name: "🇰🇷" } }] : [];
    },
  };
}

describe("ReactionTranslator", () => {
  it("翻訳中に外して付け直しても翻訳が投稿される", async () => {
    const t = setup();
    t.setReactions(1);
    t.add();
    await flush();
    expect(t.calls).toHaveLength(1);
    t.setReactions(0);
    t.remove();
    await flush();
    t.setReactions(1);
    t.add();
    await flush();
    t.calls[0]!.resolve("안녕하세요");
    await flush();
    expect(t.message.reply).toHaveBeenCalledTimes(1);
    expect(t.rest.delete).not.toHaveBeenCalled();
    expect(t.index.get("m1", "ko")?.translationId).toBe("t1");
    // 元言語は文字種から判定して渡す
    expect(t.calls[0]!.opts).toEqual({ from: "ja", to: "ko", source: "chat" });
  });

  it("翻訳中にリアクションが全て外れたら投稿しない", async () => {
    const t = setup();
    t.add();
    await flush();
    t.setReactions(0);
    t.remove();
    await flush();
    t.calls[0]!.resolve("안녕하세요");
    await flush();
    expect(t.message.reply).not.toHaveBeenCalled();
    expect(t.index.get("m1", "ko")).toBeUndefined();
  });

  it("付け外しを繰り返してもキャッシュを使い、翻訳 API は 1 回だけ", async () => {
    const t = setup();
    t.add();
    await flush();
    t.calls[0]!.resolve("안녕하세요");
    await flush();
    t.setReactions(0);
    t.remove();
    await flush();
    expect(t.rest.delete).toHaveBeenCalledTimes(1);
    expect(t.index.get("m1", "ko")).toBeUndefined();
    t.add();
    await flush();
    expect(t.calls).toHaveLength(1);
    expect(t.message.reply).toHaveBeenCalledTimes(2);
  });

  it("削除確認の API 応答待ちに付け直されたら翻訳を消さない", async () => {
    const t = setup();
    t.add();
    await flush();
    t.calls[0]!.resolve("안녕하세요");
    await flush();
    let respond!: (v: unknown) => void;
    t.rest.get.mockImplementationOnce(() => new Promise((r) => (respond = r)));
    t.remove();
    await flush();
    t.add(); // 応答が返る前に付け直し
    await flush();
    respond({ reactions: [] }); // 付け直し前の古い状態 (件数 0)
    await flush();
    expect(t.rest.delete).not.toHaveBeenCalled();
    expect(t.index.get("m1", "ko")?.translationId).toBe("t1");
  });

  it("判別できない言語 (英語) は元言語を自動判定に任せる", async () => {
    const t = setup("hello world");
    t.add();
    await flush();
    expect(t.calls[0]!.opts?.from).toBeNull();
  });

  it("翻訳メッセージの削除に失敗したら対応を残す (再試行できる)", async () => {
    const t = setup();
    t.add();
    await flush();
    t.calls[0]!.resolve("안녕하세요");
    await flush();
    t.rest.delete.mockRejectedValueOnce(new Error("network"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.client.emit(Events.MessageDelete, t.message);
    await flush();
    expect(t.index.get("m1", "ko")?.translationId).toBe("t1");
    t.client.emit(Events.MessageDelete, t.message);
    await flush();
    expect(t.index.get("m1", "ko")).toBeUndefined();
  });

  it("編集が重なっても最後の本文の訳文で更新する", async () => {
    const t = setup();
    t.add();
    await flush();
    t.calls[0]!.resolve("안녕하세요");
    await flush();

    t.message.content = "編集A";
    t.client.emit(Events.MessageUpdate, null, t.message);
    await flush();
    t.message.content = "編集B";
    t.client.emit(Events.MessageUpdate, null, t.message);
    await flush();
    t.calls[2]!.resolve("편집B");
    await flush();
    t.calls[1]!.resolve("편집A"); // 遅れて返った古い訳文
    await flush();

    expect(t.rest.patch).toHaveBeenCalledTimes(1);
    const body = (t.rest.patch.mock.calls[0] as unknown[])[1] as { body: { content: string } };
    expect(body.body.content).toContain("편집B");
    expect(t.index.get("m1", "ko")?.sourceText).toBe("編集B");
  });
});

describe("RateLimiter", () => {
  it("ウィンドウ内の回数を制限し、時間が経てば回復する", () => {
    const rl = new RateLimiter(2, 60_000);
    expect(rl.tryTake("u", 0)).toBe(true);
    expect(rl.tryTake("u", 1)).toBe(true);
    expect(rl.tryTake("u", 2)).toBe(false);
    expect(rl.tryTake("other", 2)).toBe(true);
    expect(rl.tryTake("u", 60_001)).toBe(true);
    expect(new RateLimiter(0, 1).tryTake("u")).toBe(true);
  });
});
