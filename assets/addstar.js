/*
 * Asking for a star the catalogue does not have.
 *
 * The site is static, so the computation happens elsewhere: the page files a
 * GitHub issue titled `add-star: <name>`, a workflow answers it by running
 * the pipeline, and the catalogue is committed back. The page then polls a
 * status file the workflow writes after every step, so the wait shows what is
 * happening rather than a blank spinner.
 *
 * Why an issue and not an API call: a static page has no secret it could use
 * to trigger a workflow directly, and one shipped in the JavaScript would be
 * public the moment it shipped. An issue is the one thing a signed-in visitor
 * can create with their own credentials and no secret of ours.
 *
 * The whole thing takes minutes, dominated by the MAST download, so the page
 * never blocks on it: it hands over a link and keeps working.
 */

const REPO = 'eartigau/tess-flares';
const POLL_MS = 5000;
const SLOW_AFTER_MS = 4000;      // past this, the wait gets an hourglass

export const issueUrl = (name) => {
  // `location` is absent outside a browser, and this module is unit-tested
  // under node; the origin is a courtesy line in the body, not a requirement.
  const from = typeof location === 'undefined'
    ? 'the website' : `${location.origin}${location.pathname}`;
  return `https://github.com/${REPO}/issues/new?` + new URLSearchParams({
    title: `add-star: ${name}`,
    body: `Requested from ${from}\n\n` +
          `The add-star workflow reads the title. Leave it as it is and ` +
          `submit; the run takes a few minutes, mostly downloading from MAST.`,
  });
};

export const slugify = (name) => String(name).trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* The status the workflow writes, or null while there is none yet. */
export async function pollStatus(slug, { cacheBust = true } = {}) {
  const url = `data/status/${slug}.json` + (cacheBust ? `?t=${Date.now()}` : '');
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/* Has the star itself landed? The status file says "done" before Pages has
 * rebuilt, so the index is what actually decides. */
export async function catalogueHas(slug) {
  try {
    const r = await fetch(`data/index.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return false;
    const idx = await r.json();
    return idx.stars.some((s) => s.slug === slug);
  } catch {
    return false;
  }
}

/* Watch one request until it finishes, calling back on every change.
 *
 * Stops on its own: a status of done/refused/failed, the star appearing in
 * the index, or the deadline. Returns a function that cancels it, because a
 * visitor who types another name should not keep polling the old one.
 */
export function watchRequest(slug, onUpdate, { maxMs = 20 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  let stopped = false;
  let lastKey = '';

  (async function loop() {
    while (!stopped) {
      const elapsed = Date.now() - t0;
      if (elapsed > maxMs) {
        onUpdate({ state: 'timeout', elapsedMs: elapsed });
        return;
      }
      if (await catalogueHas(slug)) {
        onUpdate({ state: 'landed', elapsedMs: elapsed });
        return;
      }
      const st = await pollStatus(slug);
      if (st) {
        const key = `${st.state}:${st.step}:${st.message}:${st.detail}`;
        if (key !== lastKey) {
          lastKey = key;
          onUpdate({ ...st, elapsedMs: elapsed });
        }
        if (st.state === 'refused' || st.state === 'failed') return;
        // "done" still waits for the index: Pages takes a minute to rebuild.
      } else {
        onUpdate({ state: 'waiting', elapsedMs: elapsed });
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();

  return () => { stopped = true; };
}

export { SLOW_AFTER_MS };
