import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath) {
  const p = path.resolve(String(dirPath || "."));
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readTextSafe(pathToFile, fallback = null) {
  try {
    const p = path.resolve(String(pathToFile));
    if (!fs.existsSync(p)) return fallback;
    return fs.readFileSync(p, "utf8");
  } catch {
    return fallback;
  }
}

export function readLinesSafe(pathToFile) {
  const text = readTextSafe(pathToFile, null);
  if (text == null) return [];
  return text
    .split(/\r?\n/g)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}
