import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listFilesRecursive,
  readJson,
  truncate,
  normalizeWhitespace,
} from "../utils.js";
import { findProcesses, summarizeProcesses } from "./system.js";

const CLAUDE_APP_DIR = path.join(os.homedir(), "Library", "Application Support", "Claude");
const RUNNING_ACTIVITY_MS = 90 * 1000;
const FRONTMOST_THINKING_MS = 6 * 60 * 1000;
const STRONG_CPU_THRESHOLD = 10;
const SOFT_CPU_THRESHOLD = 1.5;
const ACTIVE_STATUS_PATTERN =
  /コンテキストを自動的に圧縮しています|コンテキスト.*圧縮中|圧縮しています|圧縮中|思考中|試行中|考え中|推論中|処理中|分析中|thinking|reasoning|processing|compressing|compacting|summarizing context|summarising context|trying/i;

async function loadLatestSession(rootDir, fileMatcher) {
  const files = await listFilesRecursive(rootDir, (fullPath) => fileMatcher.test(path.basename(fullPath)), 5);
  const sessions = [];

  await Promise.all(
    files.map(async (filePath) => {
      try {
        const stat = await fs.stat(filePath);
        const data = await readJson(filePath);
        if (data && typeof data === "object") {
          sessions.push({
            filePath,
            mtimeMs: stat.mtimeMs,
            data,
          });
        }
      } catch {
        // ignore unreadable session files
      }
    }),
  );

  sessions.sort((a, b) => {
    const aActivity = a.data.lastActivityAt || a.data.createdAt || a.mtimeMs;
    const bActivity = b.data.lastActivityAt || b.data.createdAt || b.mtimeMs;
    return bActivity - aActivity;
  });

  return sessions[0] || null;
}

async function loadRecentSessions(rootDir, fileMatcher, maxSessions = 4) {
  const files = await listFilesRecursive(rootDir, (fullPath) => fileMatcher.test(path.basename(fullPath)), 5);
  const sessions = [];

  await Promise.all(
    files.map(async (filePath) => {
      try {
        const stat = await fs.stat(filePath);
        const data = await readJson(filePath);
        if (data && typeof data === "object" && !data.isArchived) {
          sessions.push({
            filePath,
            mtimeMs: stat.mtimeMs,
            data,
          });
        }
      } catch {
        // ignore unreadable session files
      }
    }),
  );

  sessions.sort((a, b) => {
    const aActivity = a.data.lastActivityAt || a.data.createdAt || a.mtimeMs;
    const bActivity = b.data.lastActivityAt || b.data.createdAt || b.mtimeMs;
    return bActivity - aActivity;
  });

  const now = Date.now();
  const recentSessions = sessions.filter((session) => {
    const activityAt = session.data.lastActivityAt || session.data.createdAt || 0;
    return now - activityAt < 2 * 60 * 60 * 1000;
  });

  return (recentSessions.length ? recentSessions : sessions).slice(0, maxSessions);
}

function hasActiveLanguage(...values) {
  return ACTIVE_STATUS_PATTERN.test(values.filter(Boolean).join(" "));
}

function buildStatus(now, lastActivityAt, summary, activeText = "") {
  const activeRecently = lastActivityAt && now - lastActivityAt < RUNNING_ACTIVITY_MS;
  const activeHint = hasActiveLanguage(activeText);
  const frontmostThinking = summary.frontmost && lastActivityAt && now - lastActivityAt < FRONTMOST_THINKING_MS;
  const cpuActive = summary.cpu >= STRONG_CPU_THRESHOLD;
  const warmFrontmost = summary.frontmost && (frontmostThinking || summary.cpu >= SOFT_CPU_THRESHOLD || activeHint);
  const backgroundContinuing = (activeRecently || activeHint) && summary.cpu >= SOFT_CPU_THRESHOLD;
  const hintedRunning = activeHint && summary.processCount > 0;
  const running = cpuActive || warmFrontmost || backgroundContinuing || hintedRunning;
  return running
    ? { statusKey: "running", statusLabel: "作業中" }
    : { statusKey: "waiting", statusLabel: "待機中" };
}

function buildSession({ id, source, sessionData, processSummary, visibleApp, isPrimary }) {
  const recentActivityAt = sessionData.lastActivityAt || null;
  const lastActivityAt = recentActivityAt || sessionData.createdAt || processSummary.startedAt;
  const title = truncate(sessionData.title || "Claude のセッション", 90);
  const summaryParts = [];

  if (sessionData.userSelectedFolders?.[0]) {
    summaryParts.push(`${path.basename(sessionData.userSelectedFolders[0])} を対象にしています。`);
  } else if (sessionData.originCwd) {
    summaryParts.push(`${path.basename(sessionData.originCwd)} を対象にしています。`);
  } else if (sessionData.cwd) {
    summaryParts.push(`${path.basename(sessionData.cwd)} を対象にしています。`);
  }

  if (sessionData.initialMessage) {
    summaryParts.push(truncate(normalizeWhitespace(sessionData.initialMessage), 70));
  }

  const activeText = [
    sessionData.title,
    sessionData.initialMessage,
    sessionData.status,
    sessionData.lastStatus,
    sessionData.activity,
  ]
    .filter(Boolean)
    .join(" ");

  const status =
    isPrimary || hasActiveLanguage(activeText) || (recentActivityAt && Date.now() - recentActivityAt < RUNNING_ACTIVITY_MS)
      ? buildStatus(Date.now(), recentActivityAt, processSummary, activeText)
      : { statusKey: "waiting", statusLabel: "待機中" };

  return {
    id,
    provider: "Claude",
    source,
    sourceType: source.includes("Code") ? "cli" : "desktop",
    appName: visibleApp,
    taskTitle: title,
    summary: truncate(summaryParts.join(" "), 120) || "Claude の最新セッションです。",
    workspace:
      sessionData.originCwd ||
      sessionData.worktreePath ||
      sessionData.userSelectedFolders?.[0] ||
      sessionData.cwd ||
      null,
    url: null,
    statusKey: status.statusKey,
    statusLabel: status.statusLabel,
    startedAt: sessionData.createdAt || processSummary.startedAt || null,
    lastActiveAt: lastActivityAt,
    cpu: processSummary.cpu || null,
    frontmost: processSummary.frontmost,
  };
}

export async function collectClaudeSessions(systemState) {
  const sessions = [];
  const warnings = [];

  const desktopProcesses = findProcesses(
    systemState.processes,
    /\/Applications\/Claude\.app\/Contents\/MacOS\/Claude\b|Claude Helper/i,
  );
  const cliProcesses = findProcesses(systemState.processes, /(^|\s)claude(\s|$)/i);

  const desktopSummary = summarizeProcesses(desktopProcesses, systemState.appStates, "Claude");
  const cliSummary = summarizeProcesses(cliProcesses, systemState.appStates, "claude");

  const desktopRunning = desktopSummary.processCount > 0 || desktopSummary.visible || systemState.appStates.Claude?.visible;
  const cliRunning = cliSummary.processCount > 0;

  if (!desktopRunning && !cliRunning) {
    return { sessions, warnings };
  }

  if (desktopRunning) {
    try {
      const desktopSessions = await loadRecentSessions(
        path.join(CLAUDE_APP_DIR, "local-agent-mode-sessions"),
        /^local_.*\.json$/,
      );

      if (desktopSessions.length) {
        sessions.push(
          ...desktopSessions.map((session, index) =>
            buildSession({
              id: `claude:desktop:${session.data.sessionId || `latest-${index}`}`,
              source: "Claude デスクトップ",
              sessionData: session.data,
              processSummary: {
                ...desktopSummary,
                frontmost: index === 0 ? Boolean(systemState.appStates.Claude?.frontmost) : false,
                cpu: index === 0 ? desktopSummary.cpu : 0,
              },
              visibleApp: "Claude",
              isPrimary: index === 0,
            }),
          ),
        );
      } else {
        sessions.push({
          id: "claude:desktop",
          provider: "Claude",
          source: "Claude デスクトップ",
          sourceType: "desktop",
          appName: "Claude",
          taskTitle: "Claude は起動しています",
          summary: "セッション情報は見つかりませんでした。",
          workspace: null,
          url: null,
          statusKey: desktopSummary.cpu >= STRONG_CPU_THRESHOLD ? "running" : "waiting",
          statusLabel: desktopSummary.cpu >= STRONG_CPU_THRESHOLD ? "作業中" : "待機中",
          startedAt: desktopSummary.startedAt,
          lastActiveAt: desktopSummary.startedAt,
          cpu: desktopSummary.cpu,
          frontmost: desktopSummary.frontmost,
        });
      }
    } catch (error) {
      warnings.push(
        `Claude デスクトップの詳細は読み取れませんでした。${error instanceof Error ? ` (${error.message})` : ""}`,
      );
    }
  }

  if (cliRunning) {
    try {
      const codeSessions = await loadRecentSessions(
        path.join(CLAUDE_APP_DIR, "claude-code-sessions"),
        /^local_.*\.json$/,
      );

      if (codeSessions.length) {
        sessions.push(
          ...codeSessions.map((session, index) =>
            buildSession({
              id: `claude:code:${session.data.sessionId || `latest-${index}`}`,
              source: "Claude Code",
              sessionData: session.data,
              processSummary: {
                ...cliSummary,
                cpu: index === 0 ? cliSummary.cpu : 0,
              },
              visibleApp: "claude",
              isPrimary: index === 0,
            }),
          ),
        );
      } else {
        sessions.push({
          id: "claude:code",
          provider: "Claude",
          source: "Claude Code",
          sourceType: "cli",
          appName: "claude",
          taskTitle: "Claude Code が動作中です",
          summary: "CLI セッションの詳細は見つかりませんでした。",
          workspace: null,
          url: null,
          statusKey: cliSummary.cpu >= STRONG_CPU_THRESHOLD ? "running" : "waiting",
          statusLabel: cliSummary.cpu >= STRONG_CPU_THRESHOLD ? "作業中" : "待機中",
          startedAt: cliSummary.startedAt,
          lastActiveAt: cliSummary.startedAt,
          cpu: cliSummary.cpu,
          frontmost: false,
        });
      }
    } catch (error) {
      warnings.push(
        `Claude Code の詳細は読み取れませんでした。${error instanceof Error ? ` (${error.message})` : ""}`,
      );
    }
  }

  return { sessions, warnings };
}
