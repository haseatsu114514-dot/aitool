import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ICON_DIR = path.join(ROOT_DIR, "desktop", "icons");
const SOURCE_SVG = path.join(ICON_DIR, "app-icon.svg");
const OUTPUT_PNG = path.join(ICON_DIR, "app-icon.png");
const OUTPUT_ICNS = path.join(ICON_DIR, "app-icon.icns");

const ICONSET_FILES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

function run(command, args) {
  execFileSync(command, args, {
    stdio: "pipe",
  });
}

function ensureSource() {
  if (!existsSync(SOURCE_SVG)) {
    throw new Error(`icon source not found: ${SOURCE_SVG}`);
  }
}

function renderBasePng(tempDir) {
  run("qlmanage", ["-t", "-s", "1024", "-o", tempDir, SOURCE_SVG]);
  const quickLookOutput = path.join(tempDir, "app-icon.svg.png");
  if (!existsSync(quickLookOutput)) {
    throw new Error("Quick Look did not generate the PNG icon.");
  }

  run("sips", ["-s", "format", "png", quickLookOutput, "--out", OUTPUT_PNG]);
  applyRoundedMask();
}

function applyRoundedMask() {
  execFileSync("python3", [
    "-c",
    `
from PIL import Image, ImageDraw
path = ${JSON.stringify(OUTPUT_PNG)}
img = Image.open(path).convert("RGBA")
mask = Image.new("L", img.size, 0)
draw = ImageDraw.Draw(mask)
draw.rounded_rectangle((0, 0, img.size[0] - 1, img.size[1] - 1), radius=240, fill=255)
img.putalpha(mask)
img.save(path)
`.trim(),
  ], {
    stdio: "pipe",
  });
}

function buildIconset(tempDir) {
  const iconsetDir = path.join(tempDir, "app-icon.iconset");
  mkdirSync(iconsetDir, { recursive: true });

  for (const [outputName, size] of ICONSET_FILES) {
    run("sips", ["-z", String(size), String(size), OUTPUT_PNG, "--out", path.join(iconsetDir, outputName)]);
  }

  return iconsetDir;
}

function writeIcns(iconsetDir) {
  run("iconutil", ["-c", "icns", iconsetDir, "-o", OUTPUT_ICNS]);
}

function buildDesktopIcon() {
  ensureSource();
  mkdirSync(ICON_DIR, { recursive: true });
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ai-workboard-icon-"));

  try {
    renderBasePng(tempDir);
    const iconsetDir = buildIconset(tempDir);
    writeIcns(iconsetDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

buildDesktopIcon();
