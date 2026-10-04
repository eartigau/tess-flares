"""The flare pipeline, run in the visitor's browser under Pyodide.

This is the same science as syncflares/whiten.py, flares.py and stats.py,
reduced to what a browser needs and to what Pyodide ships. It exists so that
a star nobody has precomputed can be answered in seconds instead of the
minutes a GitHub Actions run takes, and without an account.

What is the same, deliberately, because two answers for one star would be
worse than one slow answer:

  * the whitening is a running median over a 3-hour window, per sector;
  * a flare is `min_consecutive` cadences at or above `sigma_threshold` times
    the robust scatter of the residuals;
  * amplitudes above `max_amplitude` are rejected as instrumental;
  * the exposure counts cadences, not elapsed time.

What is different, and the page says so:

  * only the most recent sectors are fetched. A TESS light curve is about
    2 MB per 2-minute sector and six times that at 20 s, so the full set runs
    to 270 MB for TOI-700. Four sectors is 29 MB and about 80% of the median
    star's exposure, which is a real answer rather than a slow one.

CADENCE: the caller must hand over the FASTEST product available for each
sector, which is what syncflares' "joint" mode does. This is not a detail.
Run on AD Leo's 120-second products where the catalogue had taken its
20-second ones, the per-cadence noise came out at 5948 ppm against 11104, and
fourteen marginal detections near the threshold fell on different sides. The
hundred-odd real flares matched to 1.5 minutes with amplitudes agreeing to
0.2%, so the science holds either way, but two answers for one star is
exactly what this module exists to avoid.
  * the Gaussian-process whitening is not offered: celerite2 is not in
    Pyodide. The catalogue uses the median anyway, for the reason in
    syncflares' README, so nothing is lost.

Called from JavaScript with the FITS bytes already fetched, because the
browser's own fetch handles the MAST redirect and CORS better than anything
reachable from inside Pyodide.

Measured under a real Pyodide 0.28 on AD Leo, three sectors, 32.5 MB:
Pyodide and its packages load in 5.2 s, the computation takes 1.8 s for
279,163 cadences, and the result matches the catalogue entry cadence for
cadence, with 468 of 483 detections inside 1.5 minutes of a catalogued one
and an amplitude ratio of 1.00057. The download dominates everything.
"""
import io
import json

import numpy as np
from astropy.io import fits
from scipy.ndimage import median_filter

# NumPy 2.0 renamed trapz to trapezoid and dropped the old name. Pyodide ships
# 2.x, this machine runs 1.26, and the same hazard already bit the pipeline
# once: syncflares/flares.py carries the identical line for the identical
# reason. Resolved at import so the browser and the catalogue agree whichever
# NumPy is underneath.
_trapezoid = getattr(np, "trapezoid", None) or np.trapz

# These must match syncflares/config.py. A drift here would make the browser
# and the catalogue disagree about the same star.
SIGMA_THRESHOLD = 3.0
MIN_CONSECUTIVE = 3
MEDIAN_WINDOW_HOURS = 3.0
MAX_AMPLITUDE = 3.0
EVENT_GAP_DAYS = 0.04

# lightkurve's quality bitmasks, inlined because lightkurve is not in Pyodide.
# DEFAULT is what the catalogue uses for SPOC, HARD for QLP, whose own flags
# the default mask does not cover (see syncflares/data.py). Filtering on
# QUALITY == 0 instead looks safer and is not: it discards cadences the
# default mask keeps, which on AD Leo cost 8,166 of 279,163 cadences and
# turned 509 detections into 336. Being stricter than the catalogue is still
# disagreeing with it.
QUALITY_DEFAULT = 17087
QUALITY_HARD = 24319


def _robust_sigma(x):
    x = x[np.isfinite(x)]
    if len(x) == 0:
        return 0.0
    return float(1.4826 * np.median(np.abs(x - np.median(x))))


def read_sector(raw, flux_column="PDCSAP_FLUX"):
    """One sector's cadences from the bytes of its lc.fits.

    Quality is filtered with the SAME bitmask the catalogue uses: DEFAULT for
    SPOC products, HARD for QLP, whose flags the default mask does not cover.
    The mask is chosen from the file's own ORIGIN header rather than guessed.
    """
    with fits.open(io.BytesIO(raw), memmap=False) as hdul:
        d = hdul[1].data
        hdr = hdul[0].header
        cols = {c.upper() for c in d.columns.names}
        col = flux_column if flux_column in cols else (
            "PDCSAP_FLUX" if "PDCSAP_FLUX" in cols else
            "KSPSAP_FLUX" if "KSPSAP_FLUX" in cols else
            "DET_FLUX" if "DET_FLUX" in cols else "SAP_FLUX")
        err = col + "_ERR"
        t = np.asarray(d["TIME"], dtype=float)
        f = np.asarray(d[col], dtype=float)
        e = (np.asarray(d[err], dtype=float) if err in cols
             else np.full_like(f, np.nan))
        q = (np.asarray(d["QUALITY"], dtype=np.int64) if "QUALITY" in cols
             else np.zeros(len(t), dtype=np.int64))
        sector = int(hdr.get("SECTOR", -1))
        origin = str(hdr.get("ORIGIN", "")).upper()

    # QLP needs the harder mask; its junk passes the default one, which on
    # TOI-7149 once produced 49 flares up to 7451% amplitude.
    bitmask = QUALITY_HARD if "QLP" in origin else QUALITY_DEFAULT
    ok = np.isfinite(t) & np.isfinite(f) & ((q & bitmask) == 0) & (f > 0)
    t, f, e = t[ok], f[ok], e[ok]
    if len(t) < 100:
        return None

    # Refuse a sector whose photometry is not usable. AD Leo's sector 46 runs
    # from -0.24 to 3.83 in normalised flux and yielded 65 "flares" with a
    # median amplitude of 178%, against 0.47% in the same star's sector 48.
    # The test is the fraction of wild cadences, not the scatter: an active M
    # dwarf is genuinely variable, and a scatter cut would discard the stars
    # this tool is for.
    med = float(np.median(f))
    if not np.isfinite(med) or med <= 0:
        return None
    wild = float(np.mean((f > 2 * med) | (f < 0.5 * med)))
    if wild > 0.02:
        return None

    med = np.median(f)
    f = f / med
    e = e / med if np.isfinite(e).any() else np.full_like(f, _robust_sigma(f - 1.0))
    # TESS times are BTJD; the catalogue works in BJD_TDB.
    return {"t": t + 2457000.0, "f": f, "e": e,
            "sector": np.full(len(t), sector, dtype=np.int64)}


def whiten(t, f, window_hours=MEDIAN_WINDOW_HOURS):
    """Running median over a window set in TIME, not in points.

    The point count is derived from this sector's own cadence, because a
    20-second sector and a 120-second one need different point counts for the
    same three hours, and a fixed count would filter them differently.
    """
    if len(t) < 5:
        return np.ones_like(f), 0.0
    cad = float(np.median(np.diff(np.sort(t))))
    npix = max(3, int(round((window_hours / 24.0) / max(cad, 1e-9))) | 1)
    base = median_filter(f, size=npix, mode="nearest")
    base = np.where(base > 0, base, 1.0)
    resid = f / base - 1.0
    return base, _robust_sigma(resid)


def detect(t, resid, sigma, sector):
    """Runs of consecutive cadences above the threshold.

    `sigma` is PER CADENCE, not one number: each sector has its own noise, and
    a faint sector and a bright one must not be thresholded alike. Treating it
    as a scalar is the kind of mistake that silently thresholds a whole star
    at one sector's noise.

    Strictly consecutive, as in Medina et al. (2020), which means one flare
    whose decay dips below threshold is recorded more than once; the caller
    groups detections into events, as the catalogue does.
    """
    sigma = np.asarray(sigma, dtype=float)
    if not np.any(np.isfinite(sigma) & (sigma > 0)):
        return []
    with np.errstate(divide="ignore", invalid="ignore"):
        z = np.where(sigma > 0, resid / sigma, 0.0)
    cand = np.flatnonzero(z >= SIGMA_THRESHOLD)
    if len(cand) == 0:
        return []
    out, run = [], [cand[0]]
    for prev, cur in zip(cand[:-1], cand[1:]):
        if cur == prev + 1 and sector[cur] == sector[prev]:
            run.append(cur)
        else:
            out.append(run)
            run = [cur]
    out.append(run)

    events = []
    for g in out:
        if len(g) < MIN_CONSECUTIVE:
            continue
        g = np.asarray(g)
        peak = g[int(np.argmax(z[g]))]
        amp = float(resid[peak])
        if amp > MAX_AMPLITUDE:
            continue          # instrumental: no white-light flare looks like that
        ed = float(_trapezoid(resid[g], t[g]) * 86400.0) if len(g) > 1 else 0.0
        events.append({
            "t_start": float(t[g[0]]), "t_peak": float(t[peak]),
            "t_end": float(t[g[-1]]), "amplitude": amp,
            "peak_sigma": float(z[peak]), "ed_sec": ed,
            "n_points": int(len(g)), "sector": int(sector[peak]),
        })
    return events


def coverage_intervals(t, sector, gap_cadences=3.0):
    """Continuous stretches, as (start, end, cadence, sector).

    The same shape the catalogue ships, so the page's phase statistics work on
    a browser-computed star exactly as on a precomputed one.
    """
    out = []
    for s in np.unique(sector):
        ts = np.sort(t[sector == s])
        if len(ts) < 2:
            continue
        dt = float(np.median(np.diff(ts)))
        if not np.isfinite(dt) or dt <= 0:
            continue
        brk = np.flatnonzero(np.diff(ts) > gap_cadences * dt)
        for i0, i1 in zip(np.r_[0, brk + 1], np.r_[brk, len(ts) - 1]):
            out.append([round(float(ts[i0] - 0.5 * dt), 6),
                        round(float(ts[i1] + 0.5 * dt), 6),
                        round(dt, 9), int(s)])
    out.sort(key=lambda iv: iv[0])
    return out


def run(sector_blobs, flux_column="PDCSAP_FLUX"):
    """Everything, from raw FITS bytes to the record the page draws.

    `sector_blobs` is a list of bytes, one per sector, already fetched by the
    browser. Returns JSON, because that crosses the Pyodide boundary cleanly
    while numpy arrays do not.
    """
    parts = [p for p in (read_sector(b, flux_column) for b in sector_blobs) if p]
    if not parts:
        return json.dumps({"error": "no usable cadence in any sector"})

    t = np.concatenate([p["t"] for p in parts])
    f = np.concatenate([p["f"] for p in parts])
    e = np.concatenate([p["e"] for p in parts])
    sec = np.concatenate([p["sector"] for p in parts])
    order = np.argsort(t)
    t, f, e, sec = t[order], f[order], e[order], sec[order]

    # Whitened per SEGMENT, not per sector: a sector is cut wherever the gap
    # between cadences exceeds half a day, which is the TESS downlink pause in
    # the middle of every sector. The catalogue does the same, and the
    # difference is not cosmetic: a filter run across a half-day gap
    # interpolates its baseline through it and invents structure at both
    # edges, and the noise it then reports is the average of two halves that
    # may differ. Matching the catalogue's segmentation is what makes a
    # browser-computed star comparable to a precomputed one.
    resid = np.zeros_like(f)
    sigma = np.zeros_like(f)
    seg_sigmas = []
    for s in np.unique(sec):
        m = np.flatnonzero(sec == s)
        ts = t[m]
        cad = float(np.median(np.diff(ts))) if len(ts) > 1 else 0.02
        brk = np.flatnonzero(np.diff(ts) > max(0.5, 3 * cad))
        for i0, i1 in zip(np.r_[0, brk + 1], np.r_[brk, len(m) - 1]):
            idx = m[i0:i1 + 1]
            if len(idx) < 5:
                continue
            base, sg = whiten(t[idx], f[idx])
            resid[idx] = f[idx] / base - 1.0
            sigma[idx] = sg
            if sg > 0:
                seg_sigmas.append(sg)
    sigma_of = {}

    flares = detect(t, resid, np.where(sigma > 0, sigma, np.inf), sec)
    intervals = coverage_intervals(t, sec)
    exposure = sum(b - a for a, b, _, _ in intervals)
    noise = float(np.median(seg_sigmas)) if seg_sigmas else float("nan")

    return json.dumps({
        "n_cadences": int(len(t)),
        "sectors": sorted(int(s) for s in np.unique(sec)),
        "exposure_days": round(exposure, 4),
        "t_min": round(float(t.min()), 6), "t_max": round(float(t.max()), 6),
        "flares": flares,
        "coverage": intervals,
        "noise_per_point": round(noise, 8) if np.isfinite(noise) else None,
        "min_detectable_amplitude": (round(SIGMA_THRESHOLD * noise, 8)
                                     if np.isfinite(noise) else None),
        "flux": {"t": [round(float(x), 6) for x in t],
                 "f": [round(float(x), 5) for x in (resid + 1.0)],
                 "sector": [int(s) for s in sec]},
    })
