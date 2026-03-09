import os from "node:os";
import path from "node:path";
import { runCommand, parseJsonOutput, firstMeaningfulLine, truncate, normalizeWhitespace } from "../utils.js";
import { findProcesses, summarizeProcesses } from "./system.js";

const CODEX_DB = path.join(os.homedir(), ".codex", "state_5.sqlite");
const VERY_RECENT_THREAD_MS = 5 * 60 * 1000;
const RECENT_THREAD_MS = 20 * 60 * 1000;
const RUNNING_ACTIVITY_MS = 90 * 1000;
const STRONG_CPU_THRESHOLD = 18;
const SOFT_CPU_THRESHOLD = 2;
const MIN_PROGRESS_GAP_MS = 20 * 1000;

function hasRecentProgress(threadUpdatedAt, threadCreatedAt, now) {
  if (!threadUpdatedAt) {
    return false;
  }

  if (threadCreatedAt && threadUpdatedAt - threadCreatedAt <= MIN_PROGRESS_GAP_MS) {
    return false;
  }

  return now - threadUpdatedAt < RUNNING_ACTIVITY_MS;
}

function buildState(now, threadUpdatedAt, threadCreatedAt, summary) {
  const activeRecently = hasRecentProgress(threadUpdatedAt, threadCreatedAt, now);
  const cpuActive = summary.cpu >= STRONG_CPU_THRESHOLD;
  const warmFrontmost = summary.frontmost && (activeRecently || summary.cpu >= SOFT_CPU_THRESHOLD);
  const backgroundContinuing = activeRecently && summary.cpu >= SOFT_CPU_THRESHOLD;
  const running = cpuActive || warmFrontmost || backgroundContinuing;

  return running
    ? { statusKey: "running", statusLabel: "作業中" }
    : { statusKey: "waiting", statusLabel: "待機中" };
}

function pickRelevantThreads(threads) {
  if (!threads.length) {
    return [];
  }

  const nowMs = Date.now();
  const veryRecentThreads = threads.filter((thread) => {
    const updatedAtMs = ((thread.updated_at || thread.created_at || 0) * 1000);
    return nowMs - updatedAtMs < VERY_RECENT_THREAD_MS;
  });

  if (veryRecentThreads.length) {
    return veryRecentThreads.slice(0, 6);
  }

  const recentThreads = threads.filter((thread) => {
    const updatedAtMs = ((thread.updated_at || thread.created_at || 0) * 1000);
    return nowMs - updatedAtMs < RECENT_THREAD_MS;
  });

  if (recentThreads.length) {
    return recentThreads.slice(0, 2);
  }

  return threads.slice(0, 1);
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
    const query = [
      "select id, title, cwd, created_at, updated_at",
      "from threads",
      "where archived = 0",
      "order by updated_at desc",
      "limit 8;",
    ].join(" ");

    const { stdout } = await runCommand("sqlite3", ["-json", CODEX_DB, query], {
      timeout: 4000,
    });
    const threads = parseJsonOutput(stdout, []);
    const relevantThreads = pickRelevantThreads(threads);
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
        const state =
          index === 0
            ? buildState(Date.now(), threadUpdatedAt, threadCreatedAt, summary)
            : {
                statusKey:
                  hasRecentProgress(threadUpdatedAt, threadCreatedAt, Date.now()) ? "running" : "waiting",
                statusLabel:
                  hasRecentProgress(threadUpdatedAt, threadCreatedAt, Date.now()) ? "作業中" : "待機中",
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
          lastActiveAt: threadUpdatedAt,
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
          cpu: summary.cpu,
          frontmost: summary.frontmost,
        },
      ],
      warnings: ["Codex の詳細タスクは読み取れませんでした。"],
    };
  }
}
