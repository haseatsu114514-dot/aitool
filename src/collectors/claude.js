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

function buildStatus(now, lastActivityAt, summary) {
  const running = summary.frontmost || summary.cpu >= 5 || (lastActivityAt && now - lastActivityAt < 15 * 60 * 1000);
  return running
    ? { statusKey: "running", statusLabel: "作業中" }
    : { statusKey: "waiting", statusLabel: "待機中" };
}

function buildSession({ id, source, sessionData, processSummary, visibleApp, isPrimary }) {
  const lastActivityAt = sessionData.lastActivityAt || sessionData.createdAt || processSummary.startedAt;
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

  const status =
    isPrimary || (lastActivityAt && Date.now() - lastActivityAt < 15 * 60 * 1000)
      ? buildStatus(Date.now(), lastActivityAt, processSummary)
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
          statusKey: desktopSummary.frontmost ? "running" : "waiting",
          statusLabel: desktopSummary.frontmost ? "作業中" : "待機中",
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
          statusKey: cliSummary.cpu >= 5 ? "running" : "waiting",
          statusLabel: cliSummary.cpu >= 5 ? "作業中" : "待機中",
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
