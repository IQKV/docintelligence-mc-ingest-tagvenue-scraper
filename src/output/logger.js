const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 99 };

const noop = () => {};

function formatLine(level, tag, msg, meta) {
  const ts = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${ts} [${level.toUpperCase()}]${tag ? ` (${tag})` : ""} ${msg}${metaStr}`;
}

export function createLogger({
  level = "info",
  tag = "scraper",
  logFile = null,
  fs = null,
  outputDir = null,
} = {}) {
  const numericLevel = typeof level === "number" ? level : (LEVELS[level] ?? LEVELS.info);

  let writeToFile = noop;
  if (logFile && fs && outputDir) {
    const path = `${outputDir.replace(/\/$/, "")}/${logFile}`;
    writeToFile = (line) => {
      try {
        fs.appendFileSync(path, `${line}\n`, "utf8");
      } catch {
        /* ignore logging errors */
      }
    };
  }

  const emit = (lv, msg, meta) => {
    if ((LEVELS[lv] ?? 0) < numericLevel) return;
    const line = formatLine(lv, tag, msg, meta);
    if (lv === "error") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
    writeToFile(line);
  };

  return {
    trace: (m, meta) => emit("trace", m, meta),
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
    child: (subTag) => createLogger({ level: numericLevel, tag: subTag, logFile, fs, outputDir }),
  };
}
