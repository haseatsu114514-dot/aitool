const statsRoot = document.querySelector("#stats");
const cardsRoot = document.querySelector("#cards");
const warningsRoot = document.querySelector("#warnings");
const lastUpdated = document.querySelector("#last-updated");
const statTemplate = document.querySelector("#stat-template");
const cardTemplate = document.querySelector("#card-template");
const filterButtons = [...document.querySelectorAll(".filter-button[data-filter]")];
const viewButtons = [...document.querySelectorAll(".view-button[data-view]")];
const notificationToggleButton = document.querySelector("#notification-toggle");
const restoreHiddenButton = document.querySelector("#restore-hidden");
const hiddenTray = document.querySelector("#hidden-tray");
const staleTray = document.querySelector("#stale-tray");
const noticeFeedRoot = document.querySelector("#notice-feed");
const runtimeBadge = document.querySelector("#runtime-badge");
const roomStage = document.querySelector(".room-stage");
const roomOverview = document.querySelector("#room-overview");
const sceneRoot = document.querySelector("#scene");
const sceneTemplate = document.querySelector("#scene-template");

const STORAGE_KEY = "ai-workboard-hidden-sessions";
const VIEW_STORAGE_KEY = "ai-workboard-active-view";
const NOTIFICATION_STORAGE_KEY = "ai-workboard-notifications";
const STALE_MS = 30 * 60 * 1000;
const MAX_NOTICE_ITEMS = 5;
const SPECIES_TYPES = ["hamster", "cat", "rabbit", "bear"];

const PROVIDER_META = {
  Codex: { label: "CX", className: "provider-codex" },
  Claude: { label: "CL", className: "provider-claude" },
  Antigravity: { label: "AG", className: "provider-antigravity" },
  "Antigravity Web": { label: "AG", className: "provider-antigravity" },
  ChatGPT: { label: "CG", className: "provider-chatgpt" },
  Gemini: { label: "GM", className: "provider-gemini" },
  NotebookLM: { label: "NB", className: "provider-notebooklm" },
  Genspark: { label: "GS", className: "provider-genspark" },
  Perplexity: { label: "PX", className: "provider-perplexity" },
  Copilot: { label: "CP", className: "provider-copilot" },
  Grok: { label: "GK", className: "provider-grok" },
  DeepSeek: { label: "DS", className: "provider-deepseek" },
};

let activeFilter = "all";
let activeView = loadViewMode();
let hiddenSessionIds = loadHiddenSessionIds();
let latestSnapshot = null;
let notificationsEnabled = loadNotificationPreference();
let notificationBaselineReady = false;
let noticeFeed = [];
const speciesAssignments = new Map();
const notificationSessions = new Map();

function clampText(value, maxLength = 68) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[「」]/g, "")
    .trim();
}

function looksMostlyLatin(value) {
  const text = normalizeText(value);
  if (!text || /[ぁ-んァ-ヶ一-龠々]/.test(text)) {
    return false;
  }

  const letters = text.match(/[A-Za-z]/g) || [];
  return letters.length >= 6;
}

function sanitizeTaskSeed(value) {
  return normalizeText(value)
    .replace(/^編集中:\s*/i, "")
    .replace(/[?？].*$/, "")
    .replace(/（.*$/, "")
    .replace(/\(.*$/, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b(browser|desktop|window|chrome|safari|arc)\b/gi, "")
    .trim();
}

function fallbackJapaneseTask(rawTitle, rawSummary, project) {
  const combined = `${rawTitle} ${rawSummary}`;
  const genericProject = isGenericProjectName(project);
  const scopedProject = genericProject ? "作業内容" : project;

  if (/bug|fix|issue|error|warning|debug|crash/i.test(combined)) {
    return `${scopedProject} の不具合対応`;
  }

  if (/image|sprite|pixel|illustration|art|logo/i.test(combined)) {
    return "画像づくり";
  }

  if (/design|layout|ui|screen|color|style|character|avatar/i.test(combined)) {
    return "画面デザインの調整";
  }

  if (/notify|notification/i.test(combined)) {
    return "通知まわりの追加";
  }

  if (/summary|summarize|document|readme|note|docs?/i.test(combined)) {
    return `${scopedProject} の整理`;
  }

  if (/test|build|deploy|release|verify|check/i.test(combined)) {
    return `${scopedProject} の確認`;
  }

  if (/\.tsx?\b|\.jsx?\b|\.css\b|\.html\b|\.md\b|\.json\b|api|server|component|page|file/i.test(combined)) {
    return `${scopedProject} の調整`;
  }

  return `${scopedProject} の対応`;
}

function isGenericProjectName(project) {
  return /^(Claude|Codex|ChatGPT|Gemini|Genspark|Antigravity|NotebookLM|Perplexity|Copilot|Grok|DeepSeek)\b/i.test(
    project,
  ) || /\bAI\b/i.test(project);
}

function shortPathLabel(value) {
  const parts = String(value || "")
    .split("/")
    .filter(Boolean);
  const tail = parts.slice(-5);
  const generic = new Set([
    "src",
    "app",
    "apps",
    "browser",
    "desktop",
    "pages",
    "public",
    "brain",
    "user",
    "users",
    "documents",
    "library",
    "application support",
  ]);

  const isOpaque = (segment) =>
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ||
    (/^[a-z0-9_-]{10,}$/i.test(segment) && /\d/.test(segment));

  if (!parts.length) {
    return "";
  }

  const meaningful = tail.filter((segment) => {
    const normalized = segment.toLowerCase();
    return !generic.has(normalized) && !isOpaque(segment);
  });

  if (meaningful.length) {
    return meaningful.at(-1);
  }

  const last = parts.at(-1);
  return isOpaque(last) ? "作業フォルダ" : last;
}

function shortLocation(session) {
  if (session.workspace) {
    return shortPathLabel(session.workspace) || "作業フォルダ";
  }

  if (!session.url) {
    return "場所不明";
  }

  try {
    const url = new URL(session.url);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return session.url;
  }
}

function sessionActivityMs(session) {
  const timestamp = session.lastActiveAtIso || session.startedAtIso;
  if (!timestamp) {
    return null;
  }

  const value = new Date(timestamp).getTime();
  return Number.isNaN(value) ? null : value;
}

function staleDurationMs(session) {
  const activityMs = sessionActivityMs(session);
  if (!activityMs || session.statusKey === "running") {
    return null;
  }

  return Math.max(0, Date.now() - activityMs);
}

function isStaleSession(session) {
  const staleMs = staleDurationMs(session);
  return typeof staleMs === "number" && staleMs >= STALE_MS;
}

function staleLabel(session) {
  const staleMs = staleDurationMs(session);
  if (!staleMs) {
    return null;
  }

  const minutes = Math.max(30, Math.round(staleMs / 60000));
  if (minutes < 60) {
    return `${minutes}分放置`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}時間${restMinutes}分放置` : `${hours}時間放置`;
}

function canReopenSession(session) {
  return Boolean(session.url || session.workspace || session.appName);
}

async function reopenSession(session) {
  const response = await fetch("/api/reopen", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      appName: session.appName || null,
      workspace: session.workspace || null,
      url: session.url || null,
    }),
  });

  if (!response.ok) {
    throw new Error("reopen failed");
  }
}

function looksGenericTitle(session, title) {
  const normalized = String(title || "").trim();
  if (!normalized) {
    return true;
  }

  const genericTitles = new Set([
    "会話を開いています",
    "Gemini の会話",
    "NotebookLM のノート",
    `${session.provider} の会話`,
    `${session.provider} を開いています`,
    `${session.provider} のタスク`,
    `${session.provider} の作業`,
    `${session.provider} のセッション`,
    "作業内容を読み取れませんでした",
  ]);

  return genericTitles.has(normalized);
}

function prettyTaskTitle(session) {
  const rawTitle = clampText(normalizeText(String(session.taskTitle || "").replace(/^編集中:\s*/, "")), 58);
  if (!rawTitle) {
    return `${session.provider} のタスク`;
  }

  if (looksGenericTitle(session, rawTitle)) {
    if (session.sourceType === "browser") {
      return `${session.provider} の画面`;
    }
    return `${session.provider} のタスク`;
  }

  return rawTitle;
}

function summarizeRequestedTask(session) {
  const rawTitle = normalizeText(session.taskTitle);
  const rawSummary = normalizeText(session.summary);
  const project = resolveProject(session).name;
  const scopedProject = isGenericProjectName(project) ? "作業内容" : project;
  const combined = normalizeText(
    [rawTitle, rawSummary, session.workspace ? shortPathLabel(session.workspace) : ""].filter(Boolean).join(" "),
  );

  if (!rawTitle && !rawSummary) {
    return `${session.provider} の内容確認`;
  }

  if (session.sourceType === "browser" && looksGenericTitle(session, prettyTaskTitle(session))) {
    return `${session.provider} の内容確認`;
  }

  if (/ai-workboard|workboard|dashboard|monitor|どのAI|一目で分かる|何個AI|進捗|タスク/i.test(combined)) {
    return "AI作業ボードの開発";
  }

  if (/部屋|room|scene|キャラ|character|avatar|pet|たまごっち|ドラクエ|dragon quest/i.test(combined)) {
    return "部屋ビューとキャラの調整";
  }

  if (/godot|ゲーム|game/i.test(combined) && /落ち|クラッシュ|error|エラー|debug|デバッグ|warning/i.test(combined)) {
    return "ゲームの不具合修正";
  }

  if (/通知|notify|notification/i.test(combined)) {
    return "通知まわりの追加";
  }

  if (/ブラウザ|browser|chrome|safari|arc|tab|url|web/i.test(combined)) {
    return "ブラウザ状況の確認";
  }

  if (/デザイン|見た目|UI|レイアウト|layout|色分け|表情|css|html|style/i.test(combined)) {
    return "画面レイアウトの調整";
  }

  if (/要約|まとめ|整理|summary|summarize/i.test(combined)) {
    return "内容の要約と整理";
  }

  if (/画像|pixel|sprite|イラスト|art|illustration/i.test(combined)) {
    return "画像づくり";
  }

  if (/api|server|route|backend|db|database/i.test(combined)) {
    return "バックエンドの調整";
  }

  if (/作成|作って|追加|実装|対応|改善|修正|build|test|deploy|verify|check/i.test(combined)) {
    return isGenericProjectName(project) ? "作業内容の改善" : `${project} の改善`;
  }

  if (/編集中:/i.test(String(session.taskTitle || ""))) {
    return `${scopedProject} の編集中ファイル対応`;
  }

  if (looksGenericTitle(session, rawTitle)) {
    return `${scopedProject} の作業`;
  }

  const seed = sanitizeTaskSeed(
    rawTitle
      .replace(/最新の|今パソコン上で|もしなければ.*/g, "")
      .trim(),
  );

  if (!seed) {
    return `${scopedProject} の作業`;
  }

  if (looksMostlyLatin(seed)) {
    return fallbackJapaneseTask(rawTitle, rawSummary, project);
  }

  if (/\.tsx?\b|\.jsx?\b|\.css\b|\.html\b|\.md\b|\.json\b/i.test(seed)) {
    return `${scopedProject} のファイル対応`;
  }

  return clampText(seed, 20) || `${scopedProject} の作業`;
}

function hashText(value) {
  let hash = 0;
  for (const char of String(value || "")) {
    hash = ((hash * 31) + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

function resolveProject(session) {
  const location = shortLocation(session);
  const title = prettyTaskTitle(session);
  const weakLocations = new Set([
    "作業フォルダ",
    "antigravity",
    "claude",
    "codex",
    "genspark.ai",
    "gemini.google.com",
    "notebooklm.google.com",
    "chatgpt.com",
  ]);
  const titleLooksUseful = !looksGenericTitle(session, title) && title.length <= 34;
  const locationLooksUseful = location && location !== "場所不明" && !weakLocations.has(location.toLowerCase());

  if (titleLooksUseful && !locationLooksUseful) {
    return {
      name: clampText(title, 26),
    };
  }

  if (locationLooksUseful) {
    return {
      name: clampText(location, 26),
    };
  }

  return {
    name: clampText(titleLooksUseful ? title : session.provider, 26),
  };
}

function shuffleList(values) {
  const items = [...values];
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function speciesKey(session, projectName = null) {
  return `${session.id}|${projectName || resolveProject(session).name}`;
}

function assignSpecies(sessions) {
  const assignments = new Map();
  const activeKeys = new Set(
    sessions.map((session) => speciesKey(session, resolveProject(session).name)),
  );

  for (const key of [...speciesAssignments.keys()]) {
    if (!activeKeys.has(key)) {
      speciesAssignments.delete(key);
    }
  }

  const used = new Set();

  for (const session of sessions) {
    const projectName = resolveProject(session).name;
    const key = speciesKey(session, projectName);
    const existing = speciesAssignments.get(key);
    if (existing && !used.has(existing)) {
      assignments.set(session.id, existing);
      used.add(existing);
    }
  }

  let speciesPool = shuffleList(SPECIES_TYPES);

  for (const session of sessions) {
    if (assignments.has(session.id)) {
      continue;
    }

    const projectName = resolveProject(session).name;
    const key = speciesKey(session, projectName);
    let available = speciesPool.filter((species) => !used.has(species));

    if (!available.length) {
      used.clear();
      speciesPool = shuffleList(SPECIES_TYPES);
      available = [...speciesPool];
    }

    const species = available[0];
    speciesAssignments.set(key, species);
    assignments.set(session.id, species);
    used.add(species);
  }

  return assignments;
}

function agentDisplayName(session) {
  if (session.provider === "Claude") {
    if (session.sourceType === "cli" || /Claude Code/i.test(session.source || "")) {
      return "Claude Code";
    }

    if (session.sourceType === "browser") {
      return "Claude Web";
    }

    return "Claude Desktop";
  }

  if (session.provider === "Codex") {
    return "Codex App";
  }

  if (session.provider === "ChatGPT") {
    return session.sourceType === "browser" ? "ChatGPT Web" : "ChatGPT";
  }

  if (session.provider === "Antigravity Web") {
    return "Antigravity Web";
  }

  if (session.provider === "Gemini") {
    return session.sourceType === "browser" ? "Gemini Web" : "Gemini";
  }

  if (session.provider === "NotebookLM") {
    return "NotebookLM";
  }

  return session.provider;
}

function agentBadgeLabel(session) {
  const name = agentDisplayName(session);
  const labels = {
    "Antigravity": "AG",
    "Antigravity Web": "AG",
    "ChatGPT": "GPT",
    "ChatGPT Web": "GPT",
    "Claude Code": "CC",
    "Claude Desktop": "CL",
    "Claude Web": "CL",
    "Codex App": "CX",
    "Copilot": "CP",
    "DeepSeek": "DS",
    "Gemini": "GM",
    "Gemini Web": "GM",
    "Genspark": "GS",
    "Grok": "GK",
    "NotebookLM": "NB",
    "Perplexity": "PX",
  };

  return labels[name] || clampText(name, 3).toUpperCase();
}

function environmentKindLabel(session) {
  if (session.sourceType === "browser") {
    return "ブラウザ";
  }

  if (session.sourceType === "cli") {
    return "CLI";
  }

  return "アプリ";
}

function sourceChipLabel(session) {
  const environment = environmentKindLabel(session);
  const rawSource = normalizeText(session.source || session.appName || "");
  const cleanedSource = rawSource
    .replace(/\s*タブ$/u, "")
    .replace(/\s*デスクトップ$/u, "")
    .trim();

  if (!cleanedSource) {
    return `環境: ${environment}`;
  }

  return `環境: ${environment} / ${clampText(cleanedSource, 12)}`;
}

function buildTaskSummaryDetail(session) {
  const task = summarizeRequestedTask(session);
  const location = shortLocation(session);

  if (isStaleSession(session)) {
    return `${task} が30分以上止まっています。`;
  }

  if (session.statusKey === "waiting") {
    return `${task} の返事待ちです。`;
  }

  if (session.statusKey === "idle") {
    return session.sourceType === "browser"
      ? `${task} のページを開いたままです。`
      : `${task} を開いたまま休んでいます。`;
  }

  if (session.sourceType === "browser") {
    return `${task} の内容を確認しています。`;
  }

  if (location && location !== "場所不明") {
    return `${task} を ${location} で進めています。`;
  }

  return `${task} を進めています。`;
}

function buildTaskSummary(session) {
  return clampText(buildTaskSummaryDetail(session), 34);
}

function etaLooksClose(etaLabel) {
  if (!etaLabel) {
    return false;
  }

  if (etaLabel.includes("終盤")) {
    return true;
  }

  const match = etaLabel.match(/あと(\d+)分/);
  return Boolean(match && Number(match[1]) <= 4);
}

function resolveMood(session) {
  if (isStaleSession(session)) {
    return "rest";
  }

  if (session.statusKey === "waiting" || session.statusKey === "idle") {
    return "rest";
  }

  if (etaLooksClose(session.eta?.label)) {
    return "happy";
  }

  return "focus";
}

function resolveActivity(session) {
  if (isStaleSession(session)) {
    return {
      key: "sleep",
      label: "30分放置",
      sceneNow: "いま: 長く止まっています",
    };
  }

  if (session.sourceType === "browser") {
    return {
      key: session.statusKey === "running" ? "window" : "sleep",
      label: session.statusKey === "running" ? "ブラウザ確認" : "開いたまま",
      sceneNow: session.statusKey === "running" ? "いま: ブラウザを確認中" : "いま: ひと休み中",
    };
  }

  if (session.statusKey === "waiting") {
    return {
      key: "sleep",
      label: "返事待ち",
      sceneNow: "いま: 返事待ちです",
    };
  }

  if (session.statusKey === "idle") {
    return {
      key: "sleep",
      label: "休憩中",
      sceneNow: "いま: 横になって休憩中",
    };
  }

  if (session.statusKey === "running") {
    return {
      key: "desk",
      label: "PC作業中",
      sceneNow: "いま: パソコンで作業中",
    };
  }

  return {
    key: "sleep",
    label: "休憩中",
    sceneNow: "いま: 横になって休憩中",
  };
}

function sceneTaskLine(session) {
  return clampText(`作業: ${summarizeRequestedTask(session)}`, 30);
}

function sceneThoughtLine(session) {
  return clampText(summarizeRequestedTask(session), 18);
}

function scenePlaceLine(session, activity) {
  const location = shortLocation(session);
  const spotMap = {
    desk: "机",
    window: "窓ぎわ",
    sleep: "ベッド",
  };
  const spot = spotMap[activity.key] || "部屋";
  const agent = agentDisplayName(session);
  const environment = environmentKindLabel(session);
  return location && location !== "場所不明"
    ? `場所: ${spot} ・ ${environment} ・ ${location} ・ ${agent}`
    : `場所: ${spot} ・ ${environment} ・ ${agent}`;
}

function runningInsideDesktopApp() {
  return /Electron/i.test(navigator.userAgent || "");
}

function syncRuntimeBadge() {
  if (!runtimeBadge) {
    return;
  }

  runtimeBadge.textContent = runningInsideDesktopApp() ? "今はアプリ版" : "今はブラウザ版";
}

function displayUpdatedMs(session) {
  if (session.statusKey === "running" && session.sourceType === "browser") {
    return Date.now();
  }

  return sessionActivityMs(session) || 0;
}

function sortSessionsByFreshness(sessions) {
  const stateOrder = {
    running: 0,
    waiting: 1,
    idle: 2,
  };

  return [...sessions].sort((a, b) => {
    const updatedDelta = displayUpdatedMs(b) - displayUpdatedMs(a);
    if (updatedDelta !== 0) {
      return updatedDelta;
    }

    const stateDelta = (stateOrder[a.statusKey] ?? 9) - (stateOrder[b.statusKey] ?? 9);
    if (stateDelta !== 0) {
      return stateDelta;
    }

    return agentDisplayName(a).localeCompare(agentDisplayName(b), "ja");
  });
}

function loadHiddenSessionIds() {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function loadViewMode() {
  const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
  return stored === "room" ? "room" : "cards";
}

function loadNotificationPreference() {
  return window.localStorage.getItem(NOTIFICATION_STORAGE_KEY) === "on";
}

function saveHiddenSessionIds() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...hiddenSessionIds]));
}

function saveViewMode() {
  window.localStorage.setItem(VIEW_STORAGE_KEY, activeView);
}

function saveNotificationPreference() {
  window.localStorage.setItem(NOTIFICATION_STORAGE_KEY, notificationsEnabled ? "on" : "off");
}

function syncViewMode() {
  cardsRoot.hidden = activeView !== "cards";
  roomOverview.hidden = activeView !== "room";
  if (roomStage) {
    roomStage.dataset.view = activeView;
  }

  for (const button of viewButtons) {
    button.classList.toggle("is-active", button.dataset.view === activeView);
  }
}

function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

function syncNotificationButton() {
  if (!notificationToggleButton) {
    return;
  }

  if (!notificationsSupported()) {
    notificationToggleButton.textContent = "通知非対応";
    notificationToggleButton.title = "このブラウザでは通知を使えません。";
    notificationToggleButton.disabled = true;
    return;
  }

  if (Notification.permission === "denied") {
    notificationToggleButton.textContent = "通知がブロック中";
    notificationToggleButton.title = "ブラウザ設定で通知の許可が必要です。";
    notificationToggleButton.disabled = true;
    return;
  }

  notificationToggleButton.disabled = false;
  notificationToggleButton.classList.toggle("is-active", notificationsEnabled);
  notificationToggleButton.textContent = notificationsEnabled
    ? "通知オン"
    : Notification.permission === "granted"
      ? "通知をオン"
      : "通知を許可してオン";
  notificationToggleButton.title = notificationsEnabled
    ? "完了や放置を通知します。"
    : "クリックすると通知を許可して有効化します。";
}

function pushNotice(title, body, level = "info") {
  noticeFeed = [
    {
      id: `${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      title,
      body,
      level,
      createdAt: new Date().toISOString(),
    },
    ...noticeFeed,
  ].slice(0, MAX_NOTICE_ITEMS);
}

function renderNoticeFeed() {
  if (!noticeFeedRoot) {
    return;
  }

  noticeFeedRoot.innerHTML = "";

  if (!noticeFeed.length) {
    noticeFeedRoot.hidden = true;
    return;
  }

  noticeFeedRoot.hidden = false;

  const title = document.createElement("p");
  title.className = "notice-feed-title";
  title.textContent = "お知らせ";

  const list = document.createElement("div");
  list.className = "notice-feed-list";

  for (const notice of noticeFeed) {
    const item = document.createElement("article");
    item.className = "notice-item";
    item.dataset.level = notice.level;

    const headline = document.createElement("p");
    headline.className = "notice-item-title";
    headline.textContent = notice.title;

    const body = document.createElement("p");
    body.className = "notice-item-body";
    body.textContent = notice.body;

    const time = document.createElement("span");
    time.className = "notice-item-time";
    time.textContent = new Date(notice.createdAt).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    });

    item.append(headline, body, time);
    list.append(item);
  }

  noticeFeedRoot.append(title, list);
}

function rememberNotificationState(snapshot) {
  notificationSessions.clear();

  for (const session of snapshot.sessions || []) {
    if (hiddenSessionIds.has(session.id)) {
      continue;
    }

    notificationSessions.set(session.id, {
      statusKey: session.statusKey,
      stale: isStaleSession(session),
      label: resolveProject(session).name,
      provider: agentDisplayName(session),
      seenAt: Date.now(),
    });
  }
}

function showNotification(title, body, tag, options = {}) {
  pushNotice(title, body, options.level || "info");

  if (!notificationsEnabled || !notificationsSupported() || Notification.permission !== "granted") {
    return;
  }

  const notice = new Notification(title, {
    body,
    tag,
    icon: "/favicon.svg",
    requireInteraction: options.sticky ?? true,
  });

  if (options.sticky === false) {
    setTimeout(() => notice.close(), 7000);
  }
}

function evaluateNotifications(snapshot) {
  if (!notificationsEnabled) {
    notificationBaselineReady = false;
    notificationSessions.clear();
    return;
  }

  if (!notificationBaselineReady) {
    rememberNotificationState(snapshot);
    notificationBaselineReady = true;
    return;
  }

  const currentSessions = new Map();

  for (const session of snapshot.sessions || []) {
    if (hiddenSessionIds.has(session.id)) {
      continue;
    }

    const current = {
      statusKey: session.statusKey,
      stale: isStaleSession(session),
      label: resolveProject(session).name,
      provider: agentDisplayName(session),
      seenAt: Date.now(),
    };
    const previous = notificationSessions.get(session.id);

    if (previous?.statusKey === "running" && session.statusKey !== "running") {
      showNotification(
        `${current.label} が止まりました`,
        `${current.provider} が返事待ちや確認待ちに変わりました。`,
        `paused:${session.id}`,
      );
    }

    if (current.stale && !previous?.stale) {
      showNotification(
        `${current.label} を30分放置中です`,
        `${current.provider} が長く止まったままです。`,
        `stale:${session.id}`,
        { level: "warning" },
      );
    }

    currentSessions.set(session.id, current);
  }

  for (const [sessionId, previous] of notificationSessions) {
    if (currentSessions.has(sessionId)) {
      continue;
    }

    if (previous.statusKey === "running") {
      showNotification(
        `${previous.label} が終わったかも`,
        `${previous.provider} の表示が消えました。完了したか閉じた可能性があります。`,
        `finished:${sessionId}`,
        { level: "success" },
      );
    }
  }

  notificationSessions.clear();
  for (const [sessionId, value] of currentSessions) {
    notificationSessions.set(sessionId, value);
  }
}

function formatRelative(isoString) {
  if (!isoString) {
    return "更新不明";
  }

  const deltaMs = Date.now() - new Date(isoString).getTime();
  const minutes = Math.round(deltaMs / 60000);

  if (minutes <= 1) {
    return "たった今";
  }
  if (minutes < 60) {
    return `${minutes}分前`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}時間前`;
  }

  return new Date(isoString).toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function visibleSessionsFromSnapshot(snapshot) {
  const sessions = snapshot?.sessions || [];
  return sessions.filter((session) => !hiddenSessionIds.has(session.id));
}

function filteredSessions(sessions) {
  return sessions.filter((session) => {
    if (activeFilter === "all") {
      return true;
    }
    if (activeFilter === "running") {
      return session.statusKey === "running";
    }
    if (activeFilter === "waiting") {
      return session.statusKey === "waiting" || session.statusKey === "idle";
    }
    if (activeFilter === "browser") {
      return session.sourceType === "browser";
    }
    return true;
  });
}

function renderStats(sessions) {
  statsRoot.innerHTML = "";

  const items = [
    {
      label: "見えてるタスク",
      value: `${sessions.length}件`,
      help: "今この画面に出ている数",
    },
    {
      label: "作業中",
      value: `${sessions.filter((session) => session.statusKey === "running").length}件`,
      help: "今動いていそう",
    },
    {
      label: "ひと休み",
      value: `${sessions.filter((session) => session.statusKey !== "running").length}件`,
      help: "待機や開いたまま",
    },
    {
      label: "30分放置",
      value: `${sessions.filter((session) => isStaleSession(session)).length}件`,
      help: "長く止まっているAI",
    },
  ];

  for (const item of items) {
    const node = statTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".stat-label").textContent = item.label;
    node.querySelector(".stat-value").textContent = item.value;
    node.querySelector(".stat-help").textContent = item.help;
    statsRoot.append(node);
  }
}

function renderWarnings(warnings) {
  warningsRoot.innerHTML = "";

  if (!warnings.length) {
    warningsRoot.hidden = true;
    return;
  }

  warningsRoot.hidden = false;

  const title = document.createElement("p");
  title.className = "warnings-title";
  title.textContent = "一部は推定です";

  const list = document.createElement("ul");
  list.className = "warnings-list";

  for (const warning of warnings) {
    const item = document.createElement("li");
    item.textContent = warning;
    list.append(item);
  }

  warningsRoot.append(title, list);
}

function renderHiddenTray(snapshot) {
  hiddenTray.innerHTML = "";

  const hiddenSessions = (snapshot?.sessions || []).filter((session) => hiddenSessionIds.has(session.id));

  if (!hiddenSessions.length) {
    hiddenTray.hidden = true;
    return;
  }

  hiddenTray.hidden = false;

  const title = document.createElement("p");
  title.className = "hidden-tray-title";
  title.textContent = "隠しているAI";

  const list = document.createElement("div");
  list.className = "hidden-tray-list";

  for (const session of hiddenSessions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "hidden-chip";
    item.textContent = `${agentDisplayName(session)} を戻す`;
    item.addEventListener("click", () => {
      hiddenSessionIds.delete(session.id);
      saveHiddenSessionIds();
      rerender();
    });
    list.append(item);
  }

  hiddenTray.append(title, list);
}

function renderStaleTray(sessions) {
  if (!staleTray) {
    return;
  }

  staleTray.innerHTML = "";

  const staleSessions = sortSessionsByFreshness(sessions.filter((session) => isStaleSession(session)));
  if (!staleSessions.length) {
    staleTray.hidden = true;
    return;
  }

  staleTray.hidden = false;

  const title = document.createElement("p");
  title.className = "stale-tray-title";
  title.textContent = `30分以上止まっているものが ${staleSessions.length} 件あります`;

  const list = document.createElement("div");
  list.className = "stale-tray-list";

  for (const session of staleSessions) {
    const item = document.createElement("article");
    item.className = "stale-item";

    const name = document.createElement("p");
    name.className = "stale-item-title";
    name.textContent = summarizeRequestedTask(session);

    const meta = document.createElement("p");
    meta.className = "stale-item-meta";
    meta.textContent = `${agentDisplayName(session)} ・ ${staleLabel(session) || "長く停止中"}`;

    item.append(name, meta);
    list.append(item);
  }

  staleTray.append(title, list);
}

function renderCards(sessions, speciesBySessionId) {
  cardsRoot.innerHTML = "";

  if (!sessions.length) {
    const empty = document.createElement("article");
    empty.className = "empty-card";
    empty.textContent = "この部屋には、今その条件のAIはいません。";
    cardsRoot.append(empty);
    return;
  }

  for (const session of sortSessionsByFreshness(sessions)) {
    const meta = PROVIDER_META[session.provider] || {
      label: session.provider.slice(0, 2).toUpperCase(),
      className: "provider-default",
    };
    const activity = resolveActivity(session);
    const title = summarizeRequestedTask(session);
    const summary = buildTaskSummary(session);
    const summaryDetail = buildTaskSummaryDetail(session);
    const project = resolveProject(session);
    const species = speciesBySessionId.get(session.id) || SPECIES_TYPES[0];
    const agentName = agentDisplayName(session);

    const node = cardTemplate.content.firstElementChild.cloneNode(true);
    const stale = isStaleSession(session);
    node.dataset.state = session.statusKey;
    node.dataset.mood = resolveMood(session);
    node.dataset.activity = activity.key;
    node.dataset.stale = stale ? "true" : "false";
    node.dataset.species = species;
    node.classList.add(meta.className);

    node.querySelector(".resident-label").textContent = agentBadgeLabel(session);
    node.querySelector(".provider").textContent = `${agentName} の作業`;
    node.querySelector(".project-chip").textContent = `プロジェクト: ${project.name}`;
    node.querySelector(".project-chip").title = session.workspace || session.url || project.name;
    node.querySelector(".source-chip").textContent = sourceChipLabel(session);
    node.querySelector(".source-chip").title = `${environmentKindLabel(session)} / ${session.source || session.appName || agentName}`;
    node.querySelector(".task-title").textContent = title;
    node.querySelector(".task-title").title = normalizeText(session.taskTitle) || title;
    node.querySelector(".summary").textContent = summary;
    node.querySelector(".summary").title = summaryDetail;

    const pill = node.querySelector(".status-pill");
    pill.textContent = stale ? "30分放置" : session.statusLabel;
    pill.dataset.state = stale ? "stale" : session.statusKey;

    const workspace = node.querySelector(".workspace");
    workspace.textContent = `場所: ${shortLocation(session)}`;
    workspace.title = session.workspace || session.url || "不明";

    node.querySelector(".eta").textContent = stale
      ? `放置: ${staleLabel(session)}`
      : `目安: ${session.eta?.label || "未定"}`;
    node.querySelector(".activity").textContent = `今: ${activity.label}`;
    node.querySelector(".updated").textContent = `更新: ${formatRelative(session.lastActiveAtIso || session.startedAtIso)}`;

    const link = node.querySelector(".card-link");
    if (canReopenSession(session)) {
      link.textContent = stale ? "開いて確認" : "開いて表示";
      link.hidden = false;
      link.addEventListener("click", async () => {
        link.disabled = true;
        const previous = link.textContent;
        link.textContent = "表示中";
        try {
          await reopenSession(session);
        } catch {
          link.textContent = "開けませんでした";
          link.disabled = false;
          return;
        }

        setTimeout(() => {
          link.textContent = previous;
          link.disabled = false;
        }, 1400);
      });
    } else {
      link.hidden = true;
    }

    const reopenButton = node.querySelector(".reopen-button");
    if (stale && canReopenSession(session)) {
      reopenButton.hidden = false;
      reopenButton.textContent = "再開";
      reopenButton.addEventListener("click", async () => {
        reopenButton.disabled = true;
        const previous = reopenButton.textContent;
        reopenButton.textContent = "開いています";
        try {
          await reopenSession(session);
        } catch {
          reopenButton.textContent = "開けませんでした";
          reopenButton.disabled = false;
          return;
        }

        setTimeout(() => {
          reopenButton.textContent = previous;
          reopenButton.disabled = false;
        }, 1400);
      });
    } else {
      reopenButton.hidden = true;
    }

    const hideButton = node.querySelector(".hide-button");

    const hideSession = () => {
      hiddenSessionIds.add(session.id);
      notificationSessions.delete(session.id);
      saveHiddenSessionIds();
      rerender();
    };

    hideButton.addEventListener("click", hideSession);

    cardsRoot.append(node);
  }
}

function renderScene(sessions, speciesBySessionId) {
  sceneRoot.innerHTML = "";

  if (!sessions.length) {
    const empty = document.createElement("article");
    empty.className = "empty-card scene-empty";
    empty.textContent = "今はこの条件のAIが部屋にいません。";
    sceneRoot.append(empty);
    return;
  }

  const order = {
    desk: 0,
    window: 1,
    sleep: 2,
  };

  const sortedSessions = [...sessions].sort((a, b) => {
    const aActivity = resolveActivity(a);
    const bActivity = resolveActivity(b);
    const activityDelta = (order[aActivity.key] ?? 9) - (order[bActivity.key] ?? 9);
    if (activityDelta !== 0) {
      return activityDelta;
    }

    return displayUpdatedMs(b) - displayUpdatedMs(a);
  });

  for (const session of sortedSessions) {
    const meta = PROVIDER_META[session.provider] || {
      label: session.provider.slice(0, 2).toUpperCase(),
      className: "provider-default",
    };
    const activity = resolveActivity(session);
    const mood = resolveMood(session);
    const project = resolveProject(session);
    const species = speciesBySessionId.get(session.id) || SPECIES_TYPES[0];

    const node = sceneTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(meta.className);
    node.dataset.activity = activity.key;
    node.dataset.mood = mood;
    node.dataset.state = session.statusKey;
    node.dataset.stale = isStaleSession(session) ? "true" : "false";
    node.dataset.species = species;

    node.querySelector(".scene-name").textContent = `プロジェクト: ${project.name}`;
    node.querySelector(".scene-now").textContent = activity.sceneNow;
    node.querySelector(".scene-task").textContent = sceneTaskLine(session);
    node.querySelector(".scene-task").title = buildTaskSummaryDetail(session);
    node.querySelector(".scene-thought").textContent = sceneThoughtLine(session);
    node.querySelector(".scene-thought").title = buildTaskSummaryDetail(session);
    node.querySelector(".scene-action-chip").textContent = activity.label;
    node.querySelector(".scene-place").textContent = scenePlaceLine(session, activity);
    node.querySelector(".scene-badge").textContent = agentBadgeLabel(session);
    node.querySelector(".scene-badge").title = agentDisplayName(session);
    sceneRoot.append(node);
  }
}

function rerender() {
  const visibleSessions = visibleSessionsFromSnapshot(latestSnapshot);
  const displayedSessions = filteredSessions(visibleSessions);
  const speciesBySessionId = assignSpecies(visibleSessions);
  syncViewMode();
  syncRuntimeBadge();
  syncNotificationButton();
  renderStats(displayedSessions);
  renderHiddenTray(latestSnapshot);
  renderStaleTray(visibleSessions);
  renderNoticeFeed();
  renderWarnings(latestSnapshot?.warnings || []);
  renderCards(displayedSessions, speciesBySessionId);
  renderScene(displayedSessions, speciesBySessionId);
  restoreHiddenButton.disabled = hiddenSessionIds.size === 0;
  restoreHiddenButton.textContent =
    hiddenSessionIds.size === 0 ? "隠したAIはありません" : `隠したAIを戻す (${hiddenSessionIds.size})`;
}

async function refresh() {
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    const snapshot = await response.json();
    evaluateNotifications(snapshot);
    latestSnapshot = snapshot;
    rerender();

    lastUpdated.textContent = new Date(snapshot.generatedAt).toLocaleString("ja-JP", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    warningsRoot.hidden = false;
    warningsRoot.innerHTML = "";
    const title = document.createElement("p");
    title.className = "warnings-title";
    title.textContent = "読み込みに失敗しました";
    const body = document.createElement("p");
    body.textContent = "サーバーが起動しているか確認してください。";
    warningsRoot.append(title, body);
  }
}

for (const button of filterButtons) {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    for (const other of filterButtons) {
      other.classList.toggle("is-active", other === button);
    }
    rerender();
  });
}

for (const button of viewButtons) {
  button.addEventListener("click", () => {
    activeView = button.dataset.view === "room" ? "room" : "cards";
    saveViewMode();
    rerender();
  });
}

notificationToggleButton?.addEventListener("click", async () => {
  if (!notificationsSupported()) {
    return;
  }

  if (!notificationsEnabled) {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      notificationsEnabled = false;
      pushNotice("通知はまだオフです", "ブラウザ側で通知が許可されていません。", "warning");
      saveNotificationPreference();
      syncNotificationButton();
      renderNoticeFeed();
      return;
    }
    notificationsEnabled = true;
    notificationBaselineReady = false;
    showNotification("通知をオンにしました", "完了や放置をここで知らせます。", "notifications-enabled", {
      level: "success",
      sticky: false,
    });
  } else {
    notificationsEnabled = false;
    notificationBaselineReady = false;
    notificationSessions.clear();
    pushNotice("通知をオフにしました", "OS 通知は止めました。画面内のお知らせは残ります。", "info");
  }

  saveNotificationPreference();
  syncNotificationButton();
  renderNoticeFeed();
});

restoreHiddenButton.addEventListener("click", () => {
  hiddenSessionIds = new Set();
  saveHiddenSessionIds();
  notificationBaselineReady = false;
  rerender();
});

syncViewMode();
syncRuntimeBadge();
syncNotificationButton();
refresh();
setInterval(refresh, 8000);
