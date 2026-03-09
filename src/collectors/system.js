import { runCommand, parseElapsedTime, parseJsonOutput } from "../utils.js";

function parseProcessLine(line) {
  const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
  if (!match) {
    return null;
  }

  const [, pid, cpu, elapsed, command] = match;
  return {
    pid: Number(pid),
    cpu: Number(cpu),
    elapsed,
    elapsedMs: parseElapsedTime(elapsed),
    command: command.trim(),
  };
}

function parseAppName(command) {
  if (command.includes("/Applications/Codex.app")) {
    return "Codex";
  }
  if (command.includes("/Applications/Claude.app")) {
    return "Claude";
  }
  if (command.includes("/Applications/Antigravity.app")) {
    return "Antigravity";
  }
  if (command.includes("/Applications/Google Chrome.app")) {
    return "Google Chrome";
  }
  if (command.includes("/Applications/Arc.app")) {
    return "Arc";
  }
  if (command.includes("/Applications/Safari.app")) {
    return "Safari";
  }
  if (/\bclaude\b/.test(command)) {
    return "claude";
  }
  return null;
}

function mergeAppStates(entries) {
  const map = new Map();

  for (const entry of entries) {
    if (!entry?.name) {
      continue;
    }

    const current = map.get(entry.name) || {
      name: entry.name,
      frontmost: false,
      visible: false,
    };

    current.frontmost = current.frontmost || Boolean(entry.frontmost);
    current.visible = current.visible || Boolean(entry.visible);
    map.set(entry.name, current);
  }

  return Object.fromEntries(map.entries());
}

export async function collectSystemState() {
  const processPromise = runCommand("ps", ["-axo", "pid=,pcpu=,etime=,command=", "-ww"], {
    timeout: 5000,
  });

  const appScript = [
    'const apps = Application("System Events").applicationProcesses.whose({backgroundOnly: false})();',
    "JSON.stringify(apps.map((app) => ({",
    "  name: app.name(),",
    "  frontmost: app.frontmost(),",
    "  visible: app.visible()",
    "})))",
  ].join("\n");

  const appPromise = runCommand("osascript", ["-l", "JavaScript", "-e", appScript], {
    timeout: 5000,
  });

  const [processResult, appResult] = await Promise.allSettled([processPromise, appPromise]);
  const warnings = [];

  const processes =
    processResult.status === "fulfilled"
      ? processResult.value.stdout
          .split(/\r?\n/)
          .map(parseProcessLine)
          .filter(Boolean)
      : [];

  if (processResult.status === "rejected") {
    warnings.push("プロセス一覧の取得に失敗しました。");
  }

  const appEntries =
    appResult.status === "fulfilled" ? parseJsonOutput(appResult.value.stdout, []) : [];

  if (appResult.status === "rejected") {
    warnings.push("前面アプリの判定に失敗しました。");
  }

  const appStates = mergeAppStates(appEntries);

  for (const process of processes) {
    process.appName = parseAppName(process.command);
    process.startedAt = process.elapsedMs ? Date.now() - process.elapsedMs : null;
  }

  return {
    collectedAt: Date.now(),
    warnings,
    processes,
    appStates,
  };
}

export function findProcesses(processes, matcher) {
  return processes.filter((process) => matcher.test(process.command));
}

export function summarizeProcesses(processes, appStates, appName) {
  const cpu = processes.reduce((sum, process) => sum + (process.cpu || 0), 0);
  const startedAtCandidates = processes
    .map((process) => process.startedAt)
    .filter((value) => typeof value === "number");

  const visible = Boolean(appStates[appName]?.visible);
  const frontmost = Boolean(appStates[appName]?.frontmost);

  return {
    cpu,
    visible,
    frontmost,
    startedAt: startedAtCandidates.length ? Math.min(...startedAtCandidates) : null,
    processCount: processes.length,
  };
}
