import { App, Editor, FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath } from "obsidian";
import { execFile } from "child_process";
import type { ChildProcess } from "child_process";
import * as https from "https";

/** 停止ボタンで打ち切ったときに投げる。通常のエラーとNoticeを出し分けるために区別する。 */
class AbortedError extends Error {
  constructor(message = "処理を停止しました") {
    super(message);
    this.name = "AbortedError";
  }
}

function isAbortedError(err: unknown): boolean {
  return err instanceof AbortedError;
}

/**
 * 清書1回分の停止スイッチ。
 * 停止時はPython子プロセスと実行中のHTTPSリクエストを直ちに中断する。
 */
class RunController {
  private aborted = false;
  private children = new Set<ChildProcess>();
  private wakeups = new Set<() => void>();
  private cancellers = new Set<() => void>();

  get isAborted(): boolean {
    return this.aborted;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const cancel of Array.from(this.cancellers)) cancel();
    this.cancellers.clear();
    for (const child of Array.from(this.children)) {
      try { child.kill(); } catch { /* 既に終了している */ }
    }
    this.children.clear();
    for (const wake of Array.from(this.wakeups)) wake();
    this.wakeups.clear();
  }

  throwIfAborted(): void {
    if (this.aborted) throw new AbortedError();
  }

  registerChild(child: ChildProcess): void {
    if (this.aborted) {
      try { child.kill(); } catch { /* 既に終了している */ }
      return;
    }
    this.children.add(child);
  }

  unregisterChild(child: ChildProcess): void {
    this.children.delete(child);
  }

  registerCanceller(cancel: () => void): () => void {
    if (this.aborted) {
      cancel();
      return () => undefined;
    }
    this.cancellers.add(cancel);
    return () => this.cancellers.delete(cancel);
  }

  /** リトライ待機用。停止されたら待たずに AbortedError で抜ける。 */
  sleep(ms: number): Promise<void> {
    this.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      let timer = 0;
      const wake = () => {
        window.clearTimeout(timer);
        this.wakeups.delete(wake);
        reject(new AbortedError());
      };
      timer = window.setTimeout(() => {
        this.wakeups.delete(wake);
        resolve();
      }, ms);
      this.wakeups.add(wake);
    });
  }
}

interface CancellableResponse {
  status: number;
  json: any;
}

/** ObsidianのrequestUrlは進行中リクエストを中断できないため、停止可能なHTTPSリクエストを使う。 */
function cancellableRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  controller?: RunController,
): Promise<CancellableResponse> {
  controller?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let unregister = () => undefined;
    const finish = (error?: Error, response?: CancellableResponse) => {
      if (settled) return;
      settled = true;
      unregister();
      if (error) reject(error);
      else resolve(response!);
    };
    const req = https.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("error", (err) => finish(controller?.isAborted ? new AbortedError() : err));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          finish(undefined, { status: res.statusCode || 0, json: JSON.parse(text) });
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    req.on("error", (err) => finish(controller?.isAborted ? new AbortedError() : err));
    unregister = controller?.registerCanceller(() => {
      req.destroy();
      finish(new AbortedError());
    }) ?? (() => undefined);
    req.end(body);
  });
}

/**
 * 自動で消えない進捗Notice（duration=0）を1本に束ねる。
 * 個別に n1/n2/n3 を作っていた頃は、途中で例外が出ると後半のNoticeが消えずに残っていた。
 */
class ProgressNotice {
  private current: Notice | null = null;

  show(message: string): void {
    this.hide();
    this.current = new Notice(message, 0);
  }

  hide(): void {
    this.current?.hide();
    this.current = null;
  }
}

interface ExecFileTextResult {
  stdout: string;
  stderr: string;
}

interface ExecFileTextOptions {
  timeout: number;
  encoding: "utf8";
  maxBuffer: number;
  windowsHide: boolean;
}

/**
 * execFile の Promise 版。promisify と違い子プロセスを RunController に登録するので、
 * 停止ボタンで走っている python を即 kill できる。
 * エラーに stdout/stderr を載せる挙動は promisify(execFile) と同じ。
 */
function execFileText(
  controller: RunController | undefined,
  file: string,
  args: string[],
  options: ExecFileTextOptions,
): Promise<ExecFileTextResult> {
  controller?.throwIfAborted();
  return new Promise<ExecFileTextResult>((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      controller?.unregisterChild(child);
      if (controller?.isAborted) {
        reject(new AbortedError());
        return;
      }
      if (error) {
        const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
    controller?.registerChild(child);
  });
}

class TranscriptError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

interface ProxyConfig {
  username: string;
  password: string;
}

type ModelProvider = "anthropic" | "gemini" | "openai";

interface ModelInfo {
  id: string;
  provider: ModelProvider;
  label: string;
}

const MODEL_REGISTRY: ModelInfo[] = [
  { id: "gemini-2.5-flash", provider: "gemini", label: "Gemini 2.5 Flash（高速・低コスト）" },
  { id: "gemini-2.5-pro", provider: "gemini", label: "Gemini 2.5 Pro（高品質）" },
  { id: "claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic", label: "Claude Haiku 4.5" },
  { id: "claude-opus-4-6", provider: "anthropic", label: "Claude Opus 4.6" },
  { id: "gpt-5.6-sol", provider: "openai", label: "GPT-5.6 Sol（最高品質）" },
  { id: "gpt-5.6-terra", provider: "openai", label: "GPT-5.6 Terra（バランス型）" },
  { id: "gpt-5.6-luna", provider: "openai", label: "GPT-5.6 Luna（高速・低コスト）" },
];

function getModelInfo(modelId: string): ModelInfo {
  return MODEL_REGISTRY.find((m) => m.id === modelId) || MODEL_REGISTRY[0];
}

function getModelLabel(modelId: string): string {
  return modelId ? getModelInfo(modelId).label : "未使用";
}

type FallbackMode = "auto" | "manual";

interface YTSummarizerSettings {
  claudeApiKey: string;
  geminiApiKey: string;
  openaiApiKey: string;
  outputFolder: string;
  modelPriority: [string, string, string];
  fallbackMode: FallbackMode;
  playlistConcurrency: number;
  categories: string[];
  folderNames: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  proxyConfig: ProxyConfig;
}

interface PlaylistStats {
  loaded: number;
  saved: number;
  unprocessed: number;
  /** 再生リストが申告している総本数。取得漏れ検知用（不明なら null） */
  total: number | null;
  /** 一覧取得の時点で除外したメンバー限定動画の本数 */
  membersOnly: number;
  /** 一覧取得の時点で除外した非公開・Premium限定動画の本数 */
  unavailable: number;
}

const UNCLASSIFIED_CATEGORY = "未分類";

const DEFAULT_CATEGORIES = [
  "投資",
  "経済",
  "AI",
  "AI業務効率化・自動化",
  "プログラミング・開発",
  "Obsidianノート術",
  "勉強法",
  "情報収集法",
  "思考整理法",
  "生活・習慣・健康",
  "歴史・社会",
  "発信・マーケティング法",
  UNCLASSIFIED_CATEGORY,
];

const LEGACY_CATEGORY_MAP: Record<string, string> = {
  "投資・経済": "投資",
  "投資・資産運用": "投資",
  "経済・マーケット": "経済",
  "心理学": "生活・習慣・健康",
  "語学": "生活・習慣・健康",
  "ノート術": "Obsidianノート術",
  "Obsidian・知的生産": "Obsidianノート術",
  "学習法": "勉強法",
  "情報収集・学習": "情報収集法",
  "AI・生成AI": "AI",
  "Youtube運営": "発信・マーケティング法",
  "YouTube運営": "発信・マーケティング法",
  "YouTube・マーケ": "発信・マーケティング法",
  "YouTube・マーケティング": "発信・マーケティング法",
  "宇宙・テクノロジー": "経済",
  "エンタメ・文化": "歴史・社会",
  "お笑い": "歴史・社会",
};

function normalizeCategory(category: string): string {
  return category.trim();
}

function normalizeLegacyCategory(category: string, currentCategories: string[]): string {
  const trimmed = normalizeCategory(category);
  if (currentCategories.includes(trimmed)) return trimmed;
  const mapped = LEGACY_CATEGORY_MAP[trimmed];
  return mapped && currentCategories.includes(mapped) ? mapped : trimmed;
}

function normalizeCategoryList(categories: unknown): string[] {
  if (!Array.isArray(categories) || categories.length === 0) {
    return [...DEFAULT_CATEGORIES];
  }
  const normalized = categories
    .filter((cat): cat is string => typeof cat === "string")
    .map(normalizeCategory)
    .filter((cat) => cat.length > 0);
  const unique = [...new Set(normalized)];
  const result = unique.length > 0 ? unique : [...DEFAULT_CATEGORIES];
  if (!result.includes(UNCLASSIFIED_CATEGORY)) {
    result.push(UNCLASSIFIED_CATEGORY);
  }
  return result;
}

const DEFAULT_MODEL_PRIORITY: [string, string, string] = [
  "gemini-2.5-flash",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
];

const DEFAULT_PLAYLIST_CONCURRENCY = 2;
const MAX_PLAYLIST_CONCURRENCY = 4;

function clampPlaylistConcurrency(value: unknown): number {
  const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_PLAYLIST_CONCURRENCY;
  return Math.min(MAX_PLAYLIST_CONCURRENCY, Math.max(1, n));
}

/** 一覧取得の時点で除外した本数を「メンバー限定 2本・視聴不可 1本を除外」の形にする（0本なら空文字） */
function formatExcludedCounts(membersOnly: number, unavailable: number): string {
  const parts: string[] = [];
  if (membersOnly > 0) parts.push(`メンバー限定 ${membersOnly}本`);
  if (unavailable > 0) parts.push(`視聴不可 ${unavailable}本`);
  return parts.length > 0 ? `${parts.join("・")}を除外` : "";
}

const RETRY_BASE_DELAY_MS = 2000;
const RETRY_RATE_LIMIT_BASE_DELAY_MS = 15000;
const RETRY_MAX_DELAY_MS = 60000;

function isRateLimitMessage(message: string): boolean {
  return /rate limit|rate_limit|RESOURCE_EXHAUSTED|429|tokens per minute|レート制限/i.test(message || "");
}

// リトライ待ち時間: 指数バックオフ + ジッター（±25%）。
// レート制限が原因のときは初回から長めに待つ（1秒固定だと3回とも同じ制限窓に当たって全滅するため）。
function calcRetryDelayMs(attempt: number, rateLimited: boolean): number {
  const base = rateLimited ? RETRY_RATE_LIMIT_BASE_DELAY_MS : RETRY_BASE_DELAY_MS;
  const backoff = Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), RETRY_MAX_DELAY_MS);
  return Math.round(backoff * (0.75 + Math.random() * 0.5));
}

const DEFAULT_SETTINGS: YTSummarizerSettings = {
  claudeApiKey: "",
  geminiApiKey: "",
  openaiApiKey: "",
  outputFolder: "Kindle/Youtube",
  modelPriority: [...DEFAULT_MODEL_PRIORITY],
  fallbackMode: "auto",
  playlistConcurrency: DEFAULT_PLAYLIST_CONCURRENCY,
  categories: [...DEFAULT_CATEGORIES],
  folderNames: [],
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  proxyConfig: { username: "", password: "" },
};

function getApiKeyForModel(settings: YTSummarizerSettings, modelId: string): string {
  const provider = getModelInfo(modelId).provider;
  if (provider === "gemini") return settings.geminiApiKey;
  if (provider === "openai") return settings.openaiApiKey;
  return settings.claudeApiKey;
}

function getCallableModelIds(settings: YTSummarizerSettings): string[] {
  const candidates = settings.fallbackMode === "manual" ? [settings.modelPriority[0]] : settings.modelPriority;
  return candidates.filter((modelId) => !!getApiKeyForModel(settings, modelId));
}

function getClassificationModelLabel(result: CategoryClassificationResult): string {
  return result.modelUsed ? getModelLabel(result.modelUsed) : "フォールバック";
}

/**
 * 再生リストは1回の実行内でフォールバックが起きてモデルが混在しうるので、
 * 使われたモデルを件数付きで並べる。成功0件のときは「—」。
 */
function formatModelCounts(counts: Map<string, number>): string {
  if (counts.size === 0) return "—";
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${label}（${count}件）`)
    .join("、");
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  // 200Kトークン超は input:2.50 / output:15.0 に上がるが、清書用途では稀なため基本料金のみで簡略化
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gpt-5.6-sol": { input: 5.0, output: 30.0 },
  "gpt-5.6-terra": { input: 2.0, output: 12.0 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
};
const USD_TO_JPY = 150;

function calcCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model] || MODEL_PRICING["claude-sonnet-4-6"];
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

const JA_COLLATOR = new Intl.Collator("ja-JP", { numeric: true, sensitivity: "base" });
const EN_COLLATOR = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });

function getFolderNameSortGroup(name: string): number {
  const first = name.trim().charAt(0);
  if (!first) return 4;
  if (/^[A-Za-z]$/.test(first)) return 1;
  if (/^[0-9]$/.test(first)) return 2;
  if (/^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]$/u.test(first)) return 0;
  if (/^[\p{P}\p{S}]$/u.test(first)) return 3;
  return 4;
}

function compareFolderNames(a: string, b: string): number {
  const groupA = getFolderNameSortGroup(a);
  const groupB = getFolderNameSortGroup(b);
  if (groupA !== groupB) return groupA - groupB;
  if (groupA === 1) return EN_COLLATOR.compare(a, b);
  return JA_COLLATOR.compare(a, b);
}

function normalizeFolderNameCandidate(name: string): string {
  return name
    .replace(/\|/g, "｜")
    .replace(/[\\/:*?"<>#\[\]【】『』「」（）(){}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 100);
}

function yamlScalar(value: string): string {
  if (!value) return "";
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function wikiList(items: string[]): string {
  const unique = Array.from(new Set(items.filter((item) => item.trim().length > 0)));
  return unique.length > 0 ? unique.map((item) => `- ${item}`).join("\n") : "- ";
}

function stripMarkdownForSummary(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[[^\]]+\]\([^)]+\)/g, (m) => m.replace(/^\[|\]\([^)]+\)$/g, ""))
    .replace(/[#>*_~|]/g, "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveOneLineSummary(title: string, cleanup: string): string {
  const candidates = cleanup
    .split(/\r?\n+/)
    .map((line) => stripMarkdownForSummary(line.replace(/^[-*]\s+/, "")))
    .filter((line) => line.length >= 12 && !/^概要欄$|^清書$/.test(line));
  const summary = candidates[0] || title;
  return summary.length > 120 ? `${summary.substring(0, 117)}...` : summary;
}

function deriveKeyPoints(cleanup: string): string[] {
  const headingPoints = cleanup
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{2,4}\s+/.test(line))
    .map((line) => stripMarkdownForSummary(line.replace(/^#{2,4}\s+/, "")))
    .filter((line) => line.length > 0 && !["清書", "概要欄", "プロンプト例"].includes(line));
  const bulletPoints = cleanup
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => stripMarkdownForSummary(line.replace(/^[-*]\s+/, "")))
    .filter((line) => line.length >= 8);
  const paragraphPoints = cleanup
    .split(/\r?\n\r?\n/)
    .map(stripMarkdownForSummary)
    .filter((line) => line.length >= 20);
  const points = Array.from(new Set([...headingPoints, ...bulletPoints, ...paragraphPoints]));
  return points.slice(0, 5).map((point) => point.length > 100 ? `${point.substring(0, 97)}...` : point);
}

function buildUseSection(category: string): string[] {
  if (category.includes("Obsidian") || category.includes("思考整理") || category.includes("情報収集")) {
    return [
      "ノート化する時は、外部情報・自分の考え・次に使う場面を分けて残す。",
      "再利用できる主張は豆腐サイズの知識ノートに切り出す。",
      "関連リンクからMOCや近い動画を確認する。",
    ];
  }
  if (category.includes("投資") || category.includes("経済")) {
    return [
      "数字・時期・制度・銘柄名は鵜呑みにせず、必要に応じて外部確認する。",
      "主張、根拠、前提条件、行動案を分けて整理する。",
      "関連リンクから比較MOCや近い動画を確認する。",
    ];
  }
  if (category.includes("AI") || category.includes("開発")) {
    return [
      "ツール名、モデル名、使い方、制約を分けて整理する。",
      "実用プロンプトや手順はコードブロックで残し、後で検証する。",
      "関連リンクから比較MOCや近い動画を確認する。",
    ];
  }
  if (category.includes("発信")) {
    return [
      "媒体、ターゲット、導線、継続条件を分けて整理する。",
      "再利用できる型はテンプレート化する。",
      "関連リンクから比較MOCや近い動画を確認する。",
    ];
  }
  if (category.includes("健康") || category.includes("生活")) {
    return [
      "知識で終わらせず、今日実行できる行動と確認指標に落とす。",
      "健康・栄養・運動の断定は必要に応じて外部確認する。",
      "関連リンクから比較MOCや近い動画を確認する。",
    ];
  }
  return [
    "動画内容をそのまま結論にせず、使える主張と保留する情報を分ける。",
    "あとで使う場面があるものは豆腐サイズの知識ノートに切り出す。",
    "関連リンクからMOCや近い動画を確認する。",
  ];
}

function getTopicMoc(category: string): string {
  if (category.includes("Obsidian") || category.includes("思考整理") || category.includes("情報収集")) return "[[MOC-Youtube清書_Obsidian・ノート術]]";
  if (category.includes("投資")) return "[[MOC-Youtube清書_投資・NISA]]";
  if (category.includes("経済") || category.includes("歴史") || category.includes("社会")) return "[[MOC-Youtube清書_経済・社会・企業]]";
  if (category.includes("AI") && category.includes("業務")) return "[[MOC-Youtube清書_AI活用]]";
  if (category.includes("AI")) return "[[MOC-Youtube清書_AI活用]]";
  if (category.includes("開発") || category.includes("プログラミング")) return "[[MOC-Youtube清書_開発・バイブコーディング]]";
  if (category.includes("発信")) return "[[MOC-Youtube清書_副業・SNS・マーケティング]]";
  if (category.includes("健康") || category.includes("生活")) return "[[MOC-Youtube清書_健康・筋トレ・習慣]]";
  return "";
}

function getCompareMoc(category: string): string {
  if (category.includes("Obsidian") || category.includes("思考整理") || category.includes("情報収集")) return "[[MOC-比較_Obsidian運用比較]]";
  if (category.includes("投資")) return "[[MOC-比較_新NISA・S&P500比較]]";
  if (category.includes("AI") && category.includes("業務")) return "[[MOC-比較_AI自動化・エージェント比較]]";
  if (category.includes("AI")) return "[[MOC-比較_AIツール比較]]";
  if (category.includes("発信")) return "[[MOC-比較_副業・SNS収益化比較]]";
  return "";
}

function decideFactCheck(category: string, channel: string, title: string): string {
  const hay = `${category} ${channel} ${title}`;
  if (/お笑い|音楽|IPPON|エンタメ/.test(hay)) return "低優先";
  if (/投資|NISA|株|銘柄|決算|金融|FX|為替|S&P|NASDAQ|米国株|経済|企業|社会|政治|法律|税|不動産|AI|生成AI|Gemini|GPT|Claude|OpenAI|Google|Microsoft|Meta|最新|速報|202[0-9]|健康|筋トレ|栄養|医療|病気|Obsidian|開発|プログラミング|情報収集/.test(hay)) return "要外部確認";
  return "未確認";
}

function buildStandardCleanNote(args: {
  sourceType: "youtube" | "article" | "text" | "file";
  title: string;
  url?: string;
  date: string;
  channel?: string;
  category: string;
  status?: string;
  model?: string;
  cleanup: string;
}): string {
  const category = normalizeCategory(args.category);
  const channel = args.channel || "";
  const aliases = [
    args.title,
    channel,
    category,
    args.sourceType === "youtube" ? "Youtube" : "",
    args.sourceType === "youtube" ? "YouTube" : "",
  ];
  const factCheck = args.sourceType === "youtube"
    ? decideFactCheck(category, channel, args.title)
    : "要確認";
  const themeLink = category && category !== UNCLASSIFIED_CATEGORY ? `[[Theme/${category}|${category}]]` : "";
  const keyPoints = deriveKeyPoints(args.cleanup);
  const relatedLinks = [
    "[[MOC-Youtube清書]]",
    getTopicMoc(category),
    getCompareMoc(category),
  ];

  return `---
url: ${args.url ? yamlScalar(args.url) : ""}
date: ${args.date || ""}
channel: ${yamlScalar(channel)}
category: ${yamlScalar(category)}
source_type: ${args.sourceType}
status: ${args.status || "清書済み"}
fact_check: ${factCheck}
model: ${args.model || ""}
aliases:
${aliases.filter(Boolean).map((alias) => `  - ${yamlScalar(alias)}`).join("\n")}
---

## 関連テーマ
${themeLink ? `- ${themeLink}` : "- "}

## 1行要約
${deriveOneLineSummary(args.title, args.cleanup)}

## 要点
${wikiList(keyPoints)}

## YouTube清書から活かせること
${wikiList(buildUseSection(category))}

## 自分のメモ
- 

## 関連リンク
${wikiList(relatedLinks)}

## 清書
${args.cleanup.trim()}
`;
}

function styleIconActionButton(btn: HTMLButtonElement, variant: "add" | "delete" | "edit") {
  btn.style.minWidth = "32px";
  btn.style.height = "32px";
  btn.style.padding = "0 10px";
  btn.style.borderRadius = "6px";
  btn.style.fontWeight = "700";
  btn.style.lineHeight = "1";
  if (variant === "add") {
    btn.style.background = "var(--color-green, #2f9e44)";
    btn.style.color = "var(--text-on-accent, #ffffff)";
    btn.style.border = "1px solid var(--color-green, #2f9e44)";
  } else if (variant === "delete") {
    btn.style.background = "var(--background-modifier-error, #c92a2a)";
    btn.style.color = "var(--text-on-accent, #ffffff)";
    btn.style.border = "1px solid var(--background-modifier-error, #c92a2a)";
  } else {
    btn.style.background = "";
    btn.style.color = "";
    btn.style.border = "";
  }
}

interface AttachedPdf {
  base64: string;
  name: string;
  kind: "pdf" | "image";
  mediaType: string;
}

interface ModalResult {
  url: string;
  folderName: string;
  pdfs: AttachedPdf[];
  directText: string;
  titleInput: string;
  controller?: RunController;
  logCallback?: (msg: string) => void;
  doneCallback?: (savedPath: string | null) => void;
}

const MAX_PDFS = 3;
const MAX_PDF_PAGES = 30;
const ALLOWED_PDF_TYPE = "application/pdf";
const MAX_IMAGE_BYTES = Math.floor(3.75 * 1024 * 1024);
const MAX_IMAGE_DIMENSION = 8000;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const IMAGE_EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

function countPdfPages(base64: string): number {
  try {
    const bin = atob(base64);
    const matches = bin.match(/\/Type\s*\/Page[^s]/g);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

function getSupportedImageMediaType(file: File): string | null {
  const mediaType = file.type.toLowerCase();
  if (ALLOWED_IMAGE_TYPES.includes(mediaType)) return mediaType;
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  return IMAGE_EXTENSION_TO_MEDIA_TYPE[ext] || null;
}

function stripSupportedFileExtension(name: string): string {
  return name.replace(/\.(pdf|jpe?g|png|webp|gif)$/i, "");
}

function formatBytesAsMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

interface LlmCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** 出力トークン上限に達して応答が途中で切れた場合 true */
  truncated: boolean;
}

async function callAnthropic(
  apiKey: string,
  modelId: string,
  content: string | Array<Record<string, unknown>>,
  maxTokens: number,
  controller?: RunController,
): Promise<LlmCallResult> {
  if (!apiKey) throw new Error("Claude APIキーが設定されていません");
  const res = await cancellableRequest(
    "https://api.anthropic.com/v1/messages",
    "POST",
    {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    JSON.stringify({
      model: modelId,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    }),
    controller,
  );
  const data = res.json;
  if (data.error) throw new Error(`Claude API エラー: ${data.error.message}`);
  if (!data.content || !data.content[0] || typeof data.content[0].text !== "string") {
    throw new Error("Claude API から想定外のレスポンスが返りました");
  }
  const usage = data.usage || {};
  return {
    text: data.content[0].text as string,
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    truncated: data.stop_reason === "max_tokens",
  };
}

async function callGemini(
  apiKey: string,
  modelId: string,
  textPrompt: string,
  fileParts: AttachedPdf[] | undefined,
  maxTokens: number,
  videoUrl?: string,
  controller?: RunController,
): Promise<LlmCallResult> {
  if (!apiKey) throw new Error("Gemini APIキーが設定されていません");
  const parts: Array<Record<string, unknown>> = [];
  if (videoUrl) {
    parts.push({ fileData: { fileUri: videoUrl } });
  }
  if (fileParts) {
    for (const pdf of fileParts) {
      parts.push({ inlineData: { mimeType: pdf.mediaType, data: pdf.base64 } });
    }
  }
  parts.push({ text: textPrompt });
  const res = await cancellableRequest(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
    "POST",
    {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
    controller,
  );
  const data = res.json;
  if (data.error) {
    const isRateLimit = res.status === 429 || data.error.status === "RESOURCE_EXHAUSTED";
    throw new Error(`Gemini API エラー: ${data.error.message}${isRateLimit ? "（rate limit）" : ""}`);
  }
  const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof candidateText !== "string") {
    throw new Error("Gemini API から想定外のレスポンスが返りました");
  }
  const usage = data.usageMetadata || {};
  return {
    text: candidateText,
    inputTokens: typeof usage.promptTokenCount === "number" ? usage.promptTokenCount : 0,
    outputTokens: typeof usage.candidatesTokenCount === "number" ? usage.candidatesTokenCount : 0,
    truncated: data?.candidates?.[0]?.finishReason === "MAX_TOKENS",
  };
}

async function callOpenAI(
  apiKey: string,
  modelId: string,
  textPrompt: string,
  fileParts: AttachedPdf[] | undefined,
  maxTokens: number,
  controller?: RunController,
): Promise<LlmCallResult> {
  if (!apiKey) throw new Error("OpenAI APIキーが設定されていません");
  const content: Array<Record<string, unknown>> = [];
  if (fileParts) {
    for (const pdf of fileParts) {
      if (pdf.kind === "pdf") {
        content.push({
          type: "input_file",
          filename: pdf.name,
          file_data: `data:${pdf.mediaType};base64,${pdf.base64}`,
        });
      } else {
        content.push({ type: "input_image", image_url: `data:${pdf.mediaType};base64,${pdf.base64}` });
      }
    }
  }
  content.push({ type: "input_text", text: textPrompt });
  const res = await cancellableRequest(
    "https://api.openai.com/v1/responses",
    "POST",
    {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    JSON.stringify({
      model: modelId,
      input: [{ type: "message", role: "user", content }],
      max_output_tokens: maxTokens,
    }),
    controller,
  );
  const data = res.json;
  if (data.error) {
    const isRateLimit = res.status === 429 || data.error.code === "rate_limit_exceeded";
    throw new Error(`OpenAI API エラー: ${data.error.message}${isRateLimit ? "（rate limit）" : ""}`);
  }
  const outputText = Array.isArray(data.output)
    ? data.output
      .flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item?.content || [])
      .find((c: { type?: string; text?: string }) => c?.type === "output_text")?.text
    : undefined;
  if (typeof outputText !== "string") {
    throw new Error("OpenAI API から想定外のレスポンスが返りました");
  }
  const usage = data.usage || {};
  return {
    text: outputText,
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    truncated: data.status === "incomplete" || data?.incomplete_details?.reason === "max_output_tokens",
  };
}

interface FallbackCallResult extends LlmCallResult {
  modelUsed: string;
}

function buildAnthropicContent(textPrompt: string, fileParts?: AttachedPdf[]): string | Array<Record<string, unknown>> {
  if (!fileParts || fileParts.length === 0) return textPrompt;
  return [
    ...fileParts.map((pdf) => (pdf.kind === "pdf"
      ? { type: "document", source: { type: "base64", media_type: pdf.mediaType, data: pdf.base64 } }
      : { type: "image", source: { type: "base64", media_type: pdf.mediaType, data: pdf.base64 } })),
    { type: "text", text: textPrompt },
  ];
}

async function callModelWithFallback(
  settings: YTSummarizerSettings,
  textPrompt: string,
  fileParts: AttachedPdf[] | undefined,
  maxTokens: number,
  controller?: RunController,
): Promise<FallbackCallResult> {
  const candidates = settings.fallbackMode === "manual" ? [settings.modelPriority[0]] : settings.modelPriority;

  const apiKeyForProvider: Record<ModelProvider, string> = {
    anthropic: settings.claudeApiKey,
    gemini: settings.geminiApiKey,
    openai: settings.openaiApiKey,
  };

  let lastError: unknown = null;
  for (const modelId of candidates) {
    controller?.throwIfAborted();
    const info = getModelInfo(modelId);
    const apiKey = apiKeyForProvider[info.provider];
    if (!apiKey) {
      lastError = new Error(`${info.label} の APIキーが未設定のためスキップしました`);
      continue;
    }
    try {
      let result: LlmCallResult;
      if (info.provider === "gemini") {
        result = await callGemini(apiKey, modelId, textPrompt, fileParts, maxTokens, undefined, controller);
      } else if (info.provider === "openai") {
        result = await callOpenAI(apiKey, modelId, textPrompt, fileParts, maxTokens, controller);
      } else {
        result = await callAnthropic(apiKey, modelId, buildAnthropicContent(textPrompt, fileParts), maxTokens, controller);
      }
      return { ...result, modelUsed: modelId };
    } catch (err) {
      // 停止はフォールバック対象外。次のモデルに進まずそのまま抜ける。
      if (isAbortedError(err)) throw err;
      lastError = err;
      console.error(`[YTSummarizer] ${modelId} 呼び出し失敗`, err);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

interface TranscriptResult {
  transcript: string;
  conflictNote: string;
  hasManual: boolean;
  publishDate: string;
  title: string;
  description: string;
  channelName: string;
}

interface SummarySections {
  cleanup: string;
}

interface CategoryClassificationResult {
  category: string;
  usage: { input: number; output: number };
  modelUsed: string;
  usedAI: boolean;
}

interface CategoryClassificationInput {
  sourceType: string;
  title: string;
  url?: string;
  folderName: string;
  fallbackCategory: string;
  sections: SummarySections;
  description?: string;
  controller?: RunController;
}

interface ReceptionEntryInput {
  filePath: string;
  category: string;
  date: string;
  source: string;
}

interface PlaylistVideoItem {
  url: string;
  title: string;
  titleInputEl: HTMLInputElement | null;
}

interface PlaylistProcessResult {
  item: { url: string; title: string };
  success: boolean;
  error?: string;
}

type InputMode = "url" | "text" | "file" | "kindle";

function buildCategoryClassificationPrompt(args: CategoryClassificationInput & { categories: string[] }): string {
  const { sourceType, title, url, folderName, categories, sections, description } = args;
  const categoryList = categories.map((cat, index) => `${index + 1}. ${cat}`).join("\n");
  const material = [
    `【資料種別】${sourceType}`,
    `【タイトル】${title || "（なし）"}`,
    `【保存先フォルダ】${folderName || "（なし）"}`,
    url ? `【URL】${url}` : "",
    description ? `【概要欄・補足】\n${description.substring(0, 4000)}` : "",
    `【清書】\n${sections.cleanup.substring(0, 12000)}`,
  ].filter(Boolean).join("\n\n");

  return `あなたはObsidian Vaultの資料分類担当です。
次の資料を、既存カテゴリ一覧の中から最も適切なカテゴリ1つに分類してください。

【厳守ルール】
- 既存カテゴリ一覧にあるカテゴリ名から1つだけ選ぶこと。
- 新しいカテゴリ名を作らないこと。
- 表記を変えないこと。
- 迷う場合は、資料の中心テーマに最も近いカテゴリを1つだけ選ぶこと。
- 出力はカテゴリ名のみ。理由、番号、記号、引用符、JSON、説明文は出力しないこと。

【既存カテゴリ一覧】
${categoryList}

【分類対象】
${material}

【出力】
カテゴリ名のみ`;
}

function parseCategoryChoice(rawText: string, categories: string[]): string | null {
  const trimmed = rawText.trim()
    .replace(/^```(?:json|text)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(trimmed) as { category?: unknown };
    if (typeof parsed.category === "string") {
      const normalized = normalizeCategory(parsed.category);
      if (categories.includes(normalized)) return normalized;
    }
  } catch {
    // Not JSON; continue with plain-text parsing.
  }

  const candidates = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.\s]+/, "").replace(/^["'「『]|["'」』]$/g, "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const normalized = normalizeCategory(candidate);
    if (categories.includes(normalized)) return normalized;
  }

  const normalizedWhole = normalizeCategory(trimmed.replace(/^["'「『]|["'」』]$/g, "").trim());
  if (categories.includes(normalizedWhole)) return normalizedWhole;

  const included = categories.filter((cat) => trimmed.includes(cat));
  return included.length === 1 ? included[0] : null;
}

export default class YTSummarizerPlugin extends Plugin {
  settings: YTSummarizerSettings;
  receptionQueue: Promise<void>;
  /** 実行中の清書ジョブ。モーダルの停止ボタンは自分の分だけ、コマンドは全部止める。 */
  private activeRuns = new Set<RunController>();

  beginRun(): RunController {
    const controller = new RunController();
    this.activeRuns.add(controller);
    return controller;
  }

  endRun(controller: RunController): void {
    this.activeRuns.delete(controller);
  }

  stopAllRuns(): number {
    const targets = Array.from(this.activeRuns);
    for (const controller of targets) controller.abort();
    return targets.length;
  }

  async onload() {
    this.receptionQueue = Promise.resolve();
    await this.loadSettings();
    this.addRibbonIcon("video", "動画・記事・テキストを清書", async () => {
      await this.runSummarize();
    });
    this.addCommand({
      id: "summarize-youtube-url",
      name: "URLを入力して動画・記事を清書",
      callback: async () => { await this.runSummarize(); },
    });
    this.addCommand({
      id: "summarize-youtube-from-current-note",
      name: "現在のノートのYouTube URLを清書",
      editorCallback: async (editor: Editor) => {
        const url = extractYouTubeUrl(editor.getValue());
        if (url) await this.runSummarize(url);
        else new Notice("❌ このノートにYouTube URLが見つかりませんでした");
      },
    });
    this.addCommand({
      id: "stop-summarize",
      name: "実行中の清書を停止",
      callback: () => {
        const stopped = this.stopAllRuns();
        if (stopped === 0) new Notice("実行中の清書はありません");
        else new Notice(`⏹️ 清書を停止しています（${stopped}件）...`, 5000);
      },
    });
    this.addSettingTab(new YTSummarizerSettingTab(this.app, this));
  }

  onunload() {
    this.stopAllRuns();
  }

  async runSummarize(prefilledUrl?: string) {
    if (getCallableModelIds(this.settings).length === 0) {
      new Notice("⚠️ 優先モデルで使うAPIキーを設定してください\n設定 → YouTube Summarizer", 5000);
      return;
    }
    const result = await new Promise<ModalResult | null>((resolve) => {
      new InputModal(this.app, this, prefilledUrl, resolve).open();
    });
    if (!result) return;
    await this.executeModalResult(result);
  }

  async executeModalResult(result: ModalResult) {
    // 停止ボタン付きで走らせる場合はモーダルが controller を持つ。
    // テキスト・ファイルモードはモーダルを閉じてしまうので、ここで作ってコマンドから止められるようにする。
    const ownedRun = result.controller ? null : this.beginRun();
    const run = (result.controller ?? ownedRun) as RunController;
    try {
      await this.runSummarizeJob(result, run);
    } catch (err) {
      // runSummarizeJob 内の try/catch より外で落ちた場合の受け皿。
      // ここで doneCallback を呼ばないとモーダルのボタンが戻らない。
      console.error("[YTSummarizer] runSummarize", err);
      if (isAbortedError(err)) {
        new Notice("⏹️ 清書を停止しました", 5000);
      } else {
        new Notice(`❌ エラー: ${err instanceof Error ? err.message : String(err)}`, 8000);
      }
      result.doneCallback?.(null);
    } finally {
      if (ownedRun) this.endRun(ownedRun);
    }
  }

  private async runSummarizeJob(result: ModalResult, run: RunController) {
    const { url, folderName, pdfs, directText, titleInput, logCallback, doneCallback } = result;
    const log = (msg: string) => logCallback?.(msg);
    const category = this.getUnclassifiedCategory();
    console.log(`[YTSummarizer] runSummarize: modal returned folderName="${folderName}" url="${url}" files=${pdfs.length} directText.length=${directText.length}`);

    const trimmedUrl = url.trim();
    const trimmedText = directText.trim();

    if (trimmedUrl) {
      const dupFileName = await this.checkUrlDuplicate(trimmedUrl);
      if (dupFileName !== null) {
        new Notice(`⚠️ URLダブり（処理済み）：${dupFileName}`, 8000);
        log(`⚠️ URLダブり（処理済み）：${dupFileName}`);
        doneCallback?.(null);
        return;
      }
    }

    if (trimmedUrl && !isYouTubeUrl(trimmedUrl)) {
      await this.summarizeArticle({ url: trimmedUrl, category, folderName, titleInput, controller: run, logCallback, doneCallback });
      return;
    }

    if (!trimmedUrl && pdfs.length > 0) {
      await this.summarizePdf({ pdfs, category, folderName, titleInput, controller: run });
      return;
    }

    if (!trimmedUrl && trimmedText) {
      await this.summarizeText({ text: trimmedText, category, folderName, titleInput, controller: run });
      return;
    }

    const videoId = trimmedUrl ? extractVideoId(trimmedUrl) : null;
    if (!videoId) {
      new Notice("❌ URL・テキスト・ファイルのいずれかを入力してください");
      log("❌ URL・テキスト・ファイルのいずれかを入力してください");
      doneCallback?.(null);
      return;
    }

    let title = "";
    let transcript = "";
    let description = "";
    let conflictNote = "";
    let publishDate = "動画公開日不明";
    log(`[1/1] 処理開始：${titleInput || trimmedUrl}`);
    log("📺 YouTube情報を取得中...");
    const progress = new ProgressNotice();
    progress.show("📺 YouTube情報を取得中...");
    try {
      const data = await this.fetchYouTubeData(videoId, run);
      title = data.title;
      transcript = data.transcript;
      description = data.description;
      conflictNote = data.conflictNote;
      publishDate = data.publishDate;
      progress.hide();
      if (!transcript || transcript.trim().length < 50) {
        throw new Error("文字起こしを取得できませんでした。字幕がない動画は清書できません。");
      }
      log(`📺 取得完了：${title}`);
      log("🤖 優先モデルで清書中...");
      progress.show("🤖 優先モデルで清書中...");
      const summary = await this.summarizeVideoWithModel({
        title,
        url: trimmedUrl,
        category,
        transcript,
        description,
        conflictNote,
        controller: run,
        logCallback: log,
      });
      progress.hide();
      log(`🤖 清書完了（${getModelLabel(summary.modelUsed)}）`);
      log("🏷️ 優先モデルでカテゴリ分類中...");
      progress.show("🏷️ 優先モデルでカテゴリ分類中...");
      const classification = await this.classifyCategory({
        sourceType: "YouTube動画",
        title,
        url: trimmedUrl,
        folderName,
        fallbackCategory: category,
        sections: summary.sections,
        description,
        controller: run,
      });
      progress.hide();
      log("💾 保存中...");
      const savedPath = await this.saveNote({
        title,
        url: trimmedUrl,
        category: classification.category,
        folderName: folderName,
        channelName: data.channelName,
        publishDate,
        sections: summary.sections,
        titleInput,
        model: summary.modelUsed,
      });

      const inputTokens = summary.usage.input + classification.usage.input;
      const outputTokens = summary.usage.output + classification.usage.output;
      const cost = calcCostUsd(summary.modelUsed, summary.usage.input, summary.usage.output)
        + (classification.modelUsed ? calcCostUsd(classification.modelUsed, classification.usage.input, classification.usage.output) : 0);
      this.settings.totalInputTokens += inputTokens;
      this.settings.totalOutputTokens += outputTokens;
      this.settings.totalCostUsd += cost;
      await this.saveSettings();

      const cumulativeUsd = this.settings.totalCostUsd;
      const noticeText =
        `✅ 清書完成！\n` +
        `清書モデル: ${getModelLabel(summary.modelUsed)}\n` +
        `カテゴリ分類: ${getClassificationModelLabel(classification)}\n` +
        `今回: ${inputTokens}in + ${outputTokens}out tokens\n` +
        `今回: $${cost.toFixed(4)}（約${(cost * USD_TO_JPY).toFixed(1)}円）\n` +
        `累計: $${cumulativeUsd.toFixed(4)}（約${(cumulativeUsd * USD_TO_JPY).toFixed(1)}円）`;
      new Notice(noticeText, 10000);
      log(`💾 保存しました: ${savedPath}`);
      log(`今回: $${cost.toFixed(4)}（約${(cost * USD_TO_JPY).toFixed(1)}円） / 累計: $${cumulativeUsd.toFixed(4)}（約${(cumulativeUsd * USD_TO_JPY).toFixed(1)}円）`);
      log(`[1/1] ✅ 完了：${title}`);
      doneCallback?.(savedPath);
    } catch (err: unknown) {
      progress.hide();
      if (isAbortedError(err)) {
        new Notice("⏹️ 清書を停止しました", 5000);
        log("[1/1] ⏹️ 停止しました");
        doneCallback?.(null);
        return;
      }
      console.error("[YTSummarizer]", err);
      if (err instanceof TranscriptError) {
        switch (err.code) {
          case "IP_BLOCKED":
            new Notice("❌ YouTubeにIPブロックされています。\n\n原因:\n・短時間に大量リクエストを送った\n・回線のIPがブロックリストに入っている\n\n対処:\n・数時間〜1日待って再試行\n・ルーターを再起動してIPを変える", 15000);
            break;
          case "NO_TRANSCRIPT":
          case "TRANSCRIPTS_DISABLED": {
            new Notice("⏭️ この動画には字幕がないためスキップしました。ノートは作成していません。", 8000);
            break;
          }
          case "VIDEO_UNAVAILABLE":
            new Notice("❌ 動画にアクセスできません。\n非公開・削除・地域制限の可能性があります。", 8000);
            break;
          case "INVALID_VIDEO_ID":
            new Notice("❌ 無効な動画URLです。URLを確認してください。", 8000);
            break;
          case "NETWORK_ERROR":
            new Notice("❌ ネットワークエラー: YouTubeへの接続に失敗しました。\nWebshareプロキシの設定を確認するか、しばらく待って再試行してください。", 10000);
            break;
          default:
            new Notice(`❌ エラー: ${err.message}`, 8000);
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("rate limit") || message.includes("tokens per minute")) {
          new Notice("❌ エラー: 入力が長すぎます（1分間のトークン上限を超えました）。\nテキスト入力欄に分割して貼り付けるか、短い動画で試してください。", 10000);
        } else {
          new Notice(`❌ エラー: ${message}`, 8000);
        }
      }
      log(`[1/1] ❌ 失敗：${err instanceof Error ? err.message : String(err)}`);
      doneCallback?.(null);
    }
  }

  async fetchYouTubeData(videoId: string, controller?: RunController): Promise<{ title: string; transcript: string; description: string; conflictNote: string; channelName: string; publishDate: string }> {
    const t = await this.fetchTranscript(videoId, controller);
    return {
      title: t.title || `YouTube_${videoId}`,
      transcript: t.transcript,
      description: t.description,
      conflictNote: t.conflictNote,
      channelName: t.channelName,
      publishDate: t.publishDate,
    };
  }

  async fetchVideoMeta(videoId: string): Promise<{ title: string; channelName: string; description: string; publishDate: string }> {
    const stdout = await this.callPythonScript(["--meta-only", videoId]);
    const data = JSON.parse(stdout);
    return {
      title: data.title || "",
      channelName: data.channel_name || "",
      description: data.description || "",
      publishDate: data.publish_date || "動画公開日不明",
    };
  }

  private async callPythonScript(args: string[], controller?: RunController): Promise<string> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("デスクトップ版Obsidianでのみ動作します");
    }
    const basePath = adapter.getBasePath();
    const pluginDir = this.manifest.dir
      ? `${basePath}/${this.manifest.dir}`
      : `${basePath}/.obsidian/plugins/${this.manifest.id}`;
    const scriptPath = `${pluginDir}/get_transcript.py`;
    const options = {
      timeout: 60000,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    } as const;
    let r: ExecFileTextResult;
    try {
      r = await execFileText(controller, "python", [scriptPath, ...args], options);
    } catch (firstError) {
      if (isAbortedError(firstError)) throw firstError;
      const first = firstError as NodeJS.ErrnoException & { stderr?: string };
      const startupUnavailable = first.code === "ENOENT"
        || /^(?:python(?:\.exe)?|python was not found|the system cannot find the file specified)\.?\s*$/i.test((first.stderr || "").trim());
      if (!startupUnavailable) throw firstError;
      try {
        r = await execFileText(controller, "py", [scriptPath, ...args], options);
      } catch (secondError) {
        if (isAbortedError(secondError)) throw secondError;
        const second = secondError as NodeJS.ErrnoException & { stderr?: string };
        throw new Error(
          `Pythonを起動できません（python / py ともに失敗）。Pythonをインストールし、コマンドプロンプトで「python --version」または「py --version」が動く状態にしてください。詳細: ${(second.stderr || second.message || String(secondError)).trim().substring(0, 240)}`,
        );
      }
    }
    return r.stdout;
  }

  async ensureFolder(folderPath: string): Promise<void> {
    const parts = folderPath.split('/').filter(p => p.length > 0);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        console.log(`[YTSummarizer] ensureFolder: creating "${current}"`);
        try {
          await this.app.vault.createFolder(current);
        } catch(e) {
          console.error(`[YTSummarizer] ensureFolder: FAILED to create "${current}"`, e);
          // 作成失敗後に再確認（並行作成の場合は既に存在する可能性）
          const retry = this.app.vault.getAbstractFileByPath(current);
          if (!retry) throw e;
        }
      } else {
        console.log(`[YTSummarizer] ensureFolder: exists "${current}"`);
      }
    }
  }

  async appendReceptionEntry(args: ReceptionEntryInput): Promise<void> {
    const receptionPath = normalizePath("Index/受付.md");
    const fileLinkPath = normalizePath(args.filePath).replace(/\.md$/i, "");
    const entry = [
      `- [[${fileLinkPath}]]`,
      `  - category: ${normalizeCategory(args.category)}`,
      `  - date: ${args.date}`,
      `  - source: ${args.source}`,
      "",
    ].join("\n");

    const defaultContent = [
      "## 入口",
      "- [テーマ一覧](<テーマ一覧.md>)",
      "- [分類一覧](<分類一覧.md>)",
      "- [更新記録](<更新記録.md>)",
      "",
      "## AI向けの見方",
      "- [Source](<../Source/>): MyObsidian全体の元資料。",
      "- [Theme](<../Theme/>): MyObsidian全体を横断して、同じテーマの情報を集約する。",
      "- [Index](<./>): MyObsidian全体の入口、一覧、更新ルールを置く。",
      "",
      "## 未整理",
      "",
      "## 整理済み",
      "",
    ].join("\n");

    let file = this.app.vault.getAbstractFileByPath(receptionPath);
    if (!file) {
      await this.ensureFolder("Index");
      file = await this.app.vault.create(receptionPath, defaultContent);
    }
    if (!(file instanceof TFile)) {
      throw new Error(`受付ファイルを更新できません: ${receptionPath}`);
    }

    let content = await this.app.vault.read(file);
    if (content.includes(`[[${fileLinkPath}]]`)) return;
    if (!/^## 未整理\s*$/m.test(content)) {
      content = content.trimEnd() + "\n\n## 未整理\n\n";
    }
    if (!/^## 整理済み\s*$/m.test(content)) {
      content = content.trimEnd() + "\n\n## 整理済み\n";
    }

    const lines = content.split(/\r?\n/);
    const unsortedIndex = lines.findIndex((line) => line.trim() === "## 未整理");
    let insertIndex = unsortedIndex + 1;
    while (insertIndex < lines.length && lines[insertIndex].trim() === "") {
      insertIndex++;
    }
    lines.splice(insertIndex, 0, ...entry.trimEnd().split("\n"), "");
    await this.app.vault.modify(file, lines.join("\n").replace(/\n{3,}/g, "\n\n"));
  }

  async tryAppendReceptionEntry(args: ReceptionEntryInput): Promise<void> {
    // 受付.md は read → 加工 → modify の読み書きなので、並列処理中に2件が同時に走ると
    // 後から書いた側が先の追記を丸ごと上書きして1件消える。ここで必ず直列に流す。
    const run = this.receptionQueue.then(() => this.appendReceptionEntry(args));
    this.receptionQueue = run.then(() => undefined, () => undefined);
    try {
      await run;
    } catch (err) {
      console.warn("[YTSummarizer] 受付への追記に失敗しました", err);
      new Notice("⚠️ 清書は保存しましたが、受付への追加に失敗しました");
    }
  }

  getAvailableMarkdownPath(targetFolder: string, baseName: string): string {
    let filePath = normalizePath(`${targetFolder}/${baseName}.md`);
    let suffix = 1;
    while (this.app.vault.getAbstractFileByPath(filePath) instanceof TFile) {
      filePath = normalizePath(`${targetFolder}/${baseName}（${suffix}）.md`);
      suffix++;
    }
    return filePath;
  }

  getCategoryFallback(fallbackCategory: string, folderName: string): string {
    const categories = normalizeCategoryList(this.settings.categories);
    const normalizedFallback = normalizeCategory(fallbackCategory || "");
    if (categories.includes(normalizedFallback)) return normalizedFallback;
    if (categories.includes(UNCLASSIFIED_CATEGORY)) return UNCLASSIFIED_CATEGORY;
    return categories[0] || UNCLASSIFIED_CATEGORY;
  }

  getUnclassifiedCategory(): string {
    this.settings.categories = normalizeCategoryList(this.settings.categories);
    return this.settings.categories.includes(UNCLASSIFIED_CATEGORY)
      ? UNCLASSIFIED_CATEGORY
      : this.settings.categories[0] || UNCLASSIFIED_CATEGORY;
  }

  async classifyCategory(args: CategoryClassificationInput): Promise<CategoryClassificationResult> {
    this.settings.categories = normalizeCategoryList(this.settings.categories);
    const categories = this.settings.categories;
    const fallback = this.getCategoryFallback(args.fallbackCategory, args.folderName);
    if (categories.length === 0) {
      return { category: fallback, usage: { input: 0, output: 0 }, modelUsed: "", usedAI: false };
    }

    const prompt = buildCategoryClassificationPrompt({ ...args, categories });
    try {
      const result = await callModelWithFallback(this.settings, prompt, undefined, 200, args.controller);
      const category = parseCategoryChoice(result.text, categories);
      if (!category) {
        console.warn("[YTSummarizer] AIカテゴリ分類が既存カテゴリに一致しませんでした", result.text);
        return {
          category: fallback,
          usage: { input: result.inputTokens, output: result.outputTokens },
          modelUsed: result.modelUsed,
          usedAI: true,
        };
      }
      return {
        category,
        usage: { input: result.inputTokens, output: result.outputTokens },
        modelUsed: result.modelUsed,
        usedAI: true,
      };
    } catch (err) {
      // 停止はフォールバック扱いにせず、呼び出し元まで伝える。
      if (isAbortedError(err)) throw err;
      console.warn("[YTSummarizer] AIカテゴリ分類に失敗したためフォールバックカテゴリを使用します", err);
      return { category: fallback, usage: { input: 0, output: 0 }, modelUsed: "", usedAI: false };
    }
  }

  async fetchTranscript(videoId: string, controller?: RunController): Promise<TranscriptResult> {
    let stdout: string;
    try {
      stdout = await this.callPythonScript([videoId], controller);
    } catch (e) {
      if (isAbortedError(e)) throw e;
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };

      if (err.code === "ENOENT") {
        throw new Error("python コマンドが見つかりません。Pythonをインストールし、PATHを通してください。");
      }

      // Pythonスクリプトが exit 1 した場合、エラーJSONは stderr に入っている（get_transcript.pyの設計）。
      // ただし将来の出力先変更に備え、stdoutも念のため試す。
      const candidates = [err.stderr, err.stdout];
      for (const candidate of candidates) {
        const trimmed = (candidate || "").trim();
        if (!trimmed) continue;
        try {
          const data = JSON.parse(trimmed) as { error?: string; code?: string };
          if (data.error) {
            throw new TranscriptError(data.error, data.code ?? "UNKNOWN_ERROR");
          }
        } catch (innerErr) {
          if (innerErr instanceof TranscriptError) throw innerErr;
          // JSONでなければ次の候補へ
        }
      }

      const detail = err.stderr || err.message || String(err);
      throw new Error(`Pythonスクリプト実行エラー: ${detail.substring(0, 300)}`);
    }

    if (!stdout || !stdout.trim()) {
      throw new Error("Pythonスクリプトが応答を返しませんでした");
    }
    let data: { transcript?: string; error?: string; code?: string; conflict_note?: string; has_manual?: boolean; publish_date?: string; title?: string; description?: string; channel_name?: string };
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new Error(`Pythonスクリプトの応答を解析できませんでした: ${stdout.substring(0, 200)}`);
    }
    if (data.error) throw new TranscriptError(data.error, data.code ?? "UNKNOWN_ERROR");
    if (!data.transcript) throw new Error("文字起こしが空でした");
    return {
      transcript: data.transcript,
      conflictNote: data.conflict_note || "",
      hasManual: !!data.has_manual,
      publishDate: data.publish_date || "動画公開日不明",
      title: data.title || "",
      description: data.description || "",
      channelName: data.channel_name || "",
    };
  }

  async summarizeArticle(args: { url: string; category: string; folderName: string; titleInput: string; controller: RunController; logCallback?: (msg: string) => void; doneCallback?: (savedPath: string | null) => void }) {
    const { url, category, folderName, titleInput, controller, logCallback, doneCallback } = args;
    const log = (msg: string) => logCallback?.(msg);
    log(`[1/1] 処理開始：${titleInput || url}`);
    log("📄 記事を取得中...");
    const progress = new ProgressNotice();
    progress.show("📄 記事を取得中...");
    try {
      const data = await this.fetchArticle(url, controller);
      const title = data.title;
      const text = data.text;
      progress.hide();
      if (!text || text.trim().length < 100) {
        throw new Error("記事本文を取得できませんでした");
      }

      log(`📄 取得完了：${title}`);
      log("🤖 優先モデルで清書中...");
      progress.show("🤖 優先モデルで清書中...");
      const summary = await this.summarizeArticleWithModel({
        title,
        url,
        category,
        text,
        controller,
        logCallback: log,
      });
      progress.hide();

      log(`🤖 清書完了（${getModelLabel(summary.modelUsed)}）`);
      log("🏷️ 優先モデルでカテゴリ分類中...");
      progress.show("🏷️ 優先モデルでカテゴリ分類中...");
      const classification = await this.classifyCategory({
        sourceType: "記事",
        title,
        url,
        folderName,
        fallbackCategory: category,
        sections: summary.sections,
        controller,
      });
      progress.hide();

      log("💾 保存中...");
      const savedPath = await this.saveArticleNote({
        title,
        url,
        category: classification.category,
        folderName,
        sections: summary.sections,
        titleInput,
        model: summary.modelUsed,
      });

      const inputTokens = summary.usage.input + classification.usage.input;
      const outputTokens = summary.usage.output + classification.usage.output;
      const cost = calcCostUsd(summary.modelUsed, summary.usage.input, summary.usage.output)
        + (classification.modelUsed ? calcCostUsd(classification.modelUsed, classification.usage.input, classification.usage.output) : 0);
      this.settings.totalInputTokens += inputTokens;
      this.settings.totalOutputTokens += outputTokens;
      this.settings.totalCostUsd += cost;
      await this.saveSettings();

      const cumulativeUsd = this.settings.totalCostUsd;
      const noticeText =
        `✅ 清書完成！\n` +
        `清書モデル: ${getModelLabel(summary.modelUsed)}\n` +
        `カテゴリ分類: ${getClassificationModelLabel(classification)}\n` +
        `今回: ${inputTokens}in + ${outputTokens}out tokens\n` +
        `今回: $${cost.toFixed(4)}（約${(cost * USD_TO_JPY).toFixed(1)}円）\n` +
        `累計: $${cumulativeUsd.toFixed(4)}（約${(cumulativeUsd * USD_TO_JPY).toFixed(1)}円）`;
      new Notice(noticeText, 10000);
      log(`💾 保存しました: ${savedPath}`);
      log(`今回: $${cost.toFixed(4)}（約${(cost * USD_TO_JPY).toFixed(1)}円） / 累計: $${cumulativeUsd.toFixed(4)}（約${(cumulativeUsd * USD_TO_JPY).toFixed(1)}円）`);
      log(`[1/1] ✅ 完了：${title}`);
      doneCallback?.(savedPath);
    } catch (err: unknown) {
      progress.hide();
      if (isAbortedError(err)) {
        new Notice("⏹️ 清書を停止しました", 5000);
        log("[1/1] ⏹️ 停止しました");
        doneCallback?.(null);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error("[YTSummarizer]", err);
      if (message.includes("rate limit") || message.includes("tokens per minute")) {
        new Notice("❌ エラー: 入力が長すぎます（1分間のトークン上限を超えました）。\nテキスト入力欄に分割して貼り付けるか、短い動画で試してください。", 10000);
      } else {
        new Notice(`❌ エラー: ${message}`, 8000);
      }
      log(`[1/1] ❌ 失敗：${message}`);
      doneCallback?.(null);
    }
  }

  async fetchArticle(url: string, controller?: RunController): Promise<{ title: string; text: string }> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("デスクトップ版Obsidianでのみ動作します(ファイルシステムアクセスが必要)");
    }
    const basePath = adapter.getBasePath();
    const pluginDir = this.manifest.dir
      ? `${basePath}/${this.manifest.dir}`
      : `${basePath}/.obsidian/plugins/${this.manifest.id}`;
    const scriptPath = `${pluginDir}/article_fetcher.py`;

    let stdout: string;
    try {
      const r = await execFileText(controller, "python", [scriptPath, url], {
        timeout: 30000,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      });
      stdout = r.stdout;
    } catch (e) {
      if (isAbortedError(e)) throw e;
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (err.code === "ENOENT") {
        throw new Error("python コマンドが見つかりません。Pythonをインストールし、PATHを通してください。");
      }
      // 最優先: stdoutにJSON形式の {error, code} が出力されていればそれを使う（文字化け防止）
      let parsedError: string | null = null;
      const stdoutMsg = (err.stdout || "").trim();
      if (stdoutMsg) {
        try {
          const parsed = JSON.parse(stdoutMsg);
          if (parsed && typeof parsed.error === "string" && parsed.error) {
            parsedError = parsed.error;
          }
        } catch {
          // stdout がJSONでなければ無視して次のフォールバックへ
        }
      }
      if (parsedError) {
        throw new Error(parsedError);
      }
      const stderrMsg = (err.stderr || "").trim();
      if (stderrMsg) {
        const lastLine = stderrMsg.split(/\r?\n/).filter((l) => l.trim().length > 0).pop() || stderrMsg;
        const cleaned = lastLine.replace(/^ERROR:\s*/i, "").trim();
        throw new Error(cleaned || stderrMsg.substring(0, 300));
      }
      throw new Error(`記事取得スクリプト実行エラー: ${(err.message || String(err)).substring(0, 300)}`);
    }

    if (!stdout || !stdout.trim()) {
      throw new Error("記事取得スクリプトが応答を返しませんでした");
    }
    let data: { title?: string; text?: string };
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new Error(`記事取得スクリプトの応答を解析できませんでした: ${stdout.substring(0, 200)}`);
    }
    if (!data.text) throw new Error("記事本文が空でした");
    return { title: data.title || "", text: data.text };
  }

  async fetchArticleMeta(url: string): Promise<{ title: string; siteName: string }> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("デスクトップ版Obsidianでのみ動作します(ファイルシステムアクセスが必要)");
    }
    const basePath = adapter.getBasePath();
    const pluginDir = this.manifest.dir
      ? `${basePath}/${this.manifest.dir}`
      : `${basePath}/.obsidian/plugins/${this.manifest.id}`;
    const scriptPath = `${pluginDir}/article_fetcher.py`;

    let stdout: string;
    try {
      const r = await execFileText(undefined, "python", [scriptPath, "--meta-only", url], {
        timeout: 15000,
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
      });
      stdout = r.stdout;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (err.code === "ENOENT") {
        throw new Error("python コマンドが見つかりません");
      }
      // 最優先: stdoutにJSON形式の {error, code} が出力されていればそれを使う（文字化け防止）
      let parsedError: string | null = null;
      const stdoutMsg = (err.stdout || "").trim();
      if (stdoutMsg) {
        try {
          const parsed = JSON.parse(stdoutMsg);
          if (parsed && typeof parsed.error === "string" && parsed.error) {
            parsedError = parsed.error;
          }
        } catch {
          // stdout がJSONでなければ無視して次のフォールバックへ
        }
      }
      if (parsedError) {
        throw new Error(parsedError);
      }
      const stderrMsg = (err.stderr || "").trim();
      if (stderrMsg) {
        const lastLine = stderrMsg.split(/\r?\n/).filter((l) => l.trim().length > 0).pop() || stderrMsg;
        throw new Error(lastLine.replace(/^ERROR:\s*/i, "").trim() || stderrMsg.substring(0, 200));
      }
      throw new Error(`記事メタ取得エラー: ${(err.message || String(err)).substring(0, 200)}`);
    }
    if (!stdout || !stdout.trim()) {
      throw new Error("記事メタ取得スクリプトが応答を返しませんでした");
    }
    let data: { title?: string; siteName?: string };
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new Error(`記事メタ応答の解析に失敗: ${stdout.substring(0, 200)}`);
    }
    return { title: data.title || "", siteName: data.siteName || "" };
  }

  async summarizeArticleWithModel(args: {
    title: string;
    url: string;
    category: string;
    text: string;
    controller?: RunController;
    logCallback?: (msg: string) => void;
  }): Promise<{ sections: SummarySections; usage: { input: number; output: number }; modelUsed: string }> {
    const { title, url, category, text, controller, logCallback } = args;
    const chunks = chunkLongText(text, CLEANUP_CHUNK_CHARS);
    if (chunks.length === 0) throw new Error("記事本文が空のため清書できません");
    if (chunks.length > 1) {
      logCallback?.(`📏 記事本文${text.length}字を${chunks.length}回に分けて清書します`);
    }

    const parts: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let modelUsed = "";
    let truncated = false;
    for (let i = 0; i < chunks.length; i++) {
      controller?.throwIfAborted();
      if (chunks.length > 1) logCallback?.(`🤖 清書中 ${i + 1}/${chunks.length}...`);
      const prompt = buildArticlePrompt({ title, url, category, text: chunks[i], part: i + 1, totalParts: chunks.length });
      const result = await callModelWithFallback(this.settings, prompt, undefined, CLEANUP_MAX_TOKENS, controller);
      const parsed = parseSections(result.text, false, result.modelUsed);
      parts.push(parsed.sections.cleanup);
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      modelUsed = result.modelUsed;
      if (result.truncated) truncated = true;
    }
    if (truncated) notifyCleanupTruncated(logCallback);

    return {
      sections: { cleanup: parts.join("\n\n") },
      usage: {
        input: inputTokens,
        output: outputTokens,
      },
      modelUsed,
    };
  }

  async saveArticleNote(args: { title: string; url: string; category: string; folderName: string; sections: SummarySections; titleInput: string; model: string }): Promise<string> {
    const { title, url, category, folderName, sections, titleInput, model } = args;
    const today = new Date().toISOString().split("T")[0];
    const baseFolder = normalizePath(this.settings.outputFolder.replace(/^\/+|\/+$/g, ""));

    const sanitize = (s: string) => s
      .replace(/\|/g, "｜")
      .replace(/[\\/:*?"<>#\[\]【】『』「」（）(){}]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 100);
    const safeFolderName = sanitize(folderName || "");
    const safeTitle = sanitize(title || "");
    const titleInputSafe = sanitize(titleInput || "");
    const baseName = titleInputSafe || safeTitle || `article_${today}`;
    const targetFolder = safeFolderName
      ? normalizePath(`${baseFolder}/${safeFolderName}`)
      : baseFolder;

    await this.ensureFolder(targetFolder);
    const verify = this.app.vault.getAbstractFileByPath(targetFolder);
    if (!verify || !(verify instanceof TFolder)) {
      throw new Error(`保存先フォルダの作成に失敗しました: ${targetFolder}`);
    }

    const filePath = this.getAvailableMarkdownPath(targetFolder, baseName);

    const content = buildStandardCleanNote({
      sourceType: "article",
      title: baseName,
      url,
      date: today,
      channel: folderName,
      category,
      model,
      cleanup: sections.cleanup,
    });
    const file = await this.app.vault.create(filePath, content);
    await this.tryAppendReceptionEntry({
      filePath,
      category,
      date: today,
      source: "記事",
    });
    await this.app.workspace.getLeaf("tab").openFile(file);
    return filePath;
  }

  async summarizeText(args: { text: string; category: string; folderName: string; titleInput: string; controller: RunController }) {
    const { text, category, folderName, titleInput, controller } = args;
    const progress = new ProgressNotice();
    progress.show("🤖 優先モデルで清書中...");
    try {
      const summary = await this.summarizeTextWithModel({ text, category, controller });
      progress.hide();

      progress.show("🏷️ 優先モデルでカテゴリ分類中...");
      const classification = await this.classifyCategory({
        sourceType: "テキスト",
        title: titleInput || text.substring(0, 80),
        folderName,
        fallbackCategory: category,
        sections: summary.sections,
        controller,
      });
      progress.hide();

      await this.saveTextNote({
        text,
        category: classification.category,
        folderName,
        sections: summary.sections,
        titleInput,
        model: summary.modelUsed,
      });

      const inputTokens = summary.usage.input + classification.usage.input;
      const outputTokens = summary.usage.output + classification.usage.output;
      const cost = calcCostUsd(summary.modelUsed, summary.usage.input, summary.usage.output)
        + (classification.modelUsed ? calcCostUsd(classification.modelUsed, classification.usage.input, classification.usage.output) : 0);
      this.settings.totalInputTokens += inputTokens;
      this.settings.totalOutputTokens += outputTokens;
      this.settings.totalCostUsd += cost;
      await this.saveSettings();

      const cumulativeUsd = this.settings.totalCostUsd;
      const noticeText =
        `✅ 清書完成！\n` +
        `清書モデル: ${getModelLabel(summary.modelUsed)}\n` +
        `カテゴリ分類: ${getClassificationModelLabel(classification)}\n` +
        `今回: ${inputTokens}in + ${outputTokens}out tokens\n` +
        `今回: $${cost.toFixed(4)}（約${(cost * USD_TO_JPY).toFixed(1)}円）\n` +
        `累計: $${cumulativeUsd.toFixed(4)}（約${(cumulativeUsd * USD_TO_JPY).toFixed(1)}円）`;
      new Notice(noticeText, 10000);
    } catch (err: unknown) {
      progress.hide();
      if (isAbortedError(err)) {
        new Notice("⏹️ 清書を停止しました", 5000);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error("[YTSummarizer]", err);
      if (message.includes("rate limit") || message.includes("tokens per minute")) {
        new Notice("❌ エラー: 入力が長すぎます（1分間のトークン上限を超えました）。\nテキスト入力欄に分割して貼り付けるか、短い動画で試してください。", 10000);
      } else {
        new Notice(`❌ エラー: ${message}`, 8000);
      }
    }
  }

  async summarizeTextWithModel(args: {
    text: string;
    category: string;
    controller?: RunController;
  }): Promise<{ sections: SummarySections; usage: { input: number; output: number }; modelUsed: string }> {
    const { text, category, controller } = args;
    const chunks = chunkLongText(text, CLEANUP_CHUNK_CHARS);
    if (chunks.length === 0) throw new Error("入力テキストが空のため清書できません");

    const parts: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let modelUsed = "";
    let truncated = false;
    for (let i = 0; i < chunks.length; i++) {
      controller?.throwIfAborted();
      const prompt = buildTextPrompt({ text: chunks[i], category, part: i + 1, totalParts: chunks.length });
      const result = await callModelWithFallback(this.settings, prompt, undefined, CLEANUP_MAX_TOKENS, controller);
      const parsed = parseSections(result.text, false, result.modelUsed);
      parts.push(parsed.sections.cleanup);
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      modelUsed = result.modelUsed;
      if (result.truncated) truncated = true;
    }
    if (truncated) notifyCleanupTruncated();

    return {
      sections: { cleanup: parts.join("\n\n") },
      usage: {
        input: inputTokens,
        output: outputTokens,
      },
      modelUsed,
    };
  }

  async saveTextNote(args: { text: string; category: string; folderName: string; sections: SummarySections; titleInput: string; model: string }) {
    const { text, category, folderName, sections, titleInput, model } = args;
    const today = new Date().toISOString().split("T")[0];
    const baseFolder = normalizePath(this.settings.outputFolder.replace(/^\/+|\/+$/g, ""));

    const sanitize = (s: string, max: number) => s
      .replace(/\|/g, "｜")
      .replace(/[\\/:*?"<>#\[\]【】『』「」（）(){}]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, max);
    const safeFolderName = sanitize(folderName || "", 100);
    const titleInputSafe = sanitize(titleInput || "", 100);
    const head = sanitize(text, 30);
    const baseName = titleInputSafe || (head ? `${head}_text_${today}` : `text_${today}`);
    const targetFolder = safeFolderName
      ? normalizePath(`${baseFolder}/${safeFolderName}`)
      : baseFolder;

    await this.ensureFolder(targetFolder);
    const verify = this.app.vault.getAbstractFileByPath(targetFolder);
    if (!verify || !(verify instanceof TFolder)) {
      throw new Error(`保存先フォルダの作成に失敗しました: ${targetFolder}`);
    }

    const filePath = this.getAvailableMarkdownPath(targetFolder, baseName);

    const content = buildStandardCleanNote({
      sourceType: "text",
      title: baseName,
      date: today,
      channel: folderName,
      category,
      model,
      cleanup: sections.cleanup,
    });
    const file = await this.app.vault.create(filePath, content);
    await this.tryAppendReceptionEntry({
      filePath,
      category,
      date: today,
      source: "テキスト",
    });
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  async summarizePdf(args: { pdfs: AttachedPdf[]; category: string; folderName: string; titleInput: string; controller: RunController }) {
    const { pdfs, category, folderName, titleInput, controller } = args;
    const progress = new ProgressNotice();
    progress.show(`🤖 優先モデルで添付ファイルを清書中（ファイル${pdfs.length}件）...`);
    try {
      const summary = await this.summarizePdfWithModel({ pdfs, category, controller });
      progress.hide();

      const today = new Date().toISOString().split("T")[0];
      const finalTitle = titleInput.trim()
        || summary.extractedTitle
        || stripSupportedFileExtension(pdfs[0].name)
        || `file_${today}`;

      progress.show("🏷️ 優先モデルでカテゴリ分類中...");
      const classification = await this.classifyCategory({
        sourceType: "PDF・画像",
        title: finalTitle,
        folderName,
        fallbackCategory: category,
        sections: summary.sections,
        controller,
      });
      progress.hide();

      await this.savePdfNote({
        title: finalTitle,
        category: classification.category,
        folderName,
        sections: summary.sections,
        model: summary.modelUsed,
      });

      const inputTokens = summary.usage.input + classification.usage.input;
      const outputTokens = summary.usage.output + classification.usage.output;
      const cost = calcCostUsd(summary.modelUsed, summary.usage.input, summary.usage.output)
        + (classification.modelUsed ? calcCostUsd(classification.modelUsed, classification.usage.input, classification.usage.output) : 0);
      this.settings.totalInputTokens += inputTokens;
      this.settings.totalOutputTokens += outputTokens;
      this.settings.totalCostUsd += cost;
      await this.saveSettings();

      const cumulativeUsd = this.settings.totalCostUsd;
      const noticeText =
        `✅ 清書完成！\n` +
        `清書モデル: ${getModelLabel(summary.modelUsed)}\n` +
        `カテゴリ分類: ${getClassificationModelLabel(classification)}\n` +
        `今回: ${inputTokens}in + ${outputTokens}out tokens\n` +
        `今回: $${cost.toFixed(4)}（約${(cost * USD_TO_JPY).toFixed(1)}円）\n` +
        `累計: $${cumulativeUsd.toFixed(4)}（約${(cumulativeUsd * USD_TO_JPY).toFixed(1)}円）`;
      new Notice(noticeText, 10000);
    } catch (err: unknown) {
      progress.hide();
      if (isAbortedError(err)) {
        new Notice("⏹️ 清書を停止しました", 5000);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error("[YTSummarizer]", err);
      if (message.includes("rate limit") || message.includes("tokens per minute")) {
        new Notice("❌ エラー: 入力が長すぎます（1分間のトークン上限を超えました）。\nPDFのページ数や画像サイズを減らすか、分割して試してください。", 10000);
      } else {
        new Notice(`❌ エラー: ${message}`, 8000);
      }
    }
  }

  async summarizePdfWithModel(args: {
    pdfs: AttachedPdf[];
    category: string;
    controller?: RunController;
  }): Promise<{ sections: SummarySections; extractedTitle?: string; usage: { input: number; output: number }; modelUsed: string }> {
    const { pdfs, controller } = args;
    const prompt = buildPdfPrompt();
    const result = await callModelWithFallback(this.settings, prompt, pdfs, CLEANUP_MAX_TOKENS, controller);
    const parsed = parseSections(result.text, true, result.modelUsed);
    if (result.truncated) notifyCleanupTruncated();
    return {
      sections: parsed.sections,
      extractedTitle: parsed.extractedTitle,
      usage: {
        input: result.inputTokens,
        output: result.outputTokens,
      },
      modelUsed: result.modelUsed,
    };
  }

  async savePdfNote(args: { title: string; category: string; folderName: string; sections: SummarySections; model: string }) {
    const { title, category, folderName, sections, model } = args;
    const today = new Date().toISOString().split("T")[0];
    const baseFolder = normalizePath(this.settings.outputFolder.replace(/^\/+|\/+$/g, ""));

    const sanitize = (s: string) => s
      .replace(/\|/g, "｜")
      .replace(/[\\/:*?"<>#\[\]【】『』「」（）(){}]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 100);
    const safeFolderName = sanitize(folderName || "");
    const baseName = sanitize(title || "") || `file_${today}`;
    const targetFolder = safeFolderName
      ? normalizePath(`${baseFolder}/${safeFolderName}`)
      : baseFolder;

    await this.ensureFolder(targetFolder);
    const verify = this.app.vault.getAbstractFileByPath(targetFolder);
    if (!verify || !(verify instanceof TFolder)) {
      throw new Error(`保存先フォルダの作成に失敗しました: ${targetFolder}`);
    }

    const filePath = this.getAvailableMarkdownPath(targetFolder, baseName);

    const content = buildStandardCleanNote({
      sourceType: "file",
      title: baseName,
      date: today,
      channel: folderName,
      category,
      model,
      cleanup: sections.cleanup,
    });
    const file = await this.app.vault.create(filePath, content);
    await this.tryAppendReceptionEntry({
      filePath,
      category,
      date: today,
      source: "ファイル",
    });
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  async summarizeKindle(args: {
    filePath: string;
    titleInput: string;
    controller: RunController;
    logCallback?: (msg: string) => void;
    doneCallback?: (savedPath: string | null) => void;
  }) {
    const { filePath, titleInput, controller, logCallback, doneCallback } = args;
    const log = (msg: string) => { if (logCallback) logCallback(msg); };
    try {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
      if (!(file instanceof TFile)) {
        throw new Error(`Kindleノートが見つかりません: ${filePath}`);
      }
      const content = await this.app.vault.read(file);
      const bookTitle = titleInput.trim() || extractKindleBookTitle(content, file.basename);
      const blocks = extractKindleHighlightBlocks(content);
      if (blocks.length === 0) {
        throw new Error("ハイライトが見つかりませんでした");
      }
      const chunks = chunkKindleHighlightBlocks(blocks, KINDLE_CHUNK_CHARS);
      log(`📖 ${bookTitle}`);
      log(`ハイライト${blocks.length}件を${chunks.length}回に分けて清書します`);

      const parts: string[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let cost = 0;
      let lastModelUsed = "";
      let failedChunks = 0;
      let stopped = false;
      for (let i = 0; i < chunks.length; i++) {
        if (controller.isAborted) { stopped = true; break; }
        log(`🤖 清書中 ${i + 1}/${chunks.length}...`);
        const prompt = buildKindlePrompt({
          title: bookTitle,
          part: i + 1,
          totalParts: chunks.length,
          highlights: chunks[i],
        });
        let done = false;
        for (let attempt = 0; attempt < 3 && !done && !stopped; attempt++) {
          if (attempt > 0) {
            try {
              await controller.sleep(1000);
            } catch {
              stopped = true;
              break;
            }
            log(`🔄 ${i + 1}/${chunks.length} リトライ（${attempt + 1}回目）...`);
          }
          try {
            const result = await callModelWithFallback(this.settings, prompt, undefined, CLEANUP_MAX_TOKENS, controller);
            if (result.truncated) log(`⚠️ ${i + 1}/${chunks.length} は出力上限で途中まで（末尾を確認してください）`);
            inputTokens += result.inputTokens;
            outputTokens += result.outputTokens;
            cost += calcCostUsd(result.modelUsed, result.inputTokens, result.outputTokens);
            lastModelUsed = result.modelUsed;
            const cleaned = cleanKindleCleanupOutput(result.text);
            if (!cleaned) continue;
            parts.push(cleaned);
            done = true;
            log(`✅ ${i + 1}/${chunks.length} 完了（${getModelLabel(result.modelUsed)}）`);
          } catch (err: unknown) {
            // 停止は失敗扱いにせずループごと抜ける（ここまでの分は保存する）
            if (isAbortedError(err)) {
              stopped = true;
              break;
            }
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[YTSummarizer] Kindle清書 ${i + 1}/${chunks.length} 失敗`, err);
            log(`⚠️ ${i + 1}/${chunks.length} 失敗: ${msg}`);
          }
        }
        if (stopped) break;
        if (!done) {
          failedChunks++;
          log(`❌ ${i + 1}/${chunks.length} は清書できませんでした（この範囲を飛ばして続けます）`);
        }
      }
      if (stopped) {
        log(`⏹️ 停止しました（${parts.length}/${chunks.length}回分まで清書済み）`);
      }
      if (parts.length === 0) {
        if (stopped) {
          new Notice("⏹️ 清書を停止しました（保存なし）", 5000);
          if (doneCallback) doneCallback(null);
          return;
        }
        throw new Error("清書結果が空でした");
      }

      const savedPath = await this.saveKindleNote({ title: bookTitle, body: parts.join("\n\n---\n\n") });
      log(`💾 保存しました: ${savedPath}`);

      this.settings.totalInputTokens += inputTokens;
      this.settings.totalOutputTokens += outputTokens;
      this.settings.totalCostUsd += cost;
      await this.saveSettings();

      if (failedChunks > 0) {
        log(`⚠️ ${chunks.length}回中${failedChunks}回分は清書できませんでした`);
      }

      const cumulativeUsd = this.settings.totalCostUsd;
      const headline = stopped
        ? "⏹️ Kindle清書を停止しました（途中まで保存）"
        : failedChunks > 0
          ? "⚠️ Kindle清書完了（一部スキップ）"
          : "✅ Kindle清書完成！";
      new Notice(
        `${headline}\n` +
        `清書モデル: ${getModelLabel(lastModelUsed)}\n` +
        `分割: ${chunks.length}回${failedChunks > 0 ? `（うち${failedChunks}回失敗）` : ""}\n` +
        `今回: ${inputTokens}in + ${outputTokens}out tokens\n` +
        `今回: $${cost.toFixed(4)}（約${(cost * USD_TO_JPY).toFixed(1)}円）\n` +
        `累計: $${cumulativeUsd.toFixed(4)}（約${(cumulativeUsd * USD_TO_JPY).toFixed(1)}円）`,
        10000,
      );
      if (doneCallback) doneCallback(savedPath);
    } catch (err: unknown) {
      if (isAbortedError(err)) {
        log("⏹️ 停止しました");
        new Notice("⏹️ 清書を停止しました", 5000);
        if (doneCallback) doneCallback(null);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error("[YTSummarizer] Kindle清書に失敗", err);
      log(`❌ エラー: ${message}`);
      if (message.includes("rate limit") || message.includes("tokens per minute")) {
        new Notice("❌ エラー: 1分間のトークン上限を超えました。少し待ってからもう一度実行してください。", 10000);
      } else {
        new Notice(`❌ エラー: ${message}`, 8000);
      }
      if (doneCallback) doneCallback(null);
    }
  }

  async saveKindleNote(args: { title: string; body: string }): Promise<string> {
    const { title, body } = args;
    const baseFolder = normalizePath(KINDLE_OUTPUT_FOLDER);
    await this.ensureFolder(baseFolder);
    const verify = this.app.vault.getAbstractFileByPath(baseFolder);
    if (!verify || !(verify instanceof TFolder)) {
      throw new Error(`保存先フォルダの作成に失敗しました: ${baseFolder}`);
    }
    const sanitize = (s: string) => s
      .replace(/\|/g, "｜")
      .replace(/[\\/:*?"<>#\[\]【】『』「」（）(){}]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .substring(0, 100);
    const baseName = `${sanitize(title) || "kindle"}_清書版`;
    const filePath = this.getAvailableMarkdownPath(baseFolder, baseName);
    await this.app.vault.create(filePath, `${body.trim()}\n`);
    return filePath;
  }

  async summarizeVideoWithModel(args: {
    title: string;
    url: string;
    category: string;
    transcript: string;
    description: string;
    conflictNote: string;
    controller?: RunController;
    logCallback?: (msg: string) => void;
  }): Promise<{ sections: SummarySections; extractedTitle?: string; usage: { input: number; output: number }; modelUsed: string }> {
    const { title, url, category, transcript, description, conflictNote, controller, logCallback } = args;
    const chunks = chunkLongText(transcript, CLEANUP_CHUNK_CHARS);
    if (chunks.length === 0) throw new Error("文字起こしが空のため清書できません");
    if (chunks.length > 1) {
      logCallback?.(`📏 文字起こし${transcript.length}字を${chunks.length}回に分けて清書します`);
    }

    const parts: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let modelUsed = "";
    let truncated = false;
    for (let i = 0; i < chunks.length; i++) {
      controller?.throwIfAborted();
      if (chunks.length > 1) logCallback?.(`🤖 清書中 ${i + 1}/${chunks.length}...`);
      const prompt = buildVideoPrompt({
        title,
        url,
        category,
        transcript: chunks[i],
        description,
        conflictNote,
        part: i + 1,
        totalParts: chunks.length,
      });
      const result = await callModelWithFallback(this.settings, prompt, undefined, CLEANUP_MAX_TOKENS, controller);
      const parsed = parseSections(result.text, false, result.modelUsed);
      parts.push(parsed.sections.cleanup);
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      modelUsed = result.modelUsed;
      if (result.truncated) truncated = true;
    }
    if (truncated) notifyCleanupTruncated(logCallback);

    return {
      sections: { cleanup: parts.join("\n\n") },
      usage: {
        input: inputTokens,
        output: outputTokens,
      },
      modelUsed,
    };
  }

  async checkUrlDuplicate(url: string): Promise<string | null> {
    const baseFolder = normalizePath(this.settings.outputFolder.replace(/^\/+|\/+$/g, ""));
    const targetVid = extractVideoId(url);
    const targetKey = targetVid || url;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fp = normalizePath(file.path);
      if (fp !== baseFolder && !fp.startsWith(baseFolder + "/")) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (fm && typeof fm.url === "string") {
        const vid = extractVideoId(fm.url);
        const key = vid || fm.url;
        if (key === targetKey) return file.basename;
      }
    }
    return null;
  }

  async checkUrlDuplicates(urls: string[]): Promise<Map<string, string | null>> {
    const entries = await Promise.all(urls.map(async (url) => [url, await this.checkUrlDuplicate(url)] as const));
    return new Map(entries);
  }

  findCategoryForFolder(folderName: string): string | null {
    const safeFolderName = normalizeFolderNameCandidate(folderName);
    if (!safeFolderName) return null;
    const baseFolder = normalizePath(this.settings.outputFolder.replace(/^\/+|\/+$/g, ""));
    const targetFolder = normalizePath(`${baseFolder}/${safeFolderName}`);
    const counts = new Map<string, number>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fp = normalizePath(file.path);
      if (fp !== targetFolder && !fp.startsWith(targetFolder + "/")) continue;
      const cat = this.app.metadataCache.getFileCache(file)?.frontmatter?.category;
      if (typeof cat === "string" && cat) {
        const normalizedCat = normalizeLegacyCategory(cat, this.settings.categories);
        if (this.settings.categories.includes(normalizedCat)) {
          counts.set(normalizedCat, (counts.get(normalizedCat) || 0) + 1);
        }
      }
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [cat, count] of counts) {
      if (count > bestCount && this.settings.categories.includes(cat)) {
        best = cat;
        bestCount = count;
      }
    }
    return best;
  }

  async fetchTitlesParallel(urls: string[]): Promise<Map<string, string>> {
    const entries = await Promise.all(urls.map(async (url) => {
      try {
        const isYt = isYouTubeUrl(url);
        const videoId = isYt ? extractVideoId(url) : null;
        if (isYt && videoId) {
          const meta = await this.fetchVideoMeta(videoId);
          return [url, meta.title || url] as const;
        } else {
          const meta = await this.fetchArticleMeta(url);
          return [url, meta.title || url] as const;
        }
      } catch {
        return [url, url] as const;
      }
    }));
    return new Map(entries);
  }

  async saveNote(args: { title: string; url: string; category: string; folderName: string; channelName: string; publishDate: string; sections: SummarySections; titleInput: string; model: string }): Promise<string> {
    const { title, url, category, folderName, channelName, publishDate, sections, titleInput, model } = args;
    const today = new Date().toISOString().split("T")[0];
    const date = publishDate || "動画公開日不明";
    const baseFolder = normalizePath(this.settings.outputFolder.replace(/^\/+|\/+$/g, ""));

    const sanitizeFileName = (s: string) => s
      .replace(/\|/g, "｜")
      .replace(/[\\/:*?"<>#\[\]【】『』「」（）(){}]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 100);
    const safeFolderName = sanitizeFileName(folderName || "");
    const titleInputSafe = sanitizeFileName(titleInput || "");
    const titleSafe = sanitizeFileName(title);
    const baseName = titleInputSafe || titleSafe || `video_${today}`;
    const targetFolder = safeFolderName
      ? normalizePath(`${baseFolder}/${safeFolderName}`)
      : baseFolder;

    await this.ensureFolder(targetFolder);
    const verify = this.app.vault.getAbstractFileByPath(targetFolder);
    if (!verify || !(verify instanceof TFolder)) {
      throw new Error(`保存先フォルダの作成に失敗しました: ${targetFolder}`);
    }

    let filePath = normalizePath(`${targetFolder}/${baseName}.md`);
    let suffix = 1;
    while (this.app.vault.getAbstractFileByPath(filePath) instanceof TFile) {
      filePath = normalizePath(`${targetFolder}/${baseName}（${suffix}）.md`);
      suffix++;
    }
    const content = buildStandardCleanNote({
      sourceType: "youtube",
      title: baseName,
      url,
      date,
      channel: channelName || folderName,
      category,
      model,
      cleanup: sections.cleanup,
    });
    const file = await this.app.vault.create(filePath, content);
    await this.tryAppendReceptionEntry({
      filePath,
      category,
      date,
      source: "YouTube",
    });
    await this.app.workspace.getLeaf("tab").openFile(file);
    return filePath;
  }

  async loadSettings() {
    const loaded = (await this.loadData()) as Record<string, unknown> | null;
    const merged = Object.assign({}, DEFAULT_SETTINGS, loaded) as YTSummarizerSettings & { channels?: unknown; fileNames?: unknown; model?: string };
    const loadedRaw = loaded as { channels?: string[]; fileNames?: string[]; folderNames?: string[] } | null;
    if (!Array.isArray(merged.modelPriority) || merged.modelPriority.length !== 3) {
      merged.modelPriority = [...DEFAULT_MODEL_PRIORITY];
    }
    if (merged.fallbackMode !== "auto" && merged.fallbackMode !== "manual") {
      merged.fallbackMode = "auto";
    }
    merged.playlistConcurrency = clampPlaylistConcurrency(merged.playlistConcurrency);
    if (typeof merged.geminiApiKey !== "string") {
      merged.geminiApiKey = "";
    }
    if (typeof merged.openaiApiKey !== "string") {
      merged.openaiApiKey = "";
    }
    delete (merged as { model?: unknown }).model;
    if (loadedRaw && !Array.isArray(loadedRaw.folderNames)) {
      if (Array.isArray(loadedRaw.fileNames)) {
        merged.folderNames = [...loadedRaw.fileNames];
      } else if (Array.isArray(loadedRaw.channels)) {
        merged.folderNames = [...loadedRaw.channels];
      }
    }
    delete (merged as { channels?: unknown }).channels;
    delete (merged as { fileNames?: unknown }).fileNames;
    this.settings = merged;
    this.settings.categories = normalizeCategoryList(this.settings.categories);
    if (!Array.isArray(this.settings.folderNames)) {
      this.settings.folderNames = [];
    }
    this.settings.folderNames = this.settings.folderNames.map((name) =>
      name.startsWith("提案: ") ? name.replace("提案: ", "") : name
    );
    if (typeof this.settings.totalInputTokens !== "number") this.settings.totalInputTokens = 0;
    if (typeof this.settings.totalOutputTokens !== "number") this.settings.totalOutputTokens = 0;
    if (typeof this.settings.totalCostUsd !== "number") this.settings.totalCostUsd = 0;
    if (typeof this.settings.proxyConfig !== "object" || this.settings.proxyConfig === null) {
      this.settings.proxyConfig = { username: "", password: "" };
    } else {
      const p = this.settings.proxyConfig;
      if (typeof p.username !== "string") p.username = "";
      if (typeof p.password !== "string") p.password = "";
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async callPlaylistScript(url: string): Promise<{ items: Array<{ url: string; title: string }>; playlistTitle: string; playlistCount: number | null; membersOnlyCount: number; unavailableCount: number }> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("デスクトップ版Obsidianでのみ動作します");
    }
    const basePath = adapter.getBasePath();
    const pluginDir = this.manifest.dir
      ? `${basePath}/${this.manifest.dir}`
      : `${basePath}/.obsidian/plugins/${this.manifest.id}`;
    const scriptPath = `${pluginDir}/get_playlist.py`;

    let stdout: string;
    try {
      const r = await execFileText(undefined, "python", [scriptPath, url], {
        timeout: 120000,
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
      });
      stdout = r.stdout;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (err.code === "ENOENT") {
        throw new Error("python コマンドが見つかりません");
      }
      // 最優先: stdoutにJSON形式の {error, code} が出力されていればそれを使う（文字化け防止）
      let parsedError: string | null = null;
      const stdoutMsg = (err.stdout || "").trim();
      if (stdoutMsg) {
        try {
          const parsed = JSON.parse(stdoutMsg);
          if (parsed && typeof parsed.error === "string" && parsed.error) {
            parsedError = parsed.error;
          }
        } catch {
          // stdout がJSONでなければ無視して次のフォールバックへ
        }
      }
      if (parsedError) {
        throw new Error(parsedError);
      }
      const stderrMsg = (err.stderr || "").trim();
      if (stderrMsg) {
        const lastLine = stderrMsg.split(/\r?\n/).filter((l) => l.trim().length > 0).pop() || stderrMsg;
        throw new Error(lastLine.replace(/^ERROR:\s*/i, "").trim() || stderrMsg.substring(0, 300));
      }
      throw new Error(`プレイリスト取得エラー: ${(err.message || String(err)).substring(0, 300)}`);
    }

    if (!stdout || !stdout.trim()) {
      throw new Error("プレイリストスクリプトが応答を返しませんでした");
    }

    const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const items: Array<{ url: string; title: string }> = [];
    let playlistTitle = "";
    let playlistCount: number | null = null;
    // 一覧の時点で除外された本数（メンバー限定・非公開/Premium限定）
    let membersOnlyCount = 0;
    let unavailableCount = 0;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as { url?: string; title?: string; playlistTitle?: string; playlistCount?: number; membersOnlyCount?: number; unavailableCount?: number };
        if (typeof obj.playlistTitle === "string") {
          playlistTitle = obj.playlistTitle;
          if (typeof obj.playlistCount === "number" && Number.isFinite(obj.playlistCount)) {
            playlistCount = obj.playlistCount;
          }
          if (typeof obj.membersOnlyCount === "number" && Number.isFinite(obj.membersOnlyCount)) {
            membersOnlyCount = obj.membersOnlyCount;
          }
          if (typeof obj.unavailableCount === "number" && Number.isFinite(obj.unavailableCount)) {
            unavailableCount = obj.unavailableCount;
          }
        } else if (obj.url && obj.title) {
          items.push({ url: obj.url, title: obj.title });
        }
      } catch {
        // skip invalid lines
      }
    }

    // 除外分しか無かった場合は「取得できなかった」ではないので、件数を添えて呼び出し側に返す
    if (items.length === 0 && membersOnlyCount === 0 && unavailableCount === 0) {
      throw new Error("動画URLを取得できませんでした");
    }

    return { items, playlistTitle, playlistCount, membersOnlyCount, unavailableCount };
  }

  async runPlaylistSummarize(args: { items: Array<{ url: string; title: string }>; category: string; folderName: string; controller: RunController; logCallback?: (msg: string) => void; doneCallback?: (lastFilePath: string | null) => void }) {
    const { items, category, folderName, controller, logCallback, doneCallback } = args;
    const log = (msg: string) => logCallback?.(msg);
    const results: PlaylistProcessResult[] = [];
    let sessionInputTokens = 0;
    let sessionOutputTokens = 0;
    let sessionCostUsd = 0;
    let lastSuccessFilePath: string | null = null;
    // 成功した動画だけを数える（失敗分はモデル情報を持たない）
    const cleanupModelCounts = new Map<string, number>();
    const classificationModelCounts = new Map<string, number>();
    const countModel = (counts: Map<string, number>, label: string) => {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    };

    const dupMap = await this.checkUrlDuplicates(items.map((item) => item.url));
    const dupUrls = items.map((item) => item.url).filter((url) => dupMap.get(url) !== null);
    let targetItems = items;
    if (dupUrls.length > 0) {
      for (const url of dupUrls) {
        log(`⚠️ URLダブり（処理済み）：${dupMap.get(url) || url}`);
      }
      targetItems = items.filter((item) => dupMap.get(item.url) === null);
    }
    const n = targetItems.length;
    const concurrency = Math.min(clampPlaylistConcurrency(this.settings.playlistConcurrency), n);
    let nextIndex = 0;

    const processItem = async (i: number) => {
      const item = targetItems[i];
      const prefix = `[${i + 1}/${n}]`;
      log(`${prefix} 処理開始：${item.title}`);
      let success = false;
      let error = "";
      let stopped = false;

      for (let attempt = 0; attempt < 3; attempt++) {
        if (controller.isAborted) { stopped = true; break; }
        if (attempt > 0) {
          const waitMs = calcRetryDelayMs(attempt, isRateLimitMessage(error));
          log(`${prefix} ⏳ ${Math.round(waitMs / 1000)}秒待ってからリトライします`);
          try {
            await controller.sleep(waitMs);
          } catch {
            stopped = true;
            break;
          }
          log(`${prefix} 🔄 リトライ（${attempt + 1}回目）...`);
        }
        try {
          const { inputTokens, outputTokens, cost, filePath, modelUsed, classificationModelLabel } = await this.summarizeSingleVideoForPlaylist({
            url: item.url,
            titleOverride: item.title,
            category,
            folderName,
            controller,
            logCallback: (msg: string) => log(`${prefix} ${msg}`),
          });
          sessionInputTokens += inputTokens;
          sessionOutputTokens += outputTokens;
          sessionCostUsd += cost;
          lastSuccessFilePath = filePath;
          countModel(cleanupModelCounts, getModelLabel(modelUsed));
          countModel(classificationModelCounts, classificationModelLabel);
          success = true;
          if (modelUsed && modelUsed !== this.settings.modelPriority[0]) {
            log(`${prefix} ⚠️ フォールバック：${getModelLabel(modelUsed)} で清書しました（優先順位1が失敗しています）`);
          }
          log(`${prefix} ✅ 完了：${item.title}`);
          break;
        } catch (e) {
          // 停止はリトライせずそのまま抜ける
          if (isAbortedError(e)) {
            stopped = true;
            break;
          }
          error = e instanceof Error ? e.message : String(e);
          log(`${prefix} ❌ 失敗（${attempt + 1}回目）：${error}`);
        }
      }

      if (stopped && !success) {
        log(`${prefix} ⏹️ 停止しました`);
        results.push({
          item: { url: item.url, title: item.title },
          success: false,
          error: "停止しました",
        });
        return;
      }

      if (!success) {
        log(`${prefix} ⛔ スキップ：3回失敗しました`);
      }

      results.push({
        item: { url: item.url, title: item.title },
        success,
        error: success ? undefined : `${error || "不明なエラーが発生しました"}（3回リトライ済み）`,
      });
    };

    const worker = async () => {
      for (;;) {
        if (controller.isAborted) return;
        const i = nextIndex++;
        if (i >= n) return;
        await processItem(i);
      }
    };

    if (n > 0) {
      log(`同時処理 ${concurrency}本で開始`);
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    }

    if (controller.isAborted) {
      // 停止で着手できなかった分も結果一覧に残す
      const handled = new Set(results.map((r) => r.item.url));
      for (const item of targetItems) {
        if (handled.has(item.url)) continue;
        results.push({
          item: { url: item.url, title: item.title },
          success: false,
          error: "停止したため未処理",
        });
      }
      const doneCount = results.filter((r) => r.success).length;
      log(`⏹️ 停止しました（${doneCount}/${n}件 完了）`);
      new Notice(`⏹️ 清書を停止しました（${doneCount}/${n}件 完了）`, 8000);
    } else {
      log("全件処理完了");
    }

    this.settings.totalInputTokens += sessionInputTokens;
    this.settings.totalOutputTokens += sessionOutputTokens;
    this.settings.totalCostUsd += sessionCostUsd;
    await this.saveSettings();

    doneCallback?.(lastSuccessFilePath);
    new ResultModal(this.app, results, sessionCostUsd, sessionInputTokens, sessionOutputTokens, this.settings.totalCostUsd, cleanupModelCounts, classificationModelCounts).open();
  }

  async summarizeSingleVideoForPlaylist(args: { url: string; titleOverride: string; category: string; folderName: string; controller?: RunController; logCallback?: (msg: string) => void }): Promise<{ inputTokens: number; outputTokens: number; cost: number; filePath: string; modelUsed: string; classificationModelLabel: string }> {
    const { url, titleOverride, category, folderName, controller, logCallback } = args;

    const videoId = extractVideoId(url);
    if (!videoId) throw new Error("有効なYouTube URLではありません");

    let data: { title: string; transcript: string; description: string; conflictNote: string; channelName: string; publishDate: string };
    try {
      data = await this.fetchYouTubeData(videoId, controller);
    } catch (err) {
      if (isAbortedError(err)) throw err;
      const isNoCaption = err instanceof TranscriptError && (err.code === "NO_TRANSCRIPT" || err.code === "TRANSCRIPTS_DISABLED");
      if (isNoCaption) {
        throw new Error("字幕なしのためスキップしました");
      }
      throw err;
    }

    if (!data.transcript || data.transcript.trim().length < 50) {
      throw new Error("字幕が取得できませんでした（字幕がない動画は清書できません）");
    }

    const finalTitle = titleOverride || data.title;
    const itemFolderName = normalizeFolderNameCandidate(data.channelName) || folderName;

    const summary = await this.summarizeVideoWithModel({
      title: finalTitle,
      url,
      category,
      transcript: data.transcript,
      description: data.description,
      conflictNote: data.conflictNote,
      controller,
      logCallback,
    });

    const classification = await this.classifyCategory({
      sourceType: "YouTube動画",
      title: finalTitle,
      url,
      folderName: itemFolderName,
      fallbackCategory: category,
      sections: summary.sections,
      description: data.description,
      controller,
    });

    const filePath = await this.saveNoteForPlaylist({
      title: finalTitle,
      url,
      category: classification.category,
      folderName: itemFolderName,
      channelName: data.channelName,
      publishDate: data.publishDate,
      sections: summary.sections,
      model: summary.modelUsed,
    });

    const inputTokens = summary.usage.input + classification.usage.input;
    const outputTokens = summary.usage.output + classification.usage.output;
    const cost = calcCostUsd(summary.modelUsed, summary.usage.input, summary.usage.output)
      + (classification.modelUsed ? calcCostUsd(classification.modelUsed, classification.usage.input, classification.usage.output) : 0);

    return {
      inputTokens,
      outputTokens,
      cost,
      filePath,
      modelUsed: summary.modelUsed,
      classificationModelLabel: getClassificationModelLabel(classification),
    };
  }

  async saveNoteForPlaylist(args: { title: string; url: string; category: string; folderName: string; channelName: string; publishDate: string; sections: SummarySections; model: string }): Promise<string> {
    const { title, url, category, folderName, channelName, publishDate, sections, model } = args;
    const today = new Date().toISOString().split("T")[0];
    const date = publishDate || "動画公開日不明";
    const baseFolder = normalizePath(this.settings.outputFolder.replace(/^\/+|\/+$/g, ""));

    const sanitizeFileName = (s: string) => s
      .replace(/\|/g, "｜")
      .replace(/[\\/:*?"<>#\[\]【】『』「」（）(){}]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 100);

    const safeFolderName = sanitizeFileName(folderName || "");
    const safeChannelName = sanitizeFileName(channelName || "");
    const baseName = sanitizeFileName(title || `video_${today}`);
    const targetFolderName = safeChannelName || safeFolderName;
    const targetFolder = targetFolderName
      ? normalizePath(`${baseFolder}/${targetFolderName}`)
      : baseFolder;

    await this.ensureFolder(targetFolder);
    const verify = this.app.vault.getAbstractFileByPath(targetFolder);
    if (!verify || !(verify instanceof TFolder)) {
      throw new Error(`保存先フォルダの作成に失敗しました: ${targetFolder}`);
    }

    const content = buildStandardCleanNote({
      sourceType: "youtube",
      title: baseName,
      url,
      date,
      channel: channelName || folderName,
      category,
      model,
      cleanup: sections.cleanup,
    });
    let filePath = normalizePath(`${targetFolder}/${baseName}.md`);
    let suffix = 1;
    for (;;) {
      while (this.app.vault.getAbstractFileByPath(filePath) instanceof TFile) {
        filePath = normalizePath(`${targetFolder}/${baseName}（${suffix}）.md`);
        suffix++;
      }
      try {
        await this.app.vault.create(filePath, content);
        break;
      } catch (err) {
        if (suffix > 50) throw err;
        filePath = normalizePath(`${targetFolder}/${baseName}（${suffix}）.md`);
        suffix++;
      }
    }
    await this.tryAppendReceptionEntry({
      filePath,
      category,
      date,
      source: "YouTube",
    });
    return filePath;
  }
}

function parseSections(rawText: string, expectTitle: boolean, modelId?: string): { sections: SummarySections; extractedTitle?: string } {
  let text = rawText;
  let extractedTitle: string | undefined;
  if (expectTitle) {
    const idx = text.indexOf("---SECTION:");
    if (idx > 0) {
      const head = text.substring(0, idx).trim();
      const firstLine = head.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      if (firstLine) {
        extractedTitle = firstLine.replace(/^#+\s*/, "").replace(/\|/g, "｜").replace(/[\\/:*?"<>#\[\]]/g, "").trim().substring(0, 100);
      }
      text = text.substring(idx);
    }
  }
  const split = (key: string): string => {
    const re = new RegExp(`---SECTION:${key}---\\s*([\\s\\S]*?)(?=---SECTION:|$)`);
    const m = text.match(re);
    if (!m) return "";
    let body = m[1].trim();
    if (/^#{1,2}\s/.test(body)) {
      body = body.replace(/^#{1,2}[^\n]*\n+/, "").trim();
    }
    return body;
  };
  const stripCleanupHeading = (s: string): string =>
    s.replace(/^#{1,2}\s*清書\s*\r?\n+/, "").trim();
  const sections: SummarySections = {
    cleanup: stripCleanupHeading(split("清書")),
  };
  if (!sections.cleanup) {
    throw new Error(`${modelId ? getModelLabel(modelId) : "AI"}の出力からセクションを抽出できませんでした`);
  }
  return { sections, extractedTitle };
}

const OUTPUT_LANGUAGE_RULE = `出力は必ず日本語で書くこと。素材（文字起こし・記事・テキスト・添付ファイル）が日本語以外の言語の場合は、内容を日本語に翻訳した上で清書すること。ただし人名・企業名・製品名・書名などの固有名詞、数字・金額・年号、URL、コードブロックやプロンプトの中身は原文の表記をそのまま残すこと。原文が日本語の場合は翻訳せず、日本語のまま清書すること（この「そのまま」は言語を変えないという意味であり、逐語で書き写すという意味ではない）。`;

const COMMON_RULES = `動画の文字起こしと概要欄に含まれている情報のみを使うこと。動画外の知識・補足情報は一切加えないこと。数字・日付・固有名詞・年号は必ず概要欄の記載を正として照合し、概要欄と一致する形で出力すること。概要欄に記載がない場合のみ、その数字・日付・固有名詞・年号に限って文字起こしの表記をそのまま使うこと。相対的な時間表現（去年・今年・先月・今月・〇〇以来 等）は、概要欄に絶対年号の記載がある場合は必ずその年号に置き換えて出力すること。概要欄に年号がない場合は、その時間表現に限って文字起こしの表記をそのまま使うこと。概要欄に数字・金額・パーセント・年号が記載されている場合は、文字起こしより概要欄の数値を絶対優先すること。文字起こし内に[⚠️不確か:...]のフラグがある箇所は聞き取りが不確かな可能性があります。概要欄で確認できない場合は清書内に⚠️マークを付けて注意を促してください。文字起こし内に[⚠️数字矛盾 手動:... 自動:...]のフラグがある箇所は手動字幕と自動字幕で数字が異なります。概要欄で確認できない場合は⚠️マークを付けてください。なお、ここでの「そのまま使う」は数字・日付・固有名詞・年号の表記についての指示であり、文章全体を逐語のまま残してよいという意味ではない。`;

const PROMPT_PRESERVATION_RULES = `素材内に「プロンプト」「指示文」「コピペ用」「以下を入力」「テンプレート」などとして紹介されている実用プロンプトがある場合は、通常の説明文に溶かさず、「## プロンプト例」または文脈に合う小見出しを付けてコードブロックで残すこと。プロンプト内の役割、条件、出力形式、禁止事項、変数名、箇条書き構造は意味が変わらないよう保持すること。聞き取りが不確かな語句は勝手に補完せず⚠️を付けること。`;

const CLEANUP_REMOVAL_SPOKEN = `【必ず削除するもの】
- 冒頭・末尾の挨拶、自己紹介、チャンネルや配信者の紹介
- チャンネル登録・高評価・通知・コメント・SNSフォロー・メンバーシップの誘導、案件や商品の宣伝、他動画やイベントの告知
- 本題に入る前の前置き（「今回は〇〇について解説します」「最後まで見てください」「詳しくは後半で」などの予告・煽り・目次の読み上げ）
- 話し言葉、フィラー（えー、あのー、まあ、なんか、ですね 等）、相づち、言い直し、口癖
- 本筋から外れた雑談・脱線した例え話・思い出話
- 同じ内容の繰り返し、言い換えただけの重複、冗長な言い回し`;

const CLEANUP_REMOVAL_WRITTEN = `【必ず削除するもの】
- 冒頭・末尾の挨拶、自己紹介、媒体やサービスの宣伝、関連記事・SNS・メルマガへの誘導
- 本題に入る前の前置き（「本記事では〇〇を解説します」「最後までお読みください」などの予告・目次の読み上げ）
- 話し言葉、フィラー（えー、あのー等）、言い直し
- 本筋から外れた脱線・冗長な例え話
- 同じ内容の繰り返し、言い換えただけの重複、冗長な言い回し`;

const CLEANUP_STYLE_RULES = `【残し方】
- 主張・理由・根拠・数字・固有名詞・手順・本筋に必要な具体例は落とさないこと。
- ただし逐語で書き写さないこと。話し言葉を書き言葉に直し、1文を短くし、結論から書くこと。
- 内容のまとまりごとに「## 見出し」を、その中の区分に「### 小見出し」を付けること。
- 並列できる情報は「- 」の箇条書きにまとめること。`;

const CLEANUP_LENGTH_SPOKEN = `【分量】元の文字起こしの半分以下にすること。元の分量に近い状態は「整形しただけ」であり清書ではない。逐語に近くなっている場合は削除対象が残っているということなので、削り直してから出力すること。`;

const CLEANUP_LENGTH_WRITTEN = `【分量】元の分量より必ず短くすること（目安7割以下）。原文をそのまま書き写した状態にはしないこと。`;

const SECTIONS_SPEC = `以下の1セクションのみを出力してください。セクションの先頭に必ず指定の区切り行を入れてください。区切り行はそのままの文字列で出力すること（コードブロックや装飾なし）。

【出力言語（厳守）】
${OUTPUT_LANGUAGE_RULE}

【出力フォーマットの禁止事項】
- セクションの区切りに --- を使わない
- 箇条書きの区切りに --- を使わない
- 指定の区切り行（---SECTION:清書---）以外では --- を出力しない

---SECTION:清書---
{CLEANUP_SPEC}`;

const CLEANUP_MAX_TOKENS = 16000;
const CLEANUP_CHUNK_CHARS = 12000;

/**
 * 長い素材を文の切れ目で maxChars ごとに分割する。
 * 素材を substring で打ち切ると後半が丸ごと消えるため、分割して複数回清書するのに使う。
 */
function chunkLongText(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];
  const pieces = trimmed.split(/(?<=[。．！？\n])|(?<=[.!?]\s)/).filter((p) => p.length > 0);
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (piece.length > maxChars) {
      if (current) chunks.push(current);
      current = "";
      for (let i = 0; i < piece.length; i += maxChars) chunks.push(piece.substring(i, i + maxChars));
      continue;
    }
    if (current.length + piece.length > maxChars) {
      chunks.push(current);
      current = piece;
    } else {
      current += piece;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c) => c.trim()).filter((c) => c.length > 0);
}

/** 出力トークン上限で応答が切れたときの共通通知（従来は無警告で途中までのノートが保存されていた） */
function notifyCleanupTruncated(logCallback?: (msg: string) => void): void {
  const msg = "⚠️ 清書の出力が上限に達しました。末尾が途中で切れている可能性があります。";
  logCallback?.(msg);
  new Notice(msg, 10000);
}

function buildChunkPartNote(part: number, totalParts: number, unit: string): string {
  if (totalParts <= 1) return "";
  return `【分割清書の注意】この${unit}は全体を${totalParts}分割したうちの${part}番目です。渡された範囲だけを清書し、前後の範囲には触れないこと。「ここまでの内容」「次に」などのつなぎ文、導入文、まとめ文は書かないこと。${part > 1 ? "この範囲は途中から始まるため、冒頭に導入や前置きを書かず、いきなり本題の見出しから始めること。" : ""}\n\n`;
}

function buildVideoPrompt(args: {
  title: string;
  url: string;
  category: string;
  transcript: string;
  description: string;
  conflictNote: string;
  part: number;
  totalParts: number;
}): string {
  const { title, url, transcript, description, conflictNote, part, totalParts } = args;
  const hasDescription = description.length > 0;
  const isLastPart = part === totalParts;
  const descriptionBlock = hasDescription
    ? `【概要欄】\n${description}\n`
    : `【概要欄】（なし）\n`;
  const cleanupBase = `以下の文字起こしを、読み物として通用する日本語の文章に清書してください。清書とは「文字起こしを整形すること」ではなく、「不要な発話を削って読める文章に書き直すこと」です。

${CLEANUP_REMOVAL_SPOKEN}

${CLEANUP_STYLE_RULES}

${CLEANUP_LENGTH_SPOKEN}

${PROMPT_PRESERVATION_RULES}`;
  const cleanupSpec = hasDescription && isLastPart
    ? `${cleanupBase}\n\n概要欄に文字起こしと重複しない情報（URL・日付・参考文献・補足情報など）がある場合のみ「## 概要欄」セクションを末尾に追加し、その重複しない情報のみを箇条書き（"* "形式）で書いてください。重複する内容のみの場合は概要欄セクションを省略すること。`
    : `${cleanupBase}\n\n「## 概要欄」見出しは追加しないこと。`;
  const conflictBlock = conflictNote
    ? `【字幕の数字矛盾検出ログ】\n${conflictNote}\n\n`
    : "";

  return `あなたはYouTube動画の清書を行うアシスタントです。以下の素材から清書を生成してください。

【共通ルール（厳守）】
${COMMON_RULES}

【動画タイトル】${title}
【URL】${url}
${descriptionBlock}
${conflictBlock}${buildChunkPartNote(part, totalParts, "文字起こし")}【文字起こし】
${transcript}

---

${SECTIONS_SPEC.replace("{CLEANUP_SPEC}", cleanupSpec)}

【最終確認】
- 区切り行（---SECTION:清書---）を必ずそのまま出力してください。
- 動画外の知識を使ってはいけません。
- 出力は必ず日本語で書いてください（素材が日本語以外の場合は日本語に翻訳した上で清書すること）。
`;
}

const ARTICLE_COMMON_RULES = `記事の文章のみを情報源とすること。記事外の知識・補足情報は一切加えないこと。数字・金額・パーセント・年号・固有名詞・日付は原文の記載をそのまま使い、変更してはいけない。原文に記載がない情報は出力に含めないこと。`;

function buildArticlePrompt(args: {
  title: string;
  url: string;
  category: string;
  text: string;
  part: number;
  totalParts: number;
}): string {
  const { title, url, text, part, totalParts } = args;
  const cleanupSpec = `以下の記事本文を、論旨が明確に伝わる文章に清書してください。清書とは「原文を整形すること」ではなく、「不要な部分を削って読める文章に書き直すこと」です。内容・数字・固有名詞は一切変えず、原文の論理構造を保つこと。

${CLEANUP_REMOVAL_WRITTEN}

${CLEANUP_STYLE_RULES}

${CLEANUP_LENGTH_WRITTEN}

${PROMPT_PRESERVATION_RULES}

「## 概要欄」見出しは追加しないこと。`;

  return `あなたは記事の清書を行うアシスタントです。以下の素材から清書を生成してください。

【共通ルール（厳守）】
${ARTICLE_COMMON_RULES}

【記事タイトル】${title}
【URL】${url}
${buildChunkPartNote(part, totalParts, "記事本文")}【記事本文】
${text}

---

${SECTIONS_SPEC.replace("{CLEANUP_SPEC}", cleanupSpec)}

【最終確認】
- 区切り行（---SECTION:清書---）を必ずそのまま出力してください。
- 記事外の知識を使ってはいけません。
- 出力は必ず日本語で書いてください（素材が日本語以外の場合は日本語に翻訳した上で清書すること）。
`;
}

const TEXT_COMMON_RULES = `入力されたテキストのみを情報源とすること。テキスト外の知識・補足情報は一切加えないこと。数字・金額・パーセント・年号・固有名詞・日付は原文の記載をそのまま使い、変更してはいけない。原文に記載がない情報は出力に含めないこと。`;

function buildTextPrompt(args: {
  text: string;
  category: string;
  part: number;
  totalParts: number;
}): string {
  const { text, part, totalParts } = args;
  const cleanupSpec = `以下の入力テキストを、論旨が整理された読みやすい文章に清書してください。清書とは「原文を整形すること」ではなく、「不要な部分を削って読める文章に書き直すこと」です。内容・数字・固有名詞は一切変えず、原文の論理構造を保つこと。

${CLEANUP_REMOVAL_WRITTEN}

${CLEANUP_STYLE_RULES}

${CLEANUP_LENGTH_WRITTEN}

${PROMPT_PRESERVATION_RULES}

「## 概要欄」見出しは追加しないこと。`;

  return `あなたはテキストの清書を行うアシスタントです。以下の素材から清書を生成してください。

【共通ルール（厳守）】
${TEXT_COMMON_RULES}

${buildChunkPartNote(part, totalParts, "テキスト")}【入力テキスト】
${text}

---

${SECTIONS_SPEC.replace("{CLEANUP_SPEC}", cleanupSpec)}

【最終確認】
- 区切り行（---SECTION:清書---）を必ずそのまま出力してください。
- テキスト外の知識を使ってはいけません。
- 出力は必ず日本語で書いてください（素材が日本語以外の場合は日本語に翻訳した上で清書すること）。
`;
}

const KINDLE_SOURCE_FOLDER = "Source/Obsidian/Kindle";
const KINDLE_OUTPUT_FOLDER = "Source/Obsidian/Kindle清書";
const KINDLE_CHUNK_CHARS = 9000;

function stripYamlFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const closeIdx = text.indexOf("\n---", 3);
  if (closeIdx < 0) return text;
  const lineEnd = text.indexOf("\n", closeIdx + 1);
  return lineEnd < 0 ? "" : text.substring(lineEnd + 1);
}

function stripKindleBasenameAuthor(basename: string): string {
  const dashIdx = basename.indexOf("-");
  if (dashIdx > 0 && dashIdx <= 20) {
    const rest = basename.substring(dashIdx + 1).trim();
    if (rest) return rest;
  }
  return basename;
}

function splitKindleMainTitle(title: string): string {
  const main = title.split(/[:：]/)[0].trim();
  return main.length >= 4 ? main : title.trim();
}

function splitKindleTitleHead(title: string): string {
  const head = title.split("\u3000")[0].trim();
  return head.length >= 4 && head !== title.trim() ? head : "";
}

function extractKindleFrontmatterTitle(frontmatter: string): string {
  const lines = frontmatter.split(/\r?\n/);
  const idx = lines.findIndex((line) => /^kindle-title:/.test(line));
  if (idx < 0) return "";
  const inline = lines[idx].replace(/^kindle-title:\s*/, "").trim();
  if (inline && !/^[>|][-+]?$/.test(inline)) {
    return inline.replace(/^['"]|['"]$/g, "").trim();
  }
  if (!/^[>|][-+]?$/.test(inline)) return "";
  const folded = inline.startsWith(">");
  const parts: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (!/^\s+\S/.test(lines[i])) break;
    parts.push(lines[i].trim());
  }
  return parts.join(folded ? " " : "\n").trim();
}

function extractKindleBookTitle(content: string, basename: string): string {
  const body = stripYamlFrontmatter(content);
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading && heading[1].trim()) return heading[1].trim();
  const fmMatch = content.startsWith("---") ? content.match(/^---\r?\n([\s\S]*?)\r?\n---/) : null;
  if (fmMatch) {
    const fmTitle = extractKindleFrontmatterTitle(fmMatch[1]);
    if (fmTitle) return fmTitle;
  }
  return stripKindleBasenameAuthor(basename);
}

function extractKindleHighlightBlocks(content: string): string[] {
  let body = stripYamlFrontmatter(content);
  const hIdx = body.search(/^##\s*Highlights\s*$/m);
  if (hIdx >= 0) {
    body = body.substring(hIdx).replace(/^##\s*Highlights\s*$/m, "");
  }
  body = body
    .replace(/^#\s+[^\n]*\r?\n/, "")
    .replace(/^##\s*Metadata\s*$/m, "")
    .replace(/^\*\s*(Author|ASIN|Reference|\[Kindle link\]).*$/gm, "")
    .replace(/\s*—\s*location:\s*\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\s*\^ref-[A-Za-z0-9]+/g, "");
  return body
    .split(/^\s*---\s*$/m)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function chunkKindleHighlightBlocks(blocks: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > maxChars) {
      chunks.push(current);
      current = block;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const KINDLE_COMMON_RULES = `Kindleのハイライトに書かれている情報のみを使うこと。本の外の知識・補足情報は一切加えないこと。数字・金額・パーセント・年号・固有名詞・日付はハイライトの記載をそのまま使い、変更してはいけない。ハイライトに記載がない情報は出力に含めないこと。`;

function buildKindlePrompt(args: { title: string; part: number; totalParts: number; highlights: string }): string {
  const { title, part, totalParts, highlights } = args;
  const partNote = totalParts > 1
    ? `このハイライトは「${title}」を${totalParts}分割したうちの${part}番目です。渡された範囲だけを清書し、前後の範囲には触れないこと。「ここまでの内容」「次に」などのつなぎ文、導入文、まとめ文は書かないこと。`
    : "";

  return `あなたはKindleのハイライトを読み物として清書するアシスタントです。

【共通ルール（厳守）】
${KINDLE_COMMON_RULES}

【書名】${title}
${partNote}

【ハイライト】
${highlights}

【出力形式（厳守）】
- Markdownの本文だけを出力すること。前置き・後書き・説明文・コードブロックは出力しないこと。
- frontmatter（先頭の --- で囲むメタデータ）は出力しないこと。
- 「# 書名」のような大見出し（#）は出力しないこと。見出しは必ず「## 」から始めること。
- 内容のまとまりごとに「## 見出し」を付けること。見出しはハイライトの内容から作ること。
- 各見出しの本文は、断片的なハイライトをつなげて読み下せる日本語の文章にすること。話し言葉・冗長な表現・重複は整理してよいが、内容は変えないこと。
- 特に重要な語句は **太字** にしてよい。並列の情報は「- 」の箇条書きにしてよい。
- 見出しと見出しの間には、区切りとして --- だけの行を1行入れること。
- 出力の最後に --- を置かないこと。
`;
}

function cleanKindleCleanupOutput(rawText: string): string {
  let text = rawText.trim();
  text = text.replace(/^```(?:markdown|md)?\s*\r?\n/i, "").replace(/\r?\n```$/i, "").trim();
  const fmLike = text.match(/^---\r?\n[A-Za-z_-]+:[^\n]*\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (fmLike) text = text.substring(fmLike[0].length).trim();
  text = text.replace(/^#\s+[^\n]*\r?\n+/, "");
  text = text.replace(/\r?\n\s*---\s*$/, "");
  return text.trim();
}

function buildPdfPrompt(): string {
  const cleanupSpec = `添付ファイルの本文・画像内容を、論旨が明確に伝わる文章に清書してください。清書とは「原文を整形すること」ではなく、「不要な部分を削って読める文章に書き直すこと」です。内容・数字・固有名詞は一切変えず、原文の論理構造を保つこと。

${CLEANUP_REMOVAL_WRITTEN}

${CLEANUP_STYLE_RULES}

${CLEANUP_LENGTH_WRITTEN}

${PROMPT_PRESERVATION_RULES}

「## 概要欄」見出しは追加しないこと。`;
  return `添付ファイルから内容を読み取り、清書を生成してください。
まず添付ファイル全体を見てタイトルを1行で抽出し、その後セクションを生成してください。
添付ファイルに含まれる情報のみを使用し、外部知識は加えないこと。

【共通ルール（厳守）】
添付ファイルに含まれている情報のみを使うこと。外部知識・補足情報は一切加えないこと。数字・金額・パーセント・年号・固有名詞・日付は添付ファイルに記載のものをそのまま使い、変更してはいけない。原文に記載がない情報は出力に含めないこと。読み取りが不確かな箇所は⚠️マークを付けて注意を促してください。

---

出力形式（厳守）:
最初の1行に「タイトル：」を付けずタイトルのみを出力してください（例: "AIエージェント設計の5原則"）。
その直後に空行を入れ、続いて以下の1セクションを出力してください。セクションの先頭に必ず指定の区切り行を入れてください。区切り行はそのままの文字列で出力すること（コードブロックや装飾なし）。

${SECTIONS_SPEC.replace("{CLEANUP_SPEC}", cleanupSpec)}

【最終確認】
- 1行目にタイトル、その後に区切り行（---SECTION:清書---）を必ずそのまま出力してください。
- 添付ファイル外の知識を使ってはいけません。
- 出力は必ず日本語で書いてください（素材が日本語以外の場合は日本語に翻訳した上で清書すること）。
`;
}

class InputModal extends Modal {
  private plugin: YTSummarizerPlugin;
  private prefilledUrl: string | undefined;
  private resolve: (r: ModalResult | null) => void;
  private resolved = false;
  private closed = false;
  private inputMode: InputMode = "url";
  private selectedFolderName: string = "";
  private autoFolderName: string = "";
  private isFetchingFolderName: boolean = false;
  private modeButtonEls: Partial<Record<InputMode, HTMLButtonElement>> = {};
  private urlRowEl: HTMLElement | null = null;
  private textRowEl: HTMLElement | null = null;
  private fileRowEl: HTMLElement | null = null;
  private kindleRowEl: HTMLElement | null = null;
  private folderRowEl: HTMLElement | null = null;
  private playlistSaveHintEl: HTMLElement | null = null;
  private kindleBtnEl: HTMLButtonElement | null = null;
  private kindleListEl: HTMLElement | null = null;
  private kindleOutsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private selectedKindlePath: string = "";
  private kindleTitleCandidates: string[] = [];
  private kindleTitleWrapEl: HTMLElement | null = null;
  private kindleTitleListEl: HTMLElement | null = null;
  private kindleTitleOutsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private titleRowEl: HTMLElement | null = null;
  private folderNameBtnEl: HTMLButtonElement | null = null;
  private folderNameListEl: HTMLElement | null = null;
  private folderNameOutsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private folderNameInlineEditBtnEl: HTMLButtonElement | null = null;
  private folderNameInlineInputEl: HTMLInputElement | null = null;
  private folderNameFetchTimer: number | null = null;
  private folderNameFetchToken = 0;
  private hasManualFolderSelection = false;
  private pdfs: AttachedPdf[] = [];
  private pdfListEl: HTMLElement | null = null;
  private directTextEl: HTMLTextAreaElement | null = null;
  private urlInputEl: HTMLInputElement | null = null;
  private titleInputEl: HTMLTextAreaElement | null = null;
  private titleFetchTimer: number | null = null;
  private titleFetchToken = 0;
  private playlistItems: Array<{ url: string; title: string; titleInputEl: HTMLInputElement | null }> = [];
  private playlistAreaEl: HTMLElement | null = null;
  private logAreaEl: HTMLElement | null = null;
  private copyLogBtnEl: HTMLButtonElement | null = null;
  private submitBtnEl: HTMLButtonElement | null = null;
  private stopBtnEl: HTMLButtonElement | null = null;
  private runController: RunController | null = null;
  private isPlaylistFetched: boolean = false;
  private playlistFetchToken = 0;
  private playlistStats: PlaylistStats = { loaded: 0, saved: 0, unprocessed: 0, total: null, membersOnly: 0, unavailable: 0 };

  constructor(app: App, plugin: YTSummarizerPlugin, prefilledUrl: string | undefined, resolve: (r: ModalResult | null) => void) {
    super(app);
    this.plugin = plugin;
    this.prefilledUrl = prefilledUrl;
    this.resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("yt-summarizer-modal");
    const titleRow = contentEl.createDiv({ cls: "yt-summarizer-title-row" });
    titleRow.createEl("h2", { text: "清書を作成" });
    const infoWrap = titleRow.createSpan({ cls: "yt-summarizer-info-wrap" });
    infoWrap.createSpan({ text: "i", cls: "yt-summarizer-info-icon" });
    infoWrap.createDiv({
      text: [
        "入力方法を選び、必要な内容だけ入れて清書します。",
        "同じURLは重複保存しません。",
        "カテゴリは保存前に自動分類します。",
      ].join("\n"),
      cls: "yt-summarizer-info-tooltip",
    });

    this.buildInputModeTabs(contentEl);

    const urlRow = contentEl.createDiv({ cls: "yt-summarizer-dropdown-row" });
    this.urlRowEl = urlRow;
    urlRow.style.display = "flex";
    urlRow.style.alignItems = "center";
    urlRow.style.gap = "8px";
    urlRow.style.margin = "10px 0";
    const urlLabel = urlRow.createSpan({ text: "URL", cls: "yt-summarizer-dropdown-label" });
    urlLabel.style.minWidth = "130px";
    const input = urlRow.createEl("input", {
      type: "text",
      placeholder: "YouTube・記事・プレイリストのURL",
      cls: "yt-summarizer-input",
    });
    input.style.flex = "1";
    input.style.marginBottom = "0";
    this.urlInputEl = input;
    const scheduleUrlChange = (raw: string) => {
      if (this.folderNameFetchTimer !== null) window.clearTimeout(this.folderNameFetchTimer);
      if (this.titleFetchTimer !== null) window.clearTimeout(this.titleFetchTimer);
      ++this.titleFetchToken;
      this.hasManualFolderSelection = false;
      this.autoFolderName = "";
      this.selectedFolderName = "";
      this.isFetchingFolderName = false;
      this.refreshFolderNameButton();
      this.isPlaylistFetched = false;
      this.resetPlaylistStats();
      this.playlistItems = [{ url: "", title: "", titleInputEl: null }];
      this.renderPlaylistArea();
      this.updateInputModeVisibility();
      this.folderNameFetchTimer = window.setTimeout(() => {
        this.folderNameFetchTimer = null;
        if (!raw) {
          void this.tryAutoFillMeta("");
        } else if (raw.includes("playlist?list=")) {
          void this.fetchPlaylistUrls(raw);
        } else {
          let processUrl = raw;
          if (raw.includes("youtube.com/watch") && raw.includes("list=")) {
            try {
              const urlObj = new URL(raw);
              urlObj.searchParams.delete("list");
              urlObj.searchParams.delete("index");
              processUrl = urlObj.toString();
            } catch (_) { /* ignore invalid URL */ }
          }
          void this.tryAutoFillMeta(processUrl);
        }
      }, 500);
    };
    input.addEventListener("input", () => scheduleUrlChange(input.value.trim()));

    if (this.prefilledUrl) {
      input.value = this.prefilledUrl;
      if (this.prefilledUrl.includes("playlist?list=") && !this.prefilledUrl.includes("youtube.com/watch") && !this.prefilledUrl.includes("youtu.be/")) {
        void this.fetchPlaylistUrls(this.prefilledUrl, true);
      } else {
        let processUrl = this.prefilledUrl;
        if (this.prefilledUrl.includes("list=")) {
          try {
            const urlObj = new URL(this.prefilledUrl);
            urlObj.searchParams.delete("list");
            urlObj.searchParams.delete("index");
            processUrl = urlObj.toString();
            input.value = processUrl;
          } catch (_) { /* ignore invalid URL */ }
        }
        void this.tryAutoFillMeta(processUrl);
      }
    } else {
      navigator.clipboard.readText().then((t) => {
        if (input.value.trim()) return;
        const trimmed = t.trim();
        if (trimmed.includes("youtube.com/watch") || trimmed.includes("youtu.be/") || trimmed.includes("playlist?list=")) {
          input.value = trimmed;
          if (trimmed.includes("playlist?list=")) {
            void this.fetchPlaylistUrls(trimmed, true);
          } else {
            let processUrl = trimmed;
            if (trimmed.includes("youtube.com/watch") && trimmed.includes("list=")) {
              try {
                const urlObj = new URL(trimmed);
                urlObj.searchParams.delete("list");
                urlObj.searchParams.delete("index");
                processUrl = urlObj.toString();
                input.value = processUrl;
              } catch (_) { /* ignore invalid URL */ }
            }
            void this.tryAutoFillMeta(processUrl);
          }
        }
      }).catch(() => {});
    }

    const titleInputRow = contentEl.createDiv({ cls: "yt-summarizer-dropdown-row yt-summarizer-title-input-row" });
    this.titleRowEl = titleInputRow;
    titleInputRow.style.display = "flex";
    titleInputRow.style.alignItems = "flex-start";
    titleInputRow.style.gap = "8px";
    titleInputRow.style.margin = "10px 0";
    const titleLabel = titleInputRow.createSpan({ text: "各ファイルタイトル", cls: "yt-summarizer-dropdown-label" });
    titleLabel.style.minWidth = "130px";
    titleLabel.style.paddingTop = "6px";
    titleLabel.style.whiteSpace = "nowrap";
    const playlistArea = titleInputRow.createDiv({ cls: "yt-summarizer-playlist-area" });
    playlistArea.style.flex = "1";
    playlistArea.style.maxHeight = "300px";
    playlistArea.style.overflowY = "auto";
    playlistArea.style.marginBottom = "0";
    this.playlistAreaEl = playlistArea;
    this.playlistItems = [{ url: "", title: "", titleInputEl: null }];
    this.renderPlaylistArea();

    const textRow = contentEl.createDiv({ cls: "yt-summarizer-dropdown-row" });
    this.textRowEl = textRow;
    textRow.style.display = "flex";
    textRow.style.alignItems = "flex-start";
    textRow.style.gap = "8px";
    textRow.style.margin = "10px 0";
    const textLabel = textRow.createSpan({ text: "テキスト", cls: "yt-summarizer-dropdown-label" });
    textLabel.style.minWidth = "130px";
    textLabel.style.paddingTop = "6px";
    const ta = textRow.createEl("textarea", {
      cls: "yt-summarizer-input",
    });
    ta.placeholder = "記事・メモ・議事録などを貼り付けてください";
    ta.rows = 4;
    ta.style.flex = "1";
    ta.style.resize = "vertical";
    ta.style.fontFamily = "inherit";
    ta.style.marginBottom = "0";
    this.directTextEl = ta;

    this.fileRowEl = this.buildPdfArea(contentEl);
    this.kindleRowEl = this.buildKindleArea(contentEl);
    if (this.titleRowEl) contentEl.insertBefore(this.kindleRowEl, this.titleRowEl);

    this.buildFolderNameRow(contentEl);
    this.updateInputModeVisibility();

    const copyLogBtn = contentEl.createEl("button", { text: "ログをコピー", cls: "yt-summarizer-btn" });
    copyLogBtn.style.display = "none";
    copyLogBtn.style.margin = "0 0 6px auto";
    copyLogBtn.style.width = "auto";
    copyLogBtn.addEventListener("click", async () => {
      const text = this.logAreaEl?.innerText.trim() || "";
      if (!text) {
        new Notice("コピーできるログがありません");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        new Notice("ログをコピーしました");
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        new Notice(copied ? "ログをコピーしました" : "ログを選択して Ctrl+C でコピーしてください");
      }
    });
    this.copyLogBtnEl = copyLogBtn;

    const logArea = contentEl.createDiv({ cls: "yt-summarizer-log-area" });
    logArea.style.display = "none";
    logArea.style.maxHeight = "200px";
    logArea.style.overflowY = "auto";
    logArea.style.background = "#1e1e1e";
    logArea.style.borderRadius = "4px";
    logArea.style.padding = "8px 10px";
    logArea.style.marginBottom = "10px";
    logArea.style.fontFamily = "var(--font-monospace, monospace)";
    logArea.style.fontSize = "0.8em";
    logArea.style.color = "#d4d4d4";
    logArea.style.userSelect = "text";
    (logArea.style as CSSStyleDeclaration & { webkitUserSelect: string }).webkitUserSelect = "text";
    this.logAreaEl = logArea;

    const submitBtn = contentEl.createEl("button", {
      text: "清書開始 ▶",
      cls: "yt-summarizer-btn mod-cta",
    });
    this.submitBtnEl = submitBtn;

    // 処理中は「清書開始」と同じ位置に出す
    const stopBtn = contentEl.createEl("button", {
      text: "■ 停止",
      cls: "yt-summarizer-btn yt-summarizer-stop-btn",
    });
    stopBtn.style.display = "none";
    this.stopBtnEl = stopBtn;
    stopBtn.addEventListener("click", () => {
      const controller = this.runController;
      if (!controller || controller.isAborted) return;
      stopBtn.disabled = true;
      stopBtn.textContent = "停止中...";
      stopBtn.textContent = "⏹️ 停止処理中…";
      this.appendLog("⏹️ 停止しました。実行中のPython処理とAI通信を中断しています。");
      controller.abort();
    });
    const submit = () => {
      if (this.runController) return;
      const isUrlMode = this.inputMode === "url";
      const isTextMode = this.inputMode === "text";
      const isFileMode = this.inputMode === "file";
      if (isUrlMode && input.value.includes("playlist?list=") && (this.folderNameFetchTimer !== null || input.disabled)) {
        new Notice("再生リストの取得が終わるまでお待ちください");
        return;
      }
      if (isUrlMode && input.value.includes("playlist?list=") && !this.isPlaylistFetched) {
        new Notice("再生リストを取得できませんでした。URLを入力し直してください");
        return;
      }
      if (this.inputMode === "kindle") {
        if (!this.selectedKindlePath) {
          new Notice("Kindleの本を選んでください");
          return;
        }
        const kindleTitleInput = this.playlistItems[0]?.titleInputEl?.value.trim() || "";
        this.resolved = true;
        this.resolve(null);
        const kindleRun = this.beginRunningState();
        void this.plugin.summarizeKindle({
          filePath: this.selectedKindlePath,
          titleInput: kindleTitleInput,
          controller: kindleRun,
          logCallback: (msg: string) => this.appendLog(msg),
          doneCallback: (savedPath: string | null) => {
            this.endRunningState();
            if (!savedPath) return;
            const saved = this.app.vault.getAbstractFileByPath(savedPath);
            if (saved instanceof TFile) {
              void this.app.workspace.getLeaf("tab").openFile(saved);
            }
            // 停止したときはログを読めるようモーダルを開いたままにする
            if (!kindleRun.isAborted) this.close();
          },
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[YTSummarizer] Kindle清書に失敗", err);
          this.appendLog(`❌ エラー: ${msg}`);
          new Notice(`❌ エラー: ${msg}`, 8000);
          this.endRunningState();
        });
        return;
      }
      if (isUrlMode && this.isPlaylistFetched) {
        const itemsToProcess = this.playlistItems
          .filter((item) => item.url)
          .map((item) => ({
            url: item.url,
            title: item.titleInputEl?.value.trim() || item.title,
          }));
        if (itemsToProcess.length === 0) {
          new Notice("未処理の動画がありません");
          return;
        }
        if (!this.resolved) this.resolve(null);
        this.resolved = true;
        const playlistRun = this.beginRunningState();
        void this.plugin.runPlaylistSummarize({
          items: itemsToProcess,
          category: this.plugin.getUnclassifiedCategory(),
          folderName: this.selectedFolderName,
          controller: playlistRun,
          logCallback: (msg: string) => this.appendLog(msg),
          doneCallback: (lastFilePath: string | null) => {
            this.endRunningState();
            if (lastFilePath) {
              const lastFile = this.app.vault.getAbstractFileByPath(lastFilePath);
              if (lastFile instanceof TFile) {
                void this.app.workspace.getLeaf("tab").openFile(lastFile);
              }
            }
            // 停止したときはログを読めるようモーダルを開いたままにする
            if (!playlistRun.isAborted) this.close();
          },
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[YTSummarizer] 再生リスト清書に失敗", err);
          this.appendLog(`❌ エラー: ${msg}`);
          new Notice(`❌ エラー: ${msg}`, 8000);
          this.endRunningState();
        });
        return;
      }
      const u = isUrlMode ? input.value.trim() : "";
      const t = isTextMode ? (this.directTextEl?.value || "").trim() : "";
      const selectedPdfs = isFileMode ? this.pdfs : [];
      if (isUrlMode && !u) {
        new Notice("URLを入力してください");
        return;
      }
      if (isTextMode && !t) {
        new Notice("テキストを入力してください");
        return;
      }
      if (isFileMode && selectedPdfs.length === 0) {
        new Notice("ファイルを追加してください");
        return;
      }
      const finalFolderName = this.selectedFolderName;
      console.log(`[YTSummarizer] modal.submit: folderName="${finalFolderName}" directText.length=${t.length}`);
      const titleInput = this.playlistItems[0]?.titleInputEl?.value.trim() || "";
      if (isUrlMode) {
        const urlRun = this.beginRunningState();
        if (!this.resolved) this.resolve(null);
        this.resolved = true;
        void this.plugin.executeModalResult({
          url: u,
          folderName: finalFolderName,
          pdfs: selectedPdfs,
          directText: t,
          titleInput,
          controller: urlRun,
          logCallback: (msg: string) => this.appendLog(msg),
          doneCallback: (savedPath: string | null) => {
            this.endRunningState();
            if (!savedPath) return;
            this.close();
          },
        });
        return;
      }
      const result = { url: u, folderName: finalFolderName, pdfs: selectedPdfs, directText: t, titleInput };
      if (this.resolved) void this.plugin.executeModalResult(result);
      else { this.resolved = true; this.resolve(result); }
      this.close();
    };
    submitBtn.addEventListener("click", submit);

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === "Escape") this.close();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    setTimeout(() => input.focus(), 50);
  }

  private buildInputModeTabs(contentEl: HTMLElement) {
    contentEl.createDiv({ text: "入力方法", cls: "yt-summarizer-field-label" });
    const wrap = contentEl.createDiv({ cls: "yt-summarizer-mode-tabs" });
    const modes: Array<{ mode: InputMode; label: string }> = [
      { mode: "url", label: "URL" },
      { mode: "text", label: "テキスト" },
      { mode: "file", label: "ファイル" },
      { mode: "kindle", label: "Kindle" },
    ];
    for (const item of modes) {
      const btn = wrap.createEl("button", {
        text: item.label,
        cls: "yt-summarizer-mode-tab",
      });
      this.modeButtonEls[item.mode] = btn;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        this.setInputMode(item.mode);
      });
    }
  }

  private setInputMode(mode: InputMode) {
    if (this.inputMode === mode) return;
    this.inputMode = mode;
    if (mode !== "url") {
      if (this.folderNameFetchTimer !== null) {
        window.clearTimeout(this.folderNameFetchTimer);
        this.folderNameFetchTimer = null;
      }
      ++this.titleFetchToken;
      ++this.playlistFetchToken;
      this.isFetchingFolderName = false;
      if (this.urlInputEl) {
        this.urlInputEl.disabled = false;
        this.urlInputEl.style.opacity = "";
      }
      this.isPlaylistFetched = false;
      this.resetPlaylistStats();
      const currentTitle = this.playlistItems[0]?.titleInputEl?.value.trim() || "";
      this.playlistItems = [{ url: "", title: currentTitle, titleInputEl: null }];
      this.renderPlaylistArea();
    }
    this.updateInputModeVisibility();
    if (mode === "url") {
      if (this.urlInputEl?.value.trim()) this.urlInputEl.dispatchEvent(new Event("input"));
      setTimeout(() => this.urlInputEl?.focus(), 30);
    } else if (mode === "text") {
      setTimeout(() => this.directTextEl?.focus(), 30);
    }
  }

  private updateInputModeVisibility() {
    for (const [mode, btn] of Object.entries(this.modeButtonEls) as Array<[InputMode, HTMLButtonElement]>) {
      if (mode === this.inputMode) btn.addClass("is-active");
      else btn.removeClass("is-active");
    }
    if (this.urlRowEl) this.urlRowEl.style.display = this.inputMode === "url" ? "flex" : "none";
    if (this.textRowEl) this.textRowEl.style.display = this.inputMode === "text" ? "flex" : "none";
    if (this.fileRowEl) this.fileRowEl.style.display = this.inputMode === "file" ? "flex" : "none";
    if (this.kindleRowEl) this.kindleRowEl.style.display = this.inputMode === "kindle" ? "flex" : "none";
    const usesPlaylistChannelFolders = this.inputMode === "url" && this.isPlaylistFetched;
    if (this.folderRowEl) this.folderRowEl.style.display = this.inputMode === "kindle" || usesPlaylistChannelFolders ? "none" : "flex";
    if (this.playlistSaveHintEl) this.playlistSaveHintEl.style.display = usesPlaylistChannelFolders ? "block" : "none";
  }

  private buildKindleArea(contentEl: HTMLElement): HTMLElement {
    const row = contentEl.createDiv({ cls: "yt-summarizer-dropdown-row" });
    row.style.display = "none";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.margin = "10px 0";
    const label = row.createSpan({ text: "Kindleの本", cls: "yt-summarizer-dropdown-label" });
    label.style.minWidth = "130px";

    const wrap = row.createDiv({ cls: "yt-summarizer-custom-dropdown-wrap" });
    wrap.style.flex = "1";
    const btn = wrap.createEl("button", { cls: "yt-summarizer-dropdown-btn" });
    btn.style.width = "100%";
    btn.style.minWidth = "160px";
    btn.style.textAlign = "left";
    this.kindleBtnEl = btn;
    this.refreshKindleButton();

    const list = wrap.createDiv({ cls: "yt-summarizer-custom-dropdown-list" });
    this.kindleListEl = list;

    const outsideClickHandler = (e: MouseEvent) => {
      if (!wrap.contains(e.target as Node)) {
        list.removeClass("is-open");
      }
    };
    this.kindleOutsideClickHandler = outsideClickHandler;
    document.addEventListener("mousedown", outsideClickHandler);

    const titleOutsideClickHandler = (e: MouseEvent) => {
      if (this.kindleTitleWrapEl && !this.kindleTitleWrapEl.contains(e.target as Node)) {
        this.kindleTitleListEl?.removeClass("is-open");
      }
    };
    this.kindleTitleOutsideClickHandler = titleOutsideClickHandler;
    document.addEventListener("mousedown", titleOutsideClickHandler);

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (list.hasClass("is-open")) {
        list.removeClass("is-open");
        return;
      }
      const rect = btn.getBoundingClientRect();
      list.style.left = rect.left + "px";
      list.style.minWidth = rect.width + "px";
      this.renderKindleList();
      list.addClass("is-open");
      const listHeight = list.offsetHeight;
      list.style.top = Math.max(8, rect.top - listHeight - 4) + "px";
    });

    return row;
  }

  private getKindleFiles(): TFile[] {
    const base = normalizePath(KINDLE_SOURCE_FOLDER);
    return this.app.vault.getMarkdownFiles()
      .filter((f) => normalizePath(f.path).startsWith(`${base}/`))
      .sort((a, b) => a.basename.localeCompare(b.basename, "ja"));
  }

  private refreshKindleButton() {
    if (!this.kindleBtnEl) return;
    const file = this.selectedKindlePath
      ? this.app.vault.getAbstractFileByPath(this.selectedKindlePath)
      : null;
    const name = file instanceof TFile ? file.basename : "本を選択";
    this.kindleBtnEl.textContent = `${name} ▼`;
  }

  private renderKindleList() {
    if (!this.kindleListEl) return;
    const list = this.kindleListEl;
    list.empty();

    const files = this.getKindleFiles();
    if (files.length === 0) {
      list.createDiv({
        text: `${KINDLE_SOURCE_FOLDER} にノートがありません`,
        cls: "yt-summarizer-custom-dropdown-item",
      });
      return;
    }
    for (const file of files) {
      const item = list.createDiv({ cls: "yt-summarizer-custom-dropdown-item" });
      if (normalizePath(file.path) === this.selectedKindlePath) item.addClass("is-checked");
      item.createSpan({ text: file.basename });
      item.addEventListener("click", () => {
        this.selectKindleFile(file);
        list.removeClass("is-open");
      });
    }
  }

  private selectKindleFile(file: TFile) {
    this.selectedKindlePath = normalizePath(file.path);
    this.refreshKindleButton();
    this.kindleTitleCandidates = this.buildKindleTitleCandidates(file);
    const chosen = this.kindleTitleCandidates[0] || stripKindleBasenameAuthor(file.basename);
    if (this.playlistItems[0]) this.playlistItems[0].title = chosen;
    this.renderPlaylistArea();
  }

  private buildKindleTitleCandidates(file: TFile): string[] {
    const cache = this.app.metadataCache.getFileCache(file);
    const h1 = cache?.headings?.find((h) => h.level === 1)?.heading?.trim() || "";
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    const fmTitle = fm && typeof fm["kindle-title"] === "string" ? (fm["kindle-title"] as string).trim() : "";
    const fromBasename = stripKindleBasenameAuthor(file.basename);

    const candidates: string[] = [];
    const push = (value: string) => {
      const v = value.trim();
      if (v && !candidates.includes(v)) candidates.push(v);
    };
    push(h1);
    for (const source of [h1, fmTitle, fromBasename]) {
      if (!source) continue;
      push(splitKindleMainTitle(source));
      push(splitKindleTitleHead(source));
    }
    push(fmTitle);
    push(fromBasename);
    push(file.basename);
    return candidates;
  }

  private renderKindleTitleList(titleInput: HTMLInputElement) {
    if (!this.kindleTitleListEl) return;
    const list = this.kindleTitleListEl;
    list.empty();
    if (this.kindleTitleCandidates.length === 0) {
      list.createDiv({
        text: "先に「Kindleの本」を選んでください",
        cls: "yt-summarizer-custom-dropdown-item",
      });
      return;
    }
    for (const candidate of this.kindleTitleCandidates) {
      const item = list.createDiv({ cls: "yt-summarizer-custom-dropdown-item" });
      if (candidate === titleInput.value.trim()) item.addClass("is-checked");
      const label = item.createSpan({ text: candidate });
      label.style.whiteSpace = "normal";
      label.style.wordBreak = "break-word";
      item.addEventListener("click", () => {
        titleInput.value = candidate;
        if (this.playlistItems[0]) this.playlistItems[0].title = candidate;
        list.removeClass("is-open");
      });
    }
  }

  private buildFolderNameRow(contentEl: HTMLElement) {
    const row = contentEl.createDiv({ cls: "yt-summarizer-dropdown-row" });
    this.folderRowEl = row;
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.margin = "10px 0";
    row.style.flexWrap = "nowrap";
    const playlistSaveHint = contentEl.createDiv({
      text: "再生リストの動画はチャンネル名フォルダーに保存します（チャンネル名を取得できない場合は選択済みフォルダー）。",
      cls: "yt-summarizer-desc",
    });
    playlistSaveHint.style.display = "none";
    playlistSaveHint.style.margin = "-4px 0 10px 138px";
    this.playlistSaveHintEl = playlistSaveHint;
    const label = row.createSpan({ text: "保存先", cls: "yt-summarizer-dropdown-label" });
    label.style.minWidth = "130px";
    label.style.flexShrink = "0";

    const wrap = row.createDiv({ cls: "yt-summarizer-custom-dropdown-wrap" });
    wrap.style.flex = "1";
    wrap.style.minWidth = "0";
    const btn = wrap.createEl("button", { cls: "yt-summarizer-dropdown-btn" });
    btn.style.width = "100%";
    btn.style.minWidth = "0";
    btn.style.textAlign = "left";
    btn.style.whiteSpace = "normal";
    btn.style.overflowWrap = "anywhere";
    btn.style.height = "auto";
    btn.style.minHeight = "32px";
    btn.style.lineHeight = "1.35";
    btn.style.padding = "6px 10px";
    this.folderNameBtnEl = btn;
    this.refreshFolderNameButton();

    const list = wrap.createDiv({ cls: "yt-summarizer-custom-dropdown-list" });
    this.folderNameListEl = list;

    const outsideClickHandler = (e: MouseEvent) => {
      if (!wrap.contains(e.target as Node)) {
        list.removeClass("is-open");
      }
    };
    this.folderNameOutsideClickHandler = outsideClickHandler;
    document.addEventListener("mousedown", outsideClickHandler);

    btn.addEventListener("click", () => {
      if (list.hasClass("is-open")) {
        list.removeClass("is-open");
      } else {
        const rect = btn.getBoundingClientRect();
        list.style.left = rect.left + "px";
        list.style.minWidth = rect.width + "px";
        this.renderFolderNameList();
        list.addClass("is-open");
        const listHeight = list.offsetHeight;
        list.style.top = Math.max(8, rect.top - listHeight - 4) + "px";
      }
    });

    const inlineInput = row.createEl("input", { type: "text", cls: "yt-summarizer-input" });
    inlineInput.style.minWidth = "0";
    inlineInput.style.flex = "1";
    inlineInput.style.marginBottom = "0";
    inlineInput.style.display = "none";
    this.folderNameInlineInputEl = inlineInput;

    const showInlineEdit = () => {
      wrap.style.display = "none";
      inlineInput.style.display = "";
      inlineInput.value = this.autoFolderName || this.selectedFolderName || "";
      setTimeout(() => inlineInput.focus(), 30);
    };
    const hideInlineEdit = () => {
      inlineInput.style.display = "none";
      wrap.style.display = "";
      this.refreshFolderNameEditButton();
    };
    inlineInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const newName = inlineInput.value.trim();
        if (newName) {
          void this.setManualFolderName(newName);
        }
        hideInlineEdit();
      }
      if (e.key === "Escape") hideInlineEdit();
    });
    inlineInput.addEventListener("blur", () => {
      const newName = inlineInput.value.trim();
      if (newName) {
        void this.setManualFolderName(newName);
      }
      hideInlineEdit();
    });

    const addBtn = row.createEl("button", { text: "＋", cls: "yt-summarizer-edit-btn" });
    addBtn.setAttr("aria-label", "フォルダ名を追加");
    styleIconActionButton(addBtn, "add");
    addBtn.style.flexShrink = "0";
    addBtn.addEventListener("click", (e) => {
      e.preventDefault();
      this.promptAddFolderName();
    });

    const inlineEditBtn = row.createEl("button", { text: "✎", cls: "yt-summarizer-edit-btn" });
    this.folderNameInlineEditBtnEl = inlineEditBtn;
    styleIconActionButton(inlineEditBtn, "edit");
    inlineEditBtn.style.flexShrink = "0";
    this.refreshFolderNameEditButton();
    inlineEditBtn.addEventListener("click", (e) => {
      e.preventDefault();
      showInlineEdit();
    });
  }

  private refreshFolderNameButton() {
    if (!this.folderNameBtnEl) return;
    const txt = this.selectedFolderName
      ? this.selectedFolderName
      : this.isFetchingFolderName && !this.hasManualFolderSelection
        ? "取得中..."
        : "選択しない";
    this.folderNameBtnEl.textContent = `${txt} ▼`;
    this.refreshFolderNameEditButton();
  }

  private refreshFolderNameEditButton() {
    if (!this.folderNameInlineEditBtnEl) return;
    this.folderNameInlineEditBtnEl.style.display = this.selectedFolderName ? "" : "none";
  }

  private renderFolderNameList() {
    if (!this.folderNameListEl) return;
    const list = this.folderNameListEl;
    list.empty();

    const outputFolder = this.plugin.settings.outputFolder;
    const baseFolder = this.app.vault.getAbstractFileByPath(normalizePath(outputFolder));
    const vaultFolderNames: string[] = baseFolder instanceof TFolder
      ? baseFolder.children
          .filter((f): f is TFolder => f instanceof TFolder)
          .map(f => f.name)
      : [];
    const savedFolderNames = this.plugin.settings.folderNames
      .map(normalizeFolderNameCandidate)
      .filter((name) => name.length > 0);
    const folderNames = Array.from(new Set([...vaultFolderNames, ...savedFolderNames]))
      .sort(compareFolderNames);

    const addItem = (title: string, checked: boolean, onClick: () => void) => {
      const item = list.createDiv({ cls: "yt-summarizer-custom-dropdown-item" });
      if (checked) item.addClass("is-checked");
      item.createSpan({ text: title });
      item.addEventListener("click", () => {
        onClick();
        list.removeClass("is-open");
      });
    };
    const addSeparator = () => {
      list.createDiv({ cls: "yt-summarizer-custom-dropdown-separator" });
    };

    if (this.autoFolderName) {
      addItem(this.autoFolderName, this.selectedFolderName === this.autoFolderName, () => {
        void this.setManualFolderName(this.autoFolderName, false);
      });
      addSeparator();
    }
    addItem("選択しない", this.selectedFolderName === "", () => {
      this.selectedFolderName = "";
      this.hasManualFolderSelection = true;
      this.refreshFolderNameButton();
    });
    for (const fn of folderNames) {
      if (fn === this.autoFolderName) continue;
      addItem(fn, fn === this.selectedFolderName, () => {
        void this.setManualFolderName(fn, false);
      });
    }
  }

  private async setManualFolderName(rawName: string, saveCandidate = true) {
    const name = normalizeFolderNameCandidate(rawName);
    if (!name) return;
    this.autoFolderName = name;
    this.selectedFolderName = name;
    this.hasManualFolderSelection = true;
    if (saveCandidate && !this.plugin.settings.folderNames.some((n) => normalizeFolderNameCandidate(n) === name)) {
      this.plugin.settings.folderNames.push(name);
      this.plugin.settings.folderNames.sort(compareFolderNames);
      await this.plugin.saveSettings();
    }
    this.refreshFolderNameButton();
  }

  private promptAddFolderName() {
    if (!this.folderNameBtnEl) return;
    const parent = this.folderNameBtnEl.closest(".yt-summarizer-dropdown-row") as HTMLElement | null;
    if (!parent) return;
    this.showInlineAddInput(parent, "新しいフォルダ名", "フォルダ名を入力してください", async (rawName) => {
      const name = normalizeFolderNameCandidate(rawName);
      if (!name) {
        new Notice("有効なフォルダ名を入力してください");
        return false;
      }
      await this.setManualFolderName(name);
      return true;
    });
  }

  private showInlineAddInput(parent: HTMLElement, placeholder: string, emptyMsg: string, onSave: (name: string) => Promise<boolean>) {
    if (parent.querySelector(".yt-summarizer-inline-add")) return;
    const inputWrap = parent.createDiv({ cls: "yt-summarizer-inline-add" });
    inputWrap.style.display = "flex";
    inputWrap.style.flexBasis = "100%";
    inputWrap.style.marginTop = "6px";
    inputWrap.style.gap = "4px";
    const addInput = inputWrap.createEl("input", {
      type: "text",
      placeholder,
      cls: "yt-summarizer-input",
    });
    addInput.style.flex = "1";
    const saveBtn = inputWrap.createEl("button", { text: "保存", cls: "yt-summarizer-add-save-btn" });
    const cancelBtn = inputWrap.createEl("button", { text: "×" });
    cancelBtn.setAttr("aria-label", "キャンセル");
    const save = async () => {
      const name = addInput.value.trim();
      if (!name) { new Notice(emptyMsg); return; }
      const ok = await onSave(name);
      if (ok) inputWrap.remove();
    };
    saveBtn.addEventListener("click", save);
    cancelBtn.addEventListener("click", () => inputWrap.remove());
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); void save(); }
      if (e.key === "Escape") inputWrap.remove();
    });
    setTimeout(() => addInput.focus(), 30);
  }

  private async tryAutoFillMeta(rawUrl: string) {
    const token = ++this.titleFetchToken;
    // folderNameFetchToken も同じ値にそろえる
    this.folderNameFetchToken = token;

    if (!rawUrl) {
      // クリア処理
      const firstInput0 = this.playlistItems[0]?.titleInputEl;
      if (firstInput0) {
        firstInput0.value = "";
        firstInput0.disabled = false;
        firstInput0.placeholder = "タイトル（空欄の場合は自動取得）";
      }
      this.autoFolderName = "";
      this.selectedFolderName = "";
      this.hasManualFolderSelection = false;
      this.isFetchingFolderName = false;
      this.refreshFolderNameButton();
      return;
    }

    const isYt = isYouTubeUrl(rawUrl);
    const videoId = isYt ? extractVideoId(rawUrl) : null;

    if (isYt && !videoId) {
      this.isFetchingFolderName = false;
      this.refreshFolderNameButton();
      return;
    }
    if (!isYt && !rawUrl.startsWith("http")) {
      this.isFetchingFolderName = false;
      this.refreshFolderNameButton();
      return;
    }

    const dupFileName = await this.plugin.checkUrlDuplicate(rawUrl);
    if (this.closed || token !== this.titleFetchToken) return;
    if (dupFileName !== null) {
      new Notice(`⚠️ URLダブり（処理済み）：${dupFileName}`, 8000);
      this.isFetchingFolderName = false;
      this.refreshFolderNameButton();
      return;
    }

    // ローディング表示
    const firstInput = this.playlistItems[0]?.titleInputEl;
    if (firstInput) {
      firstInput.placeholder = "取得中...";
      firstInput.disabled = true;
    }
    this.isFetchingFolderName = true;
    this.refreshFolderNameButton();

    if (isYt && videoId) {
      // YouTube: 1回の --meta-only でタイトルとチャンネル名を両方取得
      let meta = { title: "", channelName: "", description: "", publishDate: "" };
      try {
        meta = await this.plugin.fetchVideoMeta(videoId);
      } catch (err) {
        console.warn("[YTSummarizer] fetchVideoMeta failed", err);
        if (this.logAreaEl) this.logAreaEl.style.display = "block";
        if (this.copyLogBtnEl) this.copyLogBtnEl.style.display = "block";
        this.appendLog(`⚠️ 動画情報の自動取得に失敗: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (this.closed || token !== this.titleFetchToken) return;

      // タイトルセット
      const latestFirstInput = this.playlistItems[0]?.titleInputEl;
      if (latestFirstInput) {
        latestFirstInput.value = meta.title;
        latestFirstInput.placeholder = "タイトル（空欄の場合は自動取得）";
        latestFirstInput.disabled = false;
      }

      // フォルダー名セット
      this.isFetchingFolderName = false;
      this.autoFolderName = meta.channelName;
      if (!this.hasManualFolderSelection) {
        this.selectedFolderName = meta.channelName;
      }
      this.refreshFolderNameButton();
      if (!meta.title && !meta.channelName) {
        if (this.logAreaEl) this.logAreaEl.style.display = "block";
        if (this.copyLogBtnEl) this.copyLogBtnEl.style.display = "block";
        this.appendLog("⚠️ YouTubeからタイトル・チャンネル名を取得できませんでした。ネットワークまたはYouTube側のアクセス制限を確認してください。");
      }

    } else {
      // 記事URL: タイトルとサイト名を article_fetcher.py --meta-only で取得
      let articleMeta = { title: "", siteName: "" };
      try {
        articleMeta = await this.plugin.fetchArticleMeta(rawUrl);
      } catch (err) {
        console.warn("[YTSummarizer] fetchArticleMeta failed", err);
        if (!this.closed && token === this.titleFetchToken) {
          if (this.logAreaEl) this.logAreaEl.style.display = "block";
          if (this.copyLogBtnEl) this.copyLogBtnEl.style.display = "block";
          this.appendLog(`⚠️ 記事情報の自動取得に失敗: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (this.closed || token !== this.titleFetchToken) return;

      // タイトルセット
      const latestFirstInput = this.playlistItems[0]?.titleInputEl;
      if (latestFirstInput) {
        latestFirstInput.value = articleMeta.title || "";
        latestFirstInput.placeholder = "タイトル（空欄の場合は自動取得）";
        latestFirstInput.disabled = false;
      }

      // フォルダー名セット
      this.isFetchingFolderName = false;
      this.autoFolderName = articleMeta.siteName || "";
      if (!this.hasManualFolderSelection) {
        this.selectedFolderName = articleMeta.siteName || "";
      }
      this.refreshFolderNameButton();

    }
  }

  private buildPdfArea(contentEl: HTMLElement): HTMLElement {
    const row = contentEl.createDiv({ cls: "yt-summarizer-dropdown-row" });
    row.style.display = "flex";
    row.style.alignItems = "flex-start";
    row.style.gap = "8px";
    row.style.margin = "10px 0";
    const pdfLabel = row.createSpan({ text: "ファイル", cls: "yt-summarizer-dropdown-label" });
    pdfLabel.style.minWidth = "130px";
    pdfLabel.style.paddingTop = "6px";

    const wrap = row.createDiv({ cls: "yt-summarizer-pdf-wrap" });
    wrap.style.flex = "1";
    wrap.style.marginBottom = "0";

    const dropZone = wrap.createDiv({ cls: "yt-summarizer-img-drop" });
    dropZone.setText(`クリックまたはドラッグ＆ドロップでファイルを追加（最大${MAX_PDFS}件 / PDF各${MAX_PDF_PAGES}ページまで）`);

    const fileInput = wrap.createEl("input", { type: "file" });
    fileInput.accept = ".pdf,application/pdf,.jpg,.jpeg,.png,.webp,.gif,image/jpeg,image/png,image/webp,image/gif";
    fileInput.multiple = true;
    fileInput.style.display = "none";

    dropZone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      if (fileInput.files) this.handlePdfFiles(Array.from(fileInput.files));
      fileInput.value = "";
    });
    dropZone.addEventListener("dragenter", (e) => { e.preventDefault(); dropZone.addClass("is-dragover"); });
    dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.addClass("is-dragover"); });
    dropZone.addEventListener("dragleave", (e) => { e.preventDefault(); dropZone.removeClass("is-dragover"); });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.removeClass("is-dragover");
      if (e.dataTransfer && e.dataTransfer.files) this.handlePdfFiles(Array.from(e.dataTransfer.files));
    });

    this.pdfListEl = wrap.createDiv({ cls: "yt-summarizer-pdf-list" });
    this.refreshPdfList();
    return row;
  }

  private async handlePdfFiles(files: File[]) {
    for (const file of files) {
      if (this.pdfs.length >= MAX_PDFS) {
        new Notice(`ファイルは最大${MAX_PDFS}件までです`);
        break;
      }
      const isPdf = file.type === ALLOWED_PDF_TYPE || /\.pdf$/i.test(file.name);
      const imageMediaType = getSupportedImageMediaType(file);
      if (!isPdf && !imageMediaType) {
        new Notice(`対応しているファイルではありません（PDF/JPEG/PNG/WebP/GIF）: ${file.name}`);
        continue;
      }
      try {
        if (isPdf) {
          const base64 = await readFileAsBase64(file);
          const pages = countPdfPages(base64);
          if (pages > MAX_PDF_PAGES) {
            new Notice(`❌ ${file.name} は${pages}ページです。${MAX_PDF_PAGES}ページ以下にしてください。`, 8000);
            continue;
          }
          this.pdfs.push({ base64, name: file.name, kind: "pdf", mediaType: ALLOWED_PDF_TYPE });
        } else {
          if (file.size > MAX_IMAGE_BYTES) {
            new Notice(`❌ ${file.name} は${formatBytesAsMb(file.size)}MBです。画像は${formatBytesAsMb(MAX_IMAGE_BYTES)}MB以下にしてください。`, 8000);
            continue;
          }
          const dimensions = await readImageDimensions(file);
          if (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION) {
            new Notice(`❌ ${file.name} は${dimensions.width}×${dimensions.height}pxです。画像は各辺${MAX_IMAGE_DIMENSION}px以下にしてください。`, 8000);
            continue;
          }
          const base64 = await readFileAsBase64(file);
          this.pdfs.push({ base64, name: file.name, kind: "image", mediaType: imageMediaType });
        }
      } catch (err) {
        console.error("[YTSummarizer] file read error", err);
        new Notice(`ファイルの読み込みに失敗: ${file.name}`);
      }
    }
    this.refreshPdfList();
  }

  private refreshPdfList() {
    if (!this.pdfListEl) return;
    this.pdfListEl.empty();
    this.pdfs.forEach((pdf, idx) => {
      const item = this.pdfListEl!.createDiv({ cls: "yt-summarizer-pdf-item" });
      item.style.display = "flex";
      item.style.alignItems = "center";
      item.style.gap = "6px";
      item.style.marginTop = "4px";
      item.createSpan({ text: `${pdf.kind === "pdf" ? "📄" : "🖼️"} ${pdf.name}` });
      const del = item.createEl("button", { text: "×", cls: "yt-summarizer-img-del" });
      del.setAttr("aria-label", "ファイルを削除");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pdfs.splice(idx, 1);
        this.refreshPdfList();
      });
    });
  }

  /** 清書開始時：ログ欄を出し、「清書開始」ボタンを「停止」に差し替える。 */
  private beginRunningState(): RunController {
    const controller = this.plugin.beginRun();
    this.runController = controller;
    if (this.logAreaEl) this.logAreaEl.style.display = "block";
    if (this.copyLogBtnEl) this.copyLogBtnEl.style.display = "block";
    if (this.submitBtnEl) {
      this.submitBtnEl.disabled = true;
      this.submitBtnEl.style.display = "none";
    }
    if (this.stopBtnEl) {
      this.stopBtnEl.disabled = false;
      this.stopBtnEl.textContent = "■ 停止";
      this.stopBtnEl.style.display = "block";
    }
    return controller;
  }

  /** 清書終了時（完了・失敗・停止いずれも）：ボタンを元に戻す。 */
  private endRunningState() {
    if (this.runController) {
      this.plugin.endRun(this.runController);
      this.runController = null;
    }
    if (this.stopBtnEl) this.stopBtnEl.style.display = "none";
    if (this.submitBtnEl) {
      this.submitBtnEl.disabled = false;
      this.submitBtnEl.textContent = "清書開始 ▶";
      this.submitBtnEl.style.display = "block";
    }
  }

  private appendLog(msg: string) {
    if (!this.logAreaEl) return;
    const line = this.logAreaEl.createEl("div");
    line.textContent = msg;
    this.logAreaEl.scrollTop = this.logAreaEl.scrollHeight;
  }

  private async fetchPlaylistUrls(url: string, silent = false) {
    if (!url) return;
    const token = ++this.playlistFetchToken;
    this.isPlaylistFetched = false;
    this.updateInputModeVisibility();
    if (this.urlInputEl) {
      this.urlInputEl.disabled = true;
      this.urlInputEl.style.opacity = "0.6";
    }
    try {
      const { items: rawItems, playlistTitle, playlistCount, membersOnlyCount, unavailableCount } = await this.plugin.callPlaylistScript(url);
      if (this.closed || token !== this.playlistFetchToken) return;
      const duplicateCheck = this.checkDuplicates(rawItems);
      const filtered = duplicateCheck.items;
      this.playlistStats = {
        loaded: rawItems.length,
        saved: duplicateCheck.saved,
        unprocessed: filtered.length,
        total: playlistCount,
        membersOnly: membersOnlyCount,
        unavailable: unavailableCount,
      };
      if (filtered.length === 0) {
        this.isPlaylistFetched = true;
        this.playlistItems = [{ url: "", title: "", titleInputEl: null }];
        const excludedText = formatExcludedCounts(membersOnlyCount, unavailableCount);
        if (rawItems.length === 0 && excludedText) {
          new Notice(`処理できる動画がありませんでした（${excludedText}）`);
        } else {
          new Notice(`未処理の動画はありませんでした（すべて処理済みまたは重複）${excludedText ? `／${excludedText}` : ""}`);
        }
      } else {
        this.isPlaylistFetched = true;
        this.playlistItems = filtered.map((item) => ({ ...item, titleInputEl: null }));
      }
      if (playlistTitle) {
        this.autoFolderName = playlistTitle;
        if (!this.hasManualFolderSelection) {
          this.selectedFolderName = playlistTitle;
        }
      }
      this.renderPlaylistArea();
      this.refreshFolderNameButton();
      this.updateInputModeVisibility();
    } catch (err) {
      if (this.closed || token !== this.playlistFetchToken) return;
      this.isPlaylistFetched = false;
      this.resetPlaylistStats();
      this.playlistItems = [{ url: "", title: "", titleInputEl: null }];
      this.renderPlaylistArea();
      this.updateInputModeVisibility();
      if (!silent) {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`❌ URLの取得に失敗しました: ${msg}`, 8000);
      } else {
        console.warn("[YTSummarizer] fetchPlaylistUrls (silent) failed", err);
      }
    } finally {
      if (!this.closed && token === this.playlistFetchToken && this.urlInputEl) {
        this.urlInputEl.disabled = false;
        this.urlInputEl.style.opacity = "";
      }
    }
  }

  private resetPlaylistStats() {
    this.playlistStats = { loaded: 0, saved: 0, unprocessed: 0, total: null, membersOnly: 0, unavailable: 0 };
  }

  private checkDuplicates(items: Array<{ url: string; title: string }>): { items: Array<{ url: string; title: string }>; saved: number } {
    const outputFolder = this.plugin.settings.outputFolder;
    const normalizedOutput = normalizePath(outputFolder.replace(/^\/+|\/+$/g, ""));
    const existingVideoIds = new Set<string>();

    this.app.vault.getMarkdownFiles().forEach((file) => {
      const fp = normalizePath(file.path);
      if (fp !== normalizedOutput && !fp.startsWith(normalizedOutput + "/")) return;
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (fm && typeof fm.url === "string") {
        const vid = extractVideoId(fm.url);
        if (vid) existingVideoIds.add(vid);
      }
    });

    const seen = new Set<string>();
    let saved = 0;
    const filtered = items.filter((item) => {
      const vid = extractVideoId(item.url);
      const key = vid || item.url;
      if (vid && existingVideoIds.has(vid)) {
        saved++;
        return false;
      }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { items: filtered, saved };
  }

  private renderPlaylistArea() {
    if (!this.playlistAreaEl) return;
    const area = this.playlistAreaEl;
    area.empty();

    if (this.playlistItems.length === 0) {
      this.playlistItems = [{ url: "", title: "", titleInputEl: null }];
    }

    const excludedCount = this.playlistStats.membersOnly + this.playlistStats.unavailable;
    if (this.playlistStats.loaded > 0 || excludedCount > 0) {
      const total = this.playlistStats.total;
      // 取得件数（除外分を含む）が再生リストの申告本数に届いていない = yt-dlpが途中までしか取れていない
      const fetched = this.playlistStats.loaded + excludedCount;
      const missing = total !== null && fetched < total;
      const stats = area.createDiv({ cls: "yt-summarizer-playlist-stats" });
      stats.createSpan({ text: missing ? `読込 ${this.playlistStats.loaded}/${total}本` : `読込 ${this.playlistStats.loaded}本` });
      stats.createSpan({ text: `保存済 ${this.playlistStats.saved}本` });
      stats.createSpan({ text: `未処理 ${this.playlistStats.unprocessed}本` });
      if (this.playlistStats.membersOnly > 0) {
        stats.createSpan({ text: `メンバー限定 ${this.playlistStats.membersOnly}本（除外）` });
      }
      if (this.playlistStats.unavailable > 0) {
        stats.createSpan({ text: `視聴不可 ${this.playlistStats.unavailable}本（除外）` });
      }
      if (missing) {
        area.createDiv({
          cls: "yt-summarizer-playlist-warning",
          text: `⚠️ 再生リスト${total}本のうち${fetched}本しか取得できていません。このまま実行しても残りは処理されません。ターミナルで python -m pip install --upgrade yt-dlp を実行してからObsidianを再起動してください。`,
        });
      }
    }

    if ((this.playlistStats.loaded > 0 || excludedCount > 0) && this.playlistStats.unprocessed === 0) {
      area.createDiv({
        text: "処理対象の動画はありません",
        cls: "yt-summarizer-playlist-empty",
      });
      return;
    }

    this.playlistItems.forEach((item, idx) => {
      const row = area.createDiv({ cls: "yt-summarizer-playlist-item" });
      row.style.padding = "3px 0";
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "6px";

      const numEl = row.createSpan();
      numEl.textContent = this.playlistItems.length > 1 ? `${idx + 1}.` : "";
      numEl.style.color = "var(--text-muted)";
      numEl.style.fontSize = "0.85em";
      numEl.style.minWidth = "22px";
      numEl.style.textAlign = "right";
      numEl.style.flexShrink = "0";

      const titleInput = row.createEl("input", { type: "text", cls: "yt-summarizer-input" });
      titleInput.value = item.title;
      titleInput.placeholder = this.inputMode === "url"
        ? "タイトル（空欄の場合は自動取得）"
        : this.inputMode === "kindle"
          ? "ファイル名（空欄の場合は書名）"
          : "タイトル（任意）";
      titleInput.style.flex = "1";
      titleInput.style.marginBottom = "0";
      this.playlistItems[idx].titleInputEl = titleInput;

      if (this.inputMode === "kindle" && idx === 0) {
        const candidateWrap = row.createDiv({ cls: "yt-summarizer-custom-dropdown-wrap" });
        candidateWrap.style.flexShrink = "0";
        this.kindleTitleWrapEl = candidateWrap;
        const candidateBtn = candidateWrap.createEl("button", { text: "▼", cls: "yt-summarizer-edit-btn" });
        candidateBtn.setAttr("aria-label", "タイトルの候補から選ぶ");
        styleIconActionButton(candidateBtn, "edit");
        const candidateList = candidateWrap.createDiv({ cls: "yt-summarizer-custom-dropdown-list" });
        candidateList.style.maxWidth = "min(560px, 90vw)";
        this.kindleTitleListEl = candidateList;
        candidateBtn.addEventListener("click", (e) => {
          e.preventDefault();
          if (candidateList.hasClass("is-open")) {
            candidateList.removeClass("is-open");
            return;
          }
          const rect = candidateBtn.getBoundingClientRect();
          const inputRect = titleInput.getBoundingClientRect();
          candidateList.style.left = inputRect.left + "px";
          candidateList.style.minWidth = inputRect.width + "px";
          this.renderKindleTitleList(titleInput);
          candidateList.addClass("is-open");
          const listHeight = candidateList.offsetHeight;
          candidateList.style.top = Math.max(8, rect.top - listHeight - 4) + "px";
        });
      }
    });
  }

  onClose() {
    this.closed = true;
    // 閉じても処理は止まらないので、止め方を案内しておく
    if (this.runController && !this.runController.isAborted) {
      new Notice("清書はバックグラウンドで継続中です。\n止める場合はコマンドパレット →「実行中の清書を停止」", 8000);
    }
    if (this.folderNameFetchTimer !== null) {
      window.clearTimeout(this.folderNameFetchTimer);
      this.folderNameFetchTimer = null;
    }
    if (this.titleFetchTimer !== null) {
      window.clearTimeout(this.titleFetchTimer);
      this.titleFetchTimer = null;
    }
    if (this.folderNameOutsideClickHandler) {
      document.removeEventListener("mousedown", this.folderNameOutsideClickHandler);
      this.folderNameOutsideClickHandler = null;
    }
    if (this.kindleOutsideClickHandler) {
      document.removeEventListener("mousedown", this.kindleOutsideClickHandler);
      this.kindleOutsideClickHandler = null;
    }
    if (this.kindleTitleOutsideClickHandler) {
      document.removeEventListener("mousedown", this.kindleTitleOutsideClickHandler);
      this.kindleTitleOutsideClickHandler = null;
    }
    if (!this.resolved) this.resolve(null);
    this.contentEl.empty();
  }
}

class ResultModal extends Modal {
  private results: PlaylistProcessResult[];
  private sessionCostUsd: number;
  private sessionInputTokens: number;
  private sessionOutputTokens: number;
  private totalCostUsd: number;
  private cleanupModelCounts: Map<string, number>;
  private classificationModelCounts: Map<string, number>;

  constructor(
    app: App,
    results: PlaylistProcessResult[],
    sessionCostUsd: number,
    sessionInputTokens: number,
    sessionOutputTokens: number,
    totalCostUsd: number,
    cleanupModelCounts: Map<string, number>,
    classificationModelCounts: Map<string, number>,
  ) {
    super(app);
    this.results = results;
    this.sessionCostUsd = sessionCostUsd;
    this.sessionInputTokens = sessionInputTokens;
    this.sessionOutputTokens = sessionOutputTokens;
    this.totalCostUsd = totalCostUsd;
    this.cleanupModelCounts = cleanupModelCounts;
    this.classificationModelCounts = classificationModelCounts;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("yt-summarizer-result-modal");
    contentEl.createEl("h2", { text: "プレイリスト清書結果" });

    const succeeded = this.results.filter((r) => r.success).length;
    const failed = this.results.filter((r) => !r.success).length;

    const summary = contentEl.createDiv({ cls: "yt-summarizer-result-summary" });
    const successBox = summary.createDiv({ cls: "yt-summarizer-result-count is-success" });
    successBox.createDiv({ text: "完了", cls: "yt-summarizer-result-count-label" });
    successBox.createDiv({ text: `${succeeded}件`, cls: "yt-summarizer-result-count-value" });
    const failedBox = summary.createDiv({ cls: "yt-summarizer-result-count is-failed" });
    failedBox.createDiv({ text: "失敗", cls: "yt-summarizer-result-count-label" });
    failedBox.createDiv({ text: `${failed}件`, cls: "yt-summarizer-result-count-value" });

    if (failed > 0) {
      const failedResults = this.results.filter((r) => !r.success);
      const failedUrls = failedResults.map((r) => r.item.url).join("\n");

      contentEl.createEl("hr");
      contentEl.createEl("h3", { text: "あとで再試行する動画" });
      contentEl.createEl("p", {
        text: "URLをまとめてコピーして、時間をおいてもう一度清書できます。",
        cls: "yt-summarizer-desc",
      });

      const failedBoxEl = contentEl.createDiv({ cls: "yt-summarizer-result-failed-item" });
      const urlArea = failedBoxEl.createEl("textarea", { cls: "yt-summarizer-result-url-area" });
      urlArea.value = failedUrls;
      urlArea.readOnly = true;
      urlArea.rows = Math.min(Math.max(failedResults.length, 2), 10);
      urlArea.addEventListener("focus", () => urlArea.select());

      const copyAllBtn = failedBoxEl.createEl("button", {
        text: `URLをまとめてコピー（${failedResults.length}件）`,
        cls: "yt-summarizer-result-copy-btn yt-summarizer-result-copy-all-btn",
      });
      copyAllBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(failedUrls);
          new Notice(`${failedResults.length}件のURLをコピーしました`);
        } catch (err) {
          console.error("[YTSummarizer] copy failed", err);
          // クリップボードが使えないときは選択状態にして手動コピーに逃がす
          urlArea.focus();
          urlArea.select();
          new Notice("URLのコピーに失敗しました。選択したので Ctrl+C でコピーしてください");
        }
      });

      // 動画タイトルは出さず、失敗理由を同じものでまとめて件数だけ添える
      const reasonCounts = new Map<string, number>();
      for (const r of failedResults) {
        const reasonText = r.error || "不明なエラーが発生しました";
        reasonCounts.set(reasonText, (reasonCounts.get(reasonText) ?? 0) + 1);
      }
      const reasonList = contentEl.createDiv({ cls: "yt-summarizer-result-reason-list" });
      for (const [reasonText, count] of Array.from(reasonCounts.entries()).sort((a, b) => b[1] - a[1])) {
        const reason = reasonList.createDiv({ cls: "yt-summarizer-result-reason" });
        reason.createSpan({ text: "理由: ", cls: "yt-summarizer-result-reason-label" });
        reason.createSpan({ text: count > 1 ? `${reasonText} ×${count}件` : reasonText });
      }
    }

    contentEl.createEl("hr");

    const modelWrap = contentEl.createDiv({ cls: "yt-summarizer-result-model" });
    modelWrap.createEl("h3", { text: "モデル" });
    modelWrap.createEl("p", { text: `清書モデル: ${formatModelCounts(this.cleanupModelCounts)}` });
    modelWrap.createEl("p", { text: `カテゴリ分類: ${formatModelCounts(this.classificationModelCounts)}` });

    contentEl.createEl("hr");

    const sessionJpy = this.sessionCostUsd * USD_TO_JPY;
    const totalJpy = this.totalCostUsd * USD_TO_JPY;
    const costWrap = contentEl.createDiv({ cls: "yt-summarizer-result-cost" });
    costWrap.createEl("h3", { text: "コスト" });
    costWrap.createEl("p", {
      text: `今回: $${this.sessionCostUsd.toFixed(4)}（約${sessionJpy.toFixed(1)}円）`,
    });
    costWrap.createEl("p", {
      text: `入力 ${this.sessionInputTokens.toLocaleString()} トークン / 出力 ${this.sessionOutputTokens.toLocaleString()} トークン`,
      cls: "yt-summarizer-desc",
    });
    costWrap.createEl("p", {
      text: `累計: $${this.totalCostUsd.toFixed(4)}（約${totalJpy.toFixed(1)}円）`,
    });

    const closeBtn = contentEl.createEl("button", { text: "閉じる", cls: "yt-summarizer-btn mod-cta" });
    closeBtn.style.marginTop = "12px";
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class YTSummarizerSettingTab extends PluginSettingTab {
  plugin: YTSummarizerPlugin;
  constructor(app: App, plugin: YTSummarizerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "YouTube Summarizer 設定" });

    new Setting(containerEl)
      .setName("Claude API キー")
      .setDesc("Anthropic Console で取得したAPIキー")
      .addText((text) =>
        text.setPlaceholder("sk-ant-api03-...").setValue(this.plugin.settings.claudeApiKey).onChange(async (value) => {
          this.plugin.settings.claudeApiKey = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Gemini API キー")
      .setDesc("https://aistudio.google.com/apikey で取得したAPIキー")
      .addText((text) =>
        text.setPlaceholder("AIza...").setValue(this.plugin.settings.geminiApiKey).onChange(async (value) => {
          this.plugin.settings.geminiApiKey = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("OpenAI API キー")
      .setDesc("https://platform.openai.com/api-keys で取得したAPIキー")
      .addText((text) =>
        text.setPlaceholder("sk-...").setValue(this.plugin.settings.openaiApiKey).onChange(async (value) => {
          this.plugin.settings.openaiApiKey = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("保存先フォルダ")
      .setDesc("清書ノートを保存するVault内のフォルダパス")
      .addText((text) =>
        text.setPlaceholder("Kindle/Youtube").setValue(this.plugin.settings.outputFolder).onChange(async (value) => {
          this.plugin.settings.outputFolder = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("h3", { text: "再生リストの並列処理" });
    containerEl.createEl("p", {
      text: "再生リストを清書するときに同時処理する動画の本数です。1本あたりのトークン量（＝基本料金）は並列数によって変わりませんが、増やすほどAPIのレート制限やYouTube側のIPブロックに当たりやすくなり、フォールバックで単価の高いモデルに切り替わる回数も増えます。3本が推奨上限です。",
      cls: "yt-summarizer-desc",
    });
    new Setting(containerEl)
      .setName("同時処理数")
      .addDropdown((dd) => {
        dd
          .addOption("1", "1本（直列・最も安全）")
          .addOption("2", "2本（既定）")
          .addOption("3", "3本（推奨上限）")
          .addOption("4", "4本（レート制限・IPブロックのリスク大）")
          .setValue(String(clampPlaylistConcurrency(this.plugin.settings.playlistConcurrency)))
          .onChange(async (value) => {
            this.plugin.settings.playlistConcurrency = clampPlaylistConcurrency(Number(value));
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "使用モデル・フォールバック設定" });

    const fallbackDescEl = containerEl.createEl("p", { cls: "yt-summarizer-desc" });
    const renderFallbackDesc = () => {
      fallbackDescEl.empty();
      if (this.plugin.settings.fallbackMode === "auto") {
        fallbackDescEl.setText(
          "自動: 優先順位1のモデルでエラー(レート制限・通信エラーなど)が発生した場合、自動的に優先順位2→3の順で再試行します。",
        );
      } else {
        fallbackDescEl.setText(
          "手動: 自動フォールバックを行わず、常に優先順位1のモデルのみを使用します。優先順位2・3は切り替える際の候補として保存されるだけで、自動では使われません。",
        );
      }
    };
    new Setting(containerEl)
      .setName("フォールバックモード")
      .addDropdown((dd) =>
        dd
          .addOption("auto", "自動（優先順位に沿って自動フォールバック）")
          .addOption("manual", "手動（優先順位1のみを常に使用）")
          .setValue(this.plugin.settings.fallbackMode)
          .onChange(async (value) => {
            this.plugin.settings.fallbackMode = value as FallbackMode;
            await this.plugin.saveSettings();
            renderFallbackDesc();
          }),
      );
    renderFallbackDesc();

    const priorityLabels = ["優先順位1", "優先順位2", "優先順位3"];
    priorityLabels.forEach((label, idx) => {
      new Setting(containerEl)
        .setName(label)
        .addDropdown((dd) => {
          for (const m of MODEL_REGISTRY) {
            dd.addOption(m.id, m.label);
          }
          dd.setValue(this.plugin.settings.modelPriority[idx]).onChange(async (value) => {
            this.plugin.settings.modelPriority[idx] = value;
            await this.plugin.saveSettings();
          });
        });
    });

    containerEl.createEl("h3", { text: "カテゴリ管理" });
    containerEl.createEl("p", {
      text: "清書後の自動分類で使うカテゴリ候補を編集できます。",
      cls: "yt-summarizer-desc",
    });

    const listWrap = containerEl.createDiv({ cls: "yt-summarizer-cat-list" });
    const renderList = () => {
      listWrap.empty();
      const categories = Array.from(new Set(
        this.plugin.settings.categories
          .map((cat) => normalizeCategory(cat))
          .filter((cat) => cat.length > 0)
      ));
      if (categories.length === 0) {
        listWrap.createEl("div", { text: "（カテゴリがありません）", cls: "yt-summarizer-desc" });
        return;
      }
      for (const cat of categories) {
        const row = listWrap.createDiv({ cls: "yt-summarizer-cat-list-row" });
        row.createSpan({ text: cat, cls: "yt-summarizer-cat-list-name" });
        const actions = row.createDiv({ cls: "yt-summarizer-cat-list-actions" });
        const edit = actions.createEl("button", { text: "編集", cls: "yt-summarizer-cat-list-edit" });
        edit.addEventListener("click", () => {
          row.empty();
          const input = row.createEl("input", {
            type: "text",
            value: cat,
            cls: "yt-summarizer-input yt-summarizer-cat-list-input",
          });
          const editActions = row.createDiv({ cls: "yt-summarizer-cat-list-actions" });
          const save = editActions.createEl("button", { text: "保存", cls: "yt-summarizer-cat-list-edit" });
          const cancel = editActions.createEl("button", { text: "キャンセル", cls: "yt-summarizer-cat-list-del" });
          const saveEdit = async () => {
            const nextCat = input.value.trim();
            if (!nextCat) {
              new Notice("カテゴリ名を入力してください");
              return;
            }
            const duplicate = this.plugin.settings.categories.some((c) => {
              const normalized = normalizeCategory(c);
              return normalized !== cat && normalized === normalizeCategory(nextCat);
            });
            if (duplicate) {
              new Notice("既に存在するカテゴリです");
              return;
            }
            const updated = this.plugin.settings.categories
              .map((c) => normalizeCategory(c) === cat ? nextCat : normalizeCategory(c))
              .filter((c) => c.length > 0);
            this.plugin.settings.categories = Array.from(new Set(updated));
            await this.plugin.saveSettings();
            renderList();
          };
          save.addEventListener("click", saveEdit);
          cancel.addEventListener("click", renderList);
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); saveEdit(); }
            if (e.key === "Escape") { e.preventDefault(); renderList(); }
          });
          setTimeout(() => input.focus(), 0);
        });
        const del = actions.createEl("button", { text: "削除", cls: "yt-summarizer-cat-list-del" });
        del.addEventListener("click", async () => {
          this.plugin.settings.categories = this.plugin.settings.categories.filter((c) => normalizeCategory(c) !== cat);
          await this.plugin.saveSettings();
          renderList();
        });
      }
    };
    renderList();

    const addWrap = containerEl.createDiv({ cls: "yt-summarizer-cat-add-wrap" });
    const addInput = addWrap.createEl("input", {
      type: "text",
      placeholder: "新しいカテゴリ名",
      cls: "yt-summarizer-input",
    });
    const addBtn = addWrap.createEl("button", { text: "追加", cls: "yt-summarizer-cat-add-btn" });
    const add = async () => {
      const name = addInput.value.trim();
      if (!name) return;
      if (this.plugin.settings.categories.some((cat) => normalizeCategory(cat) === normalizeCategory(name))) {
        new Notice("既に存在するカテゴリです");
        return;
      }
      this.plugin.settings.categories.push(name);
      await this.plugin.saveSettings();
      addInput.value = "";
      renderList();
    };
    addBtn.addEventListener("click", add);
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); add(); }
    });

    containerEl.createEl("h3", { text: "フォルダ名候補管理" });
    containerEl.createEl("p", {
      text: "モーダルのフォルダ名プルダウンに追加表示する候補を編集できます。実フォルダは削除しません。",
      cls: "yt-summarizer-desc",
    });

    const folderListWrap = containerEl.createDiv({ cls: "yt-summarizer-cat-list" });
    const renderFolderList = () => {
      folderListWrap.empty();
      const names = Array.from(new Set(
        [...this.plugin.settings.folderNames]
          .map(normalizeFolderNameCandidate)
          .filter((name) => name.length > 0)
      )).sort(compareFolderNames);
      if (names.length === 0) {
        folderListWrap.createEl("div", { text: "（フォルダ名候補がありません）", cls: "yt-summarizer-desc" });
        return;
      }
      for (const name of names) {
        const row = folderListWrap.createDiv({ cls: "yt-summarizer-cat-list-row" });
        row.createSpan({ text: name, cls: "yt-summarizer-cat-list-name" });
        const actions = row.createDiv({ cls: "yt-summarizer-cat-list-actions" });
        const edit = actions.createEl("button", { text: "編集", cls: "yt-summarizer-cat-list-edit" });
        edit.addEventListener("click", () => {
          row.empty();
          const input = row.createEl("input", {
            type: "text",
            value: name,
            cls: "yt-summarizer-input yt-summarizer-cat-list-input",
          });
          const editActions = row.createDiv({ cls: "yt-summarizer-cat-list-actions" });
          const save = editActions.createEl("button", { text: "保存", cls: "yt-summarizer-cat-list-edit" });
          const cancel = editActions.createEl("button", { text: "キャンセル", cls: "yt-summarizer-cat-list-del" });
          const saveEdit = async () => {
            const nextName = normalizeFolderNameCandidate(input.value);
            if (!nextName) {
              new Notice("フォルダ名を入力してください");
              return;
            }
            const duplicate = this.plugin.settings.folderNames.some((n) => {
              const normalized = normalizeFolderNameCandidate(n);
              return normalized !== name && normalized === nextName;
            });
            if (duplicate) {
              new Notice("既に存在するフォルダ名候補です");
              return;
            }
            const updated = this.plugin.settings.folderNames
              .map((n) => normalizeFolderNameCandidate(n) === name ? nextName : normalizeFolderNameCandidate(n))
              .filter((n) => n.length > 0);
            this.plugin.settings.folderNames = Array.from(new Set(updated)).sort(compareFolderNames);
            await this.plugin.saveSettings();
            renderFolderList();
          };
          save.addEventListener("click", saveEdit);
          cancel.addEventListener("click", renderFolderList);
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); saveEdit(); }
            if (e.key === "Escape") { e.preventDefault(); renderFolderList(); }
          });
          setTimeout(() => input.focus(), 0);
        });
        const del = actions.createEl("button", { text: "削除", cls: "yt-summarizer-cat-list-del" });
        del.addEventListener("click", async () => {
          this.plugin.settings.folderNames = this.plugin.settings.folderNames.filter((n) => normalizeFolderNameCandidate(n) !== name);
          await this.plugin.saveSettings();
          renderFolderList();
        });
      }
    };
    renderFolderList();

    const folderAddWrap = containerEl.createDiv({ cls: "yt-summarizer-cat-add-wrap" });
    const folderAddInput = folderAddWrap.createEl("input", {
      type: "text",
      placeholder: "新しいフォルダ名",
      cls: "yt-summarizer-input",
    });
    const folderAddBtn = folderAddWrap.createEl("button", { text: "追加", cls: "yt-summarizer-cat-add-btn" });
    const addFolderName = async () => {
      const name = normalizeFolderNameCandidate(folderAddInput.value);
      if (!name) return;
      const exists = this.plugin.settings.folderNames.some((n) => normalizeFolderNameCandidate(n) === name);
      if (exists) {
        new Notice("既に存在するフォルダ名候補です");
        return;
      }
      this.plugin.settings.folderNames.push(name);
      this.plugin.settings.folderNames.sort(compareFolderNames);
      await this.plugin.saveSettings();
      folderAddInput.value = "";
      renderFolderList();
    };
    folderAddBtn.addEventListener("click", addFolderName);
    folderAddInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addFolderName(); }
    });

    containerEl.createEl("h3", { text: "Webshare プロキシ設定（IPブロック対策）" });
    containerEl.createEl("p", {
      text: "https://dashboard.webshare.io/proxy/settings の Proxy Username と Proxy Password を入力してください。空欄の場合はプロキシなしで動作します。",
      cls: "yt-summarizer-desc",
    });
    new Setting(containerEl)
      .setName("Proxy Username")
      .addText((text) =>
        text.setPlaceholder("username").setValue(this.plugin.settings.proxyConfig.username).onChange(async (value) => {
          this.plugin.settings.proxyConfig.username = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Proxy Password")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("password").setValue(this.plugin.settings.proxyConfig.password).onChange(async (value) => {
          this.plugin.settings.proxyConfig.password = value;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "API利用コスト（累計）" });
    containerEl.createEl("p", {
      text: "Claude / Gemini / OpenAI APIの利用トークンと概算コストです。為替は固定 1USD = ¥150 で換算しています。",
      cls: "yt-summarizer-desc",
    });
    const statsWrap = containerEl.createDiv({ cls: "yt-summarizer-stats-wrap" });
    const renderStats = () => {
      statsWrap.empty();
      const inTok = this.plugin.settings.totalInputTokens;
      const outTok = this.plugin.settings.totalOutputTokens;
      const usd = this.plugin.settings.totalCostUsd;
      const yen = usd * USD_TO_JPY;
      const row = (label: string, value: string) => {
        const r = statsWrap.createDiv({ cls: "yt-summarizer-stats-row" });
        r.createSpan({ text: label, cls: "yt-summarizer-stats-label" });
        r.createSpan({ text: value, cls: "yt-summarizer-stats-value" });
      };
      row("累計入力トークン", `${inTok.toLocaleString()}`);
      row("累計出力トークン", `${outTok.toLocaleString()}`);
      row("累計コスト", `$${usd.toFixed(4)}（約¥${yen.toFixed(1)}）`);
    };
    renderStats();
    new Setting(containerEl)
      .setName("累計をリセット")
      .setDesc("入力・出力トークン数とコストをすべて0に戻します。")
      .addButton((btn) =>
        btn.setButtonText("リセット").setWarning().onClick(async () => {
          this.plugin.settings.totalInputTokens = 0;
          this.plugin.settings.totalOutputTokens = 0;
          this.plugin.settings.totalCostUsd = 0;
          await this.plugin.saveSettings();
          renderStats();
          new Notice("累計コストをリセットしました");
        }),
      );
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") { reject(new Error("FileReaderが文字列を返しませんでした")); return; }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.substring(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("ファイル読み込みエラー"));
    reader.readAsDataURL(file);
  });
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      URL.revokeObjectURL(url);
      resolve({ width, height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像サイズを確認できませんでした"));
    };
    img.src = url;
  });
}

function extractChannelName(html: string): string {
  const patterns = [
    /"ownerChannelName":"((?:[^"\\]|\\.)*)"/,
    /<link itemprop="name" content="([^"]+)"/,
    /"author":"((?:[^"\\]|\\.)*)"/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      return m[1].replace(/\\u0026/g, "&").replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
    }
  }
  return "";
}

function extractVideoId(url: string): string | null {
  const match = url.match(/(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function isYouTubeUrl(url: string): boolean {
  return /youtube\.com|youtu\.be/i.test(url);
}

function extractYouTubeUrl(text: string): string | null {
  const match = text.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}[^\s)]*/);
  return match ? match[0] : null;
}
