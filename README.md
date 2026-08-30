# mc-ingest-tagvenue-scraper

> **Tagvenue → Shortlisty Master Catalog Ingestion** - Lightweight Node.js CLI scraper for Tagvenue.com venue and room listings. Produces `MasterVenueRecord`-compatible JSON files for cold-start ingestion into the Shortlisty Intelligence internal platform **Venue Master Catalog** (`public.master_venue`).

[![GitHub repo](https://img.shields.io/badge/repo-IQKV%2Fmi--master--catalog--tagvenue--scraper-blue?logo=github)](https://github.com/IQKV/mc-ingest-tagvenue-scraper)
[![Status](https://img.shields.io/badge/status-MVP-yellow)](#)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen)](#engines)
[![License](https://img.shields.io/badge/license-Proprietary-red)](LICENSE)

---

## 1. Purpose

Tagvenue.com is a marketplace for event venues and spaces. This scraper extracts structured venue and room data from public Tagvenue listing pages and writes it as normalized JSON ready to be imported into the **Venue Master Catalog** — the internal hidden reference dataset stored in `public.master_venue` / `public.master_venue_external` tables of the `mi-venue-service` (Shortlisty Intelligence platform).

Key characteristics:

- **Stateless, single-binary container** — one image, many cities/runs, no rebuilds to change parameters.
- **Two-pass model** — discovery (sitemap / search pagination) + detail extraction.
- **Lightweight default (axios + cheerio, SSR HTML)** for 80% of fields via JSON-LD schema.org.
- **Optional Playwright browser mode** (`--browser` / `TV_BROWSER=true`) for JS-rendered pricing.
- **Robots.txt compliant** out of the box with `robots-parser`.
- **Docker & K8s-native** — fixed `/data` volume mount point, ENV-var + CLI-arg configuration.

Think of it as: the **Tagvenue provider adapter that converts public Tagvenue HTML into a `MasterVenueRecord` JSON envelope**, in a self-contained, schedulable package. Never connects to the database — the importer worker handles DB upsert.

---

## 2. Stack & Dependencies

| Layer              | Tool                                                   | Why                                                                                                            |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Runtime            | Node.js 22+ (ESM)                                      | Matches existing frontend Node 22 engines policy across the monorepo.                                          |
| Package mgmt       | pnpm 11                                                | Consistent with `foundation-ui-app`, `shortlisty-github-profile` etc.                                             |
| SSR HTTP fetch     | axios 1.x                                              | Plain HTTP GET for SSR-rendered HTML + GZIP decoding, redirect following, timeout/retry.                       |
| SSR DOM parser     | cheerio 1.x                                            | jQuery-like selectors. Lightweight, ~50MB node_modules total.                                                  |
| Browser mode (opt) | playwright 1.x (optional)                              | Full Chromium when SSR HTML lacks JS-rendered fields (dynamic pricing tables, real-time availability widgets). |
| Crawl etiquette    | robots-parser 3.x                                      | Respects `/robots.txt` sitemap/dissalow rules.                                                                 |
| Concurrency / Rate | `p-queue` + `p-throttle`                               | Fixed concurrency cap + token-bucket throttling with random jitter.                                            |
| Config             | `minimist` (CLI) + `dotenv` (ENV) + optional JSON file | 3-tier override: defaults → ENV → CLI args (see §5).                                                           |
| Quality (dev)      | oxlint + stylelint + oxfmt + husky + commitlint        | Inherited from the IQKV standard project layout template.                                                      |

---

## 3. How It Works (Two-Pass Pipeline)

```
┌──────────────────────────────────────────────────────────────────────┐
│                        mc-ingest-tagvenue-scraper                  │
│                                                                       │
│  PASS 1 — DISCOVERY (collect /rooms/... URLs)                         │
│                                                                       │
│   ┌─────────────────────────┐      ┌──────────────────────────────┐  │
│   │  sitemap.xml parser     │      │  city search pagination     │  │
│   │  (fastest, no HTTP to   │      │  (when sitemap can't be     │  │
│   │   tagvenue itself — 1   │      │   filtered by city/price/   │  │
│   │   HTTP request to CDN)  │      │   capacity)                 │  │
│   └───────────┬─────────────┘      └──────────────┬───────────────┘  │
│               │                                   │                   │
│               └─────────────────┬─────────────────┘                   │
│                                 ▼                                     │
│                    Deduplicated set of /rooms/ URLs                   │
│                    (capped by --limit / TV_LIMIT)                     │
│                                 │                                     │
│  PASS 2 — DETAIL EXTRACTION     │                                     │
│                                 ▼                                     │
│              ┌───────────────────────────────────────┐                │
│              │   Fetch each URL (HTTP or Browser)    │                │
│              └───────────────────┬───────────────────┘                │
│                                  ▼                                    │
│              ┌───────────────────────────────────────┐                │
│              │   Extract schema.org JSON-LD + DOM    │                │
│              │   fields using Tagvenue selectors     │                │
│              └───────────────────┬───────────────────┘                │
│                                  ▼                                    │
│              ┌───────────────────────────────────────┐                │
│              │   Normalize → MasterVenueRecord       │                │
│              │   (matches Master Catalog field set)  │                │
│              └───────────────────┬───────────────────┘                │
│                                  ▼                                    │
│              ┌───────────────────────────────────────┐                │
│              │   Write /data/<slug>-<date>.json      │                │
│              │   + optional .log file                │                │
│              └───────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────────────┘
```

### Pass 1 — Discovery strategies

Use `--mode sitemap` (default for full coverage) or `--mode search` (filtered by city/price/capacity).

| Mode        | What it does                                                                                                                                                                            | Speed        | Use when                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------- |
| `sitemap`   | Downloads `https://www.tagvenue.com/sitemap.xml` → parses sitemap index → iterates `sitemap-rooms-*.xml` → extracts all `/rooms/...` URLs                                               | ~100x faster | No city filters needed, or max coverage.       |
| `search`    | Builds a search URL from `--city`, `--country`, `--people`, `--min-price`, `--max-price`, `--date` and paginates `?page=1…N` clicking "Next" or infinite-scroll detecting `No results`. | Slower       | Filtered subsets, MVP city-focused cold-start. |
| `urls-file` | Reads a plain text file of raw `/rooms/...` URLs (or full URLs), one per line                                                                                                           | Instant      | QA / reproducible runs / backfill.             |

### Pass 2 — Detail extraction

For each room detail page, the scraper prioritizes sources as:

1. **`<script type="application/ld+json">` (schema.org/Place + schema.org/LodgingBusiness + schema.org/Review)** — stable, field-rich, CSS-class independent. This is the **primary source** for name, address, lat/lng, capacities, ratings, review list, opening hours, images, price range.
2. **DOM table selectors** (`data-testid`/`.spec-table`/`.room-features`) for fields not yet in JSON-LD: host info, response rate, catering details, facilities, accessibility, allowed events, host rules, nearest station.
3. **(browser mode only)** Playwright `page.waitForSelector('.price-widget')` + evaluate for JS-rendered pricing grids.

Extracted fields flow through the **Tagvenue → MasterVenueRecord normalizer** that emits `MasterVenueRecord` matching the `public.master_venue.metadata` schema shape (same `_schema_version`, same nested keys: `capacity.configurations`, `catering.policy`, `av_tech`, `amenities[]`, `restrictions[]`, `pricing.minimum_spend` etc.). The downstream `mi-mc-loader` worker then maps each record 1-to-1 into `public.master_venue_external` row and merges provenance into the parent `public.master_venue` row.

---

## 4. Output & Canonical Schema

The scraper outputs a single JSON file to:

```
<outputDir>/<slug>-<YYYY-MM-DD>.json
```

where `<outputDir>` defaults to `/data` (fixed container mount point; overridable via `--output-dir` / `TV_OUTPUT_DIR`) and `<slug>` is the city slug or `tagvenue-venues` when no city filter is used.

Each array element is one **Tagvenue room record** (i.e. one `MasterVenueRecord`) with the following top-level shape (matches the shape the `mi-mc-loader` worker expects as input — see also [platform architecture](file:///d:/git_clones/homelab/IQKV/ms/shortlisty-system-design-documentation/docs/platform/architecture.md) and the [Master Catalog cold-start notes](file:///d:/git_clones/homelab/IQKV/ms/shortlisty-system-design-documentation/docs/business/Personal_Venue_Catalog/cold-start.md)):

```json
{
  "_schema_version": 1,
  "external_id": "tagvenue:room:25426",
  "external_source": "tagvenue",
  "source": "web_scrape",
  "name": "Mala Madre Events Space at The Last Talisman",
  "aliases": ["The Last Talisman — Mala Madre"],
  "address": "171-173 Bermondsey Street, London SE1 3UW, GB",
  "city": "London",
  "country_code": "GB",
  "postal_code": "SE1 3UW",
  "location": { "lat": 51.499067, "lng": -0.0808991 },
  "description": "A stone's throw from London Bridge Station…",
  "nearest_station": {
    "name": "London Bridge Station",
    "distance_miles": 0.5
  },
  "venue_name": "The Last Talisman",
  "company": {
    "manager_name": "Dovile S.",
    "response_time_minutes": 39,
    "response_rate": 0.9991
  },
  "tagvenue_ids": {
    "room_id": 25426,
    "venue_id": 11896,
    "company_id": 67
  },
  "rating": {
    "value": 4.7,
    "review_count": 588,
    "source": "tagvenue"
  },
  "photos": {
    "count": 69,
    "main_image": "https://www.tagvenue.com/resize/07/49/widen-1680-noupsize;25426-mala-madre-events-space-room.jpg",
    "gallery": [
      "https://www.tagvenue.com/resize/07/49/widen-1680-noupsize;25426-mala-madre-events-space-room.jpg"
    ]
  },
  "source_url": "https://www.tagvenue.com/rooms/london/25426/the-last-talisman/mala-madre-events-space",
  "metadata": {
    "_schema_version": 1,
    "capacity": {
      "max_total": 90,
      "configurations": {
        "standing": 90,
        "banquet": 60,
        "theater": null,
        "classroom": null,
        "cocktail": null,
        "conference": null,
        "boardroom": 18
      },
      "min_attendees_per_event": 30
    },
    "venue_type": ["restaurant_private_event_space"],
    "catering": {
      "policy": "in_house_exclusive",
      "kosher_available": false,
      "halal_available": false,
      "vegan_available": true,
      "vegetarian_available": true,
      "gluten_free_available": true,
      "alcohol_licence_until": "01:30",
      "byo_alcohol_allowed": false,
      "external_catering_allowed": false,
      "cuisines_available": ["asian"]
    },
    "av_tech": {
      "built_in_av": true,
      "wifi": true,
      "projector": true,
      "screens": 3,
      "speakers": true,
      "pa_system": true,
      "flatscreen_tv": true,
      "whiteboard": true,
      "flipchart": true,
      "conference_call": false
    },
    "accessibility": {
      "ada_compliant": false,
      "elevator_access": false,
      "accessible_restrooms": false,
      "wheelchair_stage_access": false,
      "wheelchair_accessible": false,
      "ground_level": false,
      "disabled_parking": false,
      "cargo_lift": false
    },
    "logistics": {
      "air_conditioning": true,
      "natural_light": true,
      "private_bar": true,
      "private_entrance": true,
      "private_toilets": true,
      "parking_available": true,
      "paid_parking_nearby": true,
      "storage_space": false,
      "quiet_space": false,
      "noise_restriction_after": "23:00",
      "alcohol_licence": true
    },
    "amenities": [
      "Wi-Fi",
      "Projector",
      "Flatscreen TV",
      "Whiteboard",
      "Flipchart",
      "PA system / speakers",
      "Air conditioner",
      "Natural light",
      "Paid parking facilities available nearby",
      "Private Bar",
      "Private Entrance",
      "Private Toilets"
    ],
    "restrictions": [
      "No smoking in the building",
      "Outside catering is not allowed",
      "BYO alcohol not allowed",
      "No promoted and ticketed events allowed",
      "Bring your own DJ not allowed",
      "No wedding licence"
    ],
    "pricing": {
      "currency": "GBP",
      "minimum_spend": null,
      "rental_fee_indicative": null,
      "price_range_hint": "from £10 per person / per session",
      "price_method": "per_person_per_session"
    },
    "music_and_sound": {
      "play_own_music_allowed": true,
      "byo_dj_allowed": false,
      "noise_restriction_after": "23:00"
    },
    "contacts": [{ "name": "Dovile S.", "role": "Venue Manager" }]
  },
  "reviews": [
    {
      "author": "Luisa P.",
      "date": "2025-09-09",
      "rating": 4.8,
      "text": "I celebrated my 30's at Mala Madre and it was amazing!!…"
    }
  ],
  "confidence": 0.78,
  "scrape_run": {
    "at": "2026-08-12T03:14:07.123Z",
    "fetcher": "http",
    "fetcher_version": "0.1.0",
    "duration_ms": 1183,
    "http_status": 200
  }
}
```

### Provenance & confidence

- `confidence` defaults to **0.70–0.82** (web scraped source). It degrades to 0.55 when JSON-LD is missing and fields come only from DOM selectors.
- `scrape_run.fetcher` is `http` (SSR mode) or `browser` (Playwright mode) so downstream dedup logic can weight fields accordingly.
- `external_id` format: `tagvenue:room:<room_id>` — stable across runs. The importer worker uses the composite key `(external_source, external_id)` to UPSERT into `public.master_venue_external`. If the row exists → update `last_seen_at` + merge provenance into the parent `master_venue`. If not → proceed to name+alias+geo fuzzy dedup against `public.master_venue` to decide MERGE vs CREATE new master row.

---

## 5. Configuration (3-tier override)

Priority order (last wins):

```
DEFAULTS (hardcoded in src/config.js)
  → ENVIRONMENT VARIABLES (prefixed TV_)
    → --config file.json
      → CLI ARGUMENTS
```

### 5.1 Full parameter reference

| CLI long            | Short | ENV var              | Default                                                                  | Description                                                                                                                                             |
| ------------------- | ----- | -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mode`            | `-m`  | `TV_MODE`            | `sitemap`                                                                | Discovery mode: `sitemap`, `search`, `urls-file`.                                                                                                       |
| `--city`            |       | `TV_CITY`            | `null`                                                                   | City filter for search mode, and slug in output filename.                                                                                               |
| `--country`         |       | `TV_COUNTRY`         | `null`                                                                   | ISO country code (2-letter) used together with `--city`.                                                                                                |
| `--people`          |       | `TV_PEOPLE`          | `null`                                                                   | Minimum attendee count for search filters.                                                                                                              |
| `--date`            |       | `TV_DATE`            | `null`                                                                   | Date string `YYYY-MM-DD` for availability-filtered search.                                                                                              |
| `--time-from`       |       | `TV_TIME_FROM`       | `null`                                                                   | Numeric slot key matching Tagvenue's time picker (search mode).                                                                                         |
| `--time-to`         |       | `TV_TIME_TO`         | `null`                                                                   | Numeric slot key matching Tagvenue's time picker (search mode).                                                                                         |
| `--min-price`       |       | `TV_MIN_PRICE`       | `null`                                                                   | Minimum price filter (search mode).                                                                                                                     |
| `--max-price`       |       | `TV_MAX_PRICE`       | `null`                                                                   | Maximum price filter (search mode).                                                                                                                     |
| `--limit`           | `-l`  | `TV_LIMIT`           | `100`                                                                    | Max number of room URLs to pass through the detail pass. `0` = no cap.                                                                                  |
| `--page`            |       | `TV_PAGE`            | `1`                                                                      | Starting page for `search` mode.                                                                                                                        |
| `--urls-file`       |       | `TV_URLS_FILE`       | `null`                                                                   | Path to a line-delimited list of full /rooms/ URLs (mode `urls-file`).                                                                                  |
| `--concurrency`     | `-c`  | `TV_CONCURRENCY`     | `5`                                                                      | Concurrent detail-pass HTTP requests. Keep low (3–8) to avoid bans.                                                                                     |
| `--min-delay-ms`    |       | `TV_MIN_DELAY_MS`    | `600`                                                                    | Minimum delay between requests (ms). Random jitter of ±`--jitter-ms` is added.                                                                          |
| `--jitter-ms`       |       | `TV_JITTER_MS`       | `400`                                                                    | Maximum additional random delay added to `--min-delay-ms`.                                                                                              |
| `--timeout-ms`      |       | `TV_TIMEOUT_MS`      | `15000`                                                                  | Per-request timeout (ms).                                                                                                                               |
| `--retries`         |       | `TV_RETRIES`         | `3`                                                                      | Retry attempts per URL on 429/5xx/network failures.                                                                                                     |
| `--user-agent`      |       | `TV_USER_AGENT`      | (Chrome 126 desktop UA string)                                           | Override user agent header.                                                                                                                             |
| `--proxy`           |       | `TV_PROXY`           | `null`                                                                   | `http://user:pass@host:port` proxy URL for outgoing requests (both modes).                                                                              |
| `--browser`         |       | `TV_BROWSER`         | `false`                                                                  | Use Playwright Chromium instead of axios/cheerio for the detail pass. Needs `optionalDependencies` installed (`pnpm install` includes them by default). |
| `--browser-stealth` |       | `TV_BROWSER_STEALTH` | `true`                                                                   | Apply `playwright-stealth` plugins when in browser mode.                                                                                                |
| `--output-dir`      | `-o`  | `TV_OUTPUT_DIR`      | `/data`                                                                  | Directory where the output JSON and optional log are written. Volume mount target.                                                                      |
| `--output-file`     |       | `TV_OUTPUT_FILE`     | auto (`{city}-{YYYY-MM-DD}.json` or `tagvenue-venues-{YYYY-MM-DD}.json`) | Explicit output file name inside `--output-dir`.                                                                                                        |
| `--config`          |       | —                    | `null`                                                                   | Path to a JSON file whose keys are merged in at the `--config` priority tier (see §5 intro).                                                            |
| `--log-level`       |       | `TV_LOG_LEVEL`       | `info`                                                                   | `trace` \| `debug` \| `info` \| `warn` \| `error`.                                                                                                      |
| `--log-file`        |       | `TV_LOG_FILE`        | `null`                                                                   | Optional file name in `--output-dir` to also tee logs to disk alongside stdout.                                                                         |
| `--dry-run`         |       | `TV_DRY_RUN`         | `false`                                                                  | Run only the discovery pass and print the URL list; skip detail fetch.                                                                                  |
| `--help`            | `-h`  | —                    | —                                                                        | Print the CLI help.                                                                                                                                     |

---

## 6. Usage

### 6.1 Prerequisites

- **Node.js 22.13+** (see `engines` in [package.json](package.json)).
- **pnpm 10.33.2+** (see `packageManager` in [package.json](package.json)).
- (optional) Docker 24+ / nerdctl for image build and run.

### 6.2 Local installation

```bash
cd mc-ingest-tagvenue-scraper

# Install deps (playwright is optional; pnpm installs it by default because it's "optionalDependencies")
pnpm install

# If you need browser mode and want Chromium downloaded explicitly:
pnpm exec playwright install chromium --with-deps

# Optional: populate env
cp .env.example .env
```

### 6.3 CLI quick runs

```bash
# Discovery pass only — dry-run, print the first 50 URLs it would scrape (city search)
pnpm start --mode search --city london --country GB --limit 50 --dry-run

# Full sitemap run, 100 rooms, SSR HTTP mode, write to ./output
pnpm start --mode sitemap --limit 100 --output-dir ./output --log-level info

# Filtered city search for 200-person conferences, 10 results, browser mode (JS pricing)
pnpm start \
  --mode search \
  --city berlin \
  --country DE \
  --people 200 \
  --limit 10 \
  --browser \
  --output-dir ./output

# Custom URLs file, read list from ./urls/amsterdam-50.txt, custom UA, through proxy
pnpm start \
  --mode urls-file \
  --urls-file ./urls/amsterdam-50.txt \
  --proxy 'http://user:pass@residential-proxy.example:22225' \
  --user-agent 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 …'
```

### 6.4 Docker Quick Start

```bash
# 1. Build the SSR-only slim image (~140MB compressed; excludes Playwright browsers)
docker build -t iqkv/mc-ingest-tagvenue-scraper:latest .

# 2. Or build the with-browser variant (tagged separately, ~800MB, includes Chromium + deps)
docker build \
  --build-arg INSTALL_PLAYWRIGHT=1 \
  -t iqkv/mc-ingest-tagvenue-scraper:with-browser .

# 3. Run sitemap 100-venue scrape into local ./data dir
docker run --rm \
  -v "$(pwd)/data:/data" \
  iqkv/mc-ingest-tagvenue-scraper:latest \
  --mode sitemap --limit 100

# 4. Run city search filtered via ENV vars (no CLI args)
docker run --rm \
  -v "$(pwd)/data:/data" \
  -e TV_MODE=search \
  -e TV_CITY=london \
  -e TV_COUNTRY=GB \
  -e TV_PEOPLE=100 \
  -e TV_LIMIT=30 \
  iqkv/mc-ingest-tagvenue-scraper:latest

# 5. With-browser variant for JS-rendered pricing tables
docker run --rm \
  -v "$(pwd)/data:/data" \
  -e TV_PROXY='http://user:pass@residential-proxy.example:22225' \
  iqkv/mc-ingest-tagvenue-scraper:with-browser \
  --browser --mode search --city madrid --country ES --limit 25
```

### 6.5 Kubernetes: One-shot Job

```yaml
# k8s/job-london-100.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: tagvenue-london-100
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: scraper
          image: iqkv/mc-ingest-tagvenue-scraper:latest
          imagePullPolicy: IfNotPresent
          resources:
            requests: { cpu: "250m", memory: "128Mi" }
            limits: { cpu: "1000m", memory: "384Mi" }
          volumeMounts:
            - name: output
              mountPath: /data
          env:
            - name: TV_MODE
              value: "search"
            - name: TV_CITY
              value: "london"
            - name: TV_COUNTRY
              value: "GB"
            - name: TV_PEOPLE
              value: "120"
            - name: TV_LIMIT
              value: "100"
            - name: TV_LOG_LEVEL
              value: "info"
            - name: TV_PROXY
              valueFrom:
                secretKeyRef: { name: scraper-secrets, key: residential-proxy }
      volumes:
        - name: output
          persistentVolumeClaim:
            claimName: shortlisty-master-catalog-scrape-pvc
```

Apply: `kubectl apply -f k8s/job-london-100.yaml`.

### 6.6 Kubernetes: Scheduled CronJob (daily cold-start refresh)

```yaml
# k8s/cronjob-daily-sitemap.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: tagvenue-daily-sitemap
spec:
  schedule: "0 3 * * *" # 03:00 UTC daily
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      ttlSecondsAfterFinished: 172800
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: scraper
              image: iqkv/mc-ingest-tagvenue-scraper:latest
              args: ["--mode", "sitemap", "--limit", "0", "--concurrency", "4"]
              resources:
                requests: { cpu: "500m", memory: "256Mi" }
                limits: { cpu: "2000m", memory: "512Mi" }
              volumeMounts:
                - { name: output, mountPath: /data }
              env:
                - { name: TV_LOG_LEVEL, value: "warn" }
                - { name: TV_OUTPUT_FILE, value: "tagvenue-sitemap-latest.json" }
          volumes:
            - name: output
              persistentVolumeClaim:
                claimName: shortlisty-master-catalog-scrape-pvc
```

The scraped JSON is dropped into `/data` shared PV; wire a follow-up **`mi-mc-loader`** Job (or watcher process) that consumes new files, UPSERTs into `public.master_venue_external`, and runs the fuzzy dedup+merge pipeline against `public.master_venue` (see §9).

---

## 7. Project Structure

```
mc-ingest-tagvenue-scraper/
├── bin/
│   └── scrape.js                 # CLI entrypoint — shebang + delegates to src/cli.js
├── src/
│   ├── cli.js                    # CLI argv parsing → runner orchestration
│   ├── config.js                 # 3-tier defaults/ENV/config-file/CLI resolver
│   ├── run.js                    # Runner: discovery → detail pass → writer
│   ├── master-catalog/
│   │   └── master-venue-record.js  # Shared MasterVenueRecord shape (matches public.master_venue.metadata schema)
│   ├── discovery/
│   │   ├── sitemap.js            # robots.txt aware sitemap.xml / sitemap-rooms parser
│   │   └── search.js             # ?page=1…N paginated search URL collector
│   ├── fetchers/
│   │   ├── http.js               # axios + retries, timeout, proxy, UA, throttling
│   │   ├── browser.js            # playwright (optional) browser fetcher factory
│   │   └── robots.js             # robots-parser wrapper + cached /robots.txt
│   ├── providers/
│   │   └── tagvenue/
│   │       ├── selectors.js      # JSON-LD paths + CSS selectors catalog
│   │       ├── extractor.js      # (html|page) → raw tagvenue record
│   │       └── normalizer.js     # raw tagvenue record → MasterVenueRecord
│   ├── output/
│   │   ├── json-writer.js        # Atomic write + BOM-free JSON + _last.json symlink
│   │   └── logger.js             # Log level + stdout + optional file tee
│   └── utils/
│       ├── concurrency.js        # p-queue wrapper with progress events
│       ├── rate-limit.js         # p-throttle + min-delay/jitter composition
│       └── normalize.js          # String/currency/capacity/country-code helpers
├── docs/
│   ├── api/README.md             # Future: public API surface of lib exports
│   ├── architecture/README.md    # Design notes, provider contract, future adapters
│   └── deployment/README.md      # K8s manifests, Helm notes, OCI image push scripts
├── examples/
│   └── london-100.json           # Sample output payload shape
├── .env.example
├── .dockerignore
├── Dockerfile                    # Slim (SSR) image; INSTALL_PLAYWRIGHT=1 → full image
└── package.json
```

---

## 8. Development

```bash
# Install
pnpm install

# Dev loop (node --watch, debug log level)
pnpm dev --mode search --city amsterdam --country NL --limit 5 --output-dir ./data

# Quality checks
pnpm lint
pnpm formatter:check
pnpm formatter:write

# Type check (JS via JSDoc + jsconfig.json)
pnpm typecheck
```

Commit messages follow conventional commits via commitlint/husky, same as the rest of the monorepo. See `COMMIT_CONVENTION.md` in `.github/`.

---

## 9. Shortlisty Intelligence Integration (Venue Master Catalog Backdrop)

This scraper is the **Tagvenue provider adapter** of the Shortlisty internal **Venue Master Catalog (MC)** population pipeline. The MC is a hidden internal reference dataset (never exposed directly to tenants) that powers three invisible backdrop capabilities — (1) silent gap-fill / auto-enrich when agents upload asset PDFs, (2) silent form auto-populate when agents create a venue, (3) ingestion-time dedup so we don't create 50 "Grand Hyatt Dubai" duplicate master rows.

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  INGESTION DECOMPOSITION — 4 small workers, NOT 1 big processing-worker             │
│                                                                                     │
│  ┌───────────────────────────────┐                                                   │
│  │ mc-ingest-tagvenue-scraper │  ◀  YOU ARE HERE. Node.js SSR / Browser CLI.     │
│  │  (K8s Job / CronJob, Node.js) │    Stateless. NO DB connections, EVER.         │
│  └────────────┬──────────────────┘                                                   │
│               │ writes JSON envelope: List<MasterVenueRecord>                       │
│               ▼                                                                     │
│     /data/shortlisty-master-catalog-scrape-pvc/tagvenue-london-2026-08-12.json        │
│               │                                                                     │
│  ┌────────────▼────────────────────────────────────────────────────────────────┐    │
│  │ NEW: mi-mc-loader  — Spring Boot Worker / CLI (NEXT TO BUILD) │    │
│  │                                                                            │    │
│  │  1. Reads envelope. Validates schema. Counts stats.                         │    │
│  │  2. FOR EACH MasterVenueRecord:                                             │    │
│  │     a. UPSERT public.master_venue_external                                  │    │
│  │        UNIQUE(external_source='tagvenue', external_id=record.external_id)   │    │
│  │        → if FOUND → update last_seen_at, confidence, provider_raw_data → SKIP dedup│
│  │        → if NEW   → proceed to step b (fuzzy dedup)                          │    │
│  │                                                                            │    │
│  │     b. Fuzzy dedup against existing public.master_venue                     │    │
│  │        Candidates: same city + same country                                 │    │
│  │        Score A: pg_trgm similarity(record.name, master_venue.name + aliases)│    │
│        Score B: PostGIS ST_DWithin(record.location, master_venue.location, 200m)│    │
│  │        Combined = 0.6·A + 0.4·B                                             │    │
│  │        Thresholds: ≥ 0.75 (with geo) OR ≥ 0.90 (text-only)                  │    │
│  │        Ambiguity guard: top1 - top2 ≥ 0.08 OR flag for human review         │    │
│  │                                                                            │    │
│  │     c. MERGE (match) OR CREATE (no match) → public.master_venue             │    │
│  │        Field conflict priority: MANUAL_OVERRIDE > VERIFIED > HIGH_CONF_AI > │    │
│  │                                     MC_INHERIT(priority=7) > MEDIUM > LOW > │    │
│  │                                     SCRAPE_PROVIDER(0.70…0.82)              │    │
│  │                                                                            │    │
│  │  3. Write audit row → public.master_venue_import_log                       │    │
│  │  4. (Optional) Publish RabbitMQ: master.venue.imported.batch               │    │
│  └─────────────────────────────────┬──────────────────────────────────────────┘    │
│                                    │ writes                                         │
│                                    ▼                                                │
│                 PostgreSQL public schema:                                            │
│                   master_venue              (canonical master rows)                  │
│                   master_venue_alias        (pg_trgm GIN dedup aliases)              │
│                   master_venue_external     (1 master ↔ N provider records)          │
│                   master_venue_import_log   (audit per import run)                   │
│                                    │                                                │
│                                    │ ▼ 3 INVISIBLE backdrop consumers:              │
│                                    │                                                │
│                                    ├─ ① Gap-fill at asset-ETL time                  │
│                                    │   Planner uploads PDF → t_xxx.venue upload     │
│                                    │   → match venue by name+city+geo against MC   │
│                                    │   → if match: copy 23 non-null fields into      │
│                                    │     venue.metadata, provenance=MC_INHERIT(7)    │
│                                    │   → Planner just sees "✓ 23 fields auto-filled"│
│                                    │                                                │
│                                    ├─ ② Silent form auto-populate                   │
│                                    │   Planner types "Grand Hyatt Dubai" in CreateVenue│
│                                    │   → backend fuzzy-finds MC match                │
│                                    │   → pre-fills all non-conflicting fields.       │
│                                    │   Planner edits freely; wrong-match overrides   │
│                                    │   become MANUAL_OVERRIDE priority 10.          │
│                                    │                                                │
│                                    └─ ③ Ingestion-time dedup (step 2b above)       │
│                                                                                     │
│  ⚠️ Branch B cross-source interleaved search (ADR D4 Option D) = DEFERRED / NOT USED│
│     for v0.1–v1.0. Master Catalog only works via the 3 invisible backdrop patterns.│
│     Tenants NEVER see "Search Master Catalog" or "Include Master suggestions" in UI│
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Downstream design docs:

- [Platform Architecture Reference (Shortlisty)](../shortlisty-system-design-documentation/docs/platform/architecture.md)
- [Master Catalog cold-start, dedup thresholds & merge rules (Shortlisty)](../shortlisty-system-design-documentation/docs/business/Personal_Venue_Catalog/cold-start.md)
- [Metadata aggregation, provenance priority list & MC_INHERIT role (Shortlisty)](../shortlisty-system-design-documentation/docs/platform/architecture.md#3-metadata-aggregation)
- [Architecture notes for this specific scraper](docs/architecture/README.md)

---

## 10. License

Proprietary — IQKV exclusive. See [LICENSE](LICENSE) file for the full terms.

---

## 11. Resources

- [Changelog](./CHANGELOG.md)
- [Deployment guides](./docs/deployment/README.md)
- [Architecture notes](./docs/architecture/README.md)
- [API surface notes](./docs/api/README.md)
- Upstream: [Tagvenue sitemap (public)](https://www.tagvenue.com/sitemap.xml)
- Reference (closed-source, Apify Actors):
  - `dionysus_way/tagvenue-venue-scraper` (Apify Store)
  - `lexis-solutions/tagvenue-scraper` (Apify Store)

---

<div align="center">

**Part of the IQKV Shortlisty Intelligence family.**

Brought to you by the IQKV data & platform teams.

</div>
