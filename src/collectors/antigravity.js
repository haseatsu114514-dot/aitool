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
  normalizeWhitespace,
} from "../utils.js";
import { findProcesses, summarizeProcesses } from "./system.js";

const ANTIGRAVITY_DIR = path.join(os.homedir(), "Library", "Application Support", "Antigravity");
const RUNNING_ACTIVITY_MS = 5 * 60 * 1000;
const ACTIVE_FILE_WINDOW_MS = 20 * 60 * 1000;
const STRONG_CPU_THRESHOLD = 12;
const SOFT_CPU_THRESHOLD = 2;
const BRAIN_ROOT_PATTERN = new RegExp(`^(.*\\${path.sep}\\.gemini\\${path.sep}antigravity\\${path.sep}brain\\${path.sep}[^/]+)`);
const UUID_SEGMENT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_ARTIFACT_NAME_PATTERN =
  /^(task|walkthrough|implementation_plan|scratchpad(?:_[a-z0-9]+)?|findings|notes?|plan|draft|preview|webview|pageview|view|artifact|output|result)$/i;

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

async function latestFileActivity(filePaths) {
  let latest = null;

  await Promise.all(
    [...new Set(filePaths.filter(Boolean))].map(async (filePath) => {
      try {
        const stat = await fs.stat(filePath);
        if (!latest || stat.mtimeMs > latest) {
          latest = stat.mtimeMs;
        }
      } catch {
        // ignore missing files
      }
    }),
  );

  return latest;
}

async function collectWorkspaceFiles(rootDir, depth = 0, maxDepth = 2) {
  if (!rootDir || depth > maxDepth) {
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      files.push(...await collectWorkspaceFiles(fullPath, depth + 1, maxDepth));
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

async function getWorkspaceRecentActivity(workspaceRoot, state) {
  const candidates = [
    ...findRealFiles(state),
    path.join(workspaceRoot || "", "task.md"),
    path.join(workspaceRoot || "", "implementation_plan.md"),
    path.join(workspaceRoot || "", "walkthrough.md"),
  ];

  if (workspaceRoot) {
    const workspaceFiles = await collectWorkspaceFiles(workspaceRoot, 0, 2);
    candidates.push(...workspaceFiles);
  }

  return latestFileActivity(candidates);
}

function cleanArtifactLine(line) {
  return normalizeWhitespace(
    String(line || "")
      .replace(/^#{1,6}\s+/u, "")
      .replace(/^- \[[ x/]\]\s+/iu, "")
      .replace(/\[(.*?)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/[>|]/g, " "),
  );
}

function firstSentence(text) {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) {
    return "";
  }

  const match = cleaned.match(/^(.{1,90}?[。.!?！？])(?:\s|$)/u);
  return normalizeWhitespace(match?.[1] || cleaned);
}

function isUsefulArtifactText(value) {
  const cleaned = cleanArtifactLine(value);
  if (!cleaned || cleaned.length < 3) {
    return false;
  }

  const basename = cleaned
    .replace(/\.(md|txt|json|yaml|yml)$/iu, "")
    .replace(/\.resolved(?:\.\d+)?$/iu, "");
  return !GENERIC_ARTIFACT_NAME_PATTERN.test(basename);
}

function isOpaqueWorkspaceSegment(value) {
  return !value || UUID_SEGMENT_PATTERN.test(value) || ["brain", "browser"].includes(String(value).toLowerCase());
}

function displayWorkspaceName(workspacePath) {
  const base = basenameOrNull(workspacePath);
  return isOpaqueWorkspaceSegment(base) ? null : base;
}

function findAntigravityBrainRoot(targetPath) {
  const normalized = String(targetPath || "");
  return normalized.match(BRAIN_ROOT_PATTERN)?.[1] || null;
}

async function readArtifactDescriptor(filePath) {
  if (!filePath) {
    return null;
  }

  const descriptor = {
    title: null,
    summary: null,
  };

  try {
    const rawMetadata = await fs.readFile(`${filePath}.metadata.json`, "utf8");
    const metadata = JSON.parse(rawMetadata);
    const summary = firstSentence(metadata?.summary || "");
    if (isUsefulArtifactText(summary)) {
      descriptor.summary = truncate(summary, 120);
      descriptor.title = truncate(summary, 90);
    }
  } catch {
    // ignore missing sidecar metadata
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).map((line) => line.trim());
    const headingLine = lines.find((line) => /^#{1,6}\s+\S/u.test(line));
    const checklistLine = lines.find((line) => /^- \[[ x/]\]\s+\S/iu.test(line));
    const firstLine = lines.find((line) => {
      const cleaned = cleanArtifactLine(line);
      return cleaned && cleaned !== "---" && !/^[-|: ]+$/u.test(cleaned);
    });

    const heading = cleanArtifactLine(headingLine || checklistLine || firstLine || "");
    if (isUsefulArtifactText(heading)) {
      descriptor.title = truncate(heading, 90);
    }
  } catch {
    // ignore unreadable artifact body
  }

  const fallbackBase = basenameOrNull(filePath)
    ?.replace(/\.resolved(?:\.\d+)?$/iu, "")
    ?.replace(/\.(md|txt|json|yaml|yml)$/iu, "");
  if (!descriptor.title && isUsefulArtifactText(fallbackBase)) {
    descriptor.title = truncate(cleanArtifactLine(fallbackBase), 90);
  }

  return descriptor.title || descriptor.summary ? descriptor : null;
}

async function loadWorkspaceTaskDescriptor(workspaceRoot) {
  if (!workspaceRoot) {
    return null;
  }

  const preferredFiles = [
    path.join(workspaceRoot, "task.md"),
    path.join(workspaceRoot, "implementation_plan.md"),
    path.join(workspaceRoot, "walkthrough.md"),
  ];

  for (const candidate of preferredFiles) {
    const descriptor = await readArtifactDescriptor(candidate);
    if (descriptor?.title || descriptor?.summary) {
      return descriptor;
    }
  }

  try {
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    const metadataCandidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".metadata.json"))
      .map((entry) => path.join(workspaceRoot, entry.name));

    const summaries = await Promise.all(
      metadataCandidates.map(async (filePath) => {
        try {
          const raw = await fs.readFile(filePath, "utf8");
          const metadata = JSON.parse(raw);
          return {
            updatedAt: Date.parse(metadata?.updatedAt || "") || 0,
            summary: firstSentence(metadata?.summary || ""),
          };
        } catch {
          return null;
        }
      }),
    );

    const best = summaries
      .filter((entry) => entry?.summary && isUsefulArtifactText(entry.summary))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (best) {
      return {
        title: best.summary.length <= 48 ? truncate(best.summary, 90) : null,
        summary: truncate(best.summary, 120),
      };
    }
  } catch {
    // ignore workspace fallback failures
  }

  return null;
}

async function buildTaskContext(workspacePath, state) {
  const realFile = findPrimaryFile(state);
  const workspaceRoot = findAntigravityBrainRoot(realFile || workspacePath) || workspacePath;
  const fileDescriptor = await readArtifactDescriptor(realFile);
  const workspaceDescriptor = await loadWorkspaceTaskDescriptor(workspaceRoot);
  const preferWorkspaceTitle =
    realFile &&
    GENERIC_ARTIFACT_NAME_PATTERN.test(
      String(basenameOrNull(realFile) || "")
        .replace(/\.resolved(?:\.\d+)?$/iu, "")
        .replace(/\.(md|txt|json|yaml|yml)$/iu, ""),
    );

  const taskTitle =
    (preferWorkspaceTitle ? workspaceDescriptor?.title : fileDescriptor?.title) ||
    workspaceDescriptor?.title ||
    fileDescriptor?.title ||
    (realFile ? `編集中: ${basenameOrNull(realFile)}` : null) ||
    (displayWorkspaceName(workspacePath) ? `${displayWorkspaceName(workspacePath)} の作業` : null) ||
    (state.activePanel?.includes("agent") ? "エージェント作業" : null) ||
    "Antigravity の作業";

  return {
    taskTitle,
    summary: buildSummary(workspacePath, state, {
      realFile,
      workspaceRoot,
      fileDescriptor,
      workspaceDescriptor,
    }),
    workspace: workspaceRoot || (realFile ? path.dirname(realFile) : workspacePath),
    primaryFile: realFile,
  };
}

function buildSummary(workspacePath, state, context = {}) {
  const parts = [];
  const realFile = context.realFile || findPrimaryFile(state);
  const workspaceDescriptor = context.workspaceDescriptor || null;
  const fileDescriptor = context.fileDescriptor || null;
  const fileCount = findRealFiles(state).length;
  const workspaceName = displayWorkspaceName(context.workspaceRoot || workspacePath);
  const workspaceTask = workspaceDescriptor?.title || null;
  const currentArtifact = fileDescriptor?.title || null;

  if (workspaceTask) {
    parts.push(`${workspaceTask} の作業です。`);
  } else if (workspaceName) {
    parts.push(`${workspaceName} の作業です。`);
  }

  if (realFile) {
    const artifactLabel = currentArtifact || basenameOrNull(realFile);
    if (artifactLabel && artifactLabel !== workspaceTask) {
      parts.push(`${artifactLabel} を開いています。`);
    }
    if (fileCount > 1) {
      parts.push(`ほかに ${fileCount - 1} 件のファイルも開いています。`);
    }
  }

  const detailSummary = [fileDescriptor?.summary, workspaceDescriptor?.summary].find((value) => {
    const cleaned = normalizeWhitespace(value);
    if (!cleaned || cleaned.length > 88) {
      return false;
    }

    if (workspaceTask && cleaned.startsWith(workspaceTask)) {
      return false;
    }

    if (currentArtifact && cleaned.startsWith(currentArtifact)) {
      return false;
    }

    return true;
  });
  if (detailSummary && !parts.some((part) => part.includes(detailSummary))) {
    parts.push(detailSummary);
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

  const taskContext = await buildTaskContext(workspacePath, workspaceState);
  const workspaceRecentActivity = await getWorkspaceRecentActivity(taskContext.workspace, workspaceState);
  const lastLogActivity = await getLatestLogActivity();
  const latestActivity = Math.max(
    0,
    lastLogActivity || 0,
    workspaceRecentActivity || 0,
  ) || null;
  const now = Date.now();
  const recentLogActivity = latestActivity && now - latestActivity < RUNNING_ACTIVITY_MS;
  const recentFileActivity = workspaceRecentActivity && now - workspaceRecentActivity < ACTIVE_FILE_WINDOW_MS;
  const cpuActive = summary.cpu >= STRONG_CPU_THRESHOLD;
  const warmFrontmost = summary.frontmost && (recentLogActivity || recentFileActivity || summary.cpu >= SOFT_CPU_THRESHOLD);
  const backgroundContinuing = (recentLogActivity || recentFileActivity) && summary.cpu >= SOFT_CPU_THRESHOLD;
  const warmCpu = summary.cpu >= SOFT_CPU_THRESHOLD && (recentLogActivity || recentFileActivity || summary.frontmost);
  const runningState = cpuActive || warmFrontmost || backgroundContinuing || warmCpu;
  const lastActiveAt =
    summary.frontmost || summary.cpu >= SOFT_CPU_THRESHOLD
      ? now
      : latestActivity || summary.startedAt;

  return {
    sessions: [
      {
        id: "antigravity:desktop",
        provider: "Antigravity",
        source: "Antigravity デスクトップ",
        sourceType: "desktop",
        appName: "Antigravity",
        taskTitle: taskContext.taskTitle,
        summary: taskContext.summary,
        workspace: taskContext.workspace,
        url: null,
        statusKey: runningState ? "running" : "waiting",
        statusLabel: runningState ? "作業中" : "待機中",
        startedAt: summary.startedAt,
        lastActiveAt,
        activeHint: Boolean(recentLogActivity || recentFileActivity || summary.frontmost),
        cpu: summary.cpu,
        frontmost: summary.frontmost,
      },
    ],
    warnings,
  };
}
