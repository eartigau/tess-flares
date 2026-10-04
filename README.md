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

**Every photometric cadence is shipped**, not a binned summary. The series
goes in a separate binary file as Int16 on a regular per-block grid: within a
block the cadences sit on a fixed step, so a slot's time is `t0 + i*dt` and
only the flux has to be stored, 2 bytes against the ~14 a JSON number costs.
AU Mic's 218,570 cadences are 467 kB; TOI-700's 2.6 million are 5.4 MB rather
than 38. The flux scale is per star, `max|flux-1|/32000`, putting the
quantisation between 1 and 10 ppm, far below any star's noise.

**The x axis is broken.** TESS observes in sectors separated by months or
years, and on a true time axis these data are slivers in white: TOI-1452
spans 1979 days of which 848 hold data. Blocks of continuous observation are
laid side by side with a shaded band at each break, labelled with the sector
and the real starting date. Every point keeps its true BJD in its hover text,
and no statistic uses the display coordinate.

**Points inside a flare are coloured separately**, recomputed in the browser
from the catalogue's first and last contact times. Drawing is thinned to
~150,000 points since a browser is 1600 px wide, but in-flare cadences are
never thinned and the factor is printed under the plot.

## A star the catalogue does not have

Type any name. If the catalogue has no match the page asks **SIMBAD**, which
settles two things: whether the star is here under another identifier (GJ 1,
HD 225213 and TIC 120461526 are one object, and the page re-searches on every
alias), and if not, what the star actually is.

It then offers to **compute it**. The request is filed as a GitHub issue, the
[add-star workflow](.github/workflows/add-star.yml) runs the real pipeline on
it, and the catalogue is committed back; the page follows the run with a bar
over the six steps and loads the star when it lands. Two to ten minutes,
dominated by the MAST download.

A request can be refused, and the commonest reason is worth knowing: **the
star may have no TESS light curve at all**. GJ 1214 is exactly that, a
well-studied planet host with no pipeline product on MAST. The workflow checks
before spending minutes on it.

SIMBAD is the only one of the three archives that can be reached from a
browser: it sends `Access-Control-Allow-Origin`, the NASA Exoplanet Archive
does not, and MAST is a different matter entirely.

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
data/<star>.json    one star: flares, coverage intervals, series header
data/<star>.bin     every photometric cadence, Int16 on a regular grid
```

Rebuild or extend the catalogue with `web/precompute.py` in
[syncflares](https://github.com/eartigau/syncflares).

## Credits

TESS data from the MAST archive at STScI; stellar and planetary parameters
from the NASA Exoplanet Archive, operated by Caltech under contract with NASA
under the Exoplanet Exploration Program. Flare detection follows Medina et al.
(2020), ApJ 905, 107. Plots by Plotly.
