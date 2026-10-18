import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath) {
  const p = path.resolve(String(dirPath || "."));
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

export function writeJsonAtomic({
  outputDir,
  outputFile,
  data,
  pretty = 2,
  makeSymlinkLast = true,
}) {
  const dir = ensureDir(outputDir);
  const outPath = path.resolve(dir, outputFile);
  const tmpPath = `${outPath}.tmp.${process.pid}.${Date.now()}`;
  const json = typeof data === "string" ? data : JSON.stringify(data, null, pretty);
  fs.writeFileSync(tmpPath, json, "utf8");
  fs.renameSync(tmpPath, outPath);
  if (makeSymlinkLast) {
    const lastPath = path.resolve(dir, "_last.json");
    try {
      if (fs.existsSync(lastPath) || fs.lstatSync(lastPath, { throwIfNoEntry: false })) {
        fs.unlinkSync(lastPath);
      }
    } catch {}
    try {
      fs.symlinkSync(outPath, lastPath, "file");
    } catch {
      // Fallback on Windows: hardlink or plain copy
      try {
        fs.copyFileSync(outPath, lastPath);
      } catch {}
    }
  }
  return {
    outputPath: outPath,
    sizeBytes: Buffer.byteLength(json, "utf8"),
    count: Array.isArray(data)
      ? data.length
      : Number.isFinite(data?.items?.length)
        ? data.items.length
        : null,
  };
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
