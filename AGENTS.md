# AI Agent Development Guide

## Project Overview

**venueintelligence-mc-ingest-tagvenue-scraper** — CLI scraper for Tagvenue.com. Crawls venue and room listings via sitemap discovery and HTTP fetching, extracts structured data, normalises it into canonical master-venue-compatible JSON, and writes it for ingestion into the Shortlisty Intelligence venue registry.

**Key characteristics:**

- Node.js, plain JavaScript (no TypeScript, no framework)
- CLI entry via `src/cli.js`; main pipeline in `src/run.js`
- Provider-specific logic isolated under `src/providers/tagvenue/` (extractor, normalizer, selectors)
- Rate-limited HTTP fetching (`src/utils/rate-limit.js`), concurrency control (`src/utils/concurrency.js`)
- Output: JSON files written by `src/output/json-writer.js`

## Project Structure

```
src/
├── cli.js                         # CLI argument parsing and entry point
├── config.js                      # Configuration constants
├── index.js                       # Public API / main export
├── run.js                         # Pipeline orchestration
├── discovery/
│   └── sitemap.js                 # Sitemap crawl and URL discovery
├── fetchers/
│   ├── http.js                    # Rate-limited HTTP fetch
│   └── robots.js                  # robots.txt parsing
├── output/
│   ├── json-writer.js             # Writes normalised JSON output
│   └── logger.js                  # Logging utilities
├── providers/tagvenue/
│   ├── extractor.js               # DOM extraction from fetched HTML
│   ├── normalizer.js              # Maps extracted data to canonical schema
│   └── selectors.js               # CSS/XPath selectors for Tagvenue pages
└── utils/
    ├── concurrency.js             # Concurrency pool
    ├── normalize.js               # Generic normalisation helpers
    └── rate-limit.js              # Rate limiter
```

## Execution Discipline

- Root cause first. Read the relevant extractor/normalizer before editing.
- Tagvenue HTML structure changes are the most common breakage source — verify selectors against a live or cached page before assuming a code bug.
- After two identical failures without new evidence, change approach — do not retry blindly.
- No speculative changes to the canonical output schema without explicit approval — downstream ingestion depends on it.

## Security

- Never commit real Tagvenue session cookies, API keys, or proxy credentials.
- `.env` files are gitignored — use `.env.example` for documentation.
- Respect `robots.txt` — the fetcher already implements this; do not bypass it.
- Rate limits are intentional — do not remove or reduce them without approval.
- Never bypass `--no-verify` unless explicitly requested.

## AI Agent Guidelines

- **Ask before applying**: describe the change, show key diffs, wait for approval.
- **Approval phrases**: "Yes", "Proceed", "Apply", "Do it", "Looks good"
- **Output schema changes**: always flag to the user — downstream ingestion will break if the canonical JSON shape changes.
- **Selector changes**: verify against at least one real page sample before committing.

## Commit Standards

Format: `type(scope): subject`

- Subject: imperative, lowercase, no trailing period, ≤ 72 chars
- Types: `feat`, `fix`, `improvement`, `refactor`, `docs`, `test`, `chore`, `ci`, `perf`, `revert`
- Scope: affected module (e.g., `extractor`, `normalizer`, `selectors`, `http`, `sitemap`, `output`, `cli`, `deps`)
- For `fix`: symptom + trigger, not the code change
  - ✅ `fix(selectors): room capacity not extracted after Tagvenue layout update`
  - ❌ `fix(selectors): update CSS selector for capacity`

Examples:
- `feat(normalizer): add cuisine_type field to canonical venue schema`
- `fix(http): fetch silently drops venues when rate limit returns 429`
- `refactor(extractor): split venue and room extraction into separate functions`
- `chore(deps): update playwright scraping dependencies`

## Development Commands

```bash
pnpm start            # Run scraper with default config
pnpm dev              # Run with watch/debug mode
pnpm cli:help         # Show CLI options
pnpm test             # Run tests
pnpm typecheck        # Type checking
pnpm formatter:check  # Check formatting
pnpm formatter:write  # Auto-format
```
