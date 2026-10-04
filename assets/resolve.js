/*
 * Resolving a star this page does not have.
 *
 * The catalogue is precomputed, so a name outside it cannot be analysed here:
 * a browser cannot download a TESS light curve from MAST, and could not run
 * the detrending and flare detection on it if it could. What a browser CAN do
 * is ask SIMBAD who the star is, and SIMBAD alone, because it is the only one
 * of the three archives this tool uses that sends an
 * `Access-Control-Allow-Origin` header. The NASA Exoplanet Archive answers a
 * cross-origin request with data and no such header, which a browser then
 * discards, so the planet list cannot be fetched here and the page does not
 * pretend otherwise.
 *
 * So a miss turns into: this is what the star is, this is why it is not here,
 * and this is the one command that adds it.
 */

const SIMBAD = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';

/* SIMBAD's TAP service, by identifier. The join through `ident` is what makes
 * an alias work: GJ 1, HD 225213 and LHS 1 are one star, and only `ident`
 * knows that. */
function query(name) {
  const safe = String(name).replace(/'/g, "''");
  const adql = `SELECT TOP 1 b.main_id, b.ra, b.dec, b.sp_type, b.plx_value,
       b.otype_txt, f.V, f.J
FROM basic AS b
JOIN ident AS i ON b.oid = i.oidref
LEFT JOIN allfluxes AS f ON b.oid = f.oidref
WHERE i.id = '${safe}'`;
  const params = new URLSearchParams({
    request: 'doQuery', lang: 'adql', format: 'json', query: adql,
  });
  return `${SIMBAD}?${params}`;
}

/* The identifiers SIMBAD knows for the star, so the page can say "try this
 * name instead" when one of them IS in the catalogue. */
function aliasQuery(mainId) {
  const safe = String(mainId).replace(/'/g, "''");
  const adql = `SELECT i.id FROM ident AS i
JOIN basic AS b ON b.oid = i.oidref
WHERE b.main_id = '${safe}'`;
  const params = new URLSearchParams({
    request: 'doQuery', lang: 'adql', format: 'json', query: adql,
  });
  return `${SIMBAD}?${params}`;
}

function rowsOf(payload) {
  // SIMBAD's JSON gives `data` as rows and `metadata` as the column order.
  if (!payload || !Array.isArray(payload.data)) return [];
  const cols = (payload.metadata || []).map((m) => m.name);
  return payload.data.map((row) => {
    const out = {};
    cols.forEach((c, i) => { out[c] = row[i]; });
    return out;
  });
}

/* The TIC number, which is the only identifier MAST will answer to.
 *
 * SIMBAD carries it in its identifier table for most TESS targets, which
 * saves a second round trip to the TIC catalogue; where it does not, the
 * caller is told and the browser-side computation is not offered. */
export function ticOf(aliases) {
  for (const a of aliases || []) {
    const m = /^TIC\s*(\d+)$/i.exec(String(a).trim());
    if (m) return Number(m[1]);
  }
  return null;
}

export async function resolveStar(name, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(query(name), { signal: ctrl.signal });
    if (!r.ok) throw new Error(`SIMBAD: HTTP ${r.status}`);
    const rows = rowsOf(await r.json());
    if (!rows.length) return { found: false };
    const b = rows[0];
    const plx = Number(b.plx_value);
    return {
      found: true,
      mainId: String(b.main_id || name).trim(),
      ra: Number(b.ra), dec: Number(b.dec),
      spType: (b.sp_type || '').trim() || null,
      objType: (b.otype_txt || '').trim() || null,
      distancePc: Number.isFinite(plx) && plx > 0 ? 1000 / plx : null,
      vmag: Number.isFinite(Number(b.V)) ? Number(b.V) : null,
      jmag: Number.isFinite(Number(b.J)) ? Number(b.J) : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function aliasesOf(mainId, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(aliasQuery(mainId), { signal: ctrl.signal });
    if (!r.ok) return [];
    return rowsOf(await r.json())
      .map((x) => String(x.id || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
