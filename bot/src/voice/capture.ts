import { EndBehaviorType, type VoiceReceiver } from "@discordjs/voice";
import prism from "prism-media";

export interface Utterance {
  userId: string;
  /** 48kHz stereo s16le */
  pcm: Buffer;
  startedAt: number;
  endedAt: number;
}

interface CaptureOptions {
  /** この時間無音が続いたら発話終了とみなす */
  silenceMs: number;
  /** 発話の上限。超えたら一旦区切って処理する */
  maxUtteranceMs: number;
}

/**
 * 指定ユーザーの発話を 1 回分キャプチャする。
 * Discord はユーザー毎に独立した Opus ストリームをくれるので話者分離は不要。
 */
export function captureUtterance(
  receiver: VoiceReceiver,
  userId: string,
  opts: CaptureOptions,
): Promise<Utterance> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: opts.silenceMs },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    let total = 0;
    const maxBytes = 48_000 * 4 * (opts.maxUtteranceMs / 1000);
    let done = false;

    const cleanup = () => {
      if (!opus.destroyed) opus.destroy();
      // ネイティブの Opus デコーダを GC 任せにせず明示的に解放する
      if (!decoder.destroyed) decoder.destroy();
    };
    const finish = () => {
      if (done) return;
      done = true;
      const pcm = Buffer.concat(chunks);
      cleanup();
      resolve({ userId, pcm, startedAt, endedAt: Date.now() });
    };
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      const pcm = Buffer.concat(chunks);
      cleanup();
      // 途中までのデータがあれば活かす (DAVE 再ネゴシエーション等で稀に途切れる)
      if (total > 0) {
        resolve({ userId, pcm, startedAt, endedAt: Date.now() });
      } else {
        reject(err);
      }
    };

    decoder.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) finish();
    });
    decoder.once("end", finish);
    decoder.once("error", fail);
    opus.once("error", fail);
    opus.pipe(decoder);
  });
}
