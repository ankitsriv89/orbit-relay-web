# EventForge — Colony Telemetry Data Dictionary

**Purpose.** This is the source-of-truth reference for *what data the simulation
generates*, *how each value is produced*, and *where it surfaces* in the Colony
Stats dashboard. Use it when adding new metrics, new domains, or richer
visualizations in later phases — it maps every data point from generator →
ClickHouse → snapshot → page.

Last updated: 2026-06-22 (Phase 2A). Catalog source:
[`eventforge/internal/config/catalog.go`](../../eventforge/internal/config/catalog.go).
World model: [`eventforge/internal/sim/world.go`](../../eventforge/internal/sim/world.go).

---

## 1. Pipeline at a glance

```
simulator (world-model tick + micro amplifier)
   │   macro readings  (colony truth, low volume)   tags.tier = macro
   │   micro readings  (per-entity, high volume)     tags.tier = micro
   ▼
Redpanda (mars.<domain> topics)
   ▼
ClickHouse  ef.telemetry_raw         (every reading)
            ef.telemetry_1m / _1h    (rollups: cnt, sum_v, min_v, max_v)
            ef.telemetry_cold        (Parquet/MinIO, aged-out rows)
   ▼
cmd/exporter  → snapshots/latest.json (and public/assets/colony/snapshot.json)
   ▼
Colony Stats page (radar, gauges, sparklines, deep-dive charts)
```

### Two tiers — why values differ

| Tier | Volume | Meaning | Domains covered |
|---|---|---|---|
| **macro** | ~15 readings/region/tick | **Colony truth** — region-level aggregate state, causally modeled. | 6 (weather, energy, water, agriculture, economy, population) |
| **micro** | thousands/sec | **Per-entity** sensor/machine readings, sampled around macro setpoints with ±15% jitter. | **all 13** |

The dashboard (Phase 2A) reads the **micro** tier because it is the only tier
covering all 13 domains. Micro values are *per-entity* (e.g.
`population.headcount ≈ 250` = headcount per the 100 population entities, not the
colony total of ~25 000). The macro tier holds true colony totals for its 6
domains — a future "colony truth" toggle can surface those.

> **When adding a metric:** add it to `catalog.go` (gives it a micro presence
> automatically via the amplifier). To make it *causally modeled* (not just
> jittered mid-range), also add state + a `baseFor` case in `world.go`, and a
> `MacroReadings` line if it should appear in the macro tier.

---

## 2. Domains & metrics

Per-metric columns:
- **Unit** — emitted unit string (surfaces in the page metric table).
- **Catalog range** — `[Min, Max]` from `catalog.go` (used by micro mid-range
  default + radar normalization hints).
- **Entities** — per-region emitting units; sets micro fan-out width.
- **Modeled?** — ✅ = causal state in `world.go`; ◻︎ = jittered catalog mid-range.
- **Tier** — M=macro reading exists, μ=micro reading exists.

### weather — *entities: 50/region*
Surface weather. Dust storms (injected scenario) cascade here first.

| Metric | Unit | Range | Modeled? | Tier | Generation |
|---|---|---|---|---|---|
| `temperature_c` | C | -90…20 | ✅ | M+μ | `-60 + irradiance*45 + noise(2)` |
| `wind_speed_ms` | m/s | 0…120 | ✅ | M+μ | `8 + storm*70 + noise(3)` |
| `pressure_pa` | Pa | 600…1200 | ◻︎ | μ | catalog mid (~900) + jitter |
| `dust_opacity` | tau | 0…5 | ✅ | M+μ | `0.3 + storm*4 + noise(0.1)` |
| `irradiance_pct` | pct | — | ✅ | M | `irradiance*100` (macro-only) |

### atmosphere — *entities: 40/region*
Habitat air composition. Not yet causally modeled (jittered).

| Metric | Unit | Range | Modeled? | Tier | Generation |
|---|---|---|---|---|---|
| `co2_pct` | pct | 94…96 | ◻︎ | μ | catalog mid + jitter |
| `o2_pct` | pct | 0…21 | ◻︎ | μ | catalog mid (~10.5) + jitter |
| `humidity_pct` | pct | 0…100 | ◻︎ | μ | catalog mid + jitter |

### energy — *entities: 5000/region*
Grid generation, load, storage. Reactor-trip scenario depresses solar.

| Metric | Unit | Range | Modeled? | Tier | Generation |
|---|---|---|---|---|---|
| `production_mw` | MW | 0…5 (μ) | ✅ | M+μ | macro `solarCap*irradiance*(1-0.5*reactor)`; micro = ÷entities |
| `consumption_mw` | MW | 0…5 (μ) | ✅ | M+μ | macro `baseLoad + growLight if irr<0.6`; micro = ÷entities |
| `battery_soc_pct` | pct | 0…100 | ✅ | M+μ | `soc + (solar-consumption)*0.5`, clamped |

### water — *entities: 200/region*
Reserves, recycling, extraction. Water-leak scenario drains reserves.

| Metric | Unit | Range | Modeled? | Tier | Generation |
|---|---|---|---|---|---|
| `reserve_pct` | pct | 0…100 | ✅ | M+μ | `reserve - 0.6 - leak*3 + (recycling-90)*0.05` |
| `extraction_lph` | L/h | 0…500 | ◻︎ | μ | catalog mid (~250) + jitter |
| `recycling_pct` | pct | 50…99 | ✅ | M+μ | `95 - deficit*1.5` |

### agriculture — *entities: 2000/region*
Greenhouse output, gated by energy + water availability.

| Metric | Unit | Range | Modeled? | Tier | Generation |
|---|---|---|---|---|---|
| `yield_kg` | kg | 0…800 | ✅ | M+μ | `600*energyAvail*waterAvail`; micro ÷entities |
| `water_consumed_l` | L | 0…400 | ◻︎ | μ | catalog mid (~200) + jitter |
| `soil_moisture_pct` | pct | 0…100 | ✅ | M+μ | `waterAvail*100 + noise(3)` |
| `growth_progress_pct` | pct | 0…100 | ✅ | μ | `growth + energyAvail*2 - 1`, resets at 100 |

### mining — *entities: 500/region* — *not yet modeled*
| Metric | Unit | Range | Tier | Generation |
|---|---|---|---|---|
| `ore_extracted_t` | t | 0…50 | μ | catalog mid (~25) + jitter |
| `drill_temp_c` | C | 0…300 | μ | catalog mid (~150) + jitter |
| `power_draw_kw` | kW | 0…800 | μ | catalog mid (~400) + jitter |

### manufacturing — *entities: 800/region* — *not yet modeled*
| Metric | Unit | Range | Tier | Generation |
|---|---|---|---|---|
| `units_produced` | u | 0…200 | μ | catalog mid (~100) + jitter |
| `defect_rate_pct` | pct | 0…10 | μ | catalog mid (~5) + jitter |
| `power_draw_kw` | kW | 0…600 | μ | catalog mid (~300) + jitter |

### transport — *entities: 1200/region* — *not yet modeled*
| Metric | Unit | Range | Tier | Generation |
|---|---|---|---|---|
| `cargo_moved_t` | t | 0…100 | μ | catalog mid (~50) + jitter |
| `vehicle_speed_ms` | m/s | 0…30 | μ | catalog mid (~15) + jitter |
| `fuel_cells_pct` | pct | 0…100 | μ | catalog mid (~50) + jitter |

### research — *entities: 60/region* — *not yet modeled*
| Metric | Unit | Range | Tier | Generation |
|---|---|---|---|---|
| `experiment_progress_pct` | pct | 0…100 | μ | catalog mid (~50) + jitter |
| `compute_pflops` | PFLOPS | 0…10 | μ | catalog mid (~5) + jitter |

### population — *entities: 100/region*
| Metric | Unit | Range | Modeled? | Tier | Generation |
|---|---|---|---|---|---|
| `headcount` | people | 90000…110000 | ✅ | M+μ | macro `headcount + noise(5)`; micro ÷entities |
| `health_index` | idx | 0…100 | ✅ | μ | `morale*0.9 + 10` |
| `morale_index` | idx | 0…100 | ✅ | M+μ | eases toward `88 - waterStress - foodShort*40` |

### economy — *entities: 30/region*
| Metric | Unit | Range | Modeled? | Tier | Generation |
|---|---|---|---|---|---|
| `price_credits` | cr | 0…1000 | ✅ | μ | `(waterPrice + foodPrice)/2` |
| `trade_volume` | u | 0…50000 | ◻︎ | μ | catalog mid (~25000) + jitter |
| `water_price_credits` | cr | — | ✅ | M | `8*(1 + waterScarcity*1.5)` (macro-only) |
| `food_price_credits` | cr | — | ✅ | M | `12*(1 + yieldShort*1.5)` (macro-only) |

### governance — *entities: 20/region* — *not yet modeled*
| Metric | Unit | Range | Tier | Generation |
|---|---|---|---|---|
| `approval_pct` | pct | 0…100 | μ | catalog mid (~50) + jitter |
| `policy_changes` | n | 0…5 | μ | catalog mid (~2.5) + jitter |

### datacenters — *entities: 3000/region* — *not yet modeled*
| Metric | Unit | Range | Tier | Generation |
|---|---|---|---|---|
| `cpu_usage_pct` | pct | 0…100 | μ | catalog mid (~50) + jitter |
| `power_draw_kw` | kW | 0…20 | μ | catalog mid (~10) + jitter |
| `temp_c` | C | 10…90 | μ | catalog mid (~50) + jitter |

---

## 3. Scenarios (disturbances)

Injected via the control plane; cascade through the causal model. Defined in
[`world.go`](../../eventforge/internal/sim/world.go) `Tick()`.

| Scenario | Effect chain |
|---|---|
| **DustStorm** | ↓irradiance → ↓solar → battery drain + grow-light load → ↓water recycling → ↓yield → ↑food/water price → ↓morale. Also ↑dust_opacity, ↑wind. |
| **ReactorTrip** | ↓solar production (×`1-0.5*severity`) → same downstream energy/water/agri/economy/morale cascade. |
| **WaterLeak** | ↓water reserve (`-leak*3`/tick) → ↑water price → ↓morale. |

> Future: add scenarios (radiation event, supply-ship delay, equipment failure)
> by adding a `Kind` + a branch in `Tick()`. Document the cascade here.

---

## 4. Snapshot JSON contract

`cmd/exporter` writes this shape (consumed by `colony-stats.js`):

```jsonc
{
  "generated_at": "2026-06-22T13:40:00Z",   // RFC3339; page freshness gate (<90s ⇒ live)
  "planet": "mars",
  "meta": {
    "tier": "micro",
    "window_minutes": 120,
    "domain_count": 13,
    "metric_count": 38,
    "total_samples": 7988500,
    "bucket_first": "2026-06-22 12:24:00",
    "bucket_last":  "2026-06-22 12:50:00",
    "bucket_interval": "1m",
    "source": "EventForge · ClickHouse telemetry_1m"
  },
  "domains": {
    "energy": {
      "label": "Energy",
      "blurb": "Power generation, storage and draw…",
      "primary_metric": "battery_soc_pct",   // drives card value, trend, gauge, radar axis
      "trend": "stable",                       // last vs avg of primary (±5%)
      "alert": { "severity": "warning", "msg": "…" } | null,
      "sample_count": 699862,
      "metrics": {
        "battery_soc_pct": { "avg":99.9, "min":68.0, "max":115.0, "last":99.5, "unit":"pct", "samples":233040 }
      }
    }
    // …13 domains
  },
  "alerts": [ { "domain":"water", "severity":"critical", "msg":"…" } ],
  "history": {
    "energy": { "battery_soc_pct": [ { "t":"2026-06-22 12:24:00", "v":99.9 } ] }
    // per-domain → per-metric → 1m time-series within window
  }
}
```

### Alert thresholds (exporter `domainConfig`)
Defined in [`cmd/exporter/main.go`](../../eventforge/cmd/exporter/main.go). To tune
or add alerts, edit `domainConfig` (`alertMetric`, `alertLow`/`alertHigh`,
`severity`, `alertMsg`).

| Domain | Metric | Fires when | Severity |
|---|---|---|---|
| energy | battery_soc_pct | < 20 | warning |
| water | reserve_pct | < 15 | critical |
| weather | dust_opacity | > 0.7 | warning |
| atmosphere | o2_pct | < 8 | critical |
| agriculture | soil_moisture_pct | < 8 | warning |
| population | morale_index | < 20 | warning |
| economy | price_credits | > 28 | warning |
| manufacturing | defect_rate_pct | > 8 | warning |
| governance | approval_pct | < 25 | warning |
| datacenters | temp_c | > 75 | warning |

---

## 5. Dashboard mapping

How each snapshot field becomes a visual ([`colony-stats.js`](../../public/colony-stats/colony-stats.js)):

| Visual | Source | Notes |
|---|---|---|
| **Radar** (colony vitals) | each domain's `primary_metric` last value | normalized 0–100 via `RADAR_RANGE`; weather/economy inverted (low = healthy) |
| **Gauges** | `GAUGE_DOMAINS` (energy/water/atmosphere/population) primary metric | radial doughnut; color by % of range (red<25, amber<50, cyan) |
| **Summary cards** | per-domain primary metric + `trend` + sparkline of `history` | alert ⇒ red/amber border |
| **Deep-dive chart** | `history[domain]` all metrics | line/area/bar; AUTO-AXIS splits mixed magnitudes (>50× span) onto L/R axes; NORMALIZE rescales each series 0–100% |
| **Metric table** | `domains[d].metrics` (avg/min/max/last) | click row ⇒ filter chart to that metric |
| **Metadata panel** | `domains[d]` + `meta` | label, blurb, primary, sample count, tier, source, alert |

### Radar / gauge normalization ranges
`RADAR_RANGE` in `colony-stats.js` — `[metric, lo, hi, invert?]`. When adding a
domain to the radar or gauges, add its entry here so the value maps onto 0–100.

---

## 6. Expansion checklist (later phases)

To **add a metric**:
1. Add to `catalog.go` (`Name, Unit, Min, Max`) → auto micro presence.
2. (optional) Model it: state field + `baseFor` case in `world.go`; add to
   `MacroReadings` if it's macro-tier truth.
3. (optional) Alert: add to exporter `domainConfig`.
4. (optional) Viz: `RADAR_RANGE` / `GAUGE_DOMAINS` / `PRIMARY_METRIC` in the page.
5. Update this dictionary.

To **add a domain**: same as above plus add the domain block to `catalog.go`
(creates the `mars.<domain>` topic), and add it to `DOMAIN_ORDER` /
`DOMAIN_LABELS` on the page.

To **enrich realism** (candidates):
- Causal models for the 7 jittered domains (mining/manufacturing/transport/
  research/governance/datacenters/atmosphere).
- Macro-tier colony totals exposed via a "colony truth" toggle.
- Diurnal cycle (sol day/night irradiance), seasonal dust, supply chains linking
  mining → manufacturing → transport.
- More scenarios (§3).
