# Orbital Relay

Interactive satellite visualization and tracking platform built on Cloudflare Pages.

**Domain:** orbitalrelay.space  
**Deployment:** Cloudflare Pages (auto-deploy on git push)  
**Data:** D1 (orbit-catalog) + R2 (orbit-data)  
**GitHub:** ankitsriv89/orbit-relay-web

## Development

```bash
npm install
npm run dev  # Local dev server on http://localhost:8788
```

## Deployment

Automatic — just push to `main`:
```bash
git push origin main  # Cloudflare auto-deploys
```

## Architecture

- **Static files:** `public/` (HTML, CSS, JS, TLE data)
- **Pages Functions:** `functions/api/` (optional serverless functions)
- **Data bindings:** D1 (ORBIT_DB) + R2 (ORBIT_R2) via wrangler.toml
- **TLE ingestion:** Separate `orbit-ingest` Worker (writes to D1/R2)

## Features

- Real-time satellite catalog (Space-Track/CelesTrak integration)
- Interactive 3D orbit visualization
- Conjunction prediction
- Historical TLE archive
