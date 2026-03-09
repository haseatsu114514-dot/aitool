import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import packager from "@electron/packager";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const ICON_PATH = path.join(ROOT_DIR, "desktop", "icons", "app-icon");

execFileSync(process.execPath, [path.join(ROOT_DIR, "scripts", "build-desktop-icon.mjs")], {
  cwd: ROOT_DIR,
  stdio: "inherit",
});

const packagedPaths = await packager({
  dir: ROOT_DIR,
  out: DIST_DIR,
  overwrite: true,
  platform: "darwin",
  arch: process.arch,
  asar: true,
  prune: true,
  name: "AI管理ツール",
  executableName: "AI管理ツール",
  appBundleId: "local.ai-workboard.desktop",
  appCategoryType: "public.app-category.productivity",
  icon: ICON_PATH,
  ignore: [
    /^\/dist($|\/)/,
    /^\/data\/session-store\.json$/,
  ],
});

for (const packagedPath of packagedPaths) {
  console.log(packagedPath);
}
