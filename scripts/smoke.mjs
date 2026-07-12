#!/usr/bin/env node
/**
 * stt / voicevox コンテナの疎通確認スクリプト。
 * ホストから実行する (compose が 127.0.0.1 にデバッグ用ポートを公開している):
 *   docker compose up -d stt voicevox
 *   node scripts/smoke.mjs
 * 初回は STT がモデルをダウンロードするため数分かかることがある。
 */
const STT_BASE = process.env.STT_SMOKE_URL ?? "http://127.0.0.1:18000/v1";
const VOICEVOX = process.env.VOICEVOX_SMOKE_URL ?? "http://127.0.0.1:50021";
const STT_MODEL = process.env.STT_MODEL ?? "Systran/faster-whisper-small";
const SPEAKER = process.env.VOICEVOX_SPEAKER ?? "3";

/** 16kHz mono の正弦波 WAV を生成 (内容は何でもよい。API が音声を受け付けるかの確認用) */
function sineWav(seconds = 1, freq = 440, rate = 16000) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), 44 + i * 2);
  }
  return buf;
}

let failed = false;

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failed = true;
    console.error(`❌ ${name} — ${e.message}`);
  }
}

await check("STT /models 応答", async () => {
  const res = await fetch(`${STT_BASE}/models`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return STT_BASE;
});

await check("STT モデルのインストール (初回はダウンロードあり)", async () => {
  const res = await fetch(`${STT_BASE}/models/${STT_MODEL}`, {
    method: "POST",
    signal: AbortSignal.timeout(600_000),
  });
  const body = (await res.text()).slice(0, 200);
  if (!res.ok && !body.includes("already")) throw new Error(`HTTP ${res.status}: ${body}`);
  return body;
});

await check("STT 音声書き起こし", async () => {
  const form = new FormData();
  form.append("file", new Blob([sineWav()], { type: "audio/wav" }), "audio.wav");
  form.append("model", STT_MODEL);
  form.append("language", "ko");
  form.append("response_format", "json");
  const res = await fetch(`${STT_BASE}/audio/transcriptions`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return `model=${STT_MODEL} text=${JSON.stringify(json.text ?? "")}`;
});

await check("VOICEVOX /version 応答", async () => {
  const res = await fetch(`${VOICEVOX}/version`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return `version=${(await res.text()).replaceAll('"', "")}`;
});

await check("VOICEVOX 音声合成 (48kHz stereo)", async () => {
  const q = await fetch(
    `${VOICEVOX}/audio_query?speaker=${SPEAKER}&text=${encodeURIComponent("テストです")}`,
    { method: "POST", signal: AbortSignal.timeout(30_000) },
  );
  if (!q.ok) throw new Error(`audio_query HTTP ${q.status}`);
  const query = await q.json();
  query.outputSamplingRate = 48000;
  query.outputStereo = true;
  const s = await fetch(`${VOICEVOX}/synthesis?speaker=${SPEAKER}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(60_000),
  });
  if (!s.ok) throw new Error(`synthesis HTTP ${s.status}`);
  const wav = Buffer.from(await s.arrayBuffer());
  if (wav.toString("ascii", 0, 4) !== "RIFF") throw new Error("WAV が返ってきていません");
  return `${wav.length.toLocaleString()} bytes (speaker=${SPEAKER})`;
});

process.exit(failed ? 1 : 0);
