import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Lang } from "../mt/index.js";

export interface TranslationEntry {
  /** ボットが投稿した翻訳メッセージの ID */
  translationId: string;
  /** 翻訳元の本文 (編集検知用) */
  sourceText: string;
}

interface Row {
  lang: Lang;
  translation_id: string;
  source_text: string;
}

const toEntry = (r: Row): TranslationEntry => ({
  translationId: r.translation_id,
  sourceText: r.source_text,
});

/**
 * 元メッセージ ID → (翻訳先言語 → 翻訳メッセージ) の対応表と、訳文のキャッシュ。
 * ボットや PC を再起動しても元メッセージの削除に追随できるよう SQLite に永続化する。
 * 対応 (元メッセージ×言語 の 1 組) の数が上限を超えたら古いものから忘れる
 * (忘れた翻訳は元メッセージが消えても残る)。キャッシュも同じ上限で古いものから消す。
 */
export class TranslationIndex {
  private readonly db: DatabaseSync;
  private readonly stmt: Record<
    | "get"
    | "entries"
    | "upsert"
    | "updateSource"
    | "remove"
    | "removeAll"
    | "byTranslation"
    | "count"
    | "prune"
    | "cacheGet"
    | "cachePut"
    | "cachePrune",
    StatementSync
  >;

  /** path に ":memory:" を渡すとメモリ上のみ (テスト用) */
  constructor(
    path: string,
    private readonly maxEntries = 100_000,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS translations (
        original_id    TEXT    NOT NULL,
        lang           TEXT    NOT NULL,
        translation_id TEXT    NOT NULL UNIQUE,
        source_text    TEXT    NOT NULL,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (original_id, lang)
      );
      CREATE INDEX IF NOT EXISTS translations_created_at ON translations (created_at);
      -- リアクションの付け外しや再投稿で同じ本文を翻訳し直さないためのキャッシュ
      CREATE TABLE IF NOT EXISTS translation_cache (
        original_id TEXT    NOT NULL,
        lang        TEXT    NOT NULL,
        source_text TEXT    NOT NULL,
        translated  TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (original_id, lang)
      );
      CREATE INDEX IF NOT EXISTS translation_cache_created_at ON translation_cache (created_at);
    `);
    const cols = "lang, translation_id, source_text";
    this.stmt = {
      get: this.db.prepare(`SELECT ${cols} FROM translations WHERE original_id = ? AND lang = ?`),
      entries: this.db.prepare(`SELECT ${cols} FROM translations WHERE original_id = ? ORDER BY lang`),
      upsert: this.db.prepare(
        `INSERT OR REPLACE INTO translations (original_id, lang, translation_id, source_text, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      updateSource: this.db.prepare(
        "UPDATE translations SET source_text = ? WHERE original_id = ? AND lang = ?",
      ),
      remove: this.db.prepare(
        `DELETE FROM translations WHERE original_id = ? AND lang = ? RETURNING ${cols}`,
      ),
      removeAll: this.db.prepare(`DELETE FROM translations WHERE original_id = ? RETURNING ${cols}`),
      byTranslation: this.db.prepare(
        "SELECT original_id, lang FROM translations WHERE translation_id = ?",
      ),
      count: this.db.prepare("SELECT COUNT(*) AS n FROM translations"),
      prune: this.db.prepare(
        `DELETE FROM translations WHERE rowid IN (
           SELECT rowid FROM translations ORDER BY created_at, rowid
           LIMIT max(0, (SELECT COUNT(*) FROM translations) - ?))`,
      ),
      cacheGet: this.db.prepare(
        "SELECT translated FROM translation_cache WHERE original_id = ? AND lang = ? AND source_text = ?",
      ),
      cachePut: this.db.prepare(
        `INSERT OR REPLACE INTO translation_cache (original_id, lang, source_text, translated, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      cachePrune: this.db.prepare(
        `DELETE FROM translation_cache WHERE rowid IN (
           SELECT rowid FROM translation_cache ORDER BY created_at, rowid
           LIMIT max(0, (SELECT COUNT(*) FROM translation_cache) - ?))`,
      ),
    };
  }

  /** 対応 (元メッセージ×言語) の数 */
  get size(): number {
    return (this.stmt.count.get() as { n: number }).n;
  }

  get(originalId: string, lang: Lang): TranslationEntry | undefined {
    const row = this.stmt.get.get(originalId, lang) as Row | undefined;
    return row && toEntry(row);
  }

  entries(originalId: string): [Lang, TranslationEntry][] {
    return (this.stmt.entries.all(originalId) as unknown as Row[]).map((r) => [r.lang, toEntry(r)]);
  }

  set(originalId: string, lang: Lang, entry: TranslationEntry): void {
    this.stmt.upsert.run(originalId, lang, entry.translationId, entry.sourceText, Date.now());
    this.stmt.prune.run(this.maxEntries);
  }

  /** 元メッセージの編集で翻訳を更新したとき、翻訳元の本文を差し替える */
  updateSource(originalId: string, lang: Lang, sourceText: string): void {
    this.stmt.updateSource.run(sourceText, originalId, lang);
  }

  remove(originalId: string, lang: Lang): TranslationEntry | undefined {
    const row = this.stmt.remove.get(originalId, lang) as Row | undefined;
    return row && toEntry(row);
  }

  removeAll(originalId: string): TranslationEntry[] {
    return (this.stmt.removeAll.all(originalId) as unknown as Row[]).map(toEntry);
  }

  /** 翻訳メッセージ自体が (手動などで) 削除されたとき、その対応を忘れる */
  forgetTranslation(translationId: string): void {
    const ref = this.stmt.byTranslation.get(translationId) as
      | { original_id: string; lang: Lang }
      | undefined;
    if (ref) this.remove(ref.original_id, ref.lang);
  }

  /** 同じ本文を同じ言語へ翻訳済みならその訳文 */
  cachedTranslation(originalId: string, lang: Lang, sourceText: string): string | undefined {
    const row = this.stmt.cacheGet.get(originalId, lang, sourceText) as
      | { translated: string }
      | undefined;
    return row?.translated;
  }

  cacheTranslation(originalId: string, lang: Lang, sourceText: string, translated: string): void {
    this.stmt.cachePut.run(originalId, lang, sourceText, translated, Date.now());
    this.stmt.cachePrune.run(this.maxEntries);
  }

  close(): void {
    this.db.close();
  }
}
