import path from "node:path";
import { fileURLToPath } from "node:url";
import packager from "@electron/packager";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");

const packagedPaths = await packager({
  dir: ROOT_DIR,
  out: DIST_DIR,
  overwrite: true,
  platform: "darwin",
  arch: process.arch,
  asar: true,
  prune: true,
  name: "AI Workboard",
  executableName: "AI Workboard",
  appBundleId: "local.ai-workboard.desktop",
  appCategoryType: "public.app-category.productivity",
  ignore: [
    /^\/dist($|\/)/,
    /^\/data\/session-store\.json$/,
  ],
});

for (const packagedPath of packagedPaths) {
  console.log(packagedPath);
}
