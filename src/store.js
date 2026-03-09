import path from "node:path";
import { formatDurationJapanese, median, readJson, slugifyTask, writeJson } from "./utils.js";

const MAX_HISTORY_PER_KEY = 12;
const MAX_EVENTS_PER_KEY = 18;
const STALE_MS = 30 * 60 * 1000;

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
      events: {},
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

function staleForSession(session, now) {
  if (session.statusKey === "running") {
    return false;
  }

  const activityAt = session.lastActiveAt || session.startedAt || session.detectedStartedAt || now;
  return now - activityAt >= STALE_MS;
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

function pushEvent(events, key, event) {
  if (!key) {
    return;
  }

  events[key] = events[key] || [];
  const items = events[key];
  const previous = items.at(-1);

  if (previous?.type === event.type) {
    const previousMs = new Date(previous.at).getTime();
    if (!Number.isNaN(previousMs) && Math.abs(event.at - previousMs) < 45 * 1000) {
      return;
    }
  }

  items.push({
    type: event.type,
    at: new Date(event.at).toISOString(),
    statusKey: event.statusKey || null,
    sourceType: event.sourceType || null,
  });

  if (items.length > MAX_EVENTS_PER_KEY) {
    events[key] = items.slice(-MAX_EVENTS_PER_KEY);
  }
}

function statusEventType(session) {
  if (session.statusKey === "running") {
    return "running";
  }

  if (session.statusKey === "waiting") {
    return "waiting";
  }

  if (session.statusKey === "idle") {
    return "idle";
  }

  return "seen";
}

export async function updateStoreAndApplyEta(sessions) {
  const now = Date.now();
  const store = await loadStore();
  store.active = store.active || {};
  store.history = store.history || {};
  store.events = store.events || {};
  const nextActive = {};
  const currentIds = new Set(sessions.map((session) => session.id));

  for (const session of sessions) {
    const previous = store.active[session.id];
    const startedAt = previous?.startedAt || session.startedAt || now;
    const fingerprint = buildFingerprint(session);
    const stale = staleForSession(session, now);

    nextActive[session.id] = {
      startedAt,
      fingerprint,
      statusKey: session.statusKey,
      lastSeenAt: now,
      providerKey: providerFingerprint(session),
      stale,
      sourceType: session.sourceType || null,
    };

    session.detectedStartedAt = startedAt;
    session.fingerprint = fingerprint;

    if (!previous || previous.fingerprint !== fingerprint) {
      pushEvent(store.events, fingerprint, {
        type: "started",
        at: now,
        statusKey: session.statusKey,
        sourceType: session.sourceType,
      });

      if (session.statusKey !== "running") {
        pushEvent(store.events, fingerprint, {
          type: statusEventType(session),
          at: now,
          statusKey: session.statusKey,
          sourceType: session.sourceType,
        });
      }
    } else {
      if (previous.statusKey !== session.statusKey) {
        pushEvent(store.events, fingerprint, {
          type: statusEventType(session),
          at: now,
          statusKey: session.statusKey,
          sourceType: session.sourceType,
        });
      }

      if (stale && !previous.stale) {
        pushEvent(store.events, fingerprint, {
          type: "stale",
          at: now,
          statusKey: session.statusKey,
          sourceType: session.sourceType,
        });
      } else if (!stale && previous.stale && session.statusKey === "running") {
        pushEvent(store.events, fingerprint, {
          type: "resumed",
          at: now,
          statusKey: session.statusKey,
          sourceType: session.sourceType,
        });
      }
    }

    session.timeline = [...(store.events[fingerprint] || [])].slice(-6).reverse();
  }

  for (const [sessionId, snapshot] of Object.entries(store.active)) {
    if (currentIds.has(sessionId)) {
      continue;
    }

    const durationMs = now - snapshot.startedAt;
    pushHistory(store.history, snapshot.fingerprint, durationMs);
    pushHistory(store.history, snapshot.providerKey, durationMs);
    pushEvent(store.events, snapshot.fingerprint, {
      type: "gone",
      at: now,
      statusKey: snapshot.statusKey,
      sourceType: snapshot.sourceType,
    });
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
