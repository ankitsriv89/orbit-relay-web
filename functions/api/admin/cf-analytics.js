import { adminJson } from '../_admin.js';

export async function onRequest(context) {
  const { env } = context;
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN;
  const zoneId = env.CLOUDFLARE_ZONE_ID;

  if (!token || !zoneId) {
    return adminJson({ error: 'Cloudflare analytics not configured (missing CLOUDFLARE_ANALYTICS_TOKEN or CLOUDFLARE_ZONE_ID).' });
  }

  // httpRequests1dGroups is the free-plan dataset (httpRequestsAdaptiveGroups needs a paid plan).
  const query = `{
    viewer {
      zone(filter: { zoneTag: "${zoneId}" }) {
        httpRequests1dGroups(limit: 14, orderBy: [date_ASC]) {
          dimensions { date }
          sum { requests pageViews bytes threats }
          uniq { uniques }
        }
      }
    }
  }`;

  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      const text = await res.text();
      return adminJson({ error: `Cloudflare API error (${res.status}): ${text.slice(0, 200)}` });
    }

    const json = await res.json();
    const groups = json?.data?.viewer?.zone?.[0]?.httpRequests1dGroups ?? [];
    const days = groups.map(g => ({
      date: g.dimensions?.date,
      requests: g.sum?.requests,
      pageViews: g.sum?.pageViews,
      bytes: g.sum?.bytes,
      threats: g.sum?.threats,
      uniques: g.uniq?.uniques,
    }));

    return adminJson({ days });
  } catch (err) {
    return adminJson({ error: `Failed to fetch analytics: ${err.message}` });
  }
}
