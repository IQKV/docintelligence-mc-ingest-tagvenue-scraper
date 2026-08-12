import { createLogger } from './output/logger.js';

export async function run(config, { fs = null, now = () => new Date() } = {}) {
  const logger = createLogger({
    level: config.logLevel,
    tag: 'run',
    logFile: config.logFile,
    fs,
    outputDir: config.outputDir,
  });

  logger.info('mi-ingestion-tagvenue-scraper starting', {
    mode: config.mode,
    city: config.city ?? null,
    country: config.country ?? null,
    limit: config.limit,
    outputPath: config.outputPath,
    browser: config.browser,
    dryRun: config.dryRun,
  });

  if (config.dryRun) {
    logger.info('dry-run mode — skipping detail pass; discovery pass stubbed');
    return { status: 'dry-run', discovered: [], records: [], outputPath: config.outputPath };
  }

  logger.warn('detail extraction is stubbed in the MVP skeleton. Records array will be empty.');
  return { status: 'skeleton-ok', discovered: [], records: [], outputPath: config.outputPath, at: now().toISOString() };
}
