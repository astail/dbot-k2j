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
 * 元メッセージ ID → (翻訳先言語 → 翻訳メッセージ) の対応表。
 * ボットや PC を再起動しても元メッセージの削除に追随できるよう SQLite に永続化する。
 * 件数が上限を超えたら古いものから忘れる (忘れた翻訳は元メッセージが消えても残る)。
 */
export class TranslationIndex {
  private readonly db: DatabaseSync;
  private readonly stmt: Record<
    "get" | "entries" | "upsert" | "updateSource" | "remove" | "removeAll" | "byTranslation" | "count" | "prune",
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
      count: this.db.prepare("SELECT COUNT(DISTINCT original_id) AS n FROM translations"),
      prune: this.db.prepare(
        `DELETE FROM translations WHERE rowid IN (
           SELECT rowid FROM translations ORDER BY created_at, rowid
           LIMIT max(0, (SELECT COUNT(*) FROM translations) - ?))`,
      ),
    };
  }

  /** 対応表に載っている元メッセージの数 */
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

  close(): void {
    this.db.close();
  }
}
