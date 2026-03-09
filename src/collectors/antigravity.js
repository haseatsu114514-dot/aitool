import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runCommand,
  parseJsonOutput,
  extractFileUris,
  truncate,
  basenameOrNull,
  safeDecodeUri,
} from "../utils.js";
import { findProcesses, summarizeProcesses } from "./system.js";

const ANTIGRAVITY_DIR = path.join(os.homedir(), "Library", "Application Support", "Antigravity");

function extractWorkspaceIds(lsofOutput) {
  const matches = [...String(lsofOutput).matchAll(/workspaceStorage\/([^/]+)\/state\.vscdb/g)];
  return [...new Set(matches.map((match) => match[1]))];
}

async function loadWorkspacePath(workspaceId) {
  const workspaceFile = path.join(
    ANTIGRAVITY_DIR,
    "User",
    "workspaceStorage",
    workspaceId,
    "workspace.json",
  );

  try {
    const raw = await fs.readFile(workspaceFile, "utf8");
    const parsed = JSON.parse(raw);
    return safeDecodeUri(parsed.folder || parsed.workspace || null);
  } catch {
    return null;
  }
}

async function loadRecentWorkspaceFallback() {
  const dbPath = path.join(ANTIGRAVITY_DIR, "User", "globalStorage", "state.vscdb");
  const query = "select value from ItemTable where key = 'history.recentlyOpenedPathsList';";

  try {
    const { stdout } = await runCommand("sqlite3", ["-json", dbPath, query], { timeout: 4000 });
    const rows = parseJsonOutput(stdout, []);
    const rawValue = rows[0]?.value;
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue);
    const entry = parsed.entries?.find((item) => item.folderUri || item.workspace?.configPath);
    return safeDecodeUri(entry?.folderUri || entry?.workspace?.configPath || null);
  } catch {
    return null;
  }
}

async function loadWorkspaceState(workspaceId) {
  const dbPath = path.join(ANTIGRAVITY_DIR, "User", "workspaceStorage", workspaceId, "state.vscdb");
  const query = [
    "select key, value from ItemTable",
    "where key in (",
    "'memento/workbench.parts.editor',",
    "'memento/antigravity.jetskiArtifactsEditor',",
    "'output.activechannel',",
    "'terminal.integrated.layoutInfo',",
    "'workbench.auxiliarybar.activepanelid'",
    ");",
  ].join(" ");

  try {
    const { stdout } = await runCommand("sqlite3", ["-json", dbPath, query], { timeout: 4000 });
    const rows = parseJsonOutput(stdout, []);
    const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      openFiles: [
        ...extractFileUris(map["memento/workbench.parts.editor"]),
        ...extractFileUris(map["memento/antigravity.jetskiArtifactsEditor"]),
      ],
      activeChannel: map["output.activechannel"] || null,
      activePanel: map["workbench.auxiliarybar.activepanelid"] || null,
      terminalState: map["terminal.integrated.layoutInfo"] || null,
    };
  } catch {
    return {
      openFiles: [],
      activeChannel: null,
      activePanel: null,
      terminalState: null,
    };
  }
}

async function getLatestLogActivity() {
  const logsRoot = path.join(ANTIGRAVITY_DIR, "logs");
  try {
    const directories = await fs.readdir(logsRoot);
    const latest = directories.sort().at(-1);
    if (!latest) {
      return null;
    }

    const rendererLog = path.join(logsRoot, latest, "window1", "renderer.log");
    const stat = await fs.stat(rendererLog);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

function buildTaskTitle(workspacePath, state) {
  const realFile = findPrimaryFile(state);

  if (realFile) {
    return `編集中: ${basenameOrNull(realFile)}`;
  }

  if (workspacePath) {
    return `${basenameOrNull(workspacePath)} の作業`;
  }

  if (state.activePanel?.includes("agent")) {
    return "エージェント作業";
  }

  return "Antigravity の作業";
}

function buildSummary(workspacePath, state, taskFile = null) {
  const parts = [];
  const realFile = taskFile || findPrimaryFile(state);
  const fileCount = findRealFiles(state).length;

  if (workspacePath) {
    parts.push(`${basenameOrNull(workspacePath)} の作業です。`);
  }

  if (realFile) {
    parts.push(`${basenameOrNull(realFile)} を扱っています。`);
    if (fileCount > 1) {
      parts.push(`ほかに ${fileCount - 1} 件のファイルも開いています。`);
    }
  }

  if (state.activeChannel) {
    parts.push(`${state.activeChannel} パネルを開いています。`);
  }

  if (!parts.length && state.activePanel?.includes("agent")) {
    parts.push("エージェントパネルを開いています。");
  }

  return truncate(parts.join(" "), 120) || "Antigravity の最新状態です。";
}

function findPrimaryFile(state) {
  return state.openFiles.find(
    (filePath) =>
      filePath &&
      !filePath.includes("/Applications/Antigravity.app") &&
      !filePath.includes("/Library/Application Support/Antigravity"),
  );
}

function findRealFiles(state) {
  return [...new Set(state.openFiles.filter(
    (filePath) =>
      filePath &&
      !filePath.includes("/Applications/Antigravity.app") &&
      !filePath.includes("/Library/Application Support/Antigravity"),
  ))];
}

export async function collectAntigravitySessions(systemState) {
  const processes = findProcesses(
    systemState.processes,
    /\/Applications\/Antigravity\.app\/Contents\/MacOS\/Electron\b|Antigravity Helper/i,
  );
  const summary = summarizeProcesses(processes, systemState.appStates, "Antigravity");
  const running = summary.processCount > 0 || summary.visible;

  if (!running) {
    return { sessions: [], warnings: [] };
  }

  const warnings = [];
  let workspacePath = null;
  let workspaceState = {
    openFiles: [],
    activeChannel: null,
    activePanel: null,
    terminalState: null,
  };

  try {
    const mainProcess = processes.find((process) =>
      /\/Applications\/Antigravity\.app\/Contents\/MacOS\/Electron\b/i.test(process.command),
    );

    if (mainProcess) {
      const { stdout } = await runCommand("lsof", ["-Pan", "-p", String(mainProcess.pid)], {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const workspaceIds = extractWorkspaceIds(stdout);
      const currentWorkspaceId = workspaceIds[0];

      if (currentWorkspaceId) {
        workspacePath = await loadWorkspacePath(currentWorkspaceId);
        workspaceState = await loadWorkspaceState(currentWorkspaceId);
      }
    }
  } catch {
    warnings.push("Antigravity のワークスペース取得に失敗しました。");
  }

  if (!workspacePath) {
    workspacePath = await loadRecentWorkspaceFallback();
  }

  const lastLogActivity = await getLatestLogActivity();
  const runningState =
    summary.frontmost || summary.cpu >= 8 || (lastLogActivity && Date.now() - lastLogActivity < 15 * 60 * 1000);

  const primaryFile = findPrimaryFile(workspaceState);
  const displayWorkspace = primaryFile ? path.dirname(primaryFile) : workspacePath;

  return {
    sessions: [
      {
        id: "antigravity:desktop",
        provider: "Antigravity",
        source: "Antigravity デスクトップ",
        sourceType: "desktop",
        appName: "Antigravity",
        taskTitle: primaryFile ? `編集中: ${basenameOrNull(primaryFile)}` : buildTaskTitle(workspacePath, workspaceState),
        summary: buildSummary(displayWorkspace, workspaceState, primaryFile),
        workspace: displayWorkspace,
        url: null,
        statusKey: runningState ? "running" : "waiting",
        statusLabel: runningState ? "作業中" : "待機中",
        startedAt: summary.startedAt,
        lastActiveAt: lastLogActivity || summary.startedAt,
        cpu: summary.cpu,
        frontmost: summary.frontmost,
      },
    ],
    warnings,
  };
}
