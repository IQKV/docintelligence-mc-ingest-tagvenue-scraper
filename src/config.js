import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import minimist from "minimist";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DEFAULTS = Object.freeze({
  mode: "sitemap",
  city: null,
  country: null,
  people: null,
  date: null,
  timeFrom: null,
  timeTo: null,
  minPrice: null,
  maxPrice: null,
  page: 1,
  limit: 100,
  urlsFile: null,
  // Sitemap-specific options
  sitemapSince: null, // ISO date or relative shorthand (e.g. "7d", "2w", "1m") — only scrape URLs with lastmod >= this date
  sitemapMaxPages: 100, // maximum number of paginated sitemap-rooms-N.xml pages to fetch
  concurrency: 5,
  minDelayMs: 600,
  jitterMs: 400,
  timeoutMs: 15_000,
  retries: 3,
  userAgent: DEFAULT_UA,
  proxy: null,
  browser: false,
  browserStealth: true,
  outputDir: "/data",
  outputFile: null,
  config: null,
  logLevel: "info",
  logFile: null,
  dryRun: false,
});

const ENV_MAP = {
  TV_MODE: "mode",
  TV_CITY: "city",
  TV_COUNTRY: "country",
  TV_PEOPLE: (v) => ({ people: parseIntOrNull(v) }),
  TV_DATE: "date",
  TV_TIME_FROM: "timeFrom",
  TV_TIME_TO: "timeTo",
  TV_MIN_PRICE: (v) => ({ minPrice: parseIntOrNull(v) }),
  TV_MAX_PRICE: (v) => ({ maxPrice: parseIntOrNull(v) }),
  TV_PAGE: (v) => ({ page: parseInt(v, 10) || DEFAULTS.page }),
  TV_LIMIT: (v) => ({ limit: parseInt(v, 10) || 0 }),
  TV_URLS_FILE: "urlsFile",
  TV_SITEMAP_SINCE: "sitemapSince",
  TV_SITEMAP_MAX_PAGES: (v) => ({ sitemapMaxPages: parseInt(v, 10) || DEFAULTS.sitemapMaxPages }),
  TV_CONCURRENCY: (v) => ({ concurrency: parseInt(v, 10) || DEFAULTS.concurrency }),
  TV_MIN_DELAY_MS: (v) => ({ minDelayMs: parseInt(v, 10) || 0 }),
  TV_JITTER_MS: (v) => ({ jitterMs: parseInt(v, 10) || 0 }),
  TV_TIMEOUT_MS: (v) => ({ timeoutMs: parseInt(v, 10) || DEFAULTS.timeoutMs }),
  TV_RETRIES: (v) => ({ retries: parseInt(v, 10) || 0 }),
  TV_USER_AGENT: "userAgent",
  TV_PROXY: "proxy",
  TV_BROWSER: (v) => ({ browser: isTrueString(v) }),
  TV_BROWSER_STEALTH: (v) => ({ browserStealth: isTrueString(v) }),
  TV_OUTPUT_DIR: "outputDir",
  TV_OUTPUT_FILE: "outputFile",
  TV_LOG_LEVEL: "logLevel",
  TV_LOG_FILE: "logFile",
  TV_DRY_RUN: (v) => ({ dryRun: isTrueString(v) }),
};

const CLI_ALIAS = {
  m: "mode",
  l: "limit",
  c: "concurrency",
  o: "outputDir",
  h: "help",
};

function parseIntOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function isTrueString(v) {
  if (typeof v === "boolean") return v;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function todaySlug(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function slugifyCity(city) {
  if (!city) return null;
  return (
    city
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 80) || null
  );
}

function readJsonFile(filePath) {
  try {
    const resolved = path.resolve(process.cwd(), filePath);
    const raw = fs.readFileSync(resolved, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to read config file ${filePath}: ${err.message}`);
  }
}

export function resolveConfig({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  dotenv.config({ path: path.resolve(cwd, ".env") });

  const cli = minimist(argv, {
    alias: CLI_ALIAS,
    boolean: ["browser", "browser-stealth", "dry-run", "help"],
  });

  const envOverrides = {};
  for (const [envKey, mapping] of Object.entries(ENV_MAP)) {
    if (env[envKey] === undefined) continue;
    const value = env[envKey];
    if (typeof mapping === "function") {
      Object.assign(envOverrides, mapping(value));
    } else {
      envOverrides[mapping] = value;
    }
  }

  const fileOverrides = cli.config ? readJsonFile(cli.config) : {};

  const cliNormalized = {};
  for (const [key, value] of Object.entries(cli)) {
    if (key === "_" || key === "help" || value === undefined) continue;
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    cliNormalized[camel] = value;
  }

  const merged = {
    ...DEFAULTS,
    ...envOverrides,
    ...fileOverrides,
    ...cliNormalized,
  };

  // Coerce numerics (CLI arg string -> number)
  for (const key of [
    "people",
    "minPrice",
    "maxPrice",
    "page",
    "limit",
    "sitemapMaxPages",
    "concurrency",
    "minDelayMs",
    "jitterMs",
    "timeoutMs",
    "retries",
  ]) {
    if (merged[key] != null && typeof merged[key] !== "number")
      merged[key] = parseIntOrNull(merged[key]);
  }
  for (const key of ["browser", "browserStealth", "dryRun"]) {
    if (typeof merged[key] !== "boolean") merged[key] = isTrueString(merged[key]);
  }

  merged._projectRoot = path.resolve(__dirname, "..");
  merged._argv = argv;
  merged._help = !!cli.help;

  if (!merged.outputFile) {
    const cityPart = slugifyCity(merged.city);
    const ts = todaySlug();
    merged.outputFile = cityPart ? `${cityPart}-${ts}.json` : `tagvenue-venues-${ts}.json`;
  }
  merged.outputPath = path.posix.join(
    String(merged.outputDir).replace(/\/$/, ""),
    merged.outputFile,
  );

  return Object.freeze(merged);
}

export const CONFIG_DEFAULTS = DEFAULTS;
export { todaySlug, slugifyCity };
