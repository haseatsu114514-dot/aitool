import path from "node:path";
import { formatDurationJapanese, median, readJson, slugifyTask, writeJson } from "./utils.js";

const MAX_HISTORY_PER_KEY = 12;

function resolveStoreFile() {
  if (process.env.AI_WORKBOARD_DATA_DIR) {
    return path.join(process.env.AI_WORKBOARD_DATA_DIR, "session-store.json");
  }

  return path.join(process.cwd(), "data", "session-store.json");
}

export async function loadStore() {
  const store = await readJson(resolveStoreFile(), null);
  return (
    store || {
      active: {},
      history: {},
      updatedAt: null,
    }
  );
}

function buildFingerprint(session) {
  const workspaceToken = session.workspace ? path.basename(session.workspace) : "no-workspace";
  return `${session.provider}|${slugifyTask(session.taskTitle)}|${workspaceToken}`;
}

function providerFingerprint(session) {
  return `${session.provider}|default`;
}

function pushHistory(history, key, durationMs) {
  if (!durationMs || durationMs < 30 * 1000 || durationMs > 12 * 60 * 60 * 1000) {
    return;
  }

  history[key] = history[key] || [];
  history[key].push(durationMs);
  if (history[key].length > MAX_HISTORY_PER_KEY) {
    history[key] = history[key].slice(-MAX_HISTORY_PER_KEY);
  }
}

export async function updateStoreAndApplyEta(sessions) {
  const now = Date.now();
  const store = await loadStore();
  const nextActive = {};
  const currentIds = new Set(sessions.map((session) => session.id));

  for (const session of sessions) {
    const previous = store.active[session.id];
    const startedAt = previous?.startedAt || session.startedAt || now;
    const fingerprint = buildFingerprint(session);

    nextActive[session.id] = {
      startedAt,
      fingerprint,
      statusKey: session.statusKey,
      lastSeenAt: now,
      providerKey: providerFingerprint(session),
    };

    session.detectedStartedAt = startedAt;
    session.fingerprint = fingerprint;
  }

  for (const [sessionId, snapshot] of Object.entries(store.active)) {
    if (currentIds.has(sessionId)) {
      continue;
    }

    const durationMs = now - snapshot.startedAt;
    pushHistory(store.history, snapshot.fingerprint, durationMs);
    pushHistory(store.history, snapshot.providerKey, durationMs);
  }

  for (const session of sessions) {
    if (session.statusKey !== "running") {
      session.eta = {
        label: session.statusKey === "waiting" ? "入力待ちかもしれません" : "未定",
        confidence: "low",
      };
      continue;
    }

    const elapsedMs = now - session.detectedStartedAt;
    const exactHistory = store.history[session.fingerprint] || [];
    const providerHistory = store.history[providerFingerprint(session)] || [];

    let estimateMs = median(exactHistory);
    let confidence = "high";

    if (!estimateMs) {
      estimateMs = median(providerHistory);
      confidence = "medium";
    }

    if (!estimateMs) {
      const defaults = {
        Codex: 12 * 60 * 1000,
        Claude: 10 * 60 * 1000,
        Antigravity: 14 * 60 * 1000,
        ChatGPT: 6 * 60 * 1000,
        Gemini: 6 * 60 * 1000,
      };
      estimateMs = defaults[session.provider] || 8 * 60 * 1000;
      confidence = "low";
    }

    const remainingMs = estimateMs - elapsedMs;
    if (remainingMs <= 0) {
      session.eta = {
        label: "終盤か、少し長引いています",
        confidence,
      };
      continue;
    }

    session.eta = {
      label: `あと${formatDurationJapanese(remainingMs)}前後`,
      confidence,
    };
  }

  store.active = nextActive;
  store.updatedAt = now;
  await writeJson(resolveStoreFile(), store);
  return sessions;
}
