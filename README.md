# tess-flares

**[eartigau.github.io/tess-flares](https://eartigau.github.io/tess-flares/)**

Flare rates measured from TESS light curves, and a test of whether a star's
flares follow the orbital phase of its planets.

Type a star's name and you get its flare rate with an uncertainty, its light
curve with every detected flare marked, and the phase statistics folded on
whatever period you like: a known planet's, the rotation period, or one you
type. Stars you save are compiled in a second tab.

## How a static site does this

A browser cannot query MAST, download a TESS light curve or run a flare
detection. Those are done once per star, offline, by the pipeline in
[syncflares](https://github.com/eartigau/syncflares), and the result is
shipped as JSON.

What is **not** precomputed is the part a visitor changes. The phase
statistics for an arbitrary period are recomputed in the browser, which is
what makes this worth building as a static site rather than a catalogue of
fixed answers.

That works because of one choice in the data format: the light curve's
coverage is shipped as **intervals of continuous observation**
`(start, end, cadence)` rather than as cadence times. A few hundred intervals
per star, instead of hundreds of thousands of timestamps. The exposure in any
phase bin then follows by integration, so the exposure-weighted reference the
Kuiper test needs is exact for any period, and reproduces the pipeline's
cadence-summed exposure to better than 0.2%.

The displayed series is decimated to about 4000 binned points, plus every
cadence within 43 minutes of a flare so a flare still looks like a flare when
you zoom in, capped at 40,000 full-resolution points.

## What it computes

- **Flare rate** per day of exposure, with a Poisson interval; a 95% upper
  limit where nothing was detected. Detections are grouped into events, since
  the detector requires strictly consecutive points and one flare whose decay
  dips below threshold is otherwise counted several times.
- **Kuiper's test** (Kuiper 1960; Stephens 1970) against the light curve's own
  exposure-weighted phase coverage, not against a flat expectation.
- **Poisson excess** per phase bin at 2, 4, 8 and 16 bins, Bonferroni-corrected
  within each binning.
- Both run on all detections and on at most one flare per cycle, the
  brightest; the conclusion follows the latter, because one flare storm
  spanning several sub-peaks inside one orbit otherwise looks exactly like
  phase-locking.

Full method and references are in the site's **Methods** tab.

## A caution the site also carries

The p-values are screening statistics, not discoveries. They are corrected
neither for the number of stars you look at nor for the number of periods you
try, and they assume flares are independent, which they are not. A star whose
flares arrive in storms will produce small p-values with no planet involved.

## Repository layout

```
index.html          the page
assets/stats.js     Kuiper, Poisson, phase coverage; a port of
                    syncflares/stats.py, checked against it by that
                    repository's tests/test_web_stats.py
assets/app.js       the page's logic
assets/methods.js   the Methods tab, both languages
assets/i18n.js      every string and every (i) box, EN and FR
assets/theme.css    the shared house style
assets/app.css      this tool's own rules
data/index.json     the catalogue
data/<star>.json    one star: flares, coverage intervals, display series
```

Rebuild or extend the catalogue with `web/precompute.py` in
[syncflares](https://github.com/eartigau/syncflares).

## Credits

TESS data from the MAST archive at STScI; stellar and planetary parameters
from the NASA Exoplanet Archive, operated by Caltech under contract with NASA
under the Exoplanet Exploration Program. Flare detection follows Medina et al.
(2020), ApJ 905, 107. Plots by Plotly.
