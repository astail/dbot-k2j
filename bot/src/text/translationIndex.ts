import type { Lang } from "../mt/index.js";

export interface TranslationEntry {
  /** ボットが投稿した翻訳メッセージの ID */
  translationId: string;
  /** 翻訳元の本文 (編集検知用) */
  sourceText: string;
}

/**
 * 元メッセージ ID → (翻訳先言語 → 翻訳メッセージ) の対応表。
 * メモリ上のみで保持し、古いものから上限件数を超えた分を忘れる
 * (忘れた翻訳は元メッセージが消えても残る)。
 */
export class TranslationIndex {
  private readonly byOriginal = new Map<string, Map<Lang, TranslationEntry>>();
  private readonly byTranslation = new Map<string, { originalId: string; lang: Lang }>();

  constructor(private readonly maxOriginals = 5_000) {}

  get size(): number {
    return this.byOriginal.size;
  }

  get(originalId: string, lang: Lang): TranslationEntry | undefined {
    return this.byOriginal.get(originalId)?.get(lang);
  }

  entries(originalId: string): [Lang, TranslationEntry][] {
    return [...(this.byOriginal.get(originalId) ?? [])];
  }

  set(originalId: string, lang: Lang, entry: TranslationEntry): void {
    let langs = this.byOriginal.get(originalId);
    if (!langs) {
      langs = new Map();
      this.byOriginal.set(originalId, langs);
    }
    const prev = langs.get(lang);
    if (prev) this.byTranslation.delete(prev.translationId);
    langs.set(lang, entry);
    this.byTranslation.set(entry.translationId, { originalId, lang });
    while (this.byOriginal.size > this.maxOriginals) {
      const oldest = this.byOriginal.keys().next().value as string;
      this.removeAll(oldest);
    }
  }

  remove(originalId: string, lang: Lang): TranslationEntry | undefined {
    const langs = this.byOriginal.get(originalId);
    const entry = langs?.get(lang);
    if (!langs || !entry) return undefined;
    langs.delete(lang);
    if (langs.size === 0) this.byOriginal.delete(originalId);
    this.byTranslation.delete(entry.translationId);
    return entry;
  }

  removeAll(originalId: string): TranslationEntry[] {
    const entries = this.entries(originalId).map(([, e]) => e);
    for (const e of entries) this.byTranslation.delete(e.translationId);
    this.byOriginal.delete(originalId);
    return entries;
  }

  /** 翻訳メッセージ自体が (手動などで) 削除されたとき、その対応を忘れる */
  forgetTranslation(translationId: string): void {
    const ref = this.byTranslation.get(translationId);
    if (ref) this.remove(ref.originalId, ref.lang);
  }
}
