import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./json-writer.js";

// Root folder created under the configured output dir on every start. All
// venues live below it, each in its own record folder.
export const INGEST_ROOT_NAME = "mc-ingest";

// Record folder name: provider prefix + the provider's own venue id. The id is
// stable across runs and unique per venue, so a re-scrape rewrites the very same
// folder instead of adding a dated copy next to it.
export const VENUE_DIR_PREFIX = "tagvenue-";

export const VENUE_RECORD_FILE = "venue.json";
export const ASSETS_DIR_NAME = "assets";

// The ingest tree lives on a bind mount shared with other containers, which may
// run as a different uid than the scraper. New entries would otherwise be
// clamped by the process umask (typically 0755/0644), so we chmod them open
// explicitly. Anything under mc-ingest is writable by anyone, on purpose.
export const OPEN_DIR_MODE = 0o777;
export const OPEN_FILE_MODE = 0o666;

/** `<outputDir>/mc-ingest` — the single tree the scraper owns. */
export function ingestRoot(outputDir) {
  return path.posix.join(String(outputDir ?? ".").replace(/\/+$/, ""), INGEST_ROOT_NAME);
}

/** `tagvenue-<venue_id>` — the per-venue folder name. */
export function venueDirName(venueId) {
  return `${VENUE_DIR_PREFIX}${venueId}`;
}

/** Absolute path of a venue's record folder inside the ingest root. */
export function venueDirFor(rootDir, venueId) {
  return path.posix.join(String(rootDir).replace(/\/+$/, ""), venueDirName(venueId));
}

/** True once a venue's record file is on disk — the mark of a completed venue. */
export function venueRecordExists(rootDir, venueId) {
  return fs.existsSync(path.posix.join(venueDirFor(rootDir, venueId), VENUE_RECORD_FILE));
}

/**
 * Create a directory and force it open (0777), walking back up to `stopAt` so
 * folders created implicitly by a recursive mkdir are opened too.
 *
 * Nothing at or above `stopAt` is ever touched, so the chmod walk can never
 * escape the tree the scraper owns.
 *
 * @param {string} dirPath
 * @param {string} [stopAt] tree root; the highest directory allowed to be chmod'ed
 */
export function ensureOpenDir(dirPath, stopAt) {
  const dir = ensureDir(dirPath);
  const stop = stopAt ? path.resolve(String(stopAt)) : null;
  const insideTree = (p) => !stop || p === stop || p.startsWith(stop + path.sep);

  let cur = dir;
  for (;;) {
    if (!insideTree(cur)) break;
    fs.chmodSync(cur, OPEN_DIR_MODE);
    if (!stop || cur === stop) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dir;
}

/** `<outputDir>/mc-ingest`, created on start and writable by anyone. */
export function ensureIngestRoot(outputDir) {
  const root = ingestRoot(outputDir);
  ensureOpenDir(root, root);
  return root;
}

/** Writes JSON via tmp-file + rename so a crash never leaves a half-written record. */
export function writeJsonFile(filePath, data, pretty = 2, ingestDir = null) {
  const dir = path.posix.dirname(filePath);
  if (ingestDir) ensureOpenDir(dir, ingestDir);
  else ensureDir(dir);

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const json = JSON.stringify(data, null, pretty);
  fs.writeFileSync(tmpPath, json, "utf8");
  fs.chmodSync(tmpPath, OPEN_FILE_MODE);
  fs.renameSync(tmpPath, filePath);
  return { filePath, sizeBytes: Buffer.byteLength(json, "utf8") };
}

/**
 * Downloads a venue's photo assets into `<venueDir>/assets/<file>`.
 *
 * Asset names come from the photo key (see `pickPhotoVariants`), never from the
 * variant the page happened to cite, so the same photo always maps to the same
 * path. Files already on disk are not re-downloaded — that is what stops
 * repeated runs from duplicating assets — but they are chmod'd open.
 *
 * @param {{
 *   http: { buffer: (url: string, options?: object) => Promise<{ status: number, buffer: Buffer }> },
 *   venueDir: string,
 *   assets: Array<{ file: string, url: string, transform: string }>,
 *   ingestDir?: string | null,
 *   logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void } | null,
 *   timeoutMs?: number,
 *   retries?: number,
 *   signal?: AbortSignal | null,
 * }} options
 */
export async function downloadVenueAssets(options) {
  const {
    http,
    venueDir,
    assets,
    ingestDir = null,
    logger = null,
    timeoutMs,
    retries,
    signal,
  } = options;
  const stats = { downloaded: 0, skipped: 0, failed: 0 };
  if (!assets?.length) return stats;

  const assetsDir = ensureOpenDir(
    path.posix.join(venueDir, ASSETS_DIR_NAME),
    ingestDir ?? venueDir,
  );

  for (const asset of assets) {
    const target = path.posix.join(assetsDir, asset.file);
    if (fs.existsSync(target)) {
      // Files written before this rule existed, or by another tool, are opened
      // up here so the whole tree keeps the same permissions.
      fs.chmodSync(target, OPEN_FILE_MODE);
      stats.skipped++;
      continue;
    }
    try {
      const res = await http.buffer(asset.url, { timeoutMs, retries, signal });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(target, res.buffer);
      fs.chmodSync(target, OPEN_FILE_MODE);
      stats.downloaded++;
    } catch (err) {
      stats.failed++;
      logger?.warn?.(`asset download failed: ${asset.file}`, {
        error: String(err?.message ?? err).slice(0, 200),
      });
    }
  }

  return stats;
}
