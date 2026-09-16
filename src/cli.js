import fs from 'node:fs';
import { resolveConfig } from './config.js';
import { run } from './run.js';

const HELP = `Usage: venueintelligence-mc-ingest-tagvenue-scraper [options]

Tagvenue.com venue and room scraper. Produces master venue-compatible JSON.

Configuration priority: defaults → TV_* env vars → --config file → CLI args

Options:
  -h, --help                      Print this help and exit
      --config <file.json>        Merge in keys from a JSON file
  -m, --mode <str>                Discovery mode: sitemap | search | urls-file (default: sitemap)
      --city <str>                City filter (search mode) and output slug
      --country <CC>              2-letter ISO country code
      --people <int>              Minimum attendee count filter
      --date <YYYY-MM-DD>         Date filter for availability search
      --time-from <key>           Search start time slot key (Tagvenue numeration)
      --time-to <key>             Search end time slot key (Tagvenue numeration)
      --min-price <int>           Minimum price filter
      --max-price <int>           Maximum price filter
      --page <int>                Starting page for search mode (default: 1)
  -l, --limit <int>               Max room URLs to detail-scrape. 0 = unlimited (default: 100)
      --urls-file <path>          Line-delimited URLs file (mode urls-file)
      --sitemap-since <value>     Only include rooms whose sitemap lastmod >= this value.
                                  Accepts an ISO date (2024-06-01) or a relative shorthand
                                  (7d = last 7 days, 2w = last 2 weeks, 1m = last 30 days).
                                  Entries with no lastmod are always included. (default: none)
      --sitemap-max-pages <int>   Maximum number of paginated sitemap-rooms-N.xml pages to
                                  fetch in sitemap mode (default: 100)
  -c, --concurrency <int>         Concurrent detail-pass requests (default: 5)
      --min-delay-ms <int>        Min delay between requests ms (default: 600)
      --jitter-ms <int>           Random jitter added to delay ms (default: 400)
      --timeout-ms <int>          Per-request timeout ms (default: 15000)
      --retries <int>             Retries per URL on 429/5xx (default: 3)
      --user-agent <ua>           HTTP user agent (default: Chrome 126 desktop)
      --proxy <url>               http(s) proxy URL: http://user:pass@host:port
      --browser                   Use Playwright Chromium for detail pass (default: off)
      --no-browser-stealth        Disable playwright-stealth in browser mode
  -o, --output-dir <dir>          Directory to write JSON/log (default: /data)
      --output-file <name>        Output file name inside output-dir (default auto)
      --log-level <lvl>           trace | debug | info | warn | error (default: info)
      --log-file <name>           Also tee logs to this file inside output-dir
      --dry-run                   Run discovery only and print URLs (no detail pass)

Environment variables (TV_ prefix, 1:1 with options above):
  TV_MODE TV_CITY TV_COUNTRY TV_PEOPLE TV_DATE TV_TIME_FROM TV_TIME_TO
  TV_MIN_PRICE TV_MAX_PRICE TV_PAGE TV_LIMIT TV_URLS_FILE
  TV_SITEMAP_SINCE TV_SITEMAP_MAX_PAGES
  TV_CONCURRENCY TV_MIN_DELAY_MS TV_JITTER_MS TV_TIMEOUT_MS TV_RETRIES
  TV_USER_AGENT TV_PROXY TV_BROWSER TV_BROWSER_STEALTH
  TV_OUTPUT_DIR TV_OUTPUT_FILE TV_LOG_LEVEL TV_LOG_FILE TV_DRY_RUN

Examples:
  # Full sitemap scrape (all pages, no lastmod filter)
  venueintelligence-mc-ingest-tagvenue-scraper --mode sitemap -l 0 -o ./data

  # Incremental: only rooms updated in the last 7 days
  venueintelligence-mc-ingest-tagvenue-scraper --mode sitemap --sitemap-since 7d -l 0

  # Targeted city run with dry-run URL preview
  venueintelligence-mc-ingest-tagvenue-scraper --mode search --city london --country GB --limit 50 --dry-run

  # Scrape a hand-picked list of URLs
  venueintelligence-mc-ingest-tagvenue-scraper --mode urls-file --urls-file ./urls.txt
`;

async function main() {
  const config = resolveConfig();
  if (config._help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  try {
    const result = await run(config, { fs });
    const summary = {
      status: result.status,
      outputPath: config.outputPath,
      discovered: result.discovered?.length ?? 0,
      records: result.records?.length ?? 0,
      mode: config.mode,
      browser: config.browser,
    };
    process.stdout.write(`\n[SUMMARY] ${JSON.stringify(summary)}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`FATAL: ${err.stack ?? err.message}\n`);
    process.exit(1);
  }
}

main();
