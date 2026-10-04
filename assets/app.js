/*
 * tess-flares: the page.
 *
 * Loads a precomputed star, draws its light curve and its flares, and
 * recomputes the phase statistics in the browser for whatever period the
 * visitor asks for. The statistics live in stats.js, which is a port of
 * syncflares/stats.py checked against it by tests/test_web_stats.py.
 */
import { UI, HELP } from './i18n.js';
import { METHODS } from './methods.js';
import { aliasesOf, resolveStar, ticOf } from './resolve.js';
import { SLOW_AFTER_MS, issueUrl, slugify, watchRequest } from './addstar.js';
import { DEFAULT_MAX_SECTORS, computeStar } from './browser_pipeline.js';
import {
  brightestPerCycle, exposureCdf, groupEvents, kuiperTest, phaseExposure,
  phaseOf, poissonPhaseSearch, rateInterval,
} from './stats.js';

const $ = (id) => document.getElementById(id);
const EVENT_GAP_DAYS = 0.04;        // detections closer than this are one flare
const SAVED_KEY = 'tess-flares.saved.v1';

let lang = localStorage.getItem('tess-flares.lang') || 'en';
let index = null;      // the catalogue
let star = null;       // the star loaded
let fold = null;       // { period, t0, source }

const t = (k) => (UI[lang] && UI[lang][k]) || UI.en[k] || k;
const fmt = (x, d = 2) => (x === null || x === undefined || !isFinite(x))
  ? '—' : Number(x).toFixed(d);

/* A p-value is written as a bound when it is tiny, never as 0.000. */
function fmtP(p) {
  if (!isFinite(p)) return '—';
  if (p < 1e-4) return p.toExponential(1);
  return p.toFixed(4);
}

// ───────────────────────────── the (i) boxes ─────────────────────────────

let tip = null;
function showHelp(btn) {
  const help = HELP[btn.dataset.help];
  if (!help) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
  }
  const text = help[lang] || help.en;
  tip.textContent = text;
  if (help.cite) {
    const c = document.createElement('cite');
    c.textContent = help.cite;
    tip.appendChild(c);
  }
  tip.style.display = 'block';
  const box = btn.getBoundingClientRect();
  const width = Math.min(Math.max(420, Math.min(720, 300 + 0.28 * text.length)),
                         window.innerWidth - 24);
  tip.style.width = `${width}px`;
  const left = Math.min(Math.max(12, box.left - 20), window.innerWidth - width - 12);
  let top = box.bottom + window.scrollY + 8;
  // Flip above when there is no room below.
  if (box.bottom + tip.offsetHeight > window.innerHeight - 8) {
    top = Math.max(window.scrollY + 8, box.top + window.scrollY - tip.offsetHeight - 8);
  }
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
const hideHelp = () => { if (tip) tip.style.display = 'none'; };

document.addEventListener('mouseover', (e) => {
  const b = e.target.closest('button.info');
  if (b) showHelp(b);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest('button.info')) hideHelp();
});
document.addEventListener('focusin', (e) => {
  const b = e.target.closest('button.info');
  if (b) showHelp(b);
});
document.addEventListener('focusout', hideHelp);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideHelp(); });

// ───────────────────────────── language ─────────────────────────────

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = t(el.dataset.i18n);
    if (v) el.textContent = v;
  });
  $('lang').textContent = lang === 'en' ? 'FR' : 'EN';
  renderMethods();
  if (star) render();
  renderSaved();
}

$('lang').onclick = () => {
  lang = lang === 'en' ? 'fr' : 'en';
  localStorage.setItem('tess-flares.lang', lang);
  applyLang();
};

// ───────────────────────────── tabs ─────────────────────────────

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
    document.querySelectorAll('.layout').forEach((x) => x.classList.remove('on'));
    tab.classList.add('on');
    $(`tab-${tab.dataset.tab}`).classList.add('on');
    if (tab.dataset.tab === 'saved') renderSaved();
    // Plotly sizes to a hidden container as zero; redraw once visible.
    window.dispatchEvent(new Event('resize'));
  };
});

// ───────────────────────────── the catalogue ─────────────────────────────

async function loadIndex() {
  const r = await fetch('data/index.json');
  if (!r.ok) throw new Error(`index.json: ${r.status}`);
  index = await r.json();
}

function search(q) {
  const needle = q.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!needle) return index.stars.slice(0, 12);
  const scored = [];
  for (const s of index.stars) {
    const hay = [s.name, `tic ${s.tic}`, ...(s.aliases || [])]
      .map((x) => String(x).toLowerCase());
    let best = Infinity;
    for (const h of hay) {
      if (h === needle) best = Math.min(best, 0);
      else if (h.startsWith(needle)) best = Math.min(best, 1);
      else if (h.includes(needle)) best = Math.min(best, 2);
    }
    if (best < Infinity) scored.push([best, s]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, 12).map((x) => x[1]);
}

function renderMenu(items) {
  const menu = $('menu');
  if (!items.length) { menu.classList.remove('on'); return; }
  menu.innerHTML = items.map((s, i) =>
    `<div data-slug="${s.slug}" class="${i === 0 ? 'sel' : ''}">${s.name}` +
    `<small>TIC ${s.tic} · ${s.n_flares} ${t('flares')}` +
    `${s.n_planets ? ` · ${s.n_planets} pl.` : ''}</small></div>`).join('');
  menu.classList.add('on');
  menu.querySelectorAll('div').forEach((d) => {
    d.onclick = () => { menu.classList.remove('on'); loadStar(d.dataset.slug); };
  });
}

$('q').addEventListener('input', () => renderMenu(search($('q').value)));
$('q').addEventListener('focus', () => renderMenu(search($('q').value)));
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('go').click(); }
  if (e.key === 'Escape') $('menu').classList.remove('on');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.suggest')) $('menu').classList.remove('on');
});
$('go').onclick = () => {
  const typed = $('q').value.trim();
  const hits = search(typed);
  if (hits.length) { $('menu').classList.remove('on'); loadStar(hits[0].slug); }
  else if (typed) handleMiss(typed);
};

/* A name the catalogue does not have.
 *
 * Two things can be true: the star may be in the catalogue under a different
 * name, or it may not be here at all. SIMBAD settles both, because its
 * identifier table is what knows that GJ 1, HD 225213 and TIC 120461526 are
 * one star. So: resolve, re-search on every alias, and only if that still
 * misses, report what the star is and how to add it.
 */
async function handleMiss(typed) {
  $('menu').classList.remove('on');
  $('msg').innerHTML =
    `<p class="hint"><span class="spinner"></span>${t('resolving')}</p>`;

  let info = null;
  try {
    info = await resolveStar(typed);
  } catch (err) {
    $('msg').innerHTML = `<div class="err">${t('not_found')} ` +
      `${lang === 'fr' ? 'SIMBAD injoignable' : 'SIMBAD unreachable'}: ` +
      `${err.message}</div>`;
    return;
  }

  if (!info.found) {
    $('msg').innerHTML = `<div class="err">${lang === 'fr'
      ? `Ni le catalogue ni SIMBAD ne connaissent « ${escapeHtml(typed)} ».`
      : `Neither the catalogue nor SIMBAD knows "${escapeHtml(typed)}".`}</div>`;
    return;
  }

  // The same star under another name?
  const aliases = await aliasesOf(info.mainId);
  // MAST answers to a TIC and nothing else, so the in-browser computation is
  // only offered when SIMBAD gives one.
  info.tic = ticOf(aliases);
  for (const alias of [info.mainId, ...aliases]) {
    const hit = search(alias);
    if (hit.length && hit[0].name.toLowerCase() === alias.toLowerCase().trim()) {
      $('msg').innerHTML = '';
      $('q').value = hit[0].name;
      loadStar(hit[0].slug);
      return;
    }
  }
  // Or matched by TIC, which the index carries for every star.
  const ticAlias = aliases.find((a) => /^TIC\s*\d+$/i.test(a));
  if (ticAlias) {
    const tic = Number(ticAlias.replace(/[^0-9]/g, ''));
    const byTic = index.stars.find((x) => x.tic === tic);
    if (byTic) {
      $('msg').innerHTML = `<p class="hint">${lang === 'fr'
        ? `« ${escapeHtml(typed)} » est ${escapeHtml(byTic.name)} au catalogue.`
        : `"${escapeHtml(typed)}" is ${escapeHtml(byTic.name)} in the catalogue.`}</p>`;
      $('q').value = byTic.name;
      loadStar(byTic.slug);
      return;
    }
  }

  showUncatalogued(typed, info);
}

const escapeHtml = (x) => String(x).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* What SIMBAD knows, and the offer to compute it.
 *
 * The page cannot compute anything itself, so it offers to ask: filing an
 * issue starts a workflow that runs the real pipeline and commits the star
 * back. The visitor is told how long that takes and is not made to wait for
 * it; the page watches and says when the star has landed.
 */
let stopWatch = null;

function showUncatalogued(typed, info) {
  ['overview', 'seriescard', 'ratecard', 'periodcard', 'phasecard', 'cdfcard',
   'synccard', 'flarecard'].forEach((id) => { $(id).hidden = true; });
  if (stopWatch) { stopWatch(); stopWatch = null; }

  const bits = [];
  if (info.spType) bits.push(info.spType);
  if (info.objType) bits.push(info.objType);
  if (Number.isFinite(info.distancePc)) bits.push(`${info.distancePc.toFixed(2)} pc`);
  if (Number.isFinite(info.vmag)) bits.push(`V = ${info.vmag.toFixed(2)}`);
  if (Number.isFinite(info.jmag)) bits.push(`J = ${info.jmag.toFixed(2)}`);
  const name = info.mainId;
  const coords = `${info.ra.toFixed(5)}, ${info.dec.toFixed(5)}`;
  const simbadUrl = 'https://simbad.cds.unistra.fr/simbad/sim-id?Ident=' +
    encodeURIComponent(name);
  const alsoTyped = typed.toLowerCase() !== name.toLowerCase()
    ? (lang === 'fr' ? ` (vous avez tapé <b>${escapeHtml(typed)}</b>)`
                     : ` (you typed <b>${escapeHtml(typed)}</b>)`) : '';

  const head = lang === 'fr'
    ? `<p><b>${escapeHtml(name)}</b> est une vraie étoile, connue de SIMBAD${alsoTyped} :
       ${bits.map(escapeHtml).join(' &middot; ') || 'aucun paramètre listé'}, en ${coords}.
       <a href="${simbadUrl}" target="_blank" rel="noopener">Sa page SIMBAD</a>.</p>
       <p>Elle n'est pas encore au catalogue. Je peux la faire calculer : la
       demande lance le pipeline, qui télécharge la photométrie TESS, la
       détendance et y cherche les flares, puis l'ajoute au catalogue.
       <b>Comptez deux à dix minutes</b>, surtout du téléchargement.</p>`
    : `<p><b>${escapeHtml(name)}</b> is a real star, and SIMBAD knows it${alsoTyped}:
       ${bits.map(escapeHtml).join(' &middot; ') || 'no parameters listed'}, at ${coords}.
       <a href="${simbadUrl}" target="_blank" rel="noopener">Its SIMBAD page</a>.</p>
       <p>It is not in the catalogue yet. I can have it computed: the request
       starts the pipeline, which downloads the TESS photometry, detrends it,
       looks for flares and adds it to the catalogue.
       <b>Expect two to ten minutes</b>, mostly downloading.</p>`;

  const btnNow = lang === 'fr' ? 'Calculer ici, maintenant' : 'Compute it here, now';
  const btnAdd = lang === 'fr' ? 'Ajouter au catalogue' : 'Add to the catalogue';
  const noteNow = lang === 'fr'
    ? `Dans votre navigateur, en quelques dizaines de secondes. Télécharge
       Python (~30 Mo, une seule fois) puis ${DEFAULT_MAX_SECTORS} secteurs TESS
       (~30 Mo). Le résultat est à vous seul et n'est pas conservé.`
    : `In your browser, in under a minute. Downloads Python (~30 MB, once) and
       ${DEFAULT_MAX_SECTORS} TESS sectors (~30 MB). The result is yours alone
       and is not kept.`;
  const noteAdd = lang === 'fr'
    ? `Lance le pipeline complet sur GitHub, tous secteurs, et l'ajoute au
       catalogue pour tout le monde. Deux à dix minutes, compte GitHub requis.`
    : `Runs the full pipeline on GitHub, every sector, and adds it to the
       catalogue for everyone. Two to ten minutes, a GitHub account is needed.`;

  $('msg').innerHTML = `
    <div class="verdict">
      ${head}
      <div class="row" style="margin-top:14px;align-items:flex-start">
        <div style="flex:1;min-width:250px">
          <button id="computehere" class="go" type="button">${btnNow}</button>
          <p class="hint" style="margin:7px 0 0">${noteNow}</p>
        </div>
        <div style="flex:1;min-width:250px">
          <button id="askstar" class="small" type="button">${btnAdd}</button>
          <p class="hint" style="margin:7px 0 0">${noteAdd}</p>
        </div>
      </div>
      <div id="watch"></div>
    </div>`;

  if (info.tic) {
    $('computehere').onclick = () => computeHere(name, info);
  } else {
    $('computehere').disabled = true;
    $('computehere').title = lang === 'fr'
      ? "SIMBAD ne donne pas de numéro TIC pour cette étoile, et MAST ne répond qu'à un TIC."
      : 'SIMBAD gives no TIC for this star, and MAST answers only to a TIC.';
  }
  $('askstar').onclick = () => {
    const slug = slugify(name);
    window.open(issueUrl(name), '_blank', 'noopener');
    $('askstar').disabled = true;
    $('askstar').textContent = lang === 'fr' ? 'Demande ouverte' : 'Request opened';
    startWatching(name, slug);
  };

  // A request may already be running from an earlier visit.
  startWatching(name, slugify(name), { quiet: true });
}

/* Compute a star here, in this browser.
 *
 * The result is shaped exactly like a catalogue entry, so every panel on the
 * page works on it unchanged: the fold, the Kuiper test, the Poisson search,
 * the saved-stars tab. The only difference is that it is not kept, and the
 * page says so, because a visitor who recomputes the same star twice should
 * know why it took a minute the second time too.
 */
async function computeHere(name, info) {
  const box = $('watch');
  const btn = $('computehere');
  if (btn) { btn.disabled = true; }
  if (stopWatch) { stopWatch(); stopWatch = null; }

  const t0 = Date.now();
  const STEPS = [
    { key: 'pyodide', label: lang === 'fr' ? 'Chargement de Python' : 'Loading Python' },
    { key: 'search', label: lang === 'fr' ? 'Recherche MAST' : 'Searching MAST' },
    { key: 'download', label: lang === 'fr' ? 'Téléchargement TESS' : 'Downloading TESS' },
    { key: 'compute', label: lang === 'fr' ? 'Détection des flares' : 'Detecting flares' },
  ];
  const draw = (step, detail) => {
    const i = Math.max(0, STEPS.findIndex((x) => x.key === step));
    box.innerHTML = renderProgress({
      state: 'running', step, step_index: i, n_steps: STEPS.length,
      steps: STEPS, message: STEPS[i].label, detail: detail || '',
    }, Date.now() - t0);
  };
  draw('pyodide', '');

  let out;
  try {
    out = await computeStar(info.tic, {
      onProgress: ({ step, detail }) => draw(step, detail),
    });
  } catch (err) {
    box.innerHTML = `<div class="err">${escapeHtml(err.message)}</div>`;
    if (btn) btn.disabled = false;
    return;
  }
  if (out.error) {
    box.innerHTML = `<div class="err">${escapeHtml(out.message || out.error)}</div>`;
    if (btn) btn.disabled = false;
    return;
  }

  // Shape it like a catalogue record. The series is held as plain arrays
  // rather than the binary grid a precomputed star uses, so drawSeries is
  // given blocks it can read the same way.
  star = {
    schema: 2, name, slug: slugify(name), computed_here: true,
    generated: new Date().toISOString().slice(0, 10),
    star: {
      tic: info.tic, ra: info.ra, dec: info.dec, tmag: null,
      distance_pc: info.distancePc, st_rad: null, st_mass: null,
      st_teff: null, st_logg: null, st_rotp: null,
    },
    planets: [],
    tess: {
      sectors: out.sectors, author: 'SPOC',
      n_cadences: out.n_cadences, n_cadences_plotted: out.n_cadences,
      baseline_days: round6(out.t_max - out.t_min),
      exposure_days: out.exposure_days,
      t_min: out.t_min, t_max: out.t_max,
      exptime_by_sector: {},
    },
    detection: {
      whitening: 'running median, 3.0 h window',
      sigma_threshold: 3.0, min_consecutive_points: 3, max_amplitude: 3.0,
      noise_per_point: out.noise_per_point,
      min_detectable_amplitude: out.min_detectable_amplitude,
      n_masked_in_transit: 0,
    },
    flares: out.flares,
    coverage: out.coverage,
    series: null,
    inline_series: out.flux,
    sectors_available: out.sectors_available,
    bytes_downloaded: out.bytes_downloaded,
  };

  // No planets are known here: the Exoplanet Archive cannot be reached from a
  // browser (no CORS), so there is no period to offer and the visitor types
  // one. SIMBAD gave the identity; it does not give orbits.
  fold = null;
  $('q').value = name;
  box.innerHTML = '';
  $('msg').innerHTML = renderComputedHere(star, Date.now() - t0);
  render();
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

function renderComputedHere(st, ms) {
  const secs = (ms / 1000).toFixed(0);
  const mb = (st.bytes_downloaded / 1048576).toFixed(0);
  const missing = (st.sectors_available || []).filter((s) => !st.tess.sectors.includes(s));
  const more = missing.length
    ? (lang === 'fr'
       ? ` ${missing.length} autre(s) secteur(s) existent (${missing.join(', ')}) et n'ont pas été téléchargés.`
       : ` ${missing.length} further sector(s) exist (${missing.join(', ')}) and were not downloaded.`)
    : '';
  const txt = lang === 'fr'
    ? `<b>Calculé dans votre navigateur</b> en ${secs} s, ${mb} Mo téléchargés,
       secteurs ${st.tess.sectors.join(', ')}.${more}
       Ce résultat n'est pas conservé : rechargez la page et il disparaît.
       Aucune planète n'est listée, car l'archive des exoplanètes n'est pas
       joignable depuis un navigateur ; tapez une période pour replier.`
    : `<b>Computed in your browser</b> in ${secs} s, ${mb} MB downloaded,
       sectors ${st.tess.sectors.join(', ')}.${more}
       This result is not kept: reload and it is gone. No planets are listed,
       because the exoplanet archive cannot be reached from a browser; type a
       period to fold on.`;
  return `<div class="verdict yes">${txt}</div>`;
}

/* Follow a request and draw the bar. */
function startWatching(name, slug, { quiet = false } = {}) {
  if (stopWatch) stopWatch();
  const box = $('watch');
  if (!box) return;
  let sawAnything = false;

  stopWatch = watchRequest(slug, (st) => {
    if (st.state === 'waiting' && !sawAnything) {
      // Nothing filed yet: say nothing unless the visitor just asked.
      if (quiet) return;
      box.innerHTML = renderProgress({
        state: 'waiting', step_index: 0, n_steps: 6,
        message: lang === 'fr' ? 'En attente de la prise en charge'
                               : 'Waiting for the run to start',
      }, st.elapsedMs);
      return;
    }
    sawAnything = true;
    if (st.state === 'landed') {
      box.innerHTML = `<p class="hint">${lang === 'fr'
        ? `<b>${escapeHtml(name)}</b> est au catalogue. Chargement...`
        : `<b>${escapeHtml(name)}</b> is in the catalogue. Loading...`}</p>`;
      loadIndex().then(() => { $('q').value = name; loadStar(slug); });
      return;
    }
    box.innerHTML = renderProgress(st, st.elapsedMs);
  });
}

function renderProgress(st, elapsedMs) {
  const secs = Math.round((elapsedMs ?? (st.elapsed_s || 0) * 1000) / 1000);
  const mm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const slow = (elapsedMs ?? 0) > SLOW_AFTER_MS;

  if (st.state === 'refused') {
    return `<div class="err" style="margin-top:12px">
      <b>${lang === 'fr' ? 'Pas ajoutée' : 'Not added'}:</b>
      ${escapeHtml(st.message || '')}
      ${st.detail ? `<br><span class="hint">${escapeHtml(st.detail)}</span>` : ''}
    </div>`;
  }
  if (st.state === 'failed' || st.state === 'timeout') {
    const msg = st.state === 'timeout'
      ? (lang === 'fr'
         ? 'Toujours rien après vingt minutes. La demande est peut-être en file ; revenez plus tard.'
         : 'Still nothing after twenty minutes. The request may be queued; come back later.')
      : escapeHtml(st.error || st.message || '');
    return `<div class="err" style="margin-top:12px">${msg}</div>`;
  }

  const steps = st.steps || [];
  const n = st.n_steps || steps.length || 6;
  const i = Math.min(st.step_index ?? 0, n);
  const pct = n ? Math.round(100 * i / n) : 0;
  const indet = st.state === 'waiting' || st.step === 'queued';

  const chips = steps.length
    ? `<div class="steps">${steps.map((x, k) =>
        `<span class="${k < i ? 'past' : k === i ? 'on' : ''}">${escapeHtml(
          lang === 'fr' ? (STEP_FR[x.key] || x.label) : x.label)}</span>`).join('')}</div>`
    : '';

  return `<div class="progress">
    <div class="bar"><div class="fill${indet ? ' indet' : ''}"
      style="width:${pct}%"></div></div>
    ${chips}
    <div class="meta">
      <span>${slow ? '<span class="sablier">⏳</span>' : ''}<b>${escapeHtml(st.message || '')}</b>
        ${st.detail ? ` &middot; ${escapeHtml(st.detail)}` : ''}</span>
      <span>${mm}${st.run_url
        ? ` &middot; <a href="${st.run_url}" target="_blank" rel="noopener">${
            lang === 'fr' ? 'journal' : 'log'}</a>` : ''}</span>
    </div>
  </div>`;
}

const STEP_FR = {
  resolve: 'Résolution du nom', search: 'Recherche MAST',
  download: 'Téléchargement', detrend: 'Détendancement',
  detect: 'Détection des flares', write: 'Écriture',
};


$('rand').onclick = () => {
  const s = index.stars[Math.floor(Math.random() * index.stars.length)];
  $('q').value = s.name;
  loadStar(s.slug);
};

async function loadStar(slug) {
  $('msg').innerHTML = `<p class="hint"><span class="spinner"></span>${t('loading')} ${slug}...</p>`;
  try {
    const r = await fetch(`data/${slug}.json`);
    if (!r.ok) throw new Error(`${slug}.json: ${r.status}`);
    star = await r.json();
    // The photometry: every cadence, Int16 on a regular grid. Fetched as a
    // binary file rather than inlined, because base64 in JSON would cost a
    // third more bytes and a parse of millions of numbers.
    if (star.series && star.series.bin) {
      const rb = await fetch(`data/${star.series.bin}`);
      if (!rb.ok) throw new Error(`${star.series.bin}: ${rb.status}`);
      star.values = new Int16Array(await rb.arrayBuffer());
    }
  } catch (err) {
    $('msg').innerHTML = `<div class="err">${err.message}</div>`;
    return;
  }
  $('msg').innerHTML = '';
  $('q').value = star.name;
  history.replaceState(null, '', `?star=${encodeURIComponent(star.slug)}`);
  // Default fold: the innermost planet, else rotation, else the baseline.
  // A planet first, then the rotation period. Never a period invented from
  // the baseline: it carries no meaning, and the few cycles it covers make
  // the brightest-per-cycle reduction throw away almost every flare.
  const pl = star.planets.find((p) => p.period_days);
  const rot = star.star.st_rotp;
  if (pl) {
    fold = { period: pl.period_days, t0: pl.epoch_bjd ?? star.tess.t_min,
             source: pl.name };
  } else if (rot) {
    fold = { period: rot, t0: star.tess.t_min,
             source: 'rotation' };
  } else {
    fold = null;
  }
  if (fold) { $('P').value = fold.period; $('T0').value = fold.t0; }
  render();
  $('overview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ───────────────────────────── drawing ─────────────────────────────

const AX = {
  paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(4,10,20,0.45)',
  font: { color: '#c7d4e8', family: 'IBM Plex Mono, monospace', size: 11 },
  margin: { l: 58, r: 16, t: 10, b: 44 },
  xaxis: { gridcolor: 'rgba(200,220,255,0.10)', zeroline: false },
  yaxis: { gridcolor: 'rgba(200,220,255,0.10)', zeroline: false },
  showlegend: false, hovermode: 'closest',
};
const CFG = { displayModeBar: false, responsive: true };

/* The broken axis.
 *
 * TESS observes a star in sectors separated by months or years: TOI-1452
 * spans 1979 days of which 848 hold data, and on a true time axis the
 * photometry is a few slivers in an ocean of white. So the blocks are laid
 * side by side on a synthetic coordinate, separated by a fixed visual gap,
 * and the axis is labelled with the real date at which each block starts.
 *
 * Every point keeps its real BJD in the hover text, and the phase statistics
 * never see this coordinate: it exists for the eye only.
 */
const BLOCK_PAD_FRAC = 0.012;     // the visual break, as a fraction of the total

function buildAxis(blocks) {
  const span = blocks.reduce((a, b) => a + Math.max(b.span, b.dt), 0);
  const pad = span * BLOCK_PAD_FRAC;
  let x = 0;
  const laid = blocks.map((b) => {
    const entry = { ...b, x0: x, width: Math.max(b.span, b.dt) };
    x += entry.width + pad;
    return entry;
  });
  return { laid, total: Math.max(x - pad, 1e-9), pad };
}

/* Which cadences lie inside a flare. The flare list gives first and last
 * contact, so this needs no extra data: it is recomputed from the catalogue
 * the page already has. */
function flareRanges(flares) {
  return flares.map((f) => [f.t_start, f.t_end]);
}

function inAnyRange(t, ranges) {
  // Ranges are sorted by construction (flares are written in time order).
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < ranges[mid][0]) hi = mid - 1;
    else if (t > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/* Decode the blocks into plot coordinates, thinning to what the screen can
 * show.
 *
 * All the points are held; `budget` caps only how many are DRAWN. A browser
 * is about 1600 pixels wide, so 2.7 million points would put 1700 of them in
 * every pixel column and cost seconds of rendering to look identical. The
 * thinning is uniform and never touches a cadence inside a flare: those are
 * the ones worth seeing at full resolution, and they are a small fraction.
 */
/* A star computed in the browser carries plain arrays rather than the binary
 * grid a precomputed one does. Turn them into the same block structure, so
 * everything downstream — the broken axis, the thinning, the colouring — is
 * one code path rather than two. */
function blocksFromArrays(t, f, sector) {
  const blocks = [];
  let i0 = 0;
  for (let i = 1; i <= t.length; i++) {
    const brk = i === t.length ||
      sector[i] !== sector[i - 1] || (t[i] - t[i - 1]) > 2.0;
    if (!brk) continue;
    const n = i - i0;
    if (n >= 2) {
      const dt = (t[i - 1] - t[i0]) / (n - 1);
      blocks.push({ t0: t[i0], dt, n, off: i0, sector: sector[i0],
                    span: t[i - 1] - t[i0] });
    }
    i0 = i;
  }
  return blocks;
}

function decodeSeries(budget = 180000) {
  // Two shapes of the same thing: the binary grid of a catalogue star, or
  // the arrays of one just computed here.
  if (!star.series && star.inline_series) {
    const s = star.inline_series;
    const blocks = blocksFromArrays(s.t, s.f, s.sector);
    const axis = buildAxis(blocks);
    const ranges = flareRanges(star.flares);
    const total = s.t.length;
    const step = Math.max(1, Math.ceil(total / budget));
    const qx = [], qy = [], qt = [], fx = [], fy = [], ft = [];
    for (const b of axis.laid) {
      for (let k = 0; k < b.n; k++) {
        const i = b.off + k;
        const hot = inAnyRange(s.t[i], ranges);
        if (!hot && (k % step)) continue;
        const x = b.x0 + (s.t[i] - b.t0);
        if (hot) { fx.push(x); fy.push(s.f[i]); ft.push(s.t[i]); }
        else { qx.push(x); qy.push(s.f[i]); qt.push(s.t[i]); }
      }
    }
    return { axis, qx, qy, qt, fx, fy, ft, total, step };
  }

  const { blocks, scale, nodata } = star.series;
  const values = star.values;
  const axis = buildAxis(blocks);
  const ranges = flareRanges(star.flares);

  let total = 0;
  for (const b of blocks) total += b.n;
  const step = Math.max(1, Math.ceil(total / budget));

  const qx = [], qy = [], qt = [], fx = [], fy = [], ft = [];
  for (const b of axis.laid) {
    for (let i = 0; i < b.n; i++) {
      const v = values[b.off + i];
      if (v === nodata) continue;
      const t = b.t0 + i * b.dt;
      const hot = inAnyRange(t, ranges);
      if (!hot && (i % step)) continue;        // thin the quiescent points only
      const x = b.x0 + i * b.dt;
      const y = 1 + v * scale;
      if (hot) { fx.push(x); fy.push(y); ft.push(t); }
      else { qx.push(x); qy.push(y); qt.push(t); }
    }
  }
  return { axis, qx, qy, qt, fx, fy, ft, total, step };
}

function drawSeries() {
  const haveSeries = (star.series && star.values) || star.inline_series;
  if (!haveSeries) { $('seriescard').hidden = true; return; }
  const d = decodeSeries();
  const { axis } = d;

  const traces = [{
    x: d.qx, y: d.qy, type: 'scattergl', mode: 'markers',
    marker: { color: 'rgba(130,165,205,0.55)', size: 2 },
    name: lang === 'fr' ? 'hors flare' : 'out of flare',
    customdata: d.qt,
    hovertemplate: 'BJD %{customdata:.5f}<br>%{y:.5f}<extra></extra>',
  }, {
    x: d.fx, y: d.fy, type: 'scattergl', mode: 'markers',
    marker: { color: '#ffc27a', size: 3.4 },
    name: lang === 'fr' ? 'pendant un flare' : 'in flare',
    customdata: d.ft,
    hovertemplate: 'BJD %{customdata:.5f}<br>%{y:.5f}<extra></extra>',
  }];

  // The block boundaries, and a tick at the real date each one starts.
  //
  // Every boundary is drawn, but not every one is labelled: TOI-1452 has 68
  // blocks across 40 sectors, and 68 labels on a 1400 px axis overlap into an
  // unreadable band. One label per sector, and at most ~18 of them, keeps the
  // axis legible while the shaded breaks still show where every gap is.
  const shapes = [], tickvals = [], ticktext = [];
  const labelEvery = Math.max(1, Math.ceil(axis.laid.length / 18));
  let lastSector = null;
  axis.laid.forEach((b, i) => {
    if (i) {
      shapes.push({
        type: 'rect', xref: 'x', yref: 'paper',
        x0: b.x0 - axis.pad, x1: b.x0, y0: 0, y1: 1,
        fillcolor: 'rgba(200,220,255,0.07)', line: { width: 0 }, layer: 'below',
      });
    }
    const newSector = b.sector !== lastSector;
    if (newSector && (i % labelEvery === 0 || i === 0)) {
      tickvals.push(b.x0 + b.width / 2);
      ticktext.push(`S${b.sector}<br>${b.t0.toFixed(0)}`);
    }
    lastSector = b.sector;
  });

  Plotly.react('series', traces, {
    ...AX,
    showlegend: true,
    legend: { x: 0.01, y: 1.14, orientation: 'h',
              bgcolor: 'rgba(4,10,20,0.65)',
              bordercolor: 'rgba(200,220,255,0.16)', borderwidth: 1 },
    margin: { ...AX.margin, t: 34, b: 56 },
    shapes,
    xaxis: {
      ...AX.xaxis, tickvals, ticktext, tickfont: { size: 9 },
      range: [-axis.pad, axis.total + axis.pad],
      title: lang === 'fr'
        ? 'secteur et BJD de début (les intervalles sans données sont supprimés)'
        : 'sector and starting BJD (empty intervals removed)',
    },
    yaxis: { ...AX.yaxis, title: lang === 'fr' ? 'flux relatif' : 'relative flux' },
  }, CFG);

  const shown = d.qx.length + d.fx.length;
  const ex = star.tess.exposure_days;
  const thinned = d.step > 1
    ? (lang === 'fr'
       ? ` · ${shown.toLocaleString()} tracés (1 sur ${d.step} hors flare ; tous pendant un flare)`
       : ` · ${shown.toLocaleString()} drawn (1 in ${d.step} out of flare; all in flare)`)
    : (lang === 'fr' ? ' · tous tracés' : ' · all drawn');
  $('seriesnote').textContent =
    `${star.tess.sectors.length} ${t('sectors')} (${star.tess.sectors.join(', ')}) · ` +
    `${d.total.toLocaleString()} ${t('cadences')}${thinned} · ` +
    `${ex.toFixed(1)} d ${t('exposure').toLowerCase()}` +
    (star.computed_here
      ? ` · ${lang === 'fr' ? 'calculé ici' : 'computed here'}`
      : ` · ${star.tess.author}`);
}

function stat(k, v, cls = '') {
  return `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}

function drawOverview() {
  const s = star.star;
  $('starname').textContent = star.name;
  const bits = [`TIC ${s.tic}`];
  if (s.tmag) bits.push(`T = ${fmt(s.tmag)}`);
  if (s.st_teff) bits.push(`Teff = ${s.st_teff.toFixed(0)} K`);
  if (s.distance_pc) bits.push(`${fmt(s.distance_pc, 1)} pc`);
  $('staridents').textContent = bits.join(' · ');

  const pl = star.planets.map((p) =>
    `${p.name} (P = ${fmt(p.period_days, 4)} d${p.transiting ? ', transiting' : ''})`);
  $('starstats').innerHTML = [
    stat(lang === 'fr' ? 'Rayon' : 'Radius', `${fmt(s.st_rad, 3)} <small>R☉</small>`),
    stat(lang === 'fr' ? 'Masse' : 'Mass', `${fmt(s.st_mass, 3)} <small>M☉</small>`),
    stat('Teff', `${s.st_teff ? s.st_teff.toFixed(0) : '—'} <small>K</small>`),
    stat(lang === 'fr' ? 'Rotation' : 'Rotation',
         s.st_rotp ? `${fmt(s.st_rotp, 3)} <small>d</small>` : '—'),
    stat(lang === 'fr' ? 'Planètes' : 'Planets',
         `${star.planets.length}`, star.planets.length ? 'hi' : ''),
  ].join('');
  if (pl.length) {
    $('starstats').insertAdjacentHTML('afterend',
      `<p class="hint" style="margin-top:10px">${pl.join(' · ')}</p>`);
  }
}

function drawRates() {
  const flares = star.flares;
  const expo = star.tess.exposure_days;
  const events = groupEvents(flares, EVENT_GAP_DAYS);
  const n = events.length;
  const ci = rateInterval(n, expo);
  const rate = n / expo;
  const floor = star.detection.min_detectable_amplitude * 100;

  const rateStr = n === 0
    ? `< ${fmt(ci.hi, 3)}`
    : `${fmt(rate, 3)} <small>+${fmt(ci.hi - rate, 3)} −${fmt(rate - ci.lo, 3)}</small>`;

  $('ratestats').innerHTML = [
    stat(t('events'), `${n}`, n ? 'hi' : ''),
    stat(t('detections'), `${flares.length}`),
    stat(`${t('rate')} [/${lang === 'fr' ? 'j' : 'd'}]`, rateStr, n ? '' : 'warn'),
    stat(t('exposure'), `${fmt(expo, 1)} <small>d</small>`),
    stat(t('threshold'), `${fmt(floor, 2)} <small>%</small>`,
         floor > 8 ? 'warn' : ''),
  ].join('');

  if (!flares.length) {
    $('ratetable').innerHTML =
      `<p class="hint" style="margin-top:12px">${t('no_flares')} ` +
      `${lang === 'fr'
        ? `La limite supérieure vient de 3,0 événements de Poisson sur ${fmt(expo, 1)} j.`
        : `The upper limit is 3.0 Poisson events over ${fmt(expo, 1)} d.`}</p>`;
    return;
  }
  const amps = flares.map((f) => f.amplitude * 100).sort((a, b) => a - b);
  const eds = flares.map((f) => f.ed_sec).sort((a, b) => a - b);
  const med = (a) => a[Math.floor(a.length / 2)];
  $('ratetable').innerHTML = `<p class="hint" style="margin-top:12px">` +
    (lang === 'fr'
      ? `Amplitude médiane ${fmt(med(amps), 2)} % (de ${fmt(amps[0], 2)} à ${fmt(amps[amps.length - 1], 2)} %), durée équivalente médiane ${fmt(med(eds), 1)} s.`
      : `Median amplitude ${fmt(med(amps), 2)}% (${fmt(amps[0], 2)} to ${fmt(amps[amps.length - 1], 2)}%), median equivalent duration ${fmt(med(eds), 1)} s.`) +
    `</p>`;
}

function drawPeriodPills() {
  const out = [];
  for (const p of star.planets) {
    if (!p.period_days) continue;
    out.push(`<button type="button" class="small" data-p="${p.period_days}" ` +
      `data-t0="${p.epoch_bjd ?? star.tess.t_min}" data-src="${p.name}">` +
      `${p.name} · ${fmt(p.period_days, 3)} d</button>`);
  }
  if (star.star.st_rotp) {
    out.push(`<button type="button" class="small" data-p="${star.star.st_rotp}" ` +
      `data-t0="${star.tess.t_min}" data-src="rotation">` +
      `rotation · ${fmt(star.star.st_rotp, 3)} d</button>`);
  }
  $('periodpills').innerHTML = out.join('') ||
    `<span class="hint">${lang === 'fr'
      ? 'Aucune période connue : tapez-en une.' : 'No known period: type one.'}</span>`;
  $('periodpills').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      fold = { period: +b.dataset.p, t0: +b.dataset.t0, source: b.dataset.src };
      $('P').value = fold.period;
      $('T0').value = fold.t0;
      drawFold();
    };
  });
}

$('apply').onclick = () => {
  const P = parseFloat($('P').value);
  const T0 = parseFloat($('T0').value);
  if (!(P > 0)) return;
  fold = { period: P, t0: isFinite(T0) ? T0 : star.tess.t_min,
           source: lang === 'fr' ? 'saisie' : 'typed' };
  drawFold();
};
$('P').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('apply').click(); });
$('T0').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('apply').click(); });

let lastFold = null;

function drawFold() {
  if (!star) return;
  if (!fold) {
    // Nothing sensible to fold on. Say so rather than folding on a made-up
    // period and presenting its p-value as if it meant something.
    ['phasecard', 'cdfcard', 'synccard'].forEach((id) => { $(id).hidden = true; });
    $('periodsrc').textContent = lang === 'fr'
      ? 'Aucune planète ni période de rotation connue : tapez une période pour replier.'
      : 'No planet and no rotation period known: type a period to fold on.';
    return;
  }
  ['phasecard', 'cdfcard', 'synccard'].forEach((id) => { $(id).hidden = false; });
  const { period, t0 } = fold;
  const intervals = star.coverage;
  const flares = star.flares;
  const raw = flares.map((f) => phaseOf(f.t_peak, period, t0));
  const bright = brightestPerCycle(flares, period, t0);
  const brightPhase = bright.map((f) => phaseOf(f.t_peak, period, t0));

  const kRaw = kuiperTest(raw, intervals, period, t0);
  const kBright = kuiperTest(brightPhase, intervals, period, t0);
  const poisson = poissonPhaseSearch(brightPhase, intervals, period, t0);
  lastFold = { period, t0, kRaw, kBright, poisson, nBright: bright.length };

  $('periodsrc').textContent =
    `${lang === 'fr' ? 'source' : 'source'}: ${fold.source} · ` +
    `${fmt(star.tess.exposure_days / period, 1)} ${lang === 'fr' ? 'cycles couverts' : 'cycles covered'}`;

  // ── the fold ──
  const NB = 16;
  const expo = phaseExposure(intervals, period, t0, NB);
  const expoTotal = expo.reduce((a, b) => a + b, 0);
  const counts = new Array(NB).fill(0);
  brightPhase.forEach((p) => { counts[Math.min(Math.floor(p * NB), NB - 1)] += 1; });
  const centres = Array.from({ length: NB }, (_, i) => (i + 0.5) / NB);
  const expected = Array.from(expo, (e) =>
    expoTotal > 0 ? brightPhase.length * e / expoTotal : 0);

  Plotly.react('phaseplot', [
    { x: centres, y: counts, type: 'bar',
      marker: { color: 'rgba(98,194,255,0.55)',
                line: { color: '#62c2ff', width: 1 } },
      hovertemplate: (lang === 'fr' ? 'phase %{x:.3f}<br>%{y} flares'
                                     : 'phase %{x:.3f}<br>%{y} flares') + '<extra></extra>' },
    { x: centres, y: expected, type: 'scatter', mode: 'lines',
      line: { color: '#ffc27a', width: 2, dash: 'dot' },
      hovertemplate: (lang === 'fr' ? 'attendu %{y:.2f}' : 'expected %{y:.2f}') + '<extra></extra>' },
  ], {
    ...AX, bargap: 0.05,
    xaxis: { ...AX.xaxis, title: lang === 'fr' ? 'phase orbitale' : 'orbital phase',
             range: [0, 1] },
    yaxis: { ...AX.yaxis, title: lang === 'fr' ? 'flares par intervalle' : 'flares per bin' },
  }, CFG);

  // ── the Kuiper CDF ──
  const k = kBright.n ? kBright : kRaw;
  const traces = [
    { x: Array.from(k.refPhase), y: Array.from(k.refCdf), type: 'scatter',
      mode: 'lines', line: { color: '#ffc27a', width: 2, dash: 'dot' },
      name: lang === 'fr' ? 'exposition' : 'exposure' },
  ];
  if (k.n) {
    // A step function: the empirical CDF jumps at each flare.
    const sx = [0], sy = [0];
    k.samplePhase.forEach((p, i) => {
      sx.push(p, p); sy.push(i / k.n, (i + 1) / k.n);
    });
    sx.push(1); sy.push(1);
    traces.push({ x: sx, y: sy, type: 'scatter', mode: 'lines',
                  line: { color: '#62c2ff', width: 2 },
                  name: lang === 'fr' ? 'flares' : 'flares' });
  }
  Plotly.react('cdfplot', traces, {
    ...AX, showlegend: true,
    legend: { x: 0.02, y: 0.98, bgcolor: 'rgba(4,10,20,0.6)',
              bordercolor: 'rgba(200,220,255,0.16)', borderwidth: 1 },
    xaxis: { ...AX.xaxis, title: lang === 'fr' ? 'phase' : 'phase', range: [0, 1] },
    yaxis: { ...AX.yaxis, title: 'CDF', range: [0, 1] },
  }, CFG);

  // ── the verdict ──
  const anySig = poisson.some((r) => r.significant.length);
  $('syncstats').innerHTML = [
    stat(lang === 'fr' ? 'Période' : 'Period', `${fmt(period, 5)} <small>d</small>`),
    stat(lang === 'fr' ? 'Flares utilisés' : 'Flares used',
         `${kBright.n} <small>/ ${flares.length}</small>`),
    stat('Kuiper V', fmt(kBright.v, 4)),
    stat('p (brightest/cycle)', fmtP(kBright.p),
         kBright.p < 0.05 && kBright.n >= 8 ? 'warn' : ''),
    stat('p (raw)', fmtP(kRaw.p)),
  ].join('');

  const sig = kBright.p < 0.05 && kBright.n >= 8;
  const small = kBright.n < 8;
  let msg;
  if (!kBright.n) {
    msg = lang === 'fr' ? 'Aucun flare : rien à tester.' : 'No flares: nothing to test.';
  } else if (small) {
    msg = lang === 'fr'
      ? `Seulement <b>${kBright.n}</b> flare(s) indépendant(s). La p-valeur de Kuiper n'est fiable qu'au-dessus d'environ 8 ; en dessous elle est optimiste. À lire comme suggestif au mieux.`
      : `Only <b>${kBright.n}</b> independent flare(s). Kuiper's p-value is reliable above about 8; below that it is optimistic. Read this as suggestive at best.`;
  } else if (sig || anySig) {
    msg = lang === 'fr'
      ? `Les flares <b>ne sont pas uniformes</b> en phase à cette période (p = ${fmtP(kBright.p)}${anySig ? ', et un intervalle de Poisson ressort' : ''}). Avant d'y voir une interaction étoile-planète : vérifiez la période de rotation, car l'activité stellaire ordinaire se replie dessus ; vérifiez que le signal n'est pas porté par un seul secteur ; et rappelez-vous que cette p-valeur n'est corrigée ni du nombre d'étoiles ni du nombre de périodes essayées.`
      : `The flares are <b>not uniform</b> in phase at this period (p = ${fmtP(kBright.p)}${anySig ? ', and a Poisson bin stands out' : ''}). Before reading this as a star-planet interaction: check the rotation period, because ordinary stellar activity folds on it; check the signal is not carried by one sector alone; and remember this p-value is corrected neither for the number of stars nor for the number of periods tried.`;
  } else {
    msg = lang === 'fr'
      ? `Les flares sont <b>compatibles avec une distribution uniforme</b> en phase à cette période (p = ${fmtP(kBright.p)}). Rien n'indique de synchronisation.`
      : `The flares are <b>consistent with being uniform</b> in phase at this period (p = ${fmtP(kBright.p)}). No sign of synchronisation.`;
  }
  $('verdict').innerHTML = `<div class="verdict ${sig || anySig ? 'yes' : ''}">${msg}</div>`;

  // ── the Poisson table ──
  let html = `<table><thead><tr><th>${lang === 'fr' ? 'intervalles' : 'bins'}</th>` +
    `<th>${lang === 'fr' ? 'phase' : 'phase'}</th><th>obs</th>` +
    `<th>${lang === 'fr' ? 'attendu' : 'expected'}</th><th>p</th>` +
    `<th>p (Bonf.)</th></tr></thead><tbody>`;
  for (const r of poisson) {
    // Only the most extreme bin of each binning, else the table is 30 rows.
    let j = 0;
    for (let i = 1; i < r.nbins; i++) if (r.pBonf[i] < r.pBonf[j]) j = i;
    const lo = (j / r.nbins).toFixed(3), hi = ((j + 1) / r.nbins).toFixed(3);
    const isSig = r.significant.includes(j);
    html += `<tr class="${isSig ? 'sig' : ''}"><td>${r.nbins}</td>` +
      `<td class="num">${lo}–${hi}</td><td class="num">${r.observed[j]}</td>` +
      `<td class="num">${r.expected[j].toFixed(2)}</td>` +
      `<td class="num">${fmtP(r.pRaw[j])}</td>` +
      `<td class="num">${fmtP(r.pBonf[j])}</td></tr>`;
  }
  html += `</tbody></table><p class="hint">${lang === 'fr'
    ? "L'intervalle le plus extrême de chaque découpage. Bonferroni corrige à l'intérieur d'un découpage, pas entre les quatre."
    : 'The most extreme bin of each binning. Bonferroni corrects within a binning, not across the four.'}</p>`;
  $('poissontable').innerHTML = html;
}

function drawFlareTable() {
  if (!star.flares.length) { $('flarecard').hidden = true; return; }
  $('flarecard').hidden = false;
  const h = lang === 'fr'
    ? ['BJD du pic', 'phase', 'amplitude %', 'σ', 'ED [s]', 'pts', 'secteur']
    : ['peak BJD', 'phase', 'amplitude %', 'σ', 'ED [s]', 'pts', 'sector'];
  let html = `<table><thead><tr>${h.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>`;
  for (const f of star.flares) {
    const ph = fold ? phaseOf(f.t_peak, fold.period, fold.t0) : NaN;
    html += `<tr><td class="num">${f.t_peak.toFixed(4)}</td>` +
      `<td class="num">${isFinite(ph) ? ph.toFixed(3) : '—'}</td>` +
      `<td class="num">${(f.amplitude * 100).toFixed(2)}</td>` +
      `<td class="num">${f.peak_sigma.toFixed(1)}</td>` +
      `<td class="num">${f.ed_sec.toFixed(1)}</td>` +
      `<td class="num">${f.n_points}</td><td class="num">${f.sector}</td></tr>`;
  }
  $('flaretable').innerHTML = html + '</tbody></table>';
}

function render() {
  ['overview', 'seriescard', 'ratecard', 'periodcard', 'phasecard', 'cdfcard',
   'synccard'].forEach((id) => { $(id).hidden = false; });
  drawOverview();
  drawSeries();
  drawRates();
  drawPeriodPills();
  drawFold();
  drawFlareTable();
}

// ───────────────────────────── saved stars ─────────────────────────────

const readSaved = () => {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); }
  catch { return []; }
};
const writeSaved = (rows) => {
  localStorage.setItem(SAVED_KEY, JSON.stringify(rows));
  $('nsaved').textContent = rows.length;
};

$('save').onclick = () => {
  if (!star || !lastFold) return;
  const rows = readSaved().filter((r) => r.slug !== star.slug);
  const events = groupEvents(star.flares, EVENT_GAP_DAYS);
  const expo = star.tess.exposure_days;
  const ci = rateInterval(events.length, expo);
  rows.push({
    slug: star.slug, name: star.name, tic: star.star.tic,
    tmag: star.star.tmag, teff: star.star.st_teff, rad: star.star.st_rad,
    n_detections: star.flares.length, n_events: events.length,
    exposure_days: expo,
    rate: events.length ? events.length / expo : null,
    rate_hi: ci.hi,
    floor_pct: star.detection.min_detectable_amplitude * 100,
    period: lastFold.period, period_source: fold.source,
    kuiper_p: lastFold.kBright.p, kuiper_v: lastFold.kBright.v,
    n_used: lastFold.kBright.n,
    sectors: star.tess.sectors.join(' '),
    saved: new Date().toISOString().slice(0, 10),
  });
  writeSaved(rows);
  $('save').textContent = lang === 'fr' ? 'Gardée ✓' : 'Saved ✓';
  setTimeout(() => { $('save').textContent = t('save'); }, 1600);
};

function renderSaved() {
  const rows = readSaved();
  $('nsaved').textContent = rows.length;
  if (!rows.length) {
    $('savedtable').innerHTML = `<p class="hint">${t('nothing_saved')}</p>`;
    $('savedplotcard').hidden = true;
    return;
  }
  const h = lang === 'fr'
    ? ['étoile', 'Teff', 'expo [j]', 'évén.', 'taux [/j]', 'seuil %', 'P [j]', 'p Kuiper', '']
    : ['star', 'Teff', 'expo [d]', 'events', 'rate [/d]', 'floor %', 'P [d]', 'p Kuiper', ''];
  let html = `<table><thead><tr>${h.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>`;
  for (const r of rows) {
    const rateCell = r.rate === null
      ? `&lt; ${fmt(r.rate_hi, 3)}` : fmt(r.rate, 3);
    const sig = r.kuiper_p < 0.05 && r.n_used >= 8;
    html += `<tr class="${sig ? 'sig' : ''}"><td>${r.name}</td>` +
      `<td class="num">${r.teff ? r.teff.toFixed(0) : '—'}</td>` +
      `<td class="num">${fmt(r.exposure_days, 1)}</td>` +
      `<td class="num">${r.n_events}</td><td class="num">${rateCell}</td>` +
      `<td class="num">${fmt(r.floor_pct, 2)}</td>` +
      `<td class="num">${fmt(r.period, 4)}</td>` +
      `<td class="num">${fmtP(r.kuiper_p)}</td>` +
      `<td><button class="small ghost" data-drop="${r.slug}">×</button></td></tr>`;
  }
  $('savedtable').innerHTML = html + '</tbody></table>';
  $('savedtable').querySelectorAll('[data-drop]').forEach((b) => {
    b.onclick = () => {
      writeSaved(readSaved().filter((r) => r.slug !== b.dataset.drop));
      renderSaved();
    };
  });

  const withTeff = rows.filter((r) => r.teff);
  $('savedplotcard').hidden = !withTeff.length;
  if (!withTeff.length) return;
  const det = withTeff.filter((r) => r.rate !== null);
  const lim = withTeff.filter((r) => r.rate === null);
  Plotly.react('savedplot', [
    { x: det.map((r) => r.teff), y: det.map((r) => r.rate),
      text: det.map((r) => r.name), type: 'scatter', mode: 'markers',
      marker: { color: '#62c2ff', size: 11,
                line: { color: '#0b1526', width: 1 } },
      hovertemplate: '%{text}<br>Teff %{x:.0f} K<br>%{y:.3f} /d<extra></extra>' },
    { x: lim.map((r) => r.teff), y: lim.map((r) => r.rate_hi),
      text: lim.map((r) => r.name), type: 'scatter', mode: 'markers',
      marker: { color: '#ffc27a', size: 11, symbol: 'triangle-down',
                line: { color: '#2a1a08', width: 1 } },
      hovertemplate: '%{text}<br>Teff %{x:.0f} K<br>&lt; %{y:.3f} /d<extra></extra>' },
  ], {
    ...AX,
    xaxis: { ...AX.xaxis, title: 'Teff [K]', autorange: 'reversed' },
    yaxis: { ...AX.yaxis, title: lang === 'fr' ? 'flares par jour' : 'flares per day',
             type: det.length > 1 ? 'log' : 'linear' },
  }, CFG);
}

$('clearsaved').onclick = () => {
  if (!readSaved().length) return;
  const ask = lang === 'fr' ? 'Effacer toutes les étoiles gardées ?'
                            : 'Clear every saved star?';
  if (confirm(ask)) { writeSaved([]); renderSaved(); }
};

$('exportcsv').onclick = () => {
  const rows = readSaved();
  if (!rows.length) return;
  const cols = ['name', 'tic', 'tmag', 'teff', 'rad', 'sectors', 'exposure_days',
                'n_detections', 'n_events', 'rate', 'rate_hi', 'floor_pct',
                'period', 'period_source', 'n_used', 'kuiper_v', 'kuiper_p', 'saved'];
  const esc = (v) => (v === null || v === undefined) ? ''
    : (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))]
    .join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'tess-flares.csv';
  a.click();
  URL.revokeObjectURL(a.href);
};

// ───────────────────────────── methods tab ─────────────────────────────

function renderMethods() {
  $('methods').innerHTML = METHODS[lang] || METHODS.en;
}

// ───────────────────────────── start ─────────────────────────────

(async function start() {
  try {
    await loadIndex();
  } catch (err) {
    $('msg').innerHTML = `<div class="err">${err.message}</div>`;
    return;
  }
  applyLang();
  $('nsaved').textContent = readSaved().length;
  const want = new URLSearchParams(location.search).get('star');
  const first = want && index.stars.find((s) => s.slug === want);
  if (first) loadStar(first.slug);
  else renderMenu(search(''));
})();
