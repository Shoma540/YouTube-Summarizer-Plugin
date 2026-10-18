# 作業ルール

## ビルド
必ずこのフォルダ内で作業すること:
C:\Users\shoma\Documents\MyObsidian\.obsidian\plugins\My-YouTube-Summarizer-Plugin\

ビルドコマンドは必ず以下を使うこと:
npx esbuild src/main.ts --bundle --external:obsidian --external:electron --external:child_process --external:util --external:https --format=cjs --target=es2018 --outfile=main.js

main.jsの出力先は必ず上記フォルダ直下にすること。
他のフォルダのmain.jsを絶対に上書きしないこと。
ビルド後は必ずSelect-StringでclaudeApiKey・geminiApiKey・openaiApiKeyが含まれることを確認すること。

# CLAUDE.md — My-YouTube-Summarizer-Plugin 作業ルール

## プロジェクト基本情報

| 項目 | 内容 |
|---|---|
| プラグインフォルダ | `C:\Users\shoma\Documents\MyObsidian\.obsidian\plugins\My-YouTube-Summarizer-Plugin\` |
| Vault パス | `C:\Users\shoma\Documents\MyObsidian`（`MyObsidian\Obsidian` ではない） |
| ソース | `src/main.ts`、`get_transcript.py`、`article_fetcher.py` |
| ビルド成果物 | `main.js`（2026-09-07の清書プロンプト強化後は205KB前後が正常。80KB台・130KB台に戻っていたら別プラグイン混入や差分消失を疑う） |
| 保存先フォルダ | `Obsidian/Youtube要約` |

---

## ファイル構成

```
My-YouTube-Summarizer-Plugin/
├── main.js               # ビルド済み本体（直接編集禁止）
├── manifest.json         # プラグイン定義（変更禁止）
├── styles.css            # UIスタイル
├── get_transcript.py     # YouTube字幕取得
├── get_playlist.py       # 再生リストの動画一覧・再生リスト名・総本数取得（メンバー限定/非公開は除外）
├── article_fetcher.py    # 記事HTML取得・本文抽出・メタ情報取得
├── data.json             # 設定・APIキー・累計コスト・プロキシ設定
├── CLAUDE.md             # このファイル
└── src/
    └── main.ts           # 編集対象ソース
```

**編集するのは `src/main.ts` / `get_transcript.py` / `get_playlist.py` / `article_fetcher.py` のみ。`main.js` は必ずビルドで生成する。**

---

## ビルドコマンド（必ずこれを使う）

```powershell
cd "C:\Users\shoma\Documents\MyObsidian\.obsidian\plugins\My-YouTube-Summarizer-Plugin"
npx esbuild src/main.ts --bundle --external:obsidian --external:electron --external:child_process --external:util --external:https --format=cjs --target=es2018 --outfile=main.js
```

### ビルド後の確認（必須・省略禁止）

```powershell
Select-String -Path ".\main.js" -Pattern "claudeApiKey" | Select-Object -First 3
Select-String -Path ".\main.js" -Pattern "geminiApiKey" | Select-Object -First 3
Select-String -Path ".\main.js" -Pattern "openaiApiKey" | Select-Object -First 3
```

- `claudeApiKey`・`geminiApiKey`・`openaiApiKey` がそれぞれ3件以上 → 正常
- 見覚えのない別プラグイン由来の文字列が出る → 別プラグイン混入。即再ビルド
- main.js サイズ: 205KB前後が正常（清書プロンプト強化前は195KB前後、Gemini/OpenAI対応前は80KB前後だった）

---

## ⛔ 絶対にいじってはいけないもの

以下は変更・リファクタ・整理の対象外。理由があっても触らない。

### 処理フロー
- YouTube処理フロー（`summarizeVideo()` 相当）
- 記事URL処理フロー（`summarizeArticle()`）
- テキスト処理フロー（`summarizeText()`）
- PDF/画像ファイル処理フロー（`summarizePdf()`）

> 上記4フローの「プロンプト構築 → API呼び出し → `parseSections()`」という外形は不変。API呼び出し部分は `callModelWithFallback()` 経由でAnthropic/Gemini/OpenAIどれも呼べるよう共通化されている。

### プロンプト・パース
- 清書セクション名（`---SECTION:清書---`）
- セクションパースロジック（`parseSections()`）
- プロンプトのルール（外部知識禁止・数字優先・⚠️フラグ・出力言語）
- 出力言語ルール（`OUTPUT_LANGUAGE_RULE`）: 2026-09の追加。`SECTIONS_SPEC` の【出力言語（厳守）】と、動画・記事・テキスト・PDFの4フローの【最終確認】に入っている。日本語以外の素材は日本語に翻訳した上で清書させるためのもの（固有名詞・数字・URL・コード内は原文のまま）。削除しないこと。
- プロンプト内に `---` を出力させない指示

### 保存フォーマット
- frontmatterの構造（url / date / category）
- 本文中へのタイトル行挿入禁止（`# タイトル` を入れない）

### 設定・定数
- `manifest.json` の内容
- `USD_TO_JPY`（為替換算定数）
- `MODEL_REGISTRY` の `id` 文字列（Gemini/Anthropic/OpenAIのAPIモデル名と一致させる必要があるため、表示名`label`以外は変更しない）
- プロバイダ判定ロジック（`getModelInfo()` / `ModelInfo.provider` による Anthropic ⇔ Gemini ⇔ OpenAI の分岐）

> `DEFAULT_SETTINGS` の構造・`MODEL_PRICING` の値は2026-08のGemini対応で変更済み（旧ルールを解除）。今後モデルを追加する場合は `MODEL_REGISTRY` と `MODEL_PRICING` の両方に追記すること。

### UI・DOM操作
- ボタンテキスト更新は `textContent =` で行う（`setText()` 禁止・イベントリスナーが消えるため）
- 清書モーダルにカテゴリ欄は置かない（カテゴリは設定画面で管理し、保存前に自動分類する）
- URLモード（単一動画・記事）・再生リスト・Kindleは、送信後もモーダルを開いたままログエリアに進捗を出す。モーダルを閉じるのは`doneCallback`で成功パスを受け取ったときだけ（失敗時は閉じずにボタンを戻す）
- フォルダー名ドロップダウン: `new Menu()` は使わない。カスタムdiv（position: fixed）で実装。
  - CSSクラス: `.yt-summarizer-custom-dropdown-list`
  - 開閉時に `getBoundingClientRect()` でボタン座標を取得して top/left を動的にセット
  - z-index: 9999、max-height: 300px、overflow-y: auto
  - リスト外クリック（document の mousedown）で閉じる
- 保存先の行（`buildFolderNameRow()`）のレイアウト: 行は `flex-wrap: nowrap`。ドロップダウンのラッパーが `flex:1 / min-width:0`、ボタンが `width:100% / white-space:normal / overflow-wrap:anywhere / height:auto / min-height:32px` で、長い保存先名は折り返してボタンの高さが伸びる。`＋`と`✎`は `flex-shrink:0` で常に保存先名の右隣に並ぶ。`flex-wrap: wrap` に戻すとボタンが次の行に落ちるので戻さないこと

### その他
- コスト計算・表示ロジック（`calcCostUsd()`）
- ファイル保存はBOMなしUTF-8

---

## manifest.json（変更禁止）

```json
{
  "id": "youtube-summarizer",
  "name": "YouTube Summarizer",
  "version": "1.0.0",
  "minAppVersion": "1.0.0",
  "description": "YouTube, articles, text, and files cleaner for Obsidian",
  "author": "Custom",
  "isDesktopOnly": true
}
```

---

## DEFAULT_SETTINGS

```typescript
{
  claudeApiKey: "",
  geminiApiKey: "",
  openaiApiKey: "",
  outputFolder: "Obsidian/Youtube要約",
  modelPriority: ["gemini-2.5-flash", "claude-haiku-4-5-20251001", "claude-sonnet-4-6"],
  fallbackMode: "auto",  // "auto" | "manual"
  playlistConcurrency: 2,  // 再生リストの同時処理数（1〜4。loadSettingsでclampPlaylistConcurrency()により範囲外は丸められる）
  categories: ["投資・経済", "心理学", "語学", "ノート術", "学習法"],
  folderNames: [],
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  proxyConfig: {
    username: "",
    password: ""
  }
}
```

### data.json マイグレーション履歴
- `channels` → `fileNames` → `folderNames`（loadSettingsで自動移行済み）
- 「提案: 」プレフィックス付きデータ → プレフィックス除去（loadSettingsで自動修正済み）
- `proxyConfig.host` / `proxyConfig.port` → 廃止（Webshare専用のusername/passwordのみ）
- `model`（単一モデル選択の文字列） → `modelPriority`（3要素配列）+ `fallbackMode`（2026-08、loadSettingsで自動移行済み。旧`model`の値は引き継がず、常にGemini優先のデフォルト値で新規作成される）
- `openaiApiKey` 新設（2026-08、loadSettingsで自動補完済み）
- `playlistConcurrency` 新設（2026-09、未設定のdata.jsonは既定値2で補完。1〜4の範囲外・非数値は`clampPlaylistConcurrency()`が2または境界値に丸める）

---

## モデルレジストリ・料金定数

`MODEL_REGISTRY`（`src/main.ts`）で全モデルを一元管理。設定画面の優先順位1〜3ドロップダウンはここから選択肢を生成する。

```typescript
"gemini-2.5-flash":           provider: gemini,     input $0.30/1M, output $2.50/1M
"gemini-2.5-pro":             provider: gemini,     input $1.25/1M, output $10.0/1M（200K超で$2.50/$15.0だが簡略化して基本料金のみ計算）
"claude-sonnet-4-6":          provider: anthropic,  input $3/1M,    output $15/1M
"claude-haiku-4-5-20251001":  provider: anthropic,  input $1.0/1M,  output $5.0/1M
"claude-opus-4-6":            provider: anthropic,  input $15/1M,   output $75/1M
"gpt-5.6-sol":                provider: openai,     input $5.0/1M,  output $30.0/1M
"gpt-5.6-terra":              provider: openai,     input $2.0/1M,  output $12.0/1M
"gpt-5.6-luna":               provider: openai,     input $0.2/1M,  output $1.2/1M
USD_TO_JPY = 150
```

新モデル追加時は `MODEL_REGISTRY`（id/provider/label）と `MODEL_PRICING`（料金）の両方に追記すること。

---

## フォールバック機構（2026-08追加）

- `settings.modelPriority`: 3つのモデルIDを優先順位順に保持する配列。設定画面で自由に変更可能（Gemini/Claude/OpenAI混在も、同一プロバイダのみに揃えるのも自由）
- `settings.fallbackMode`:
  - `"auto"`: 優先順位1のモデルでエラー（レート制限・通信エラー・APIエラー等）が出ると、自動的に優先順位2→3の順で再試行する
  - `"manual"`: 自動フォールバックせず、常に優先順位1のモデルのみを使用する（優先順位2・3は未使用の控え）
- 実装は `callModelWithFallback()`（`src/main.ts`）。対応するプロバイダのAPIキーが未設定の候補は自動的にスキップする
- コスト計算は実際に応答した `modelUsed` を使う（`calcCostUsd(summary.modelUsed, ...)`）。優先順位1のモデル名では計算しないこと（フォールバックが発生した場合に料金を誤計算するため）

---

## 再生リストの並列処理（2026-09追加）

- 同時処理数は `settings.playlistConcurrency`（1〜4、既定2）。設定画面「再生リストの並列処理 → 同時処理数」で変更する。旧実装の `Math.min(2, n)` ハードコードは廃止
- 実装は `runPlaylistSummarize()` のワーカープール（`concurrency = Math.min(clampPlaylistConcurrency(settings.playlistConcurrency), n)`）。ワーカーは共有カウンタ `nextIndex` から次の動画を取るので、並列数を変えても処理順・重複チェック（`checkUrlDuplicates()`）の挙動は変わらない
- **コストは並列数では増えない**（課金はトークン量ベース、1本あたりのトークンは同じ）。ただし並列数を上げるとレート制限に当たりやすくなり、`callModelWithFallback()` が単価の高いモデル（Gemini Flash → Haiku → Sonnet で最大10倍）に切り替わる回数が増えるため、**実効単価は上がりうる**。清書が優先順位1以外のモデルで行われた場合、ログに `⚠️ フォールバック：{モデル名} で清書しました` を出す（並列数を下げる判断材料）
- リトライ待ちは `calcRetryDelayMs(attempt, rateLimited)`：指数バックオフ + ジッター±25%。通常エラーは2秒→4秒、レート制限（`isRateLimitMessage()` が `rate limit` / `RESOURCE_EXHAUSTED` / `429` / `tokens per minute` / `レート制限` に一致）は15秒→30秒、上限60秒。**1秒固定に戻さないこと**（3回とも同じ制限窓に当たって全滅し、動画が丸ごとスキップされるため）
- 3回失敗した動画はスキップされる（`⛔ スキップ：3回失敗しました`）。字幕なし動画も同じリトライ経路を通るため、スキップ確定までに約6秒かかる
- 並列数を上げるほどWebshareプロキシへの同時接続が増え、YouTube側の `IpBlocked` と帯域消費のリスクが上がる。3本が推奨上限
- Kindleのチャンク処理（`summarizeKindle()`）は従来どおり直列・1秒待ちリトライのままで、この変更の対象外

### メンバー限定・視聴不可の動画は一覧の時点で除外する（2026-09-20追加）

- `get_playlist.py` がフラット取得した各エントリの `availability` を見て、`subscriber_only`（メンバー限定）は `membersOnlyCount`、`private` / `premium_only` は `unavailableCount` として数え、**動画一覧（results）には含めない**。`availability` が `null` のものは「バッジ無しの通常動画」なので必ず残す（通常動画は `public` ではなく `null` で返ってくる）
- 除外本数は先頭のメタ行で返す: `{"playlistTitle": "...", "playlistCount": N, "membersOnlyCount": M, "unavailableCount": U}`（0本のキーは出さない）。`callPlaylistScript()` が読み取り、`PlaylistStats.membersOnly` / `.unavailable` に入れて、モーダルの統計行に `メンバー限定 M本（除外）` / `視聴不可 U本（除外）` として出す
- **取得漏れ警告（`読込 100/6092本`）の判定は `読込件数 + 除外件数 < 申告総本数` で行う。** `playlistCount` は除外分も含んだ数を返すので、除外分を足し忘れるとメンバー限定を含む再生リストで毎回yt-dlp更新の誤警告が出る
- 除外の結果0本になっても `callPlaylistScript()` はエラーにしない。`動画URLを取得できませんでした` を投げるのは「動画0本かつ除外も0本」のときだけ
- yt-dlp側の判定はバッジのstyle（`BADGE_STYLE_TYPE_MEMBERS_ONLY`）なので表示言語に依存しない。実測（2026-09-20）: `playlist?list=PL…` にはメンバー限定動画がバッジ付きで含まれる（67本中36本のケースを確認）。一方チャンネルのアップロード再生リスト（`list=UU…`）にはメンバー限定動画がそもそも含まれない
- `get_transcript.py` 側は変更していない。バッジが付かないケースが残った場合は従来どおり3回リトライ後にスキップされる

### 受付.md への追記は必ず直列（重要）

`appendReceptionEntry()` は `vault.read()` → 加工 → `vault.modify()` の read-modify-write で、`await` を挟むため並列に走ると後勝ちで先の追記が消える（ノート本体は保存されるので気づきにくい）。`tryAppendReceptionEntry()` が `this.receptionQueue`（Promiseチェーン）で全呼び出しを直列化している。**このキューを外して直接 `appendReceptionEntry()` を呼ばないこと。** 追記の失敗はキューを止めない（`run.then(() => undefined, () => undefined)` でチェーンを継続させる）。

---

## 動作モード（5種類）

| モード | 条件 | 動作 |
|---|---|---|
| YouTube | YouTube URL あり | 文字起こし＋概要欄 → `callModelWithFallback()`（Gemini/Claude/OpenAI） |
| 記事URL | YouTube以外のURL あり | article_fetcher.py で本文取得 → `callModelWithFallback()` |
| ファイル | URL なし・PDF/画像添付あり | Claude利用時は`type:"document"`/`type:"image"`、Gemini利用時は`inlineData`、OpenAI利用時は`input_file`/`input_image`でネイティブ送信 |
| テキスト | URL なし・ファイル添付なし・テキスト入力あり | テキスト直接 → `callModelWithFallback()` |
| Kindle | 入力方法タブで「Kindle」を選択 | Vault内の `Source/Obsidian/Kindle` のノートを読み、ハイライトを分割して `callModelWithFallback()` を複数回呼び、1ファイルに結合 |

**入力優先順位:** Kindleタブ選択時はKindle処理。それ以外は URL > ファイル > テキスト

> 独立した画像添付・画像のみモードは廃止（2026-07 削除）。`AttachedImage` / `MAX_IMAGES` / `buildImageOnlyPrompt` / `SummarizeMode` は撤去済み。現在はPDF欄を拡張したファイル添付として、PDF/画像を同一フローで扱う。YouTubeは常にA相当の単一フロー。

### ファイル添付モード仕様
- 最大3ファイル（`MAX_PDFS=3`）。PDFは各30ページまで（`MAX_PDF_PAGES=30`）。超過は Notice で拒否
- 画像形式は JPEG / PNG / WebP / GIF。画像は1枚3.75MB以下、各辺8000px以下。超過は Notice で拒否
- ページ数は `countPdfPages()` が base64 を `atob` して `/Type /Page` を数える簡易判定。圧縮PDFで0判定になる場合は通す（安全側で拒否しない）
- PythonやPDFライブラリは不使用。base64データは共通で、Claude利用時は document/image ブロック、Gemini利用時は `inlineData`(`mimeType`+`data`)、OpenAI利用時は `input_file`(`file_data`にdata URI)/`input_image`(`image_url`にdata URI) に変換して送信（`buildAnthropicContent()` / `callGemini()` / `callOpenAI()`）
- プロンプトは `buildPdfPrompt()`（添付ファイルから1行目タイトル抽出 → 清書セクション、`parseSections(text, true)`）
- タイトル: タイトル入力欄 → 添付ファイルから抽出 → ファイル名（拡張子除去）→ `file_日付` の順でフォールバック
- 保存: `savePdfNote()`。frontmatterは `date` / `category`（urlなし）。PDF/画像は `summarizePdf()` の同一フローで処理

### Kindleモード仕様（2026-08追加）
- 入力元は `KINDLE_SOURCE_FOLDER = "Source/Obsidian/Kindle"` 配下の `.md`（obsidian-kindle-pluginが作るハイライトノート）
- 保存先は `KINDLE_OUTPUT_FOLDER = "Source/Obsidian/Kindle清書"` に固定。`settings.outputFolder` とフォルダー名ドロップダウンは一切使わない（Kindleタブ選択中は保存先の行を非表示にする）
- 出力は既存のKindle清書ノートに合わせる。**frontmatterなし・`## 見出し` + `---` 区切りのみ**。`buildStandardCleanNote()` は使わない
- ファイル名は `{書名}_清書版.md`。書名は「タイトル入力欄 → ノートのH1見出し → frontmatterの`kindle-title`（YAMLの`>-`ブロックスカラー対応） → ファイル名（先頭の`著者-`を除去）」の順。空白は `_` に置換する
- Kindleタブでは「Kindleの本」の行をタイトル行の上に差し込む（`contentEl.insertBefore(kindleRow, titleRowEl)`）。本を選ぶ→タイトルを決める、の順にするため
- タイトル欄の右の `▼` はKindleタブなら常に表示する。本を未選択のときは「先に「Kindleの本」を選んでください」とだけ出す。本を選ぶと書名の候補が並ぶ（`buildKindleTitleCandidates()`）。候補は「H1見出し → 各候補の`：`より前 → 各候補の全角スペースより前 → `kindle-title`全文 → ファイル名から著者を除いたもの → ファイル名」の順で重複を除いたもの。先頭が既定値として自動で入る。手入力も従来どおり可能
- カテゴリ自動分類・`Index/受付.md`への追記は行わない（Youtube清書の一覧・Basesの対象外のため）
- ハイライトは `---` 行で分割し、`— location: [..](kindle://..)` と `^ref-xxxx` を除去してからAIに渡す
- `KINDLE_CHUNK_CHARS = 9000` 文字ごとにチャンク化し、チャンクごとに `callModelWithFallback(..., CLEANUP_MAX_TOKENS)` を呼ぶ。結果は `\n\n---\n\n` で連結して1ファイルに保存する
- チャンクは3回までリトライ（1秒待ち）。3回失敗した範囲はスキップして続行し、Noticeとログに失敗回数を出す
- 実装は `summarizeKindle()` / `saveKindleNote()` / `buildKindlePrompt()` / `extractKindleHighlightBlocks()` / `chunkKindleHighlightBlocks()` / `cleanKindleCleanupOutput()`
- Kindleのプロンプトは `---SECTION:清書---` 形式を使わない。Markdown本文を直接出させ、`parseSections()` は通さない（見出し間の `---` 区切りが必要なため）

---

## プロンプトルール（変更禁止）

1. 文字起こし・概要欄・入力テキストの情報のみ使用。外部知識補完禁止
2. 概要欄に数字・金額・パーセント・年号がある場合は概要欄絶対優先
3. 相対時間表現（去年・今年）は概要欄の絶対年号に置き換え
4. `[⚠️不確か]` フラグ箇所は要約内に ⚠️ マーク付きで注意喚起
5. 出力セクションは以下の1つ固定（名称変更禁止）:
   - `---SECTION:清書---`
6. セクション内に `---` を出力しない
7. **清書の定義（2026-09-07 追加・削除禁止）**: 清書とは「文字起こしの整形」ではなく「不要な発話を削って読める文章に書き直すこと」。プロンプトには以下の3ブロックを必ず含める。外すとモデルが逐語のまま出力し、全文文字起こしと変わらないノートになる
   - `CLEANUP_REMOVAL_SPOKEN`（動画）/ `CLEANUP_REMOVAL_WRITTEN`（記事・テキスト・ファイル）: 挨拶・自己紹介・チャンネル登録誘導・宣伝・**前置き**・フィラー・脱線・繰り返しを削除対象として明示する
   - `CLEANUP_STYLE_RULES`: 逐語で書き写さない／書き言葉に直す／`##`・`###` の見出しを付ける
   - `CLEANUP_LENGTH_SPOKEN`（元の半分以下）/ `CLEANUP_LENGTH_WRITTEN`（目安7割以下）: 分量の目標。**これが無いとモデルは安全側に倒れて逐語のまま出力する**
8. **「そのまま」を無条件に書かない（2026-09-07 追加）**: `COMMON_RULES` / `OUTPUT_LANGUAGE_RULE` の「そのまま使う」には必ず「数字・日付・固有名詞・年号の表記に限る」「言語を変えないという意味」の限定を付けること。限定なしの「そのまま」は7の削除指示と綱引きになり、逐語出力の原因になる
9. **素材を `substring()` で打ち切らない（2026-09-07 追加）**: 長い素材は `chunkLongText()` で分割して複数回清書する。打ち切ると後半が無警告で消える

---

## ノート保存フォーマット（変更禁止）

```markdown
---
url: "{url}"          # テキストモードはurlなし
date: {date}
category: "{category}"
---

## 清書
...
```

---

## 保存パス

```
フォルダー名あり: {outputFolder}/{フォルダー名}/{タイトル}.md
フォルダー名なし: {outputFolder}/{タイトル}.md
再生リスト:      {outputFolder}/{動画のチャンネル名}/{動画タイトル}.md（チャンネル名未取得時は選択済みフォルダー。通常は再生リスト名）
Kindleモード:    Source/Obsidian/Kindle清書/{書名}_清書版.md（フォルダー名は使わない）
```

**タイトルのフォールバック（優先順）:**
1. タイトル入力欄の値（手動入力 or 自動取得）
2. YouTube動画タイトル / 記事タイトル / テキスト先頭30文字
3. 各モード固有のフォールバック
4. ドメイン+日付は使わない（廃止済み）

**フォルダー名禁止文字:** `\ / : * ? " < > # [ ] 【】『』「」（）() {}` を除去。半角`|`のみ例外で全角`｜`に置き換え(2026-08〜。YouTubeチャンネル名などに`|`が含まれるケースで、削除すると意味が失われるため)

---

## モーダルUI構成

```
清書を作成

入力方法
[ URL ] [ テキスト ] [ ファイル ] [ Kindle ]

URL
[YouTube・記事・プレイリストのURL]

※ 入力方法が「テキスト」の場合のみ:
テキスト
[textarea 4行]

※ 入力方法が「ファイル」の場合のみ:
ファイル
[ドロップエリア 最大3件 / PDF各30ページまで / 画像3.75MB・8000pxまで]

※ 入力方法が「Kindle」の場合のみ（各ファイルタイトルの上に表示する）:
Kindleの本
[ドロップダウン Source/Obsidian/Kindle のノート一覧]

各ファイルタイトル
[1行入力（URLは自動取得、Kindleは書名を自動セット、テキスト・ファイルは任意）]  [▼ Kindleのみ: 候補から選ぶ]

保存先  [RIT ▼]  [✎]   ※ Kindleタブでは非表示

[清書開始 ▶]   ※ 処理中は同じ位置が [■ 停止] に入れ替わる
```

### キーバインド
- `Enter` → 清書開始
- `Shift+Enter` → 改行

### 処理の停止（2026-09追加）
- 清書を開始すると「清書開始 ▶」を隠して同じ位置に「■ 停止」（`.yt-summarizer-stop-btn`）を出す。状態の切り替えは `InputModal.beginRunningState()` / `endRunningState()` に集約する（各分岐で `submitBtn.disabled` を直接触らない）。
- 停止の実体は `RunController`。`plugin.beginRun()` で作って `activeRuns` に登録し、完了・失敗・停止のいずれでも `endRun()` で外す。
- `requestUrl` は中断できないので、**送信済みの1リクエストは最後まで待つ**。止まるのはチャンクの区切り・リトライ待機・モデルのフォールバック切り替えなどのチェックポイント。Pythonスクリプトは子プロセスを `kill()` するので即死する。
- 停止は `AbortedError` で伝える。`callModelWithFallback()` は `AbortedError` を**フォールバック対象にせず**そのまま投げ、`classifyCategory()` も握りつぶさずに再送出する。
- 再生リスト・Kindleは停止時点までの結果を保存する（再生リストは未処理分を「停止したため未処理」として結果一覧に残す）。停止したときはログを読めるようモーダルを閉じない。
- テキスト・ファイルモードはモーダルを閉じてしまうので、`runSummarize()` 側で `RunController` を作る。こちらはコマンドパレットの **「実行中の清書を停止」**（id: `stop-summarize`）から止める。このコマンドは `stopAllRuns()` で実行中の全ジョブを止める。
- 進捗Notice（`duration: 0`）は `ProgressNotice` で1本にまとめる。個別に `n1`/`n2`/`n3` を作ると途中で例外が出たとき後半のNoticeが消えずに残るため、`new Notice(..., 0)` を直接増やさないこと。

### ドロップダウンの動作
- フォルダー名ドロップダウン: `new Menu()` は使わない。カスタムdiv（position: fixed）で実装。
  - CSSクラス: `.yt-summarizer-custom-dropdown-list`
  - 開閉時に `getBoundingClientRect()` でボタン座標を取得して top/left を動的にセット
  - z-index: 9999、max-height: 300px、overflow-y: auto
- リスト外クリック（document の mousedown）で閉じる
- ボタンテキスト更新は `textContent =` で行う（`setText()` 禁止）
- フォルダー名ドロップダウンはVaultの実フォルダをスキャンして表示する。
  settings.outputFolder 配下のサブフォルダを TFolder でスキャンし、ソートして一覧表示。
  settings.folderNames は後方互換のため残すが、ドロップダウン表示には使わない。
  Vaultでフォルダを削除すると次回モーダルを開いたとき自動的に一覧から消える。
- フォルダー名の `[✎]` ボタン: autoFolderNameをインライン編集可能にする。
  インライン入力欄は keydown Enter と blur の両方で selectedFolderName・autoFolderName を更新して refreshFolderNameButton() を呼ぶ。
  Enterを押さずに清書開始ボタンをクリックしても編集内容が反映される。

### フォルダー名の自動取得（autoFolderName）
- YouTube URL → `fetchChannelName()` でチャンネル名取得（500ms debounce）
- 記事URL → `article_fetcher.py --meta-only` でサイト名取得（500ms debounce）
- 再生リストURL → `get_playlist.py`が動画一覧と一緒に再生リスト名を返し、チャンネル名を取得できない動画の保存先フォールバックとして保持（入力時点ですでに手動選択していた場合はその名前）。取得済み再生リストでは保存先選択を隠し、各動画を動画情報から取得したチャンネル名のフォルダーへ保存する
- 取得した名前を `autoFolderName`（一時）と `selectedFolderName` に即セット
- ドロップダウン先頭にセパレーター付きで表示（Vaultスキャン結果に同名があればスキップ）
- モーダルを閉じると消える（`folderNames` には保存しない）

### カテゴリ分類
- 清書モーダルにはカテゴリ欄を表示しない。
- カテゴリ候補は設定画面の「カテゴリ管理」で追加・編集・削除する。
- 清書保存前に、タイトル・URL・フォルダー名・概要欄・清書本文を使い、既存カテゴリ一覧からAIが1つだけ選ぶ。再生リストでは、その動画の実際の保存先フォルダー名（チャンネル名、取得不能時は再生リスト名）を分類に渡す。
- AI分類が失敗した場合は `未分類` を保存する。
- AIに新しいカテゴリ名を作らせない。

### タイトルの自動取得
- YouTube URL → 動画タイトルを取得して入力欄にセット（500ms debounce）
- 記事URL → `article_fetcher.py --meta-only` の `title` をセット
- テキスト・ファイル → 空欄（ファイルはClaudeが内容から抽出、なければファイル名）

---

## article_fetcher.py 仕様

### 通常モード
```
python article_fetcher.py "{url}"
stdout: {"title": "...", "siteName": "...", "text": "..."}
stderr: ERROR: ... （エラー時、exit code 1）
```

### メタのみモード
```
python article_fetcher.py --meta-only "{url}"
stdout: {"title": "...", "siteName": "...", "text": ""}
```

- タイムアウト: 10秒 / User-Agent: `Mozilla/5.0`
- JS描画サイト非対応（本文500文字未満でエラー）

### サイト名取得ロジック（優先順）
1. `<meta property="og:site_name">`
2. `<meta name="application-name">`
3. `<title>` を `｜ / - – —` で分割し、先頭・末尾トークンのうち短い方を採用（2026-08修正: 「サイト名｜記事タイトル」「記事タイトル｜サイト名」どちらの並びでも対応するため。以前は末尾固定だったため、サイト名が先頭にある形式で記事タイトル側を誤取得していた）
4. 取れなければ `""`

---

## get_transcript.py 仕様

- `youtube-transcript-api` v1.2.4
- 手動字幕優先、なければ自動字幕
- 数字矛盾: `[⚠️数字矛盾 手動:X 自動:Y]`
- 低信頼度セグメント: `[⚠️不確か:...]`
- ビデオID抽出: URL・短縮URL・IDのみすべて対応
- Webshare Rotating Residentialプロキシ使用（`WebshareProxyConfig`）

### エラーコード一覧

| code | 原因 |
|---|---|
| `IP_BLOCKED` | YouTubeがIPをブロック |
| `NO_TRANSCRIPT` | 字幕が存在しない |
| `TRANSCRIPTS_DISABLED` | 字幕が無効化されている |
| `VIDEO_UNAVAILABLE` | 動画が非公開・削除・地域制限 |
| `INVALID_VIDEO_ID` | ビデオIDが不正 |
| `NETWORK_ERROR` | ネットワーク接続エラー |
| `UNKNOWN_ERROR` | その他 |

---

## Webshareプロキシ設定

- プラン: Rotating Residential $3.50/月（1GB帯域幅）
- 設定場所: Obsidian設定 → YouTube Summarizer → Webshareプロキシ設定
- Proxy Username / Proxy Password: `https://dashboard.webshare.io/proxy/settings` で確認
- 帯域幅確認: `https://dashboard.webshare.io`
- 月約1,800〜4,000本が1GB以内の目安
- 解約は即時反映（月末まで使いたい場合は更新日直前にキャンセル）

---

## コスト表示

```
✅ 清書完成！
清書モデル: {model}
カテゴリ分類: {model}
今回: {input}in + {output}out tokens
今回: ${cost}（約{円}円）
累計: ${total}（約{円}円）
```

設定画面: 累計入力・出力トークン、累計コスト表示、リセットボタン

---

## よくあるバグと対処

| 症状 | 原因 | 対処 |
|---|---|---|
| プラグインが認識されない | manifest.json に BOM 混入 | BOMなしで再保存 |
| 別プラグインの動作をする | main.js に別ファイルが混入 | 再ビルド後に `claudeApiKey` 確認 |
| 追加後ドロップダウンが開かない | `setText()` でイベントロスト | `textContent =` を使う |
| IP_BLOCKED エラー | YouTubeにIPブロックされている | Webshareプロキシ設定を確認 |
| NETWORK_ERROR エラー | プロキシ認証情報が誤り | Obsidian設定のUsername/Passwordを確認 |
| 字幕が取得できない | youtube-transcript-api バージョン不一致 | `pip show youtube-transcript-api` でv1.2.4確認 |
| 記事本文が空 | JS描画サイト | エラーNotice表示。対応外 |
| ProxyConfigインポートエラー | パッケージ内のパスが変わった | `from youtube_transcript_api.proxies import WebshareProxyConfig` を使う |
| 入力が長すぎます（1分間のトークン上限を超えました） | 動画・テキストが長すぎてAPIのレート制限に抵触（Claude/Gemini/OpenAI共通） | テキストを分割して入力するか短い動画で試す |
| Geminiが選ばれず常にClaudeが使われる | `geminiApiKey`未設定、または`fallbackMode`が期待通りでない | 設定画面でGemini APIキーと優先順位1〜3、フォールバックモードを確認 |
| GPTが選ばれない | `openaiApiKey`未設定 | 設定画面でOpenAI APIキーと優先順位1〜3を確認 |
| 記事の自動フォルダ名(サイト名)に｜が含まれる部分が入らない/記事タイトル側が入ってしまう | `extract_site_name()`が「サイト名｜記事タイトル」の並びを「記事タイトル｜サイト名」と誤認識(2026-08修正済み、`article_fetcher.py`) | 現在は先頭・末尾トークンのうち短い方をサイト名として採用。それでも誤取得する場合はサイト側の`og:site_name`未設定が原因なので手動でフォルダ名を編集 |
| 再生リスト処理後に`Index/受付.md`のエントリが動画本数より少ない | 並列処理中の`appendReceptionEntry()`のread-modify-writeが競合し、後勝ちで上書きされていた（2026-09修正済み） | `tryAppendReceptionEntry()`の`receptionQueue`による直列化が入っているか確認。消えた分は手動で追記 |
| 再生リストのメンバー限定動画が3回リトライしてスキップされる | 一覧の時点で除外していなかった（2026-09-20修正済み） | `get_playlist.py` が `availability == "subscriber_only"` を除外しているか確認。除外されていればモーダルの統計行に `メンバー限定 N本（除外）` と出る |
| 再生リストが100本までしか読み込まれない | yt-dlpが古く、YouTubeの仕様変更で2ページ目以降の継続取得に失敗している。エラーも警告も出さず1ページ目の100件だけを返す（2026-09-09に検知機能を追加） | モーダルに `読込 100/6092本` と警告行が出ていたら `python -m pip install --upgrade yt-dlp` を実行してObsidianを再起動する |
| フォルダー名に含めた半角`\|`が保存後に消える | 半角`\|`はWindowsのファイル/フォルダ名禁止文字のためNTFS上に作成できず、`sanitize()`/`normalizeFolderNameCandidate()`が除去していた | 2026-08〜、半角`\|`は削除ではなく全角`｜`に自動置換されるよう修正済み(他の禁止文字`\ / : * ? " < >`は従来通り削除) |

**実装メモ:** `callAnthropic()`/`callGemini()`/`callOpenAI()` の `catch` ブロックでエラーメッセージに `"rate limit"` または `"tokens per minute"` が含まれる場合、日本語の専用メッセージを Notice で表示する（全モード共通、Gemini側は429/RESOURCE_EXHAUSTED時、OpenAI側は429/rate_limit_exceeded時に明示的に`"rate limit"`を付与）。`callModelWithFallback()`が`fallbackMode:"auto"`の場合、この判定はモデルごとに行われ、失敗した候補は次の優先順位へ回される。

---

## 字幕なし動画のフォールバック（2026-08追加）

- 対象: `TranscriptError`のcodeが`NO_TRANSCRIPT`または`TRANSCRIPTS_DISABLED`の場合（字幕が存在しない・無効化されている動画）
- `geminiApiKey`が設定されている場合のみ発動。未設定なら従来通り「❌ この動画には字幕がありません」のNoticeで終了
- 動作: 文字起こしを使わず、YouTube動画のURLをそのままGemini APIに`fileData.fileUri`として渡し、Geminiに動画（音声・映像）を直接視聴させて清書を生成する（`buildVideoUrlPrompt()` → `callGemini(..., videoUrl)` → `parseSections()`）
- 実装: `YTSummarizerPlugin.summarizeVideoByUrlWithGemini()`。単一URL処理は`runSummarize()`の`NO_TRANSCRIPT`/`TRANSCRIPTS_DISABLED`ケース内、プレイリスト処理は`summarizeSingleVideoForPlaylist()`の`fetchYouTubeData()`失敗時キャッチ内から呼ばれる
- 使用モデル: `getFallbackGeminiModelId()`が`modelPriority`内の最初のGeminiモデルを選ぶ（`modelPriority`にGeminiが無ければ`gemini-2.5-flash`にフォールバック）。Claude/OpenAIへのフォールバックは行わない（この機能はGemini API固有のため）
- タイトル・概要欄・公開日は`fetchVideoMeta()`（`get_transcript.py --meta-only`）から取得。`--meta-only`モードは従来`publish_date`を常に空文字で返していたが、この対応で実際の値を返すよう修正済み
- 保存フォーマット・清書セクション構成・プロンプトの基本ルールは通常のYouTube処理フローと同一。「文字起こし」を「添付された動画」に置き換えた専用プロンプト（`buildVideoUrlPrompt()`）を使う点のみ異なる

---

## 変更履歴

- 2026-10-18: 再生リスト動画の保存先を他のYouTube動画と同じチャンネル名フォルダーに統一。カテゴリ分類にも実際の保存先名を渡し、再生リスト取得後は誤解を招く手動保存先の行を隠してチャンネル別保存を表示。標準ビルドでNode組み込みの`https`を外部扱いにし、`main.js`を更新できるようにした。
- 2026-09-20: **`MODEL_PRICING` の Claude Haiku 4.5 の単価を実際の料金に修正した。** `claude-haiku-4-5-20251001` を input $0.8/1M・output $4/1M としていたが、現行の公式料金は input $1.0/1M・output $5.0/1M（旧Haiku 3.5の$0.8/$4を引きずっていた）。Haiku で清書した分のコストが約25%過小計上されていた（`calcCostUsd()` が今回分・累計の両方に使うため、`data.json` の `totalCostUsd` に記録済みの過去分はそのまま。必要なら設定画面の累計リセットで作り直す）。料金定数以外は不変。
- 2026-09-20: **再生リスト結果モーダルの失敗一覧を「URL一括コピー＋理由のみ」に変更した。** 従来は失敗した動画ごとにカード（動画タイトル＋URL入力欄＋コピーボタン＋理由）を並べていたため、失敗が多いと1本ずつコピーする必要があり、タイトルの情報量も再試行の役に立っていなかった。失敗URLを改行区切りでまとめた読み取り専用テキストエリア（`.yt-summarizer-result-url-area`、最大10行・縦リサイズ可）と`URLをまとめてコピー（N件）`ボタン（`.yt-summarizer-result-copy-all-btn`）に置き換え、動画タイトルの表示は廃止して理由だけを出すようにした。理由は同一文言でまとめて `理由: 〜 ×N件` と表示する（`.yt-summarizer-result-reason-list`）。あわせて失敗理由が空文字のときに `（3回リトライ済み）` だけになっていたのを直し、`不明なエラーが発生しました（3回リトライ済み）` と出るようにした（`runPlaylistSummarize()` の `results.push`）。クリップボードAPIが失敗したときはテキストエリアを選択状態にして手動コピーへ逃がす。旧CSS（`.yt-summarizer-result-failed-title` / `-url-row` / `-url-input`）は未使用になったため削除。再生リストの処理フロー・リトライ回数・プロンプト・パース・保存フォーマットは不変。
- 2026-09-20: **メンバー限定動画を再生リスト取得の時点で除外するようにした。** 従来はメンバー限定動画も一覧に含まれ、字幕も動画本体も取れないまま3回リトライして `⛔ スキップ：3回失敗しました` になっていた（1本あたり待機込みで約6秒＋字幕なし扱いでGeminiフォールバックを無駄打ちする可能性）。`get_playlist.py` がフラット取得エントリの `availability` を見て `subscriber_only` を除外し、除外本数を `membersOnlyCount` としてメタ行で返すようにした。あわせて非公開・Premium限定（`private` / `premium_only`）も `unavailableCount` として除外する。`callPlaylistScript()` の戻り値・`PlaylistStats`・モーダルの統計行に除外本数を通し、取得漏れ警告の判定を「読込件数＋除外件数」に修正した（除外分を足さないとメンバー限定を含む再生リストで毎回yt-dlp更新警告が誤発生するため）。単一動画URL・記事・テキスト・ファイル・Kindleの各フロー、プロンプト・パース・保存フォーマットは不変。
- 2026-09-19: **清書処理を途中で止められるようにした。** 従来は開始すると中断手段が無く（ボタンが `処理中...` で無効になるだけ、`Esc` でモーダルを閉じても処理はバックグラウンドで継続）、止めるにはObsidian自体のリロードしかなかった。`RunController`（`abort()` / `throwIfAborted()` / 中断可能な `sleep()` / 子プロセスの `kill()`）と `AbortedError` を追加し、モーダルに「■ 停止」ボタン、コマンドパレットに「実行中の清書を停止」（`stop-summarize`）を新設。`callModelWithFallback()` / `classifyCategory()` / 各 `*WithModel()` のチャンクループ / 再生リストのワーカーとリトライ待機 / Kindleのチャンクループに停止チェックを入れ、`execFileAsync`（`promisify(execFile)`）を子プロセスを保持する `execFileText()` に置き換えた。`requestUrl` は中断できないため送信済みの1リクエストは待つ。再生リスト・Kindleは停止時点までの結果を保存する。あわせて進捗Noticeを `ProgressNotice` に一本化し、清書中・分類中に例外が出ると `n2`/`n3` のNoticeが消えずに残っていた不具合を修正した。4処理フローの「プロンプト構築 → API呼び出し → `parseSections()`」の外形・プロンプト・パース・保存フォーマットは不変。
- 2026-09-09: **再生リストが100本までしか取得できていなかった問題を修正。** 原因はプラグイン側ではなく yt-dlp 2026.3.17 で、YouTubeの仕様変更により再生リストの2ページ目以降の継続取得に失敗し、エラーも警告も出さずに1ページ目の100件だけを返していた（`playlist_count` は6092と正しく認識した上で100件しか返さない。`extract_flat` の値変更・`playlistend` 指定・`ignoreerrors:False` のいずれでも回避不可）。yt-dlp を 2026.8.19 に更新して解消（6092本全件を23.6秒で取得、stdoutは732KBで `maxBuffer: 5MB` に収まる）。**`ensure_ytdlp()` は import 失敗時にしかインストールしないため、一度入ったyt-dlpは自動では上がらない。同じ劣化は再発する。** 再発時に気づけるよう、`get_playlist.py` が再生リストの申告総本数を `{"playlistTitle": "...", "playlistCount": N}` として先頭行に出力し、`callPlaylistScript()` の戻り値に `playlistCount` を追加、`PlaylistStats.total` に保持して、取得件数が総本数に届かない場合はモーダルの統計を `読込 100/6092本` 表示に切り替えたうえで警告行（`.yt-summarizer-playlist-warning`）を出すようにした。非公開・削除された動画を含む再生リストでは取得件数が総本数を下回るのが正常なため、**処理はブロックせず警告表示にとどめている**（ハードエラーにすると通常の再生リストで誤検知するため）。単一動画URLの出力形式・処理フロー・プロンプト・パース・保存フォーマットは不変。
- 2026-09-07: **清書が「全文文字起こしの整形」になっていた問題を修正。** 原因は2つで、(1) プロンプトの削除対象が「話し言葉・フィラー・脱線した例え話・繰り返し・冗長な表現」の5つだけで、**前置き・挨拶・チャンネル登録誘導・宣伝が削除対象に入っておらず**、分量の目標も無かったこと、(2) `COMMON_RULES` の「文字起こしの表現をそのまま使うこと」×2 と `OUTPUT_LANGUAGE_RULE` の「そのまま清書すること」が限定なしで効いていて、削除指示と綱引きになっていたこと。対応として `CLEANUP_REMOVAL_SPOKEN` / `CLEANUP_REMOVAL_WRITTEN` / `CLEANUP_STYLE_RULES` / `CLEANUP_LENGTH_SPOKEN` / `CLEANUP_LENGTH_WRITTEN` を新設し、動画・記事・テキスト・ファイルの4フローの `cleanupSpec` を全面的に書き直したうえで、「そのまま」に限定句を付けた（プロンプトルール7・8）。処理フロー・セクション名・`parseSections()`・保存フォーマットは不変。
- 2026-09-07: **長い素材が無警告で途中まで保存されていた問題を修正。** (1) 入力側: `buildVideoPrompt()` / `buildArticlePrompt()` / `buildTextPrompt()` の `substring(0, 30000)` を廃止し、`chunkLongText()`（`CLEANUP_CHUNK_CHARS = 12000` 文字、文の切れ目で分割）でチャンク化して、`summarizeVideoWithModel()` / `summarizeArticleWithModel()` / `summarizeTextWithModel()` がチャンクごとにAPIを呼び結果を連結する方式にした（Kindleと同じ方式）。2番目以降のチャンクには `buildChunkPartNote()` が「前後の範囲に触れない・導入とまとめを書かない」注意を入れる。`## 概要欄` セクションは最後のチャンクでのみ生成する。(2) 出力側: 出力上限を `8000` から `CLEANUP_MAX_TOKENS = 16000` に引き上げ、`LlmCallResult.truncated`（Anthropic `stop_reason==="max_tokens"` / Gemini `finishReason==="MAX_TOKENS"` / OpenAI `status==="incomplete"`）を追加。上限で切れた場合は `notifyCleanupTruncated()` がNoticeとログに警告を出す。従来は9,000字前後で無警告に切れていた。進捗ログのため `summarizeVideoWithModel()` / `summarizeArticleWithModel()` / `summarizeSingleVideoForPlaylist()` に `logCallback` を追加した。
- 2026-09: 再生リストの同時処理数を設定画面から1〜4本で変更できるようにした（`settings.playlistConcurrency`、既定2。旧`Math.min(2, n)`ハードコードを廃止）。あわせて並列度を上げても安全に回るよう2点を修正: (1)`Index/受付.md`への追記を`receptionQueue`で直列化し、並列完了時に追記が上書きで消えるレースを解消、(2)再生リストのリトライ待ちを1秒固定から指数バックオフ+ジッター（通常2秒→4秒、レート制限15秒→30秒、上限60秒）に変更。さらに優先順位1以外のモデルで清書された場合に`⚠️ フォールバック：{モデル名}`をログに出すようにした（単価上昇の検知用）。処理フロー・プロンプト・パース・保存フォーマットは不変。
- 2026-09: 保存先の行のレイアウトを修正。長い保存先名でドロップダウンボタンが横に伸び、`＋`/`✎`が次の行に折り返してしまっていた。行を `flex-wrap: nowrap` にし、ボタン側を折り返し可（`white-space:normal` / `overflow-wrap:anywhere` / `height:auto`）にして、保存先名は複数行で全文表示・`＋`/`✎`は常に名前の右隣に固定されるようにした。
- 2026-09: 単一URL（YouTube動画・記事）でも再生リストと同じ処理ログを出すよう変更。従来は清書開始と同時にモーダルを閉じてNoticeだけで進捗を出していたが、URLモードではモーダルを開いたまま`yt-summarizer-log-area` にログを流し、完了時に`doneCallback`でモーダルを閉じる（失敗時はボタンを「清書開始 ▶」に戻して再実行可能）。`ModalResult`に`logCallback`/`doneCallback`を追加し、`runSummarize()`と`summarizeArticle()`が受け取る。ログ形式は再生リストに合わせた `[1/1] 処理開始：` / `[1/1] ✅ 完了：` / `[1/1] ❌ 失敗：`。併せて`saveNote()`/`saveArticleNote()`が保存先パスを返すようにした（`saveNoteForPlaylist()`と同じ）。テキスト・ファイル・Kindleモードの挙動は変更なし。4処理フローの「プロンプト構築 → API呼び出し → `parseSections()`」の外形は不変。
- 2026-08: Gemini優先 + 3段階フォールバック機能を追加。`geminiApiKey`/`modelPriority`/`fallbackMode`を新設し、旧`model`単一選択を置き換え。API呼び出しを`callAnthropic()`/`callGemini()`/`callModelWithFallback()`に共通化（4処理フローの外形・プロンプト・パースロジックは不変）。この変更に伴い、旧CLAUDE.mdの「DEFAULT_SETTINGS構造・モデル料金定数は絶対にいじらない」ルールをユーザー承認のうえ解除し、本ファイルを新構成に合わせて更新した。
- 2026-08: OpenAI(GPT-5.6ファミリー: sol/terra/luna)を3つ目のプロバイダとして追加。`openaiApiKey`を新設し、`callOpenAI()`(Responses API `/v1/responses`使用)を実装、`callModelWithFallback()`の分岐に組み込み。優先順位1〜3の選択肢にGPT-5.6系3モデルが追加され、Gemini/Claude/OpenAIを自由に混在・並び替え可能。
- 2026-08: `article_fetcher.py`の`extract_site_name()`を修正。「サイト名｜記事タイトル」の並び(サイト名が先頭)で記事タイトル側を誤ってサイト名として返していたバグを修正し、先頭・末尾トークンのうち短い方を採用するよう変更。
- 2026-08: フォルダー名・タイトルのサニタイズ処理(`sanitize()`各所・`normalizeFolderNameCandidate()`)を修正。半角`|`はWindows禁止文字のため従来は削除していたが、YouTubeチャンネル名などで意味が失われるため、削除ではなく全角`｜`に自動置換するよう変更。
- 2026-08: 再生リストのフォルダー名自動取得に対応。`get_playlist.py`がプレイリスト抽出時に`info.get("title")`(再生リスト名)を`{"playlistTitle": "..."}`行として先頭に出力するよう変更し、`callPlaylistScript()`の戻り値を`Array<{url,title}>`から`{items, playlistTitle}`に変更。`fetchPlaylistUrls()`が単一動画URL・記事URLと同様に`autoFolderName`/`selectedFolderName`へ即セットする。
- 2026-08: 入力方法タブに4つ目の「Kindle」を追加。`Source/Obsidian/Kindle` のハイライトノートをドロップダウンで選び、`Source/Obsidian/Kindle清書/{書名}_清書版.md` に保存する。既存のKindle清書ノートに合わせてfrontmatterなし・`## 見出し`＋`---`区切りの形式で出力し、カテゴリ分類と受付追記は行わない。長い本は9000文字ごとに分割してAIを複数回呼び、結果を1ファイルに結合する（チャンクごとに3回リトライ、失敗分はスキップして続行）。`settings.outputFolder`・保存先ドロップダウンは変更していない。
- 2026-08: 清書モーダルからカテゴリ欄を削除。カテゴリ候補は設定画面で管理し、清書保存前にAIが既存カテゴリ一覧から1つだけ分類する。分類失敗時は`未分類`を保存する。
