import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export async function runCommand(command, args = [], options = {}) {
  const { timeout = 5000, maxBuffer = 8 * 1024 * 1024 } = options;
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout,
    maxBuffer,
    env: process.env,
  });

  return { stdout, stderr };
}

export async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export async function listFilesRecursive(rootDir, matcher, maxDepth = 6) {
  const results = [];

  async function walk(currentDir, depth) {
    if (depth > maxDepth) {
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
          return;
        }

        if (matcher(fullPath, entry)) {
          results.push(fullPath);
        }
      }),
    );
  }

  await walk(rootDir, 0);
  return results;
}

export function truncate(text, maxLength = 120) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function firstMeaningfulLine(text) {
  const line = String(text || "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return line || "";
}

export function parseJsonOutput(stdout, fallback = []) {
  try {
    return JSON.parse(stdout);
  } catch {
    return fallback;
  }
}

export function parseElapsedTime(etime) {
  const value = String(etime || "").trim();
  if (!value) {
    return null;
  }

  const daySplit = value.split("-");
  const timePart = daySplit.pop();
  const dayCount = daySplit.length ? Number(daySplit[0]) : 0;
  const parts = timePart.split(":").map((item) => Number(item));

  if (parts.some(Number.isNaN) || Number.isNaN(dayCount)) {
    return null;
  }

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (parts.length === 3) {
    [hours, minutes, seconds] = parts;
  } else if (parts.length === 2) {
    [minutes, seconds] = parts;
  } else if (parts.length === 1) {
    [seconds] = parts;
  } else {
    return null;
  }

  return ((((dayCount * 24) + hours) * 60) + minutes) * 60 * 1000 + (seconds * 1000);
}

export function toIsoOrNull(value) {
  if (!value || Number.isNaN(value)) {
    return null;
  }
  return new Date(value).toISOString();
}

export function basenameOrNull(value) {
  if (!value) {
    return null;
  }
  try {
    return path.basename(value);
  } catch {
    return null;
  }
}

export function safeDecodeUri(uri) {
  if (!uri) {
    return null;
  }

  const normalized = uri.startsWith("file://") ? uri.replace("file://", "") : uri;
  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
}

export function median(numbers) {
  if (!numbers.length) {
    return null;
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

export function slugifyTask(text) {
  const normalized = normalizeWhitespace(text).toLowerCase();
  return normalized
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fbf]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function extractFileUris(rawValue) {
  const matches = String(rawValue || "").match(/file:\/\/[^"'\\)\]]+/g) || [];
  return [...new Set(matches.map((item) => safeDecodeUri(item)).filter(Boolean))];
}

export function formatDurationJapanese(ms) {
  const roundedMinutes = Math.max(1, Math.round(ms / 60000));

  if (roundedMinutes < 60) {
    return `${roundedMinutes}分`;
  }

  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (!minutes) {
    return `${hours}時間`;
  }
  return `${hours}時間${minutes}分`;
}
