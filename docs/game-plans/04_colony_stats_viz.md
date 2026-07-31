# Colony Stats — Data Population & Visualizations (Phase 2)

> **STATUS — Phase 2A DONE (2026-06-22).** Built beyond the original spec:
> all **13 domains** (not 6), live/snapshot toggle, and four visualization
> families. Details in the "Phase 2A — As Built" section below.

## Goal

Populate EventForge data locally, build the Colony Stats visualization
page, and wire it up. AWS cloud deployment is a later phase (live demo).

## Two-Phase Approach

```
Phase 2A (this session) — local data + static visualizations
─────────────────────────────────────────────────────────────
EventForge runs locally → cmd/exporter writes snapshots/latest.json
Colony Stats page reads the JSON snapshot → Chart.js visualizations
Charts are static (snapshot-based), no Lambda needed yet
Deploy: snapshot JSON uploaded to S3/CDN manually, or served via
        existing Lambda as a one-shot file proxy

Phase 2B (live demo, later) — cloud pipeline + live refresh
─────────────────────────────────────────────────────────────
EC2 spot VM runs EventForge → cold-tier Parquet archived to AWS S3
marsapiens_colony_stats Lambda (DuckDB-in-Lambda) queries Parquet
Colony Stats page polls Lambda every 30s → live charts
```

---

## Phase 2A — Local Run + Snapshot Visualizations

### Architecture

```
Local machine
│
├── make up && make sim          (EventForge Docker stack)
│       ↓ 14k ev/s, ~30 min
├── make cold HOT=5m             (archive to MinIO)
├── go run ./cmd/exporter -once  (writes snapshots/latest.json)
│       ↓
│   snapshots/latest.json        ← the data source for Phase 2A
│
└── Upload to S3 manually (aws s3 cp) or serve via admin Lambda
        ↓
    GET /colony/snapshot  →  returns latest.json
        ↓
    src/colony-stats/index.html + colony-stats.js
        Chart.js charts, domain tabs, health summary cards
```

### Step 1 — Run EventForge locally, populate data

```bash
cd eventforge
make up                   # start all services
make sim                  # run for 20–30 min at 14k ev/s (Ctrl+C when done)
make cold HOT=5m          # archive aged rows to MinIO as Parquet
make verify               # confirm row counts + domain coverage
go run ./cmd/exporter -once  # writes snapshots/latest.json
```

Check the snapshot:
```bash
cat snapshots/latest.json | python3 -m json.tool | head -60
```

### Step 2 — Extend cmd/exporter output (if needed)

Current `latest.json` shape (from P1.4). Extend if the page needs more:

```json
{
  "generated_at": "2026-06-22T12:00:00Z",
  "sim_tick": 3600,
  "planet": "mars",
  "domains": {
    "weather": {
      "metrics": {
        "dust_opacity":   { "avg": 0.42, "min": 0.1,  "max": 0.9  },
        "temperature_c":  { "avg": -23,  "min": -61,  "max": 5    },
        "wind_speed_ms":  { "avg": 14.2, "min": 0.5,  "max": 38   }
      },
      "trend": "stable",
      "alert": null
    },
    "energy": {
      "metrics": {
        "solar_output":   { "avg": 0.87, "min": 0.0,  "max": 1.0  },
        "battery_level":  { "avg": 0.61, "min": 0.1,  "max": 0.99 }
      },
      "trend": "declining",
      "alert": { "severity": "warning", "msg": "Solar below threshold" }
    }
    ...13 domains total
  },
  "alerts": [
    { "domain": "energy", "severity": "warning", "msg": "Solar below threshold" }
  ],
  "history": {
    "weather": [
      { "ts": "2026-06-22T11:00:00Z", "dust_opacity": 0.38, "temperature_c": -24 },
      ...
    ]
  }
}
```

The `history` key (per-domain time series, last N 5-min buckets) powers
the line charts. If `cmd/exporter` doesn't emit it yet, add it — reads
from `ef.rollup_5m`.

### Step 3 — Serve the snapshot

**Option A (simplest):** Upload `latest.json` to the existing
`marsapiens.com` S3 bucket under `/assets/colony/snapshot.json` and serve
via CloudFront. No new Lambda. The Colony Stats page fetches it directly.

```bash
aws s3 cp snapshots/latest.json \
  s3://marsapiens.com/assets/colony/snapshot.json \
  --cache-control "max-age=300"
```

**Option B:** Add a thin route to the existing `marsapiens_admin_api`
Lambda — `GET /colony/snapshot` returns the JSON. Keeps data off the
public S3 path if preferred.

Default: **Option A** — simplest, no Lambda changes, CloudFront caches it.

### Step 4 — Colony Stats page: charts

Replace the placeholder in `src/colony-stats/index.html` with real chart
UI. Create `src/js/colony-stats.js`.

**Page layout:**

```
┌───────────────────────────────────────────────────────┐
│  COLONY STATS          [● LIVE · updated 2 min ago]   │
├───────────────────────────────────────────────────────┤
│  Colony Health — summary cards (top 6 key domains)    │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐    │
│  │ ENERGY  │ │ WEATHER │ │  AGRI   │ │ ECONOMY │    │
│  │  87%  ↑ │ │CLEAR  → │ │  GOOD ↓ │ │ +2.1% ↑ │    │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘    │
├───────────────────────────────────────────────────────┤
│  [ALERT] Energy: solar output below threshold         │
├───────────────────────────────────────────────────────┤
│  Domain Deep-Dive                                     │
│  [WEATHER][ENERGY][AGRI][MINING][TRANSPORT][+8 more]  │
│                                                       │
│  ┌───────────────────────────────────────────────┐   │
│  │  Line chart — key metrics over time           │   │
│  │  (last 1h / 6h / 24h toggle)                  │   │
│  └───────────────────────────────────────────────┘   │
│                                                       │
│  Metric breakdown table (avg / min / max)             │
└───────────────────────────────────────────────────────┘
```

**Files:**

| File | Action |
|---|---|
| `src/colony-stats/index.html` | Replace placeholder with full chart layout |
| `src/js/colony-stats.js` | Fetch snapshot, render Chart.js charts + cards |
| `src/css/colony-stats.css` | Extend with grid, chart container, card styles |

**Chart.js config:**
- Dark theme: `Chart.defaults.color = 'rgba(255,255,255,0.6)'`
- Primary line: cyan `#00f0ff`; alert/critical: red `#ff003c`
- Minimal grid: `grid.color = 'rgba(255,255,255,0.06)'`
- Monospace tick labels, no legend box borders
- Responsive: full-width on mobile, side-by-side on desktop

**colony-stats.js outline:**

```js
const SNAPSHOT_URL = '/assets/colony/snapshot.json';
const DOMAINS = ['weather','atmosphere','energy','water','agriculture',
                 'mining','manufacturing','transport','research',
                 'population','economy','governance','datacenters'];

async function loadSnapshot() { ... }
function renderSummaryCards(domains) { ... }
function renderAlerts(alerts) { ... }
function renderDomainChart(domain, history, range) { ... }  // Chart.js
function initTabs() { ... }
```

### Step 5 — Deploy

```bash
# push frontend changes
git add src/colony-stats/ src/js/colony-stats.js src/css/colony-stats.css
git commit && git push   # triggers GitHub Actions → terraform apply

# upload snapshot (manual, once)
aws s3 cp snapshots/latest.json s3://marsapiens.com/assets/colony/snapshot.json
```

The page is now live at `https://marsapiens.com/colony-stats/` with real
simulated data. Snapshot is static until Phase 2B.

---

## Phase 2B — Cloud Pipeline + Live Data (later)

When ready to do a live demo, this is the delta on top of 2A:

### EC2 spot VM

```bash
# launch t3.medium spot (ap-south-1) — ~$0.015/hr
# SSH in, clone repo, run EventForge
git clone https://github.com/ankitsriv89/marsapiens.git
cd marsapiens/eventforge && make up && make sim

# archive to real S3 every 5 min (daemon mode)
go run ./cmd/coldtier -interval 5m \
  -s3-endpoint https://s3.ap-south-1.amazonaws.com \
  -s3-bucket marsapiens-ef-cold \
  -s3-access-key $AWS_ACCESS_KEY_ID \
  -s3-secret-key $AWS_SECRET_ACCESS_KEY

# refresh snapshot every 30s
watch -n 30 'go run ./cmd/exporter -once && \
  aws s3 cp snapshots/latest.json s3://marsapiens.com/assets/colony/snapshot.json'
```

Tear down the VM after the demo — data persists in S3.
**Cost estimate:** 2-hour demo run ≈ ₹5 total.

### Lambda: marsapiens_colony_stats (optional upgrade)

Only needed if you want per-domain time-series queries against the Parquet
cold tier (richer charts). DuckDB-in-Lambda reads directly from S3:

| Route | What |
|---|---|
| `GET /colony/snapshot` | Proxies `latest.json` from S3 (replaces CloudFront file) |
| `GET /colony/domain?d=weather&range=6h` | DuckDB queries Parquet → chart JSON |

Lambda config: Python 3.12, 512 MB, 30s timeout, DuckDB layer.
Terraform: new resource in `terraform/lambda.tf`.

---

## Sequencing — Phase 2A (next session)

```
1. Run EventForge locally (30 min)
   make up → make sim → make cold HOT=5m → cmd/exporter

2. Inspect + extend snapshot JSON if needed (30 min)
   Add history[] time-series to exporter output

3. Upload snapshot to S3 (5 min)
   aws s3 cp snapshots/latest.json s3://marsapiens.com/assets/colony/snapshot.json

4. Build Colony Stats page (1.5–2 hr)
   index.html layout + colony-stats.js + CSS

5. Test locally with Live Server (30 min)

6. Commit + push → auto-deploy (15 min)
```

**Total: ~3 hours for a live page with real simulated data.**

---

## Files to Create / Modify (Phase 2A)

| File | Action | Notes |
|---|---|---|
| `eventforge/cmd/exporter/main.go` | maybe modify | add `history[]` time-series to output |
| `src/colony-stats/index.html` | replace | full chart layout |
| `src/js/colony-stats.js` | create | fetch, Chart.js, tabs, cards |
| `src/css/colony-stats.css` | extend | chart container, summary cards, alert bar |

Phase 2B adds: `terraform/s3.tf`, `terraform/lambda.tf`, `lambda/colony_stats_handler.py`

---

---

## Phase 2A — As Built (2026-06-22)

Diverged from / exceeded the original spec. What actually shipped:

### Data
- **All 13 domains** surfaced (spec assumed 6). The exporter now reads the
  **micro tier** from `ef.telemetry_1m` — the only tier covering every domain
  (38 metrics). Macro tier (6 domains) holds true colony totals; a future
  "colony truth" toggle can expose those. See
  [`docs/eventforge/data-dictionary.md`](../eventforge/data-dictionary.md) for
  the full data-point reference (generation logic, units, ranges, tiers).
- **Exporter rewrite** ([`cmd/exporter/main.go`](../../eventforge/cmd/exporter/main.go)):
  emits `domains` (avg/min/max/last + trend + alert + label/blurb + sample
  count), `alerts[]`, `history` (per-domain per-metric 1m series), and `meta`
  (window, bucket range, totals, source). Atomic write (`.tmp` + rename) so the
  page never reads a half-written file in loop mode. `-interval` loop mode feeds
  live polling; `-window` controls history depth.

### Page (`public/colony-stats/`)
- **Live / Snapshot toggle.** REAL-TIME polls the snapshot every 15s and is
  enabled **only when the served snapshot is < 90s old** (i.e. a live exporter
  loop is running). On a static deploy it auto-disables → honest "snapshot only"
  UX. Re-enables automatically during a local live demo.
- **Four visualization families:** radar (13-domain colony-vitals web), radial
  gauges (4 critical systems), per-card sparklines, and a deep-dive chart with
  line / area / bar types.
- **Smart scaling:** AUTO-AXIS auto-splits mixed-magnitude metrics onto L/R axes
  (span > 50×); NORMALIZE rescales each series to 0–100% for shape comparison.
- **Controls:** metric filter dropdown, range (15M/1H/2H/ALL), click any metric
  table row to isolate it, per-tab metadata panel.
- Vendored locally (no CDN): `vendor/chart.umd.min.js`,
  `vendor/chartjs-adapter-date-fns.bundle.min.js`.

### Deploy
- **Snapshot ships in the static build** (`public/assets/colony/snapshot.json`),
  served as a Cloudflare Pages static asset. No R2/Lambda this phase.
- Hub card added (`public/index.html` + `public/hub.css`, cyan accent).

### Deferred to Phase 2B
- **R2/S3 snapshot storage + refresh.** Move the snapshot off the static build
  into R2 (or AWS S3), refreshed on a schedule, served via a Pages Function
  (mirror the TLE function's "Phase 2: read from R2 snapshot" pattern in
  `functions/api/tle.js`). Enables true live data on the deployed site without a
  redeploy. Live data source = EC2/spot VM or local sim → exporter loop → R2.
- Causal models for the 7 currently-jittered domains; macro "colony truth"
  toggle; diurnal/seasonal cycles; more scenarios. See data-dictionary §6.

## References

- EventForge Phase 1 plan: `docs/game-plans/03_eventforge_pipeline.md`
- **Data dictionary:** `docs/eventforge/data-dictionary.md`
- EventForge code: `eventforge/` (both repos)
- Colony Stats page: `public/colony-stats/` (index.html, colony-stats.js, colony-stats.css)
- Snapshot format: `eventforge/snapshots/latest.json` (after running exporter)
- Lambda pattern (Phase 2B): `lambda/admin_handler.py`
