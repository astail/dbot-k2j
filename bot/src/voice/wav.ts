/**
 * Discord から受信する音声は 48kHz stereo s16le PCM。
 * Whisper 系 STT は 16kHz mono を想定しているため、L/R 平均 + 3サンプル平均の
 * デシメーションで変換する (音声認識用途にはこれで十分)。
 */
export function pcm48kStereoToWav16kMono(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4); // 1フレーム = L(2byte) + R(2byte)
  const outSamples = Math.floor(frames / 3);
  const out = Buffer.allocUnsafe(44 + outSamples * 2);
  writeWavHeader(out, outSamples * 2, 16_000, 1);
  for (let i = 0; i < outSamples; i++) {
    let acc = 0;
    for (let j = 0; j < 3; j++) {
      const off = (i * 3 + j) * 4;
      acc += (pcm.readInt16LE(off) + pcm.readInt16LE(off + 2)) / 2;
    }
    const v = Math.round(acc / 3);
    out.writeInt16LE(Math.max(-32_768, Math.min(32_767, v)), 44 + i * 2);
  }
  return out;
}

function writeWavHeader(buf: Buffer, dataBytes: number, sampleRate: number, channels: number): void {
  const byteRate = sampleRate * channels * 2;
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(channels * 2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
}

/** s16le PCM の RMS (0〜32768)。環境ノイズだけの発話を弾くゲートに使う */
export function pcmRms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let acc = 0;
  for (let i = 0; i < samples; i++) {
    const v = pcm.readInt16LE(i * 2);
    acc += v * v;
  }
  return Math.sqrt(acc / samples);
}

/** WAV バイト列から data チャンクの生 PCM を取り出す (VOICEVOX の合成結果用) */
export function wavToPcm(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("WAV ではないデータを受け取りました");
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      return wav.subarray(offset + 8, Math.min(offset + 8 + size, wav.length));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV に data チャンクが見つかりません");
}
