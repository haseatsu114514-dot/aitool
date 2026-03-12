import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, parseJsonOutput, firstMeaningfulLine, truncate, normalizeWhitespace } from "../utils.js";
import { findProcesses, summarizeProcesses } from "./system.js";

const CODEX_DIR = path.join(os.homedir(), ".codex");
const CODEX_DB = path.join(CODEX_DIR, "state_5.sqlite");
const VERY_RECENT_THREAD_MS = 5 * 60 * 1000;
const RECENT_THREAD_MS = 20 * 60 * 1000;
const RUNNING_ACTIVITY_MS = 90 * 1000;
const LOG_ACTIVITY_MS = 2 * 60 * 1000;
const UPDATED_ACTIVITY_MS = 2 * 60 * 1000;
const ACTIVE_THREAD_WINDOW_MS = 10 * 60 * 1000;
const MIN_PROGRESS_GAP_MS = 20 * 1000;
const RUNNING_CPU_THRESHOLD = 24;
const ACTIVE_STATUS_PATTERN =
  /コンテキストを自動的に圧縮しています|コンテキスト.*圧縮中|圧縮しています|圧縮中|思考中|試行中|考え中|推論中|処理中|分析中|thinking|reasoning|processing|compressing|compacting|summarizing context|summarising context|trying/i;

async function resolveCodexDbPath() {
  try {
    const entries = await fs.readdir(CODEX_DIR, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const match = entry.name.match(/^state_(\d+)\.sqlite$/);
        if (!match) {
          return null;
        }

        return {
          name: entry.name,
          version: Number(match[1]),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.version - a.version);

    if (candidates.length) {
      return path.join(CODEX_DIR, candidates[0].name);
    }
  } catch {
    // fall back to the older fixed path below
  }

  return CODEX_DB;
}

function hasMeaningfulProgress(threadUpdatedAt, threadCreatedAt) {
  if (!threadUpdatedAt) {
    return false;
  }

  if (threadCreatedAt && threadUpdatedAt - threadCreatedAt <= MIN_PROGRESS_GAP_MS) {
    return false;
  }

  return true;
}

function hasRecentProgress(threadUpdatedAt, threadCreatedAt, now) {
  return hasMeaningfulProgress(threadUpdatedAt, threadCreatedAt) && now - threadUpdatedAt < RUNNING_ACTIVITY_MS;
}

function hasActiveLanguage(...values) {
  return ACTIVE_STATUS_PATTERN.test(values.filter(Boolean).join(" "));
}

function latestActivityAt(threadUpdatedAt, recentLogAt) {
  return Math.max(threadUpdatedAt || 0, recentLogAt || 0) || null;
}

function updatedRecently(threadUpdatedAt, threadCreatedAt, now) {
  return hasMeaningfulProgress(threadUpdatedAt, threadCreatedAt) && now - threadUpdatedAt < UPDATED_ACTIVITY_MS;
}

function buildState(now, threadUpdatedAt, threadCreatedAt, summary, activeText = "", recentLogAt = null) {
  const activeRecently = hasRecentProgress(threadUpdatedAt, threadCreatedAt, now);
  const threadUpdatedRecently = updatedRecently(threadUpdatedAt, threadCreatedAt, now);
  const activeHint = hasActiveLanguage(activeText);
  const logActive = recentLogAt && now - recentLogAt < RUNNING_ACTIVITY_MS;
  const cpuBusy = (summary.cpu || 0) >= RUNNING_CPU_THRESHOLD;
  const freshActivity = latestActivityAt(threadUpdatedAt, recentLogAt);
  const busyCurrentThread =
    Boolean(freshActivity) &&
    now - freshActivity < ACTIVE_THREAD_WINDOW_MS &&
    threadUpdatedRecently &&
    cpuBusy;
  const hintedRunning = activeHint && (summary.frontmost || activeRecently || cpuBusy);
  const running = Boolean(logActive || hintedRunning || busyCurrentThread);

  return running
    ? { statusKey: "running", statusLabel: "作業中" }
    : { statusKey: "waiting", statusLabel: "待機中" };
}

function pickRelevantThreads(threads, recentLogsByThreadId) {
  if (!threads.length) {
    return [];
  }

  const nowMs = Date.now();
  const [primaryThread] = threads;
  const relevant = primaryThread ? [primaryThread] : [];
  const seenIds = new Set(primaryThread ? [primaryThread.id] : []);

  for (const thread of threads) {
    if (seenIds.has(thread.id)) {
      continue;
    }

    const recentLogAt = recentLogsByThreadId.get(thread.id);
    const updatedAtMs = (thread.updated_at || thread.created_at || 0) * 1000;
    const createdAtMs = thread.created_at ? thread.created_at * 1000 : null;

    if (
      (recentLogAt && nowMs - recentLogAt < LOG_ACTIVITY_MS) ||
      updatedRecently(updatedAtMs, createdAtMs, nowMs)
    ) {
      relevant.push(thread);
      seenIds.add(thread.id);
    }
  }

  if (relevant.length > 1) {
    return relevant.slice(0, 4);
  }

  const veryRecentThreads = threads.filter((thread) => {
    const updatedAtMs = ((thread.updated_at || thread.created_at || 0) * 1000);
    return nowMs - updatedAtMs < VERY_RECENT_THREAD_MS;
  });

  if (veryRecentThreads.length) {
    return veryRecentThreads.slice(0, 1);
  }

  const recentThreads = threads.filter((thread) => {
    const updatedAtMs = ((thread.updated_at || thread.created_at || 0) * 1000);
    return nowMs - updatedAtMs < RECENT_THREAD_MS;
  });

  if (recentThreads.length) {
    return recentThreads.slice(0, 1);
  }

  return threads.slice(0, 1);
}

async function loadRecentLogsByThreadId(dbPath) {
  const query = [
    "select thread_id, max(ts) as last_log_ts",
    "from logs",
    "where thread_id is not null",
    "group by thread_id",
    "order by last_log_ts desc",
    "limit 32;",
  ].join(" ");

  const { stdout } = await runCommand("sqlite3", ["-json", dbPath, query], {
    timeout: 4000,
  });
  const rows = parseJsonOutput(stdout, []);
  const map = new Map();

  for (const row of rows) {
    if (!row?.thread_id || !row?.last_log_ts) {
      continue;
    }
    map.set(row.thread_id, Number(row.last_log_ts) * 1000);
  }

  return map;
}

export async function collectCodexSessions(systemState) {
  const appProcesses = findProcesses(
    systemState.processes,
    /\/Applications\/Codex\.app\/Contents\/MacOS\/Codex\b|codex app-server|Codex Helper/i,
  );

  const summary = summarizeProcesses(appProcesses, systemState.appStates, "Codex");
  const running = summary.processCount > 0 || summary.visible;
  if (!running) {
    return { sessions: [], warnings: [] };
  }

  try {
    const dbPath = await resolveCodexDbPath();
    const query = [
      "select id, title, cwd, created_at, updated_at",
      "from threads",
      "where archived = 0",
      "order by updated_at desc",
      "limit 8;",
    ].join(" ");

    const { stdout } = await runCommand("sqlite3", ["-json", dbPath, query], {
      timeout: 4000,
    });
    const threads = parseJsonOutput(stdout, []);
    const recentLogsByThreadId = await loadRecentLogsByThreadId(dbPath);
    const relevantThreads = pickRelevantThreads(threads, recentLogsByThreadId);
    const currentThread = relevantThreads[0];

    if (!currentThread) {
      return {
        sessions: [
          {
            id: "codex:desktop",
            provider: "Codex",
            source: "Codex デスクトップ",
            sourceType: "desktop",
            appName: "Codex",
            taskTitle: "作業内容を読み取れませんでした",
            summary: "Codex は起動しています。",
            workspace: null,
            url: null,
            statusKey: summary.frontmost ? "running" : "waiting",
            statusLabel: summary.frontmost ? "作業中" : "待機中",
            startedAt: summary.startedAt,
            lastActiveAt: summary.startedAt,
            cpu: summary.cpu,
            frontmost: summary.frontmost,
          },
        ],
        warnings: [],
      };
    }

    return {
      sessions: relevantThreads.map((thread, index) => {
        const threadUpdatedAt = thread.updated_at ? thread.updated_at * 1000 : null;
        const threadCreatedAt = thread.created_at ? thread.created_at * 1000 : null;
        const bodyLines = String(thread.title || "")
          .split(/\r?\n/)
          .map((line) => normalizeWhitespace(line))
          .filter(Boolean);
        const taskTitle = truncate(firstMeaningfulLine(thread.title), 90);
        const summaryLine = bodyLines.length > 1 ? truncate(bodyLines.slice(1).join(" / "), 120) : null;
        const activeText = [taskTitle, summaryLine].filter(Boolean).join(" ");
        const activeHint = hasActiveLanguage(activeText);
        const recentLogAt = recentLogsByThreadId.get(thread.id) || null;
        const lastActiveAt = latestActivityAt(threadUpdatedAt, recentLogAt);
        const state =
          index === 0
            ? buildState(Date.now(), threadUpdatedAt, threadCreatedAt, summary, activeText, recentLogAt)
            : {
                statusKey:
                  (recentLogAt && Date.now() - recentLogAt < RUNNING_ACTIVITY_MS) ||
                  updatedRecently(threadUpdatedAt, threadCreatedAt, Date.now())
                    ? "running"
                    : "waiting",
                statusLabel:
                  (recentLogAt && Date.now() - recentLogAt < RUNNING_ACTIVITY_MS) ||
                  updatedRecently(threadUpdatedAt, threadCreatedAt, Date.now())
                    ? "作業中"
                    : "待機中",
              };

        return {
          id: `codex:${thread.id}`,
          provider: "Codex",
          source: "Codex デスクトップ",
          sourceType: "desktop",
          appName: "Codex",
          taskTitle: taskTitle || "Codex のスレッド",
          summary: summaryLine || "この依頼の詳細文は短く取得できませんでした。",
          workspace: thread.cwd || null,
          url: null,
          statusKey: state.statusKey,
          statusLabel: state.statusLabel,
          startedAt: threadCreatedAt || summary.startedAt,
          lastActiveAt,
          activeHint: index === 0 ? activeHint : false,
          cpu: index === 0 ? summary.cpu : null,
          frontmost: index === 0 ? summary.frontmost : false,
        };
      }),
      warnings: [],
    };
  } catch {
    return {
      sessions: [
        {
          id: "codex:desktop",
          provider: "Codex",
          source: "Codex デスクトップ",
          sourceType: "desktop",
          appName: "Codex",
          taskTitle: "Codex は起動しています",
          summary: "内部DBを読めなかったので、起動状態だけ表示しています。",
          workspace: null,
          url: null,
          statusKey: summary.frontmost ? "running" : "waiting",
          statusLabel: summary.frontmost ? "作業中" : "待機中",
          startedAt: summary.startedAt,
          lastActiveAt: summary.startedAt,
          activeHint: false,
          cpu: summary.cpu,
          frontmost: summary.frontmost,
        },
      ],
      warnings: ["Codex の詳細タスクは読み取れませんでした。"],
    };
  }
}
