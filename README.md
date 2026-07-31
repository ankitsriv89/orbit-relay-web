# Orbital Relay

Interactive satellite visualization and tracking platform built on Cloudflare.

**Domain:** orbitalrelay.space  
**Deployment:** Cloudflare Pages (`orbit-relay` project)  
**Data:** D1 (orbit-catalog) + R2 (orbit-data)

## Development

```bash
npm install
npm run dev  # Local dev server on http://localhost:8788
```

## Deployment

```bash
npm run deploy  # Deploy to orbit-relay.pages.dev, then DNS routes to orbitalrelay.space
```

## Architecture

- **Public static files:** `public/` (HTML, CSS, JS, assets)
- **Pages Functions:** `functions/api/` (serverless edge functions)
- **Data bindings:** D1 (ORBIT_DB) + R2 (ORBIT_R2) via wrangler.toml
- **TLE ingestion:** Separate `orbit-ingest` Worker (writes to D1/R2)

## Features

- Real-time satellite catalog (Space-Track/CelesTrak integration)
- Interactive 3D orbit visualization
- Conjunction prediction
- Historical TLE archive
