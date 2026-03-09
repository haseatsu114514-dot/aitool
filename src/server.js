import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { collectSnapshot } from "./monitor.js";

const execFileAsync = promisify(execFile);
const MODULE_PATH = fileURLToPath(import.meta.url);
const __dirname = path.dirname(MODULE_PATH);
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DEFAULT_PORT = Number(process.env.PORT || 4315);
const CHROMIUM_BROWSERS = new Set(["Google Chrome", "Arc"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function ensureDirectories() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveFile(filePath, res) {
  await fs.access(filePath);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      sendJson(res, 404, { error: "not found" });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

async function runOsascript(lines, env = {}, language = null) {
  const args = [];
  if (language) {
    args.push("-l", language);
  }

  for (const line of Array.isArray(lines) ? lines : [lines]) {
    args.push("-e", line);
  }

  const { stdout } = await execFileAsync("osascript", args, {
    env: {
      ...process.env,
      ...env,
    },
  });

  return String(stdout || "").trim();
}

async function focusChromiumTab(appName, targetUrl) {
  const script = [
    'set browserName to system attribute "BROWSER_APP"',
    'set targetUrl to system attribute "TARGET_URL"',
    "tell application browserName",
    "if not running then return \"miss\"",
    "repeat with w in windows",
    "set tabIndex to 0",
    "repeat with t in tabs of w",
    "set tabIndex to tabIndex + 1",
    "try",
    "set tabUrl to URL of t",
    "if my urlsMatch(tabUrl, targetUrl) then",
    "set active tab index of w to tabIndex",
    "set index of w to 1",
    "activate",
    "return \"hit\"",
    "end if",
    "end try",
    "end repeat",
    "end repeat",
    "end tell",
    "return \"miss\"",
    "on normalizeUrl(rawUrl)",
    "set text item delimiters to \"#\"",
    "set withoutFragment to text item 1 of rawUrl",
    "set text item delimiters to \"?\"",
    "set withoutQuery to text item 1 of withoutFragment",
    "set text item delimiters to \"\"",
    "if withoutQuery ends with \"/\" then",
    "return text 1 thru -2 of withoutQuery",
    "end if",
    "return withoutQuery",
    "end normalizeUrl",
    "on urlsMatch(existingUrl, targetUrl)",
    "set existingNormalized to my normalizeUrl(existingUrl as text)",
    "set targetNormalized to my normalizeUrl(targetUrl as text)",
    "if existingNormalized is targetNormalized then return true",
    "if existingNormalized starts with targetNormalized then return true",
    "if targetNormalized starts with existingNormalized then return true",
    "return false",
    "end urlsMatch",
  ];

  return (await runOsascript(script, { BROWSER_APP: appName, TARGET_URL: targetUrl })) === "hit";
}

async function focusSafariTab(targetUrl) {
  const script = [
    'set targetUrl to system attribute "TARGET_URL"',
    'tell application "Safari"',
    "if not running then return \"miss\"",
    "repeat with w in windows",
    "repeat with t in tabs of w",
    "try",
    "set tabUrl to URL of t",
    "if my urlsMatch(tabUrl, targetUrl) then",
    "set current tab of w to t",
    "set index of w to 1",
    "activate",
    "return \"hit\"",
    "end if",
    "end try",
    "end repeat",
    "end repeat",
    "end tell",
    "return \"miss\"",
    "on normalizeUrl(rawUrl)",
    "set text item delimiters to \"#\"",
    "set withoutFragment to text item 1 of rawUrl",
    "set text item delimiters to \"?\"",
    "set withoutQuery to text item 1 of withoutFragment",
    "set text item delimiters to \"\"",
    "if withoutQuery ends with \"/\" then",
    "return text 1 thru -2 of withoutQuery",
    "end if",
    "return withoutQuery",
    "end normalizeUrl",
    "on urlsMatch(existingUrl, targetUrl)",
    "set existingNormalized to my normalizeUrl(existingUrl as text)",
    "set targetNormalized to my normalizeUrl(targetUrl as text)",
    "if existingNormalized is targetNormalized then return true",
    "if existingNormalized starts with targetNormalized then return true",
    "if targetNormalized starts with existingNormalized then return true",
    "return false",
    "end urlsMatch",
  ];

  return (await runOsascript(script, { TARGET_URL: targetUrl })) === "hit";
}

async function focusExistingBrowserTarget(appName, targetUrl) {
  try {
    if (CHROMIUM_BROWSERS.has(appName)) {
      return await focusChromiumTab(appName, targetUrl);
    }

    if (appName === "Safari") {
      return await focusSafariTab(targetUrl);
    }
  } catch {
    return false;
  }

  return false;
}

async function reopenSession(payload) {
  if (payload?.url) {
    if (payload.appName && await focusExistingBrowserTarget(payload.appName, payload.url)) {
      return;
    }

    if (payload.appName) {
      await execFileAsync("open", ["-a", payload.appName, payload.url], { env: process.env });
      return;
    }

    await execFileAsync("open", [payload.url], { env: process.env });
    return;
  }

  if (payload?.workspace) {
    await execFileAsync("open", [payload.workspace], { env: process.env });
    return;
  }

  if (payload?.appName) {
    await execFileAsync("open", ["-a", payload.appName], { env: process.env });
    return;
  }

  throw new Error("reopen target not available");
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        sendJson(res, 400, { error: "invalid request" });
        return;
      }

      const requestUrl = new URL(req.url, "http://localhost");

      if (requestUrl.pathname === "/api/snapshot") {
        const snapshot = await collectSnapshot();
        sendJson(res, 200, snapshot);
        return;
      }

      if (requestUrl.pathname === "/api/reopen" && req.method === "POST") {
        const payload = await readJsonBody(req);
        await reopenSession(payload);
        sendJson(res, 200, { ok: true });
        return;
      }

      const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
      const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(PUBLIC_DIR, safePath);

      await serveFile(filePath, res);
    } catch (error) {
      if (error?.code === "ENOENT") {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      sendJson(res, 500, {
        error: "snapshot_failed",
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
  });
}

export async function startServer(options = {}) {
  const { port = DEFAULT_PORT, quiet = false, host = "127.0.0.1" } = options;
  await ensureDirectories();

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  if (!quiet) {
    console.log("");
    console.log("AI Workboard is running.");
    console.log(`Open: http://${host}:${actualPort}`);
    console.log("");
  }

  return server;
}

export async function stopServer(server) {
  if (!server || !server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  await startServer();
}
