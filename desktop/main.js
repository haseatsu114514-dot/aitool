import path from "node:path";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeImage, screen, shell } from "electron";
import { startServer } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ICON_PATH = path.join(ROOT_DIR, "desktop", "icons", "app-icon.png");
const LOG_PATH = "/tmp/ai-workboard-desktop.log";
const APP_TITLE = "AI管理ツール";
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const WINDOW_REVEAL_DELAY_MS = 1200;

let server = null;
let windowRef = null;
let serverUrl = null;
let revealTimer = null;

if (!hasSingleInstanceLock) {
  writeLaunchLog("single-instance lock not acquired; quitting");
  app.quit();
}

function writeLaunchLog(message) {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // ignore logging failures
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlinePage({ title, body, tone = "info" }) {
  const accent = tone === "error" ? "#f47d73" : "#6ce6c1";
  const html = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_TITLE}</title>
    <style>
      :root {
        color-scheme: dark;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(108, 230, 193, 0.18), transparent 36%),
          linear-gradient(180deg, #181c33 0%, #111422 100%);
        color: #f5f7ff;
        font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
      }

      main {
        width: min(560px, calc(100vw - 48px));
        padding: 28px 26px;
        border-radius: 24px;
        background: rgba(12, 16, 32, 0.9);
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: 0 32px 80px rgba(0, 0, 0, 0.42);
      }

      .eyebrow {
        margin: 0 0 12px;
        color: ${accent};
        font-size: 12px;
        letter-spacing: 0.18em;
      }

      h1 {
        margin: 0 0 12px;
        font-size: 30px;
        line-height: 1.2;
      }

      p {
        margin: 0;
        color: rgba(245, 247, 255, 0.82);
        font-size: 15px;
        line-height: 1.8;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">${APP_TITLE}</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
    </main>
  </body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function clearRevealTimer() {
  if (!revealTimer) {
    return;
  }

  clearTimeout(revealTimer);
  revealTimer = null;
}

function scheduleReveal() {
  clearRevealTimer();
  revealTimer = setTimeout(() => {
    focusMainWindow();
  }, WINDOW_REVEAL_DELAY_MS);
}

function focusMainWindow() {
  writeLaunchLog(`focusMainWindow called; hasWindow=${Boolean(windowRef)}`);
  if (!windowRef) {
    return;
  }

  if (windowRef.isMinimized()) {
    windowRef.restore();
  }

  if (!windowRef.isVisible()) {
    windowRef.show();
  }

  windowRef.focus();
}

async function ensureServer() {
  writeLaunchLog(`ensureServer start; existing=${Boolean(server && serverUrl)}`);
  if (server && serverUrl) {
    return serverUrl;
  }

  server = await startServer({
    port: 0,
    quiet: true,
    host: "127.0.0.1",
    dataDir: path.join(app.getPath("userData"), "data"),
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 4315;
  serverUrl = `http://127.0.0.1:${port}`;
  writeLaunchLog(`ensureServer ready; url=${serverUrl}`);
  return serverUrl;
}

async function loadStatusPage(title, body, tone = "info") {
  writeLaunchLog(`loadStatusPage start; title=${title}`);
  if (!windowRef || windowRef.isDestroyed()) {
    writeLaunchLog("loadStatusPage skipped; window missing");
    return;
  }

  await windowRef.loadURL(inlinePage({ title, body, tone }));
  writeLaunchLog(`loadStatusPage done; title=${title}`);
  focusMainWindow();
}

async function loadMainInterface(targetWindow) {
  writeLaunchLog("loadMainInterface start");
  try {
    const url = await ensureServer();
    if (!targetWindow || targetWindow.isDestroyed()) {
      writeLaunchLog("loadMainInterface aborted; window destroyed");
      return;
    }

    await targetWindow.loadURL(url);
    writeLaunchLog(`loadMainInterface loaded; url=${url}`);
    if (windowRef === targetWindow) {
      clearRevealTimer();
      focusMainWindow();
    }
  } catch (error) {
    writeLaunchLog(`loadMainInterface error; ${error instanceof Error ? error.stack || error.message : String(error)}`);
    if (windowRef !== targetWindow || !targetWindow || targetWindow.isDestroyed()) {
      return;
    }

    clearRevealTimer();
    await loadStatusPage(
      "起動に失敗しました",
      error instanceof Error ? error.message : "サーバーを立ち上げられませんでした。",
      "error",
    );
  }
}

async function createMainWindow() {
  writeLaunchLog(`createMainWindow start; existing=${Boolean(windowRef && !windowRef.isDestroyed())}`);
  if (windowRef && !windowRef.isDestroyed()) {
    focusMainWindow();
    return;
  }

  const icon = nativeImage.createFromPath(ICON_PATH);
  const workArea = screen.getPrimaryDisplay().workArea;
  const initialWidth = 1360;
  const initialHeight = 940;
  const leftInset = 18;
  const x = workArea.x + leftInset;
  const y = workArea.y + Math.max(24, Math.round((workArea.height - initialHeight) / 2));

  windowRef = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: 300,
    minHeight: 360,
    x,
    y,
    title: APP_TITLE,
    backgroundColor: "#15182d",
    autoHideMenuBar: true,
    show: true,
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });
  writeLaunchLog("BrowserWindow created");

  if (process.platform === "darwin" && !icon.isEmpty()) {
    app.dock.setIcon(icon);
  }

  windowRef.once("ready-to-show", () => {
    writeLaunchLog("window ready-to-show");
    clearRevealTimer();
    focusMainWindow();
  });

  windowRef.on("closed", () => {
    writeLaunchLog("window closed");
    clearRevealTimer();
    windowRef = null;
  });

  windowRef.on("unresponsive", () => {
    writeLaunchLog("window unresponsive");
    void loadStatusPage("画面が止まっています", "いったん表示を出し直しています。少し待っても戻らない時は、アプリを閉じて開き直してください。", "error");
  });

  windowRef.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: "deny" };
  });

  windowRef.webContents.on("will-navigate", (event, targetUrl) => {
    if (!serverUrl) {
      return;
    }

    if (!targetUrl.startsWith(serverUrl)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  windowRef.webContents.on("did-fail-load", (_event, _code, description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || String(validatedUrl || "").startsWith("data:")) {
      return;
    }

    writeLaunchLog(`did-fail-load; url=${validatedUrl} description=${description}`);

    void loadStatusPage(
      "読み込みに失敗しました",
      `${description || "画面を開けませんでした。"}\nしばらく待ってから開き直してください。`,
      "error",
    );
  });

  windowRef.webContents.on("dom-ready", () => {
    writeLaunchLog("window dom-ready");
    focusMainWindow();
  });

  await loadStatusPage("起動しています", `${APP_TITLE} を準備中です。少し待つと一覧が出ます。`);
  scheduleReveal();
  void loadMainInterface(windowRef);
}

app.on("second-instance", async () => {
  if (!windowRef || windowRef.isDestroyed()) {
    await createMainWindow();
    return;
  }

  focusMainWindow();
});

app.on("window-all-closed", () => {
  writeLaunchLog("window-all-closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  writeLaunchLog("app activate");
  if (!windowRef) {
    await createMainWindow();
    return;
  }

  focusMainWindow();
});

app.on("will-quit", () => {
  writeLaunchLog("will-quit");
  if (server?.listening) {
    server.close();
  }
});

process.on("uncaughtException", (error) => {
  writeLaunchLog(`uncaughtException; ${error instanceof Error ? error.stack || error.message : String(error)}`);
});

process.on("unhandledRejection", (error) => {
  writeLaunchLog(`unhandledRejection; ${error instanceof Error ? error.stack || error.message : String(error)}`);
});

function bootApplication() {
  writeLaunchLog(`bootApplication; isReady=${app.isReady()}`);
  void createMainWindow();
}

if (app.isReady()) {
  bootApplication();
} else {
  writeLaunchLog("waiting for ready event");
  app.once("ready", () => {
    writeLaunchLog("ready event fired");
    bootApplication();
  });
}
