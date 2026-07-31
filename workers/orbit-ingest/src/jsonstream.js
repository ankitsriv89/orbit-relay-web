/**
 * Incremental parser for a JSON array of objects.
 *
 * **Why this exists.** `class/gp` with a 6.7-hour `CREATION_DATE` window is not
 * a small delta: 18 SPCS regenerates elsets continuously, so most of the ~28k
 * active catalog has a fresh elset in any 6-hour window. That response is
 * 10-20 MB of JSON, and `await resp.json()` would materialise the text *and*
 * ~28k parsed objects at once — comfortably past a Worker's 128 MB memory
 * limit. Streaming keeps the resident set at one row plus the current upsert
 * batch, so ingest memory is flat regardless of catalog size.
 *
 * It is a scanner, not a full JSON parser: it tracks string/escape state and
 * brace depth to find each top-level element's boundaries, then hands that
 * slice to the real `JSON.parse`. So values are parsed by the engine, and only
 * the *framing* is ours — the part that can be done in one pass without
 * buffering.
 *
 * Works unchanged in Workers and in Node 18+ (`scripts/bootstrap.mjs`): both
 * give `resp.body` as a web ReadableStream.
 */

/**
 * @param {ReadableStream<Uint8Array>} stream  typically `resp.body`
 * @yields {object} one array element at a time
 * @throws if the payload is not a JSON array — Space-Track signals some errors
 *         with a bare `{"error": ...}` object, and silently ingesting zero rows
 *         from one of those would look exactly like "nothing changed".
 */
export async function* streamJsonRows(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let buf = '';
  let i = 0;              // scan cursor into buf
  let depth = 0;          // brace depth *within* the current element
  let inString = false;
  let escaped = false;
  let elemStart = -1;
  let sawOpen = false;    // consumed the array's opening bracket
  let checkedShape = false;

  for (;;) {
    const { value, done } = await reader.read();
    buf += done ? decoder.decode() : decoder.decode(value, { stream: true });

    while (i < buf.length) {
      const c = buf[i];

      // Inside a string literal nothing is structural — a name like
      // O'BRIEN {TEST} must not move the depth counter.
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        i++;
        continue;
      }

      if (!sawOpen) {
        if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { i++; continue; }
        if (!checkedShape) {
          checkedShape = true;
          if (c !== '[') {
            throw new Error(
              `expected a JSON array, got ${JSON.stringify(buf.slice(0, 200))}`);
          }
        }
        sawOpen = true;
        i++;
        continue;
      }

      if (c === '"') { inString = true; i++; continue; }

      if (c === '{' || c === '[') {
        if (depth === 0) elemStart = i;
        depth++;
        i++;
        continue;
      }

      if (c === '}' || c === ']') {
        // depth 0 here is the array's own closing bracket.
        if (depth === 0) { i++; continue; }
        depth--;
        i++;
        if (depth === 0 && elemStart >= 0) {
          const text = buf.slice(elemStart, i);
          // Drop everything consumed so the buffer never grows with the
          // response — this is the whole point of the exercise.
          buf = buf.slice(i);
          i = 0;
          elemStart = -1;
          yield JSON.parse(text);
        }
        continue;
      }

      i++;
    }

    if (done) break;
  }

  if (!checkedShape) throw new Error('empty response where a JSON array was expected');
}

/** Convenience for tests and small responses: drain the generator into an array. */
export async function collectJsonRows(stream) {
  const out = [];
  for await (const row of streamJsonRows(stream)) out.push(row);
  return out;
}
