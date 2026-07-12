import type { Config } from "../config.js";
import { wavToPcm } from "../voice/wav.js";

export class VoicevoxClient {
  constructor(private readonly cfg: Config) {}

  /**
   * テキストを 48kHz stereo の生 PCM (s16le) に合成する。
   * audio_query の出力設定を Discord の再生フォーマットに合わせることで、
   * ffmpeg やリサンプリングを不要にしている (StreamType.Raw でそのまま再生可能)。
   */
  async synthesize(text: string): Promise<Buffer> {
    const speaker = this.cfg.voicevoxSpeaker;
    const qRes = await fetch(
      `${this.cfg.voicevoxUrl}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`,
      { method: "POST", signal: AbortSignal.timeout(15_000) },
    );
    if (!qRes.ok) throw new Error(`VOICEVOX audio_query ${qRes.status}`);
    const query = (await qRes.json()) as Record<string, unknown>;
    query.outputSamplingRate = 48_000;
    query.outputStereo = true;

    const sRes = await fetch(`${this.cfg.voicevoxUrl}/synthesis?speaker=${speaker}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(30_000),
    });
    if (!sRes.ok) throw new Error(`VOICEVOX synthesis ${sRes.status}`);
    return wavToPcm(Buffer.from(await sRes.arrayBuffer()));
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.voicevoxUrl}/version`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
