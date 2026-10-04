/*
 * Running the flare pipeline in the visitor's own browser.
 *
 * Everything here exists because of one fact I had wrong for most of this
 * tool's life: MAST serves its data with CORS. The query API, the download
 * redirect and the S3 bucket behind it all send
 * `Access-Control-Allow-Origin: *`, so a page can fetch a TESS light curve
 * directly. Pyodide then supplies numpy, scipy and astropy, which is
 * everything the detrending and the flare detection need.
 *
 * So a star nobody precomputed can be answered in seconds rather than the
 * minutes a GitHub Actions run takes, with no account and no issue. The
 * workflow is kept for what it is good at: putting the answer in the
 * catalogue so the next visitor does not recompute it.
 *
 * MAST's own download endpoint cannot be used from a page: it answers with a
 * 307 that carries NO Access-Control-Allow-Origin header, so the browser
 * rejects the redirect before reaching S3, which does send one. From a shell
 * this is invisible, because curl does not enforce CORS, and the symptom in
 * the page is a bare "Load failed". The public bucket URL is therefore built
 * from the filename, whose layout is deterministic, with the endpoint kept as
 * a fallback.
 *
 * What it costs, measured rather than guessed:
 *   ~30 MB once for Pyodide (runtime 8.2, scipy 12.6, astropy 5.8, numpy 3.0),
 *   cached by the browser afterwards;
 *   ~7 MB per 2-minute sector and ~11 MB per 20-second one;
 *   ~0.2 s of compute for 180,000 cadences.
 * The download dominates entirely, which is why the sector count is capped.
 */

const PYODIDE_VERSION = 'v0.28.0';
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;
const MAST_API = 'https://mast.stsci.edu/api/v0/invoke';
const MAST_FILE = 'https://mast.stsci.edu/api/v0.1/Download/file?uri=';
const STPUBDATA = 'https://stpubdata.s3.us-east-1.amazonaws.com/tess/public/tid/';

/* The public S3 URL of a TESS light curve, built from its filename.
 *
 * MAST's own download endpoint answers a browser with a 307 that carries NO
 * CORS header, so the browser rejects the redirect before it ever reaches
 * S3, which does send one. From a shell this is invisible, because curl does
 * not enforce CORS; in a page it is a bare "Load failed". That is what broke
 * HD 189733.
 *
 * The bucket layout is deterministic: tid/s<sector>/ then the 16-digit TIC in
 * four-character groups, then the filename. Verified against the Location
 * header MAST itself returns.
 */
export function publicUrl(filename) {
  const m = /^tess\d+-s(\d{4})-(\d{16})-/.exec(filename);
  if (!m) return null;
  const [, sector, tid] = m;
  const groups = [tid.slice(0, 4), tid.slice(4, 8), tid.slice(8, 12), tid.slice(12, 16)];
  return `${STPUBDATA}s${sector}/${groups.join('/')}/${filename}`;
}

/* Four sectors is 29 MB and about 80% of the median star's exposure. The full
 * set reaches 270 MB for TOI-700, which is not something to ask of a visitor
 * without warning. The page says how many were used. */
export const DEFAULT_MAX_SECTORS = 4;

let pyodidePromise = null;

/* Pyodide, loaded once and shared. The packages are the pipeline's real
 * dependencies and nothing else: lightkurve and astroquery are absent from
 * Pyodide, but they are only HTTP wrappers and the fetching is done here in
 * JavaScript, which handles the MAST redirect better anyway. */
export function loadPyodide(onProgress = () => {}) {
  if (pyodidePromise) return pyodidePromise;
  pyodidePromise = (async () => {
    onProgress({ step: 'pyodide', detail: 'runtime' });
    if (!window.loadPyodide) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `${PYODIDE_URL}pyodide.js`;
        s.onload = resolve;
        s.onerror = () => reject(new Error('could not load Pyodide'));
        document.head.appendChild(s);
      });
    }
    const py = await window.loadPyodide({ indexURL: PYODIDE_URL });
    onProgress({ step: 'pyodide', detail: 'numpy, scipy, astropy' });
    await py.loadPackage(['numpy', 'scipy', 'astropy']);
    onProgress({ step: 'pyodide', detail: 'pipeline' });
    const src = await (await fetch('assets/pipeline.py')).text();
    py.FS.writeFile('/pipeline.py', src);
    py.runPython('import sys; sys.path.insert(0, "/")');
    py.runPython('import pipeline');
    return py;
  })();
  return pyodidePromise;
}

/* The products MAST holds for a TIC.
 *
 * Caom.Filtered.Product rather than the portal: it is the endpoint that
 * answers a cross-origin request. Only timeseries light curves are kept, and
 * only from the pipelines the catalogue uses, so a browser-computed star is
 * the same kind of data as a precomputed one.
 */
export async function findProducts(tic) {
  const request = {
    service: 'Mast.Caom.Filtered',
    format: 'json',
    params: {
      columns: '*',
      filters: [
        { paramName: 'obs_collection', values: ['TESS'] },
        { paramName: 'dataproduct_type', values: ['timeseries'] },
        { paramName: 'target_name', values: [String(tic)] },
      ],
    },
  };
  const r = await fetch(MAST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'request=' + encodeURIComponent(JSON.stringify(request)),
  });
  if (!r.ok) throw new Error(`MAST search: HTTP ${r.status}`);
  const out = await r.json();
  if (out.status !== 'COMPLETE') {
    throw new Error(`MAST search: ${out.msg || out.status}`);
  }
  return out.data || [];
}

/* The product files of those observations, one per sector, fastest cadence.
 *
 * Fastest matters: syncflares takes the fastest product per sector ("joint"
 * mode), and running the 120-second file where the catalogue took the
 * 20-second one changed the per-cadence noise by a factor of two on AD Leo.
 * The flares matched either way, but two answers for one star is what this
 * whole module exists to avoid.
 */
export async function findFiles(obsIds) {
  const request = {
    service: 'Mast.Caom.Products',
    format: 'json',
    params: { obsid: obsIds.join(',') },
  };
  const r = await fetch(MAST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'request=' + encodeURIComponent(JSON.stringify(request)),
  });
  if (!r.ok) throw new Error(`MAST products: HTTP ${r.status}`);
  const out = await r.json();
  // TESS names its two cadences differently, and not in the way a guess
  // would suggest: the 2-minute light curve is `..._lc.fits` and the
  // 20-second one is `..._fast-lc.fits`. The four-digit field before the
  // suffix is a processing run, NOT the cadence, so it cannot be used to
  // tell them apart. Both are SCIENCE products; the _dvt and _tp files are
  // not light curves and are dropped here.
  return (out.data || []).filter((p) => {
    const fn = p.productFilename || '';
    return /(^|[-_])(fast-)?lc\.fits$/i.test(fn) &&
           (p.productType === 'SCIENCE' || !p.productType);
  });
}

/* Pick one file per sector, preferring the fastest cadence, newest first. */
export function chooseSectors(files, maxSectors = DEFAULT_MAX_SECTORS) {
  const bySector = new Map();
  for (const f of files) {
    const fn = f.productFilename || '';
    const m = /-s(\d{4})-/.exec(fn);
    if (!m) continue;
    const sector = parseInt(m[1], 10);
    // `fast` means 20 s, plain means 120 s. Checked against MAST's own
    // listing for AD Leo rather than inferred from the four-digit field,
    // which is a processing run and would have picked the wrong file.
    const cadence = /fast-lc\.fits$/i.test(fn) ? 20 : 120;
    const cur = bySector.get(sector);
    if (!cur || cadence < cur.cadence) {
      bySector.set(sector, { sector, cadence, filename: fn,
                             uri: f.dataURI || f.dataURL });
    }
  }
  return [...bySector.values()]
    .filter((x) => x.uri)
    .sort((a, b) => b.sector - a.sector)
    .slice(0, maxSectors)
    .sort((a, b) => a.sector - b.sector);
}

/* Fetch the FITS files, reporting bytes as they arrive: the download is
 * essentially the whole wait, so a bar that does not move during it would be
 * a bar that lies. */
export async function fetchSectors(chosen, onProgress = () => {}) {
  const blobs = [];
  let done = 0;
  for (const c of chosen) {
    onProgress({ step: 'download', detail: `sector ${c.sector}`,
                 index: done, total: chosen.length });

    // The public bucket first, because MAST's redirect is not CORS-safe.
    // The endpoint is kept as a fallback: if the bucket layout ever changes,
    // a browser that follows the redirect successfully still works.
    const direct = publicUrl(c.filename || '');
    let r = null;
    if (direct) {
      try { r = await fetch(direct); } catch { r = null; }
      if (r && !r.ok) r = null;
    }
    if (!r) {
      r = await fetch(MAST_FILE + encodeURIComponent(c.uri));
    }
    if (!r.ok) throw new Error(`sector ${c.sector}: HTTP ${r.status}`);

    const len = Number(r.headers.get('content-length')) || 0;
    if (r.body && len) {
      const reader = r.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done: fin, value } = await reader.read();
        if (fin) break;
        parts.push(value);
        got += value.length;
        onProgress({ step: 'download', detail:
          `sector ${c.sector}, ${(got / 1048576).toFixed(1)} of ` +
          `${(len / 1048576).toFixed(1)} MB`,
          index: done, total: chosen.length, fraction: got / len });
      }
      const buf = new Uint8Array(got);
      let at = 0;
      for (const p of parts) { buf.set(p, at); at += p.length; }
      blobs.push(buf);
    } else {
      blobs.push(new Uint8Array(await r.arrayBuffer()));
    }
    done += 1;
  }
  return blobs;
}

/* The whole thing: find, fetch, compute. */
export async function computeStar(tic, {
  maxSectors = DEFAULT_MAX_SECTORS, onProgress = () => {},
} = {}) {
  const py = await loadPyodide(onProgress);

  onProgress({ step: 'search', detail: `TIC ${tic}` });
  const obs = await findProducts(tic);
  if (!obs.length) {
    return { error: 'no-data',
             message: `MAST has no TESS timeseries for TIC ${tic}.` };
  }
  const files = await findFiles(obs.map((o) => o.obsid).slice(0, 200));
  const chosen = chooseSectors(files, maxSectors);
  if (!chosen.length) {
    return { error: 'no-data',
             message: `MAST lists observations for TIC ${tic} but no light-curve file.` };
  }

  const blobs = await fetchSectors(chosen, onProgress);

  onProgress({ step: 'compute', detail: `${chosen.length} sectors` });
  // The bytes cross into Python as a list of bytes objects; numpy arrays do
  // not survive the boundary, which is why pipeline.run returns JSON.
  py.globals.set('_blobs', blobs.map((b) => py.toPy(b)));
  const json = py.runPython(`
import pipeline
pipeline.run([bytes(b.to_py()) if hasattr(b, "to_py") else bytes(b)
              for b in _blobs])
`);
  const out = JSON.parse(json);
  out.sectors_available = [...new Set(files
    .map((f) => { const m = /-s(\d{4})-/.exec(f.productFilename || ''); return m ? +m[1] : null; })
    .filter((x) => x !== null))].sort((a, b) => a - b);
  out.sectors_used = chosen.map((c) => c.sector);
  out.bytes_downloaded = blobs.reduce((a, b) => a + b.length, 0);
  return out;
}
