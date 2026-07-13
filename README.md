# dbot-k2j — Discord 韓国語→日本語 音声翻訳ボット

Discord のボイスチャンネルで、**指定した韓国語話者**の発話をほぼリアルタイムに日本語へ翻訳し、
**VOICEVOX の音声で読み上げ + 字幕をテキスト投稿**するボットです。

```
[VC の韓国語発話]
   → 音声認識 (ローカル faster-whisper / OpenAI から選択)
   → 翻訳 (DeepL / Claude から選択)
   → 日本語読み上げ (VOICEVOX) + 字幕投稿
```

- 話者はコマンドで指定するため、日本語話者の発話が誤翻訳されることはありません
- すべて Docker Compose で動作。外部公開ポート不要 (アウトバウンド通信のみ) なので、そのまま AWS 等へ移設できます

## 必要なもの

| もの | 入手先 |
|---|---|
| Discord Bot トークン | [Discord Developer Portal](https://discord.com/developers/applications) (下記手順) |
| DeepL API キー **または** Anthropic API キー | [DeepL API](https://www.deepl.com/ja/pro-api) (無料枠 50万字/月) / [Anthropic Console](https://platform.claude.com) |
| (OpenAI の音声認識を使う場合のみ) OpenAI API キー | [OpenAI Platform](https://platform.openai.com) |
| Docker + Docker Compose | インストール済みであること |

## セットアップ

### 1. Discord Bot を作成する

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → 名前を付けて作成
2. 左メニュー **Bot** → **Reset Token** → 表示されたトークンを控える (`.env` に書く)
3. 特権 Intent (Presence / Server Members / Message Content) は**すべて OFF のままで OK** (音声のみ使用)
4. サーバーへの招待は、bot 起動時のログに出る招待 URL を使うのが簡単です。手動で作る場合:
   `https://discord.com/api/oauth2/authorize?client_id=<アプリのAPPLICATION ID>&permissions=3214336&scope=bot%20applications.commands`
   (権限 = チャンネル閲覧 / メッセージ送信 / 履歴閲覧 / 接続 / 発言)

### 2. 設定ファイルを作る

```bash
cp .env.example .env
# .env を編集: DISCORD_TOKEN と、使う翻訳エンジンの API キーを設定
```

既定の構成 (`.env.example` のまま) は **ローカル音声認識 + DeepL 翻訳 + 読み上げ ON** です。

### 3. 起動

```bash
docker compose up -d --build
docker compose logs -f bot   # 起動ログと招待 URL を確認
```

ローカル音声認識のモデルは**初回の発話時に自動ダウンロード**されます (small で 1 分弱)。
事前に疎通確認とモデル取得を済ませるには:

```bash
node scripts/smoke.mjs
```

### 4. Discord 上での使い方

| コマンド | 説明 |
|---|---|
| `/k2j add @ユーザー` | 韓国語話者として指定 (要: サーバー管理権限) |
| `/k2j remove @ユーザー` | 指定を解除 |
| `/k2j list` | 指定中の話者一覧 |
| `/k2j join` | 自分が入っている VC にボットを接続して翻訳開始 |
| `/k2j leave` | VC から切断 (VC が無人になると自動退出もします) |
| `/k2j tts on\|off` | 読み上げの ON/OFF (OFF でも字幕は投稿されます) |
| `/k2j subtitle [#チャンネル]` | 字幕の投稿先 (省略時は VC 内蔵のテキストチャット) |
| `/k2j status` | エンジン設定・処理件数・DeepL 使用量などを表示 |

字幕はこの形式で投稿されます:

> **みんちゃん**：今日のゲーム本当に面白かった
> <sub>오늘 게임 진짜 재밌었어</sub>

投稿された字幕は、チャンネルを流し過ぎないよう**既定で 30 秒後に自動削除**されます
(`.env` の `SUBTITLE_TTL_MS` で変更、`0` で削除しない)。

## エンジンの切り替え

すべて `.env` の編集 + `docker compose up -d` の再実行で反映されます。

### 翻訳: DeepL ⇔ Claude

```bash
MT_PROVIDER=anthropic          # deepl → anthropic に変更
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5   # 品質重視なら claude-opus-4-8 等に変更可
```

- **DeepL**: 無料枠 50万字/月。VC をよく使うと逼迫することがあるので `/k2j status` で使用量を確認
- **Claude**: 口語・ゲームスラング・認識ミスの補正に強い。既定の `claude-haiku-4-5` ($1/$5 per 100万トークン) なら通常利用で月数十〜数百円程度

### 音声認識: ローカル ⇔ OpenAI

```bash
# OpenAI に切り替える場合
STT_BASE_URL=https://api.openai.com/v1
STT_API_KEY=sk-...
STT_MODEL=gpt-4o-mini-transcribe   # 約 $0.003/分
COMPOSE_PROFILES=                  # ローカル STT コンテナを起動しない
```

- **ローカル (既定)**: 無料・音声を外部送信しない。精度/速度はモデル次第。`STT_MODEL=Systran/faster-whisper-medium` にすると精度が上がる (CPU 負荷増)
- **OpenAI**: 高精度・低遅延。音声が OpenAI に送信される点は留意

### 読み上げ音声の変更

```bash
VOICEVOX_SPEAKER=3   # 3 = ずんだもん ノーマル
```

話者 ID の一覧は `curl -s http://127.0.0.1:50021/speakers | jq '.[] | {name, styles: [.styles[] | {name, id}]}'` で確認できます。
VOICEVOX の音声を公の場で使う場合はキャラクター毎の利用規約 (クレジット表記 `VOICEVOX:ずんだもん` など) に従ってください。

## AWS などへの移設

このボットは**インバウンドポートを一切使いません** (Discord へのアウトバウンド WebSocket/UDP と各 API への HTTPS のみ)。
永続化が必要なのは 2 つのボリュームだけです:

- `bot-data` … ギルド毎の設定 (`settings.json`)
- `hf-cache` … ローカル STT のモデルキャッシュ (OpenAI STT 利用時は不要)

移設パターン:

1. **EC2 / Lightsail など (推奨・最も簡単)**: このリポジトリを配置して `docker compose up -d` するだけ。
   ローカル STT を使うなら 4 vCPU / 8GB RAM 程度を推奨。`STT_BASE_URL` を OpenAI にすれば 1 vCPU / 1〜2GB でも動きます (bot + voicevox のみ)
2. **ECS など**: `bot` イメージを ECR に push し、voicevox をサイドカーに。設定ボリュームを EFS 等に

## トラブルシューティング

| 症状 | 確認すること |
|---|---|
| ボットは VC にいるが何も起きない | `/k2j add` で話者を指定したか。`/k2j status` の処理件数が増えているか。`docker compose logs bot` |
| `音声認識サービスに接続できません` | ローカル STT: `.env` の `COMPOSE_PROFILES=local-stt` と `docker compose ps` で stt が起動しているか |
| 最初の認識だけ異常に遅い | 初回のモデルダウンロード。`docker compose logs stt` で進捗確認 |
| 認識精度が低い | `STT_MODEL=Systran/faster-whisper-medium` に上げる、または OpenAI STT へ切替。話者のマイク環境も影響大 |
| 読み上げされない (字幕は出る) | `docker compose logs voicevox`。`/k2j tts on` になっているか |
| 音声受信が突然壊れた | Discord の音声プロトコル (DAVE/E2EE) 更新の可能性。`cd bot && npm update @discordjs/voice discord.js` して再ビルド |
| 翻訳が遅い/欠ける | `/k2j status` のレイテンシ確認。読み上げが追いつかない分は自動スキップされます (字幕は全件投稿) |

## 既知の制限・注意

- **VC の音声受信は Discord の非公式機能**です。自己管理サーバでの利用を想定しています。Discord 側の変更で動かなくなる可能性があるため、その際は `@discordjs/voice` の更新で追随してください
- 音声認識は韓国語固定 (`STT_LANGUAGE=ko`) のため、**指定話者が日本語を話すと誤認識**されます (定型ノイズはフィルタで破棄されます)
- クラウド API 利用時は音声/テキストが外部 (OpenAI / DeepL / Anthropic) に送信されます。サーバのメンバーに周知しておくことを推奨します
- 読み上げは会話と被ることがあります。気になる場合は `/k2j tts off` で字幕のみの運用にしてください

## 開発

```bash
cd bot
npm install
npm run typecheck   # 型チェック
npm test            # ユニットテスト
```

構成: `bot/src/` — `voice/` (受信・区切り・再生) → `stt/` (OpenAI互換クライアント) → `mt/` (DeepL/Claude) → `tts/` (VOICEVOX) を `voice/pipeline.ts` が接続。Discord 側の入出力は `index.ts` と `commands.ts`。
