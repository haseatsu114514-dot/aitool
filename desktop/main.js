import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeImage, shell } from "electron";
import { startServer } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ICON_PATH = path.join(ROOT_DIR, "public", "favicon.svg");
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let server = null;
let windowRef = null;
let serverUrl = null;

if (!hasSingleInstanceLock) {
  app.quit();
}

function focusMainWindow() {
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
  if (server && serverUrl) {
    return serverUrl;
  }

  server = await startServer({
    port: 0,
    quiet: true,
    host: "127.0.0.1",
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 4315;
  serverUrl = `http://127.0.0.1:${port}`;
  return serverUrl;
}

async function createMainWindow() {
  const url = await ensureServer();
  const icon = nativeImage.createFromPath(ICON_PATH);

  windowRef = new BrowserWindow({
    width: 1360,
    height: 940,
    minWidth: 1120,
    minHeight: 760,
    title: "AI Workboard",
    backgroundColor: "#15182d",
    autoHideMenuBar: true,
    show: false,
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (process.platform === "darwin" && !icon.isEmpty()) {
    app.dock.setIcon(icon);
  }

  windowRef.once("ready-to-show", () => {
    windowRef?.show();
    focusMainWindow();
  });

  windowRef.on("closed", () => {
    windowRef = null;
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

  await windowRef.loadURL(url);
}

app.on("second-instance", () => {
  focusMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (!windowRef) {
    await createMainWindow();
    return;
  }

  focusMainWindow();
});

app.on("will-quit", () => {
  if (server?.listening) {
    server.close();
  }
});

await app.whenReady();
await createMainWindow();
