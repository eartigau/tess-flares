/*
 * The phase statistics, in the browser.
 *
 * A port of syncflares/stats.py. It exists because the one thing a visitor
 * changes -- the period the flares are folded on -- cannot be precomputed:
 * the site would otherwise be limited to the periods of the known planets.
 * Given the flare times and the coverage intervals, everything the Python
 * pipeline reports about phase can be recomputed here, for any period, with
 * no server.
 *
 * tests/test_web_stats.py runs this file under node against the Python and
 * requires them to agree. If you change a formula here, change it there.
 *
 * References for the methods, as the page's "Methods" tab also states:
 *   Kuiper (1960), Proc. K. Ned. Akad. Wet. A 63, 38 -- the V statistic.
 *   Stephens (1970), JRSS B 32, 115 -- the finite-sample correction.
 *   Press et al., Numerical Recipes, 3rd ed., section 14.3.4 -- the
 *     asymptotic p-value as implemented below.
 *   Medina et al. (2020), ApJ 905, 107 -- the flare detection the precomputed
 *     catalogue used (N consecutive points above a threshold).
 */

/* ---------------------------------------------------------------------------
 * phase coverage from the coverage intervals
 *
 * An interval [a, b) observed at cadence dt contributes exposure to every
 * phase it crosses. Rather than walk cadence by cadence, which would need the
 * cadence times the site does not ship, the interval is integrated: it covers
 * (b - a) / P whole cycles plus a remainder, and a whole cycle contributes
 * P/nbins of exposure to every bin equally. Only the remainder has to be
 * distributed, and it is one contiguous arc of phase.
 * ------------------------------------------------------------------------ */

export function phaseExposure(intervals, period, t0, nbins) {
  const bins = new Float64Array(nbins);
  if (!(period > 0)) return bins;
  const binWidth = period / nbins;

  for (const [a, b] of intervals) {
    const span = b - a;
    if (!(span > 0)) continue;

    const whole = Math.floor(span / period);
    if (whole > 0) {
      // Every bin gets the same exposure from a complete cycle.
      const each = whole * binWidth;
      for (let i = 0; i < nbins; i++) bins[i] += each;
    }
    const restStart = a + whole * period;
    let rest = b - restStart;
    if (rest <= 0) continue;

    // Walk the remaining arc bin by bin from where it starts.
    let phase = (((restStart - t0) / period) % 1 + 1) % 1;
    let idx = Math.min(Math.floor(phase * nbins), nbins - 1);
    let toEdge = (idx + 1) / nbins * period - phase * period;
    while (rest > 0) {
      const take = Math.min(rest, toEdge);
      bins[idx] += take;
      rest -= take;
      idx = (idx + 1) % nbins;
      toEdge = binWidth;
    }
  }
  return bins;
}

/* The exposure-weighted CDF of phase, on a grid, for the Kuiper test. */
export function exposureCdf(intervals, period, t0, nbins = 2048) {
  const bins = phaseExposure(intervals, period, t0, nbins);
  let total = 0;
  for (let i = 0; i < nbins; i++) total += bins[i];
  const phase = new Float64Array(nbins + 1);
  const cdf = new Float64Array(nbins + 1);
  let run = 0;
  phase[0] = 0; cdf[0] = 0;
  for (let i = 0; i < nbins; i++) {
    run += bins[i];
    phase[i + 1] = (i + 1) / nbins;
    cdf[i + 1] = total > 0 ? run / total : (i + 1) / nbins;
  }
  return { phase, cdf, total };
}

function cdfAt(phase, cdf, x) {
  // Linear interpolation, the np.interp of the Python.
  if (x <= phase[0]) return cdf[0];
  const n = phase.length;
  if (x >= phase[n - 1]) return cdf[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (phase[mid] <= x) lo = mid; else hi = mid;
  }
  const span = phase[hi] - phase[lo];
  if (span <= 0) return cdf[lo];
  return cdf[lo] + (cdf[hi] - cdf[lo]) * (x - phase[lo]) / span;
}

/* ---------------------------------------------------------------------------
 * Kuiper's test
 *
 * V = D+ + D-, the largest excess plus the largest deficit of the empirical
 * CDF over the reference. Unlike the Kolmogorov-Smirnov D, V is invariant
 * under a cyclic shift of the phase origin, which is what makes it the right
 * statistic on a circle: phase 0 is an arbitrary cut, not a boundary, and an
 * effect straddling it would look weaker to KS purely by where the cut fell.
 * ------------------------------------------------------------------------ */

export function kuiperPValue(v, n) {
  if (!(n > 0) || !(v > 0)) return 1;
  const sq = Math.sqrt(n);
  const lam = (sq + 0.155 + 0.24 / sq) * v;
  let p = 0;
  for (let j = 1; j <= 100; j++) {
    const a = 2 * j * j * lam * lam;
    const term = (2 * a - 1) * Math.exp(-a);
    p += term;
    if (j > 3 && Math.abs(term) < 1e-12) break;
  }
  return Math.min(Math.max(2 * p, 0), 1);
}

export function kuiperTest(flarePhases, intervals, period, t0) {
  const n = flarePhases.length;
  const ref = exposureCdf(intervals, period, t0);
  if (n === 0) {
    return { n: 0, dPlus: 0, dMinus: 0, v: 0, p: 1,
             refPhase: ref.phase, refCdf: ref.cdf,
             samplePhase: [], sampleCdf: [] };
  }
  const sample = Float64Array.from(flarePhases).sort();
  let dPlus = -Infinity, dMinus = -Infinity;
  const fAt = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    fAt[i] = cdfAt(ref.phase, ref.cdf, sample[i]);
    dPlus = Math.max(dPlus, (i + 1) / n - fAt[i]);
    dMinus = Math.max(dMinus, fAt[i] - i / n);
  }
  const v = dPlus + dMinus;
  return {
    n, dPlus, dMinus, v, p: kuiperPValue(v, n),
    refPhase: ref.phase, refCdf: ref.cdf,
    samplePhase: Array.from(sample),
    sampleCdf: Array.from({ length: n }, (_, i) => (i + 1) / n),
  };
}

/* ---------------------------------------------------------------------------
 * Poisson excess per phase bin
 *
 * The expected count in a bin is the total count times that bin's share of
 * the exposure, so a bin that falls in a data gap expects nothing and is not
 * penalised for holding nothing. The p-value is the Poisson survival function
 * at the observed count, Bonferroni-corrected across the bins of that
 * binning. The correction is within a binning, not across binnings: the 2-,
 * 4-, 8- and 16-bin searches are four views of one dataset, not twenty-eight
 * independent trials, and multiplying by 28 would be the wrong correction in
 * the conservative direction.
 * ------------------------------------------------------------------------ */

function logGamma(x) {
  // Lanczos, g = 7, n = 9. Accurate to ~1e-13 relative for x > 0, which is
  // far better than the Poisson tail needs.
  const g = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
             771.32342877765313, -176.61502916214059, 12.507343278686905,
             -0.13857109526572012, 9.9843695780195716e-6,
             1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = g[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += g[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/* P(X >= k) for X ~ Poisson(mu). Summed from the smaller tail so the terms
 * stay representable: at mu = 40 the direct sum of the upper tail starts from
 * exp(-40) and loses most of its significant digits. */
export function poissonSf(k, mu) {
  if (mu <= 0) return k > 0 ? 0 : 1;
  if (k <= 0) return 1;
  if (k < mu) {
    // Upper tail is the bigger one: 1 - P(X <= k-1), summed directly.
    let sum = 0;
    for (let i = 0; i < k; i++) {
      sum += Math.exp(-mu + i * Math.log(mu) - logGamma(i + 1));
    }
    return Math.min(Math.max(1 - sum, 0), 1);
  }
  // Upper tail is the small one: sum it until the terms stop mattering.
  let sum = 0, i = k;
  for (; i < k + 10000; i++) {
    const term = Math.exp(-mu + i * Math.log(mu) - logGamma(i + 1));
    sum += term;
    if (term < 1e-18 * Math.max(sum, 1e-300)) break;
  }
  return Math.min(Math.max(sum, 0), 1);
}

export function poissonPhaseSearch(flarePhases, intervals, period, t0,
                                   binCounts = [2, 4, 8, 16], threshold = 0.05) {
  const out = [];
  const nTotal = flarePhases.length;
  for (const nbins of binCounts) {
    const exposure = phaseExposure(intervals, period, t0, nbins);
    let expTotal = 0;
    for (let i = 0; i < nbins; i++) expTotal += exposure[i];

    const observed = new Array(nbins).fill(0);
    for (const ph of flarePhases) {
      observed[Math.min(Math.floor(ph * nbins), nbins - 1)] += 1;
    }
    const expected = [], pRaw = [], pBonf = [], significant = [];
    for (let i = 0; i < nbins; i++) {
      const e = expTotal > 0 ? nTotal * exposure[i] / expTotal : 0;
      expected.push(e);
      const p = e > 0 ? poissonSf(observed[i], e) : (observed[i] > 0 ? 0 : 1);
      pRaw.push(p);
      const pb = Math.min(Math.max(p * nbins, 0), 1);
      pBonf.push(pb);
      if (pb < threshold) significant.push(i);
    }
    out.push({ nbins, observed, expected, exposure: Array.from(exposure),
               pRaw, pBonf, significant });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * the pieces the page assembles
 * ------------------------------------------------------------------------ */

export function phaseOf(t, period, t0) {
  return (((t - t0) / period) % 1 + 1) % 1;
}

/* At most one flare per cycle, the brightest.
 *
 * Without this a single flaring episode spanning several detected sub-peaks
 * inside one orbit counts as several independent phase-locked events, and one
 * storm at one phase can look like a repeated signal. The conclusion the page
 * reports is driven by this reduced list; the raw list is shown beside it so
 * the difference is visible rather than hidden. */
export function brightestPerCycle(flares, period, t0) {
  const best = new Map();
  for (const f of flares) {
    const cyc = Math.round((f.t_peak - t0) / period);
    const cur = best.get(cyc);
    if (!cur || f.peak_sigma > cur.peak_sigma) best.set(cyc, f);
  }
  return Array.from(best.values()).sort((a, b) => a.t_peak - b.t_peak);
}

/* Flares grouped into physical EVENTS.
 *
 * The detector requires strictly consecutive points above threshold, so one
 * flare whose decay dips below it and returns is recorded as several
 * detections. On TOI-3235 that is the difference between 10 and 2, and
 * between a rate of 0.149/day and 0.030/day. */
export function groupEvents(flares, gapDays = 0.04) {
  const sorted = [...flares].sort((a, b) => a.t_peak - b.t_peak);
  const groups = [];
  let cur = null;
  for (const f of sorted) {
    if (!cur || f.t_peak - cur.last > gapDays) {
      cur = { members: [f], last: f.t_peak, brightest: f };
      groups.push(cur);
    } else {
      cur.members.push(f);
      cur.last = f.t_peak;
      if (f.peak_sigma > cur.brightest.peak_sigma) cur.brightest = f;
    }
  }
  return groups;
}

/* A Poisson confidence interval on a rate, for the tables.
 *
 * Garwood (1936): the exact interval from the chi-square quantiles. For zero
 * events the upper limit is -ln(alpha) events, which at 95% is the familiar
 * 3.0, and that is the number a non-detection should be quoted with. */
export function rateInterval(n, exposure, conf = 0.95) {
  if (!(exposure > 0)) return { lo: NaN, hi: NaN };
  const alpha = 1 - conf;
  if (n === 0) return { lo: 0, hi: -Math.log(alpha) / exposure };
  // Wilson-Hilferty approximation to the chi-square quantiles: accurate to a
  // few parts in a thousand above n = 5, which is all a displayed interval
  // needs. Exact at n = 0 through the branch above.
  const z = 1.959963984540054;      // the 97.5th percentile of the normal
  const lo = n * Math.pow(1 - 1 / (9 * n) - z / (3 * Math.sqrt(n)), 3);
  const hi = (n + 1) * Math.pow(1 - 1 / (9 * (n + 1)) + z / (3 * Math.sqrt(n + 1)), 3);
  return { lo: Math.max(lo, 0) / exposure, hi: hi / exposure };
}
