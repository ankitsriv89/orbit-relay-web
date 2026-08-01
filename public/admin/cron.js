// Client-side "next ingest run" computation (plan 36 §5).
//
// The real scheduler is GitHub Actions (.github/workflows/orbit-ingest.yml),
// NOT wrangler.toml's crons — which are documented as deployable-and-unused.
// Computing next-due from the wrong source would display a schedule that
// never fires, so the schedule lives here, next to the crons themselves.
//
// GitHub Actions cron syntax: `*`, comma lists and `*/n` steps only (no
// ranges, no names). All times are UTC — GitHub evaluates crons in UTC.
// Pure functions, no DOM — testable in Node.

export const ACTIONS_CRONS = [
  { job: 'GP', cron: '17 */6 * * *' },   // GP delta → objects, events, R2 bundles
  { job: 'DAILY', cron: '35 17 * * *' }, // SATCAT + DECAY + BOXSCORE
  { job: 'WEEKLY', cron: '40 17 * * 3' },// 60-day decay predictions
];

function fieldMatches(field, value) {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    if (part === '*') return true;
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (step > 0 && value % step === 0) return true;
    } else if (parseInt(part, 10) === value) {
      return true;
    }
  }
  return false;
}

/**
 * Next run of one Actions cron expression, strictly after `fromMs`.
 * Standard cron semantics: when both day-of-month and day-of-week are
 * restricted, a day matches if EITHER field matches (OR).
 */
export function nextRun(cronExpr, fromMs) {
  const [min, hour, dom, month, dow] = String(cronExpr).trim().split(/\s+/);
  if (!min || !hour || !dom || !month || !dow) return null;
  const d = new Date(fromMs);
  d.setUTCSeconds(0, 0);
  d.setUTCMilliseconds(0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);

  const domRestricted = dom !== '*' || dom.includes(',') || dom.includes('*/');
  const dowRestricted = dow !== '*' || dow.includes(',') || dow.includes('*/');

  for (let i = 0; i < 60 * 24 * 366; i++) {
    const domOk = fieldMatches(dom, d.getUTCDate());
    const dowOk = fieldMatches(dow, d.getUTCDay());
    const dayOk = domRestricted && dowRestricted ? (domOk || dowOk) : (domOk && dowOk);
    if (fieldMatches(min, d.getUTCMinutes()) &&
        fieldMatches(hour, d.getUTCHours()) &&
        fieldMatches(month, d.getUTCMonth() + 1) && dayOk) {
      return d.getTime();
    }
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return null;
}

/** Earliest next run across the three Actions jobs. */
export function nextDue(fromMs = Date.now()) {
  let best = null;
  for (const { job, cron } of ACTIONS_CRONS) {
    const at = nextRun(cron, fromMs);
    if (at != null && (best === null || at < best.at)) best = { job, at };
  }
  return best;
}
