import { describe, expect, it } from "vitest";
import { pcm48kStereoToWav16kMono, pcmRms, wavToPcm } from "../src/voice/wav.js";

/** 48kHz stereo s16le の PCM を生成 (L=R=value) */
function stereoPcm(frames: number, value: number): Buffer {
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(value, i * 4);
    buf.writeInt16LE(value, i * 4 + 2);
  }
  return buf;
}

describe("pcm48kStereoToWav16kMono", () => {
  it("正しい WAV ヘッダを生成する", () => {
    const wav = pcm48kStereoToWav16kMono(stereoPcm(48_000, 1000)); // 1秒
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits
    expect(wav.readUInt32LE(40)).toBe(16_000 * 2); // 1秒分の data バイト数
    expect(wav.length).toBe(44 + 16_000 * 2);
  });

  it("サンプル値を維持したままダウンサンプルする", () => {
    const wav = pcm48kStereoToWav16kMono(stereoPcm(300, -2500));
    const pcm = wavToPcm(wav);
    expect(pcm.length).toBe(100 * 2); // 300 frames / 3
    for (let i = 0; i < 100; i++) {
      expect(pcm.readInt16LE(i * 2)).toBe(-2500);
    }
  });

  it("端数フレームを切り捨てて長さ 0 でも壊れない", () => {
    const wav = pcm48kStereoToWav16kMono(Buffer.alloc(2)); // 1フレーム未満
    expect(wav.readUInt32LE(40)).toBe(0);
  });
});

describe("pcmRms", () => {
  it("無音は 0、定数値はその絶対値になる", () => {
    expect(pcmRms(Buffer.alloc(200))).toBe(0);
    const buf = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) buf.writeInt16LE(1000, i * 2);
    expect(pcmRms(buf)).toBeCloseTo(1000, 5);
  });
});

describe("wavToPcm", () => {
  it("data チャンクを取り出せる", () => {
    const wav = pcm48kStereoToWav16kMono(stereoPcm(30, 42));
    expect(wavToPcm(wav).length).toBe(10 * 2);
  });

  it("WAV でないデータは拒否する", () => {
    expect(() => wavToPcm(Buffer.from("not a wav file at all"))).toThrow();
  });
});
