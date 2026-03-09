import { collectSystemState } from "./collectors/system.js";
import { collectBrowserSessions } from "./collectors/browser.js";
import { collectCodexSessions } from "./collectors/codex.js";
import { collectClaudeSessions } from "./collectors/claude.js";
import { collectAntigravitySessions } from "./collectors/antigravity.js";
import { toIsoOrNull } from "./utils.js";
import { updateStoreAndApplyEta } from "./store.js";

function sortSessions(sessions) {
  const order = {
    running: 0,
    viewing: 1,
    waiting: 2,
    idle: 3,
  };

  return [...sessions].sort((a, b) => {
    const stateDelta = (order[a.statusKey] ?? 9) - (order[b.statusKey] ?? 9);
    if (stateDelta !== 0) {
      return stateDelta;
    }

    if (a.frontmost !== b.frontmost) {
      return a.frontmost ? -1 : 1;
    }

    return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
  });
}

function summarize(sessions) {
  const providers = new Set(sessions.map((session) => session.provider));
  const browserCount = sessions.filter((session) => session.sourceType === "browser").length;
  const runningCount = sessions.filter((session) => session.statusKey === "running").length;
  const waitingCount = sessions.filter((session) => session.statusKey === "waiting").length;

  return {
    totalSessions: sessions.length,
    providerCount: providers.size,
    browserCount,
    runningCount,
    waitingCount,
  };
}

export async function collectSnapshot() {
  const systemState = await collectSystemState();
  const warnings = [...systemState.warnings];

  const results = await Promise.allSettled([
    collectBrowserSessions(systemState),
    collectCodexSessions(systemState),
    collectClaudeSessions(systemState),
    collectAntigravitySessions(systemState),
  ]);

  const sessions = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      sessions.push(...result.value.sessions);
      warnings.push(...result.value.warnings);
    } else {
      warnings.push("一部の情報源が取得できませんでした。");
    }
  }

  const enrichedSessions = await updateStoreAndApplyEta(sortSessions(sessions));
  const withIsoDates = enrichedSessions.map((session) => ({
    ...session,
    startedAtIso: toIsoOrNull(session.startedAt || session.detectedStartedAt),
    lastActiveAtIso: toIsoOrNull(session.lastActiveAt),
  }));

  return {
    generatedAt: new Date().toISOString(),
    summary: summarize(withIsoDates),
    warnings: [...new Set(warnings)].filter(Boolean),
    sessions: withIsoDates,
  };
}
