# AI Agent Development Guide

## Project Overview

**docintelligence-mc-ingest-tagvenue-scraper** — CLI scraper for Tagvenue.com. Crawls venue and room listings via sitemap discovery and HTTP fetching, extracts structured data, normalises it into canonical master-venue-compatible JSON, and writes it for ingestion into the Shortlisty Intelligence venue registry.

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

## Minimal Change Discipline

Solve the whole problem with the least new code. The best code is the code never written.

### Scope before you write

Read the task and the code it touches. List every place the change must reach: callers, tests, fixtures, config, exports. Check what it could break for users: data it would destroy or expose, callers that stop working. That is scope. Extra features are not.

### Pick the smallest complete change

Take the first option that fully works:

1. Does it need to exist? Drop features, options and flexibility nobody asked for — name them in one line so the user can decide.
2. Already in this codebase (helper, component, service, pattern)? Use it the way the surrounding code does.
3. Standard library or platform feature? Use it, unless the project has its own.
4. An installed dependency? Use it. Never add a dependency for a few lines.
5. Can it be one line a reader gets at a glance? One line.
6. Otherwise: the minimum code that works.

Be lazy about the solution, never about the change itself:

- Finish every part the task needs, including the callers, tests and fixtures the change breaks.
- No abstraction, wrapper, option, config, boilerplate or "for later" code nobody asked for. Keep values in the form the platform already gives you. Deletion beats addition. Keep the layers, interfaces and conventions the codebase already has.
- The shortest working diff wins, once you know everything it must touch. A one-liner that needs decoding is not short.
- Comment only the why the code cannot show, in one line.
- Bug fix: grep every caller of the function you touch, then fix the root cause once in the shared code.
- Code you move or merge keeps its error handling and validation.
- Between options of equal size, take the one that is correct on edge cases.
- New non-trivial logic (a branch, a loop, a parser, money or security, or a whole new script) leaves one small test or an assert-based self-check. Trivial changes need none.
- A shortcut with a known limit gets a one-line comment: `shortcut: <the limit>, <when to upgrade>`.
- Push back when the need does not justify a part: state the smaller option in one line instead of building the bigger one silently.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs, anything the user explicitly asked for.

### Token discipline

- Locate with Grep/Glob, then read only the ranges you need — not whole trees or whole files.
- Prefer editing existing files to creating new ones; reuse code that is already there before writing.
- Never paste file contents back in a reply. Cite the path and lines.
- Keep replies to the outcome: what changed, what passed, any risk (see AI Communication Standards).

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

## Evaluation

How we judge whether an agent task in this repository is actually done. Evaluation is evidence-based — a claim without the command and its observed result is not a pass.

> This section starts minimal and grows with the repository. Add a gate only when a change type repeatedly slips through without it.

### Definition of done

A task is evaluated as done only when all of the following hold:

- Every gate required by the change type below has run and passed.
- The final report names the exact command(s) run and the observed result (pass/fail) — per AI Agent Guidelines.
- No required gate was skipped silently. A gate that could not run is reported as a gap, never as a pass.

### Required gates by change type

| Change type                           | Required gates                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Any change                            | `pnpm typecheck` and `pnpm formatter:check`                                      |
| Scraper, parser or extractor logic    | `pnpm test`; a new non-trivial branch, loop or parser needs a test               |
| Selector or source-site change        | `pnpm test`, then `pnpm start` on a sample source — report which sample was used |
| Network, retry or rate-limit behavior | `pnpm test` covering the failure path (429, timeout), then `pnpm typecheck`      |
| Dependency or config change           | `pnpm test`, then `pnpm typecheck`                                               |
| Docs or `AGENTS.md` only              | `pnpm formatter:check`                                                           |

### Ordering

Run the narrowest relevant gate first, then the full set for the change type. On the first failure, stop and report it — do not continue on an unproven base (see Execution Discipline).

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
