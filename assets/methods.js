/*
 * The Methods tab: what was computed, how, and from whose work.
 *
 * Every number the page shows should be traceable from here to a formula and
 * a paper. Where this pipeline made a choice that another would make
 * differently, the choice is stated rather than hidden behind a default.
 */

const EN = `
<h2>Methods and references</h2>
<p class="hint">Everything on the Star tab, from where the data came to how each p-value is defined.</p>

<h3>1. Where the data come from</h3>
<p>Light curves are TESS, fetched from <b>MAST</b> through <code>lightkurve</code>, one product per sector, preferring the fastest cadence available for that sector (20 s over 120 s over 200 s FFI). Pipelines are preferred in the order SPOC, TESS-SPOC, QLP.</p>
<p>Stellar and planetary parameters come from the <b>NASA Exoplanet Archive</b>'s composite table (<code>pscomppars</code>), which carries one best published solution per planet.</p>
<p><b>A trap worth naming.</b> QLP light curves are not SPOC light curves. They carry no <code>PDCSAP_FLUX</code>, and they renamed their own detrended column between versions: <code>KSPSAP_FLUX</code> in v01, <code>DET_FLUX</code> in v02, with both appearing for the same star. Worse, <code>lightkurve</code>'s <code>default</code> quality bitmask is tuned to SPOC's flags and lets QLP junk through. On TOI-7149 (T = 14.8) that combination left cadences at 524 times the median flux and produced 49 "flares" with a median amplitude of 79% and a maximum of 7451%. The flux column and the quality mask are therefore chosen per file from the product's author, and QLP uses the <code>hard</code> mask.</p>

<h3>1b. A star the catalogue does not have</h3>
<p>Type any name and the page will try. If the catalogue has no match it asks
<b>SIMBAD</b>, which settles two different questions. First, whether the star is
here under another name: SIMBAD's identifier table knows that GJ 1,
HD 225213 and TIC 120461526 are one object, so a name that looks like a miss
often is not. Second, if it really is absent, what the star is, which the page
then shows alongside the command that would add it.</p>
<p><b>Only SIMBAD, and that is not an oversight.</b> Of the three archives this
tool depends on, SIMBAD is the only one that answers a cross-origin request
with an <code>Access-Control-Allow-Origin</code> header. The NASA Exoplanet
Archive answers with the data and no such header, which a browser then
discards, so the planet list cannot be fetched here. MAST is further out of
reach still: a TESS light curve is tens of megabytes of FITS per sector, and
the detrending and flare detection behind every number on this page are not
things a browser should be asked to do. They run offline, once per star.</p>

<h3>2. Detrending</h3>
<p>Each sector's flux is divided by a running median over a <b>3-hour window</b>, then normalised so the quiescent level is 1.</p>
<p>A median, not a mean, and the distinction is the whole point: a median is unmoved by a feature occupying less than half its window, so a flare lasting minutes passes through a 3-hour filter untouched, while the star's rotation and the instrument's drifts do not. A boxcar mean would absorb a fraction of every flare equal to the flare's duration over the window.</p>
<p>A Gaussian-process detrending is also implemented in the pipeline (two SHO kernels, MAP-fit per sector) but is <b>not</b> used for this catalogue. A GP flexible enough to follow a star's rotation is flexible enough to follow its flares and subtract them from its own residual: on M dwarfs it erased them, and on quiet F and G stars it manufactured them.</p>
<p>Cadences inside the transit of a known transiting planet are removed, because the baseline there is only interpolated across the masked dip and a flare landing on a transit is not reliably recoverable.</p>

<h3>3. Flare detection</h3>
<p>A flare is <b>N consecutive cadences at least 3σ above the detrended baseline</b>, with N = 3 and σ the robust per-segment scatter of the residuals, following Medina et al. (2020). Points must be strictly consecutive.</p>
<p>Two consequences are handled downstream rather than by loosening the rule:</p>
<ul>
<li><b>One flare can be recorded several times.</b> A decay that dips below threshold and returns starts a new detection. The page therefore reports <i>events</i> (detections closer than one hour grouped) alongside <i>detections</i>. On TOI-3235 that is 2 against 10, and a rate of 0.030 against 0.149 per day.</li>
<li><b>Not every detection is stellar.</b> Candidates with amplitude above 4 times the quiescent flux are rejected: no white-light flare looks like that, and what does is a bad cadence.</li>
</ul>
<p>The <b>equivalent duration</b> of a flare is the integral of its relative flux over time, in seconds: the time the quiescent star would need to emit the same energy. It is quoted rather than an energy because it needs no distance and no bolometric correction.</p>

<h3>4. Flare rate, and its uncertainty</h3>
<p>The rate is events divided by <b>exposure</b>, not by elapsed time: TESS observes in sectors, with gaps between them and a downlink gap inside each, and only cadences that exist count. In-transit cadences are excluded from the exposure too, so the rate and its denominator describe the same data.</p>
<p>Intervals are the exact Poisson ones (Garwood 1936), from the chi-square quantiles. For a star with no detection the rate is quoted as the 95% upper limit, which for zero events over an exposure T is <span class="eq">rate &lt; −ln(0.05) / T = 3.00 / T</span></p>
<p>The <b>detection floor</b> is about 3σ of the per-cadence noise: the shallowest flare that star could have shown. It varies by a factor of several across the catalogue, and a rate of zero is meaningless without it.</p>

<h3>5. Phase coverage</h3>
<p>This is the piece that makes an arbitrary period possible in a browser. Shipping every cadence time would be hundreds of megabytes per star, so the coverage is written as <b>intervals of continuous observation</b> (start, end, cadence): a few hundred per star, split wherever a gap exceeds three cadences.</p>
<p>The exposure in any phase bin then follows by integration rather than by counting: an interval spanning k whole cycles contributes equally to every bin, and only the remaining arc has to be distributed. The result is exact for any period, and reproduces the pipeline's cadence-summed exposure to better than 0.2%.</p>
<p>This correction is not cosmetic. TESS does not sample every orbital phase equally, and at a period near a fraction of a sector's length some phases get far more coverage than others. Comparing flare counts against a flat expectation would then show an excess wherever the coverage happens to be good.</p>

<h3>5b. The displayed light curve</h3>
<p><b>Every cadence is shipped</b>, not a binned summary. That is affordable because the photometry goes in a separate binary file as Int16 on a regular per-block grid: within a block the cadences sit on a fixed step, so a slot's time is <code>t0 + i*dt</code> and only the flux has to be stored, at 2 bytes against the 14 or so a JSON number costs. TOI-700's 2.6 million cadences are 5.4 MB rather than 38. The flux scale is per star, <code>max|flux - 1| / 32000</code>, which puts the quantisation between 1 and 10 ppm, far below any star's noise.</p>
<p><b>The axis is broken.</b> TESS observes in sectors separated by months or years, and on a true time axis the data are slivers in white: TOI-1452 spans 1979 days of which 848 hold data. Blocks of continuous observation are laid side by side with a shaded band at each break, labelled with the sector and the real starting date. Every point keeps its true BJD in its hover text, and no statistic ever uses this coordinate.</p>
<p><b>Points inside a flare are coloured differently</b>, from the catalogue's first and last contact times. This needs no extra data; it is recomputed in the browser.</p>
<p>Drawing is thinned to about 150,000 points, because a browser is 1600 pixels wide and more would be invisible, but <b>cadences inside a flare are never thinned</b> and zooming redraws from the full data. The thinning factor is printed under the plot.</p>

<h3>6. Kuiper's test</h3>
<p>Asks whether the flares' phases are drawn from the exposure's own phase distribution. With F the exposure-weighted reference CDF and the flares sorted by phase,</p>
<span class="eq">D⁺ = max( i/n − F(φᵢ) ),  D⁻ = max( F(φᵢ) − (i−1)/n ),  V = D⁺ + D⁻</span>
<p><b>Why Kuiper and not Kolmogorov-Smirnov.</b> KS uses D, the single largest gap. V is invariant under a cyclic shift of the phase origin, and phase is a circle: phase 0 is an arbitrary cut, not a boundary. An excess straddling phase 0/1 would look artificially weak to KS depending on where the cut fell.</p>
<p>The p-value is the asymptotic series with Stephens' finite-sample correction, with λ = (√n + 0.155 + 0.24/√n)·V:</p>
<span class="eq">p = 2 Σ_{j≥1} (4j²λ² − 1) exp(−2j²λ²)</span>
<p>Reliable for n above about 8. Below that it is optimistic, and the page says so.</p>

<h3>7. Poisson excess per phase bin</h3>
<p>Complementary to Kuiper, and sensitive to something different: Kuiper responds to a smooth shift of the whole distribution, the bins to a sharp excess in one place.</p>
<p>Each bin's expectation is the total flare count times that bin's share of the exposure, so a bin in a data gap expects nothing. The p-value is the Poisson survival function at the observed count.</p>
<p>Four binnings (2, 4, 8, 16) are shown because the right one depends on the width of the excess, unknown in advance. Within a binning the p-values are <b>Bonferroni-corrected across that binning's own bins</b> (Dunn 1961). They are deliberately <b>not</b> corrected across the four binnings: those are four views of one dataset, not thirty independent trials, and multiplying by thirty would be a wrong correction in the conservative direction.</p>

<h3>8. One flare per cycle</h3>
<p>Both tests are run twice: on every detection, and on <b>at most one flare per orbital cycle, the brightest</b>. The conclusion is driven by the second.</p>
<p>The reason is a specific failure mode. A single flaring episode spanning several detected sub-peaks inside one orbit appears, in the raw list, as several independent events at the same phase, which is exactly what phase-locking looks like. One storm can therefore manufacture a detection. Collapsing to one event per cycle removes that at the cost of sensitivity, and the raw result is shown beside it so the difference is visible rather than hidden.</p>

<h3>8b. The rotation period, and why it is not measured here</h3>
<p>Rotation is the control any claim of orbital phase-locking has to pass: flares that follow the <b>rotation</b> phase are ordinary active longitudes, and only flares following the <b>orbital</b> phase would be a star-planet interaction. The page therefore offers the rotation period as a fold whenever the archive has a published one.</p>
<p>It does <b>not</b> measure one from the light curve, and the reason is worth stating. A Lomb-Scargle periodogram of a TESS light curve returns a peak for every star, and a false-alarm probability of zero for every star: with a few hundred thousand cadences, the instrument's own coherent systematics are formally significant. Checked against published values on eleven stars, a naive implementation got four right, and nothing available in the periodogram distinguished those four from the seven that were wrong. Since a wrong rotation period would license exactly the conclusion this control exists to prevent, none is shipped.</p>
<p>Doing it properly would need the FFI-level photometry with the systematics modelled rather than filtered, a harmonic check at half and twice the peak, and agreement between sectors. Where the archive has no rotation period, read any phase-locking result on this page as unvetted against rotation.</p>

<h3>9. How to read a small p-value here</h3>
<p>As a screening statistic, not a discovery. Specifically, it is <b>not</b> corrected for the number of stars you look at, nor for the number of periods you try, and it assumes flares are independent events, which they are not: flares cluster, and a star whose flares arrive in storms will produce small p-values with no planet involved.</p>
<p>A real star-planet magnetic interaction would show a signal at the <b>orbital</b> period but not at the rotation period, persisting across sectors rather than confined to one, and surviving the brightest-per-cycle reduction. The history of this field is one of claimed detections that did not repeat (Shkolnik et al. 2005, 2008; and the non-confirmations of Miller et al. 2015), which is the reason for the caution above.</p>

<h3>10. Reproducing this</h3>
<p>The catalogue is built by <code>web/precompute.py</code> in the <code>syncflares</code> repository, which calls the same pipeline as the command line. The browser's statistics are <code>web/assets/stats.js</code>, a port of <code>syncflares/stats.py</code>; <code>tests/test_web_stats.py</code> runs both on the same inputs and requires them to agree, currently to 3×10⁻⁵ on Kuiper's V and 10⁻¹⁴ on the Poisson survival function against SciPy.</p>

<h3>References</h3>
<ul class="refs">
<li><b>Kuiper, N. H. (1960).</b> Tests concerning random points on a circle. <i>Proc. K. Ned. Akad. Wet. A</i> 63, 38.</li>
<li><b>Stephens, M. A. (1970).</b> Use of the Kolmogorov-Smirnov, Cramér-von Mises and related statistics without extensive tables. <i>J. R. Stat. Soc. B</i> 32, 115.</li>
<li><b>Press, W. H., et al.</b> <i>Numerical Recipes</i>, 3rd ed., §14.3.4 (Kuiper's statistic and its asymptotic p-value).</li>
<li><b>Dunn, O. J. (1961).</b> Multiple comparisons among means. <i>J. Am. Stat. Assoc.</i> 56, 52.</li>
<li><b>Garwood, F. (1936).</b> Fiducial limits for the Poisson distribution. <i>Biometrika</i> 28, 437.</li>
<li><b>Medina, A. A., et al. (2020).</b> Flare rates, rotation periods, and spectroscopic activity indicators of a volume-complete sample of mid- to late-M dwarfs within 15 pc. <i>ApJ</i> 905, 107.</li>
<li><b>Gershberg, R. E. (1972).</b> Some results of the cooperative photometric observations of the UV Cet-type flare stars. <i>Ap&amp;SS</i> 19, 75. (Equivalent duration.)</li>
<li><b>Hunt-Walker, N. M., et al. (2012).</b> The photometric variability of the M dwarfs. <i>PASP</i> 124, 545.</li>
<li><b>West, A. A., et al. (2008).</b> Constraining the age-activity relation for cool stars. <i>AJ</i> 135, 785.</li>
<li><b>Shkolnik, E., et al. (2005).</b> Hot Jupiters and hot spots: the short- and long-term chromospheric activity on stars with giant planets. <i>ApJ</i> 622, 1075.</li>
<li><b>Shkolnik, E., et al. (2008).</b> Signs of star-planet interactions. <i>ApJ</i> 676, 628.</li>
<li><b>Miller, B. P., et al. (2015).</b> On the search for transiting hot Jupiters and star-planet interaction. <i>ApJ</i> 799, 163.</li>
<li><b>Ricker, G. R., et al. (2015).</b> Transiting Exoplanet Survey Satellite. <i>JATIS</i> 1, 014003.</li>
<li><b>Jenkins, J. M., et al. (2016).</b> The TESS science processing operations center. <i>Proc. SPIE</i> 9913, 99133E. (SPOC.)</li>
<li><b>Huang, C. X., et al. (2020).</b> Photometry of 10 million stars from the first two years of TESS full frame images. <i>RNAAS</i> 4, 204. (QLP.)</li>
<li><b>Lightkurve Collaboration (2018).</b> Lightkurve: Kepler and TESS time series analysis in Python. <i>ascl:1812.013</i>.</li>
<li><b>Astropy Collaboration (2022).</b> The Astropy project. <i>ApJ</i> 935, 167.</li>
<li><b>Virtanen, P., et al. (2020).</b> SciPy 1.0. <i>Nature Methods</i> 17, 261.</li>
</ul>
<p class="hint">This research uses the NASA Exoplanet Archive, operated by Caltech under contract with NASA under the Exoplanet Exploration Program, and data from the MAST archive at STScI. Funding for TESS is provided by NASA's Science Mission Directorate.</p>
`;

const FR = `
<h2>Méthodes et références</h2>
<p class="hint">Tout ce que montre l'onglet Étoile : d'où viennent les données, et comment chaque p-valeur est définie.</p>

<h3>1. D'où viennent les données</h3>
<p>Les courbes de lumière viennent de TESS, récupérées sur <b>MAST</b> via <code>lightkurve</code>, un produit par secteur, en préférant la cadence la plus rapide disponible (20 s plutôt que 120 s plutôt que 200 s FFI). Les pipelines sont préférés dans l'ordre SPOC, TESS-SPOC, QLP.</p>
<p>Les paramètres stellaires et planétaires viennent de la table composite de la <b>NASA Exoplanet Archive</b> (<code>pscomppars</code>), qui porte une meilleure solution publiée par planète.</p>
<p><b>Un piège qui mérite d'être nommé.</b> Les courbes QLP ne sont pas des courbes SPOC. Elles n'ont pas de <code>PDCSAP_FLUX</code>, et QLP a renommé sa propre colonne détendancée entre versions : <code>KSPSAP_FLUX</code> en v01, <code>DET_FLUX</code> en v02, les deux pouvant coexister pour une même étoile. Pire, le masque qualité <code>default</code> de <code>lightkurve</code> est réglé pour les drapeaux de SPOC et laisse passer les rebuts de QLP. Sur TOI-7149 (T = 14,8) cette combinaison laissait des cadences à 524 fois le flux médian et produisait 49 « flares » d'amplitude médiane 79 % et de maximum 7451 %. La colonne de flux et le masque qualité sont donc choisis par fichier selon l'auteur du produit, et QLP utilise le masque <code>hard</code>.</p>

<h3>1b. Une étoile que le catalogue n'a pas</h3>
<p>Tapez n'importe quel nom, la page essaiera. Si le catalogue n'a pas de
correspondance, elle interroge <b>SIMBAD</b>, ce qui tranche deux questions
distinctes. D'abord, si l'étoile est ici sous un autre nom : la table
d'identifiants de SIMBAD sait que GJ 1, HD 225213 et TIC 120461526 sont un
seul objet, donc un nom qui semble absent ne l'est souvent pas. Ensuite, si
elle est vraiment absente, ce qu'est cette étoile, que la page affiche alors
avec la commande qui l'ajouterait.</p>
<p><b>SIMBAD seulement, et ce n'est pas un oubli.</b> Des trois archives dont
cet outil dépend, SIMBAD est la seule qui réponde à une requête d'origine
croisée avec un en-tête <code>Access-Control-Allow-Origin</code>. La NASA
Exoplanet Archive répond avec les données et sans cet en-tête, qu'un
navigateur jette alors, si bien que la liste des planètes ne peut pas être
récupérée ici. MAST est encore plus hors de portée : une courbe de lumière
TESS fait des dizaines de mégaoctets de FITS par secteur, et le
détendancement et la détection de flares derrière chaque nombre de cette page
ne sont pas des choses à demander à un navigateur. Ils tournent hors ligne,
une fois par étoile.</p>

<h3>2. Détendancement</h3>
<p>Le flux de chaque secteur est divisé par une médiane glissante sur une <b>fenêtre de 3 heures</b>, puis normalisé pour que le niveau au repos vaille 1.</p>
<p>Une médiane, pas une moyenne, et la distinction est tout l'enjeu : une médiane ne bouge pas pour un trait qui occupe moins de la moitié de sa fenêtre. Un flare de quelques minutes traverse donc un filtre de 3 heures intact, alors que la rotation de l'étoile et les dérives de l'instrument, non. Une moyenne glissante absorberait de chaque flare une fraction égale à sa durée divisée par la fenêtre.</p>
<p>Un détendancement par processus gaussien existe aussi dans le pipeline (deux noyaux SHO, ajustement MAP par secteur) mais n'est <b>pas</b> utilisé pour ce catalogue. Un GP assez souple pour suivre la rotation d'une étoile l'est assez pour suivre ses flares et les soustraire de son propre résidu : sur les naines M il les effaçait, et sur les étoiles F et G calmes il en fabriquait.</p>
<p>Les cadences situées dans le transit d'une planète transitante connue sont retirées : la ligne de base n'y est qu'interpolée au travers du creux masqué, et un flare tombant sur un transit n'est pas récupérable de façon fiable.</p>

<h3>3. Détection des flares</h3>
<p>Un flare est <b>N cadences consécutives à au moins 3σ au-dessus de la ligne de base</b>, avec N = 3 et σ la dispersion robuste des résidus du segment, d'après Medina et al. (2020). Les points doivent être strictement consécutifs.</p>
<p>Deux conséquences sont traitées en aval plutôt qu'en relâchant la règle :</p>
<ul>
<li><b>Un flare peut être compté plusieurs fois.</b> Une décroissance qui repasse sous le seuil puis remonte ouvre une nouvelle détection. La page rapporte donc les <i>événements</i> (détections séparées de moins d'une heure, regroupées) à côté des <i>détections</i>. Sur TOI-3235 cela fait 2 contre 10, et un taux de 0,030 contre 0,149 par jour.</li>
<li><b>Toute détection n'est pas stellaire.</b> Les candidats d'amplitude supérieure à 4 fois le flux de repos sont rejetés : aucun flare en lumière blanche ne ressemble à cela, mais une mauvaise cadence, oui.</li>
</ul>
<p>La <b>durée équivalente</b> d'un flare est l'intégrale de son flux relatif dans le temps, en secondes : le temps qu'il faudrait à l'étoile au repos pour émettre la même énergie. Elle est donnée plutôt qu'une énergie parce qu'elle ne demande ni distance ni correction bolométrique.</p>

<h3>4. Taux de flares et son incertitude</h3>
<p>Le taux est le nombre d'événements divisé par l'<b>exposition</b>, pas par le temps écoulé : TESS observe par secteurs, avec des trous entre eux et un trou de télémesure dans chacun, et seules les cadences existantes comptent. Les cadences en transit sont aussi exclues de l'exposition, pour que le taux et son dénominateur décrivent les mêmes données.</p>
<p>Les intervalles sont ceux de Poisson exacts (Garwood 1936), par les quantiles du khi-deux. Pour une étoile sans détection, le taux est donné comme limite supérieure à 95 %, qui pour zéro événement sur une exposition T vaut <span class="eq">taux &lt; −ln(0,05) / T = 3,00 / T</span></p>
<p>Le <b>seuil de détection</b> vaut environ 3σ du bruit par cadence : le flare le moins profond que cette étoile aurait pu montrer. Il varie d'un facteur plusieurs à travers le catalogue, et un taux nul n'a aucun sens sans lui.</p>

<h3>5. Couverture en phase</h3>
<p>C'est la pièce qui rend possible une période arbitraire dans un navigateur. Livrer toutes les dates de cadences ferait des centaines de mégaoctets par étoile ; la couverture est donc écrite comme des <b>intervalles d'observation continue</b> (début, fin, cadence) : quelques centaines par étoile, coupés dès qu'un trou dépasse trois cadences.</p>
<p>L'exposition dans n'importe quel intervalle de phase s'obtient alors par intégration plutôt que par comptage : un intervalle couvrant k cycles entiers contribue également à tous les bins, et seul l'arc restant doit être réparti. Le résultat est exact pour toute période, et reproduit l'exposition sommée sur les cadences du pipeline à mieux que 0,2 %.</p>
<p>Cette correction n'est pas cosmétique. TESS n'échantillonne pas toutes les phases orbitales également, et à une période proche d'une fraction de la durée d'un secteur, certaines phases sont bien mieux couvertes. Comparer les comptes de flares à une attente plate montrerait alors un excès partout où la couverture se trouve bonne.</p>

<h3>5b. La courbe de lumière affichée</h3>
<p><b>Toutes les cadences sont livrées</b>, pas un résumé groupé. C'est abordable parce que la photométrie part dans un fichier binaire séparé, en Int16 sur une grille régulière par bloc : dans un bloc les cadences sont sur un pas fixe, donc la date d'un créneau est <code>t0 + i*dt</code> et seul le flux doit être stocké, pour 2 octets contre la quinzaine qu'un nombre JSON coûte. Les 2,6 millions de cadences de TOI-700 font 5,4 Mo au lieu de 38. L'échelle de flux est propre à chaque étoile, <code>max|flux - 1| / 32000</code>, ce qui place la quantification entre 1 et 10 ppm, très en dessous du bruit de n'importe quelle étoile.</p>
<p><b>L'axe est brisé.</b> TESS observe par secteurs séparés de mois ou d'années, et sur un axe temporel réel les données sont des éclats dans du blanc : TOI-1452 s'étend sur 1979 jours dont 848 portent des données. Les blocs d'observation continue sont posés côte à côte, une bande grisée à chaque coupure, étiquetés du secteur et de la date réelle de début. Chaque point garde son vrai BJD au survol, et aucune statistique n'utilise cette coordonnée.</p>
<p><b>Les points situés dans un flare sont d'une autre couleur</b>, d'après les instants de premier et dernier contact du catalogue. Cela ne demande aucune donnée supplémentaire : c'est recalculé dans le navigateur.</p>
<p>Le tracé est éclairci à environ 150 000 points, parce qu'un navigateur fait 1600 pixels de large et que davantage serait invisible, mais <b>les cadences dans un flare ne sont jamais éclaircies</b> et le zoom redessine depuis les données complètes. Le facteur d'éclaircissage est imprimé sous le graphique.</p>

<h3>6. Test de Kuiper</h3>
<p>Demande si les phases des flares sont tirées de la distribution en phase de l'exposition. Avec F la CDF de référence pondérée par l'exposition et les flares triés en phase,</p>
<span class="eq">D⁺ = max( i/n − F(φᵢ) ),  D⁻ = max( F(φᵢ) − (i−1)/n ),  V = D⁺ + D⁻</span>
<p><b>Pourquoi Kuiper et pas Kolmogorov-Smirnov.</b> KS utilise D, le plus grand écart unique. V est invariant par décalage cyclique de l'origine des phases, et la phase est un cercle : la phase 0 est une coupure arbitraire, pas une frontière. Un excès à cheval sur la phase 0/1 paraîtrait artificiellement faible à KS selon l'endroit de la coupure.</p>
<p>La p-valeur est la série asymptotique avec la correction d'échantillon fini de Stephens, avec λ = (√n + 0,155 + 0,24/√n)·V :</p>
<span class="eq">p = 2 Σ_{j≥1} (4j²λ² − 1) exp(−2j²λ²)</span>
<p>Fiable pour n au-dessus d'environ 8. En dessous elle est optimiste, et la page le dit.</p>

<h3>7. Excès de Poisson par intervalle de phase</h3>
<p>Complémentaire de Kuiper, et sensible à autre chose : Kuiper répond à un déplacement doux de toute la distribution, les intervalles à un excès marqué en un endroit.</p>
<p>L'attente de chaque intervalle est le nombre total de flares multiplié par sa part d'exposition : un intervalle tombant dans un trou n'attend rien. La p-valeur est la fonction de survie de Poisson au compte observé.</p>
<p>Quatre découpages (2, 4, 8, 16) sont montrés parce que le bon dépend de la largeur de l'excès, inconnue d'avance. Dans un découpage, les p-valeurs sont <b>corrigées de Bonferroni sur les intervalles de ce découpage</b> (Dunn 1961). Elles ne le sont délibérément <b>pas</b> entre les quatre découpages : ce sont quatre vues d'un même jeu de données, pas trente essais indépendants, et multiplier par trente serait une correction fausse dans le sens conservateur.</p>

<h3>8. Un flare par cycle</h3>
<p>Les deux tests sont faits deux fois : sur toutes les détections, et sur <b>au plus un flare par cycle orbital, le plus brillant</b>. La conclusion est portée par le second.</p>
<p>La raison est un mode de défaillance précis. Un seul épisode éruptif étalé sur plusieurs sous-pics détectés dans une même orbite apparaît, dans la liste brute, comme plusieurs événements indépendants à la même phase, ce qui est exactement l'allure d'un verrouillage en phase. Une seule tempête peut donc fabriquer une détection. Réduire à un événement par cycle supprime cela au prix de la sensibilité, et le résultat brut est montré à côté pour que la différence soit visible plutôt que cachée.</p>

<h3>8b. La période de rotation, et pourquoi elle n'est pas mesurée ici</h3>
<p>La rotation est le contrôle que doit passer toute affirmation de verrouillage en phase orbitale : des flares suivant la phase de <b>rotation</b> sont de simples longitudes actives, et seuls des flares suivant la phase <b>orbitale</b> seraient une interaction étoile-planète. La page propose donc la période de rotation comme repliement chaque fois que l'archive en publie une.</p>
<p>Elle n'en <b>mesure pas</b> depuis la courbe de lumière, et la raison mérite d'être dite. Un périodogramme de Lomb-Scargle d'une courbe TESS renvoie un pic pour chaque étoile, et une probabilité de fausse alarme nulle pour chaque étoile aussi : avec quelques centaines de milliers de cadences, les systématiques cohérentes de l'instrument sont formellement significatives. Confrontée aux valeurs publiées sur onze étoiles, une implémentation naïve en a trouvé quatre de justes, et rien dans le périodogramme ne distinguait ces quatre-là des sept fausses. Comme une période de rotation erronée autoriserait précisément la conclusion que ce contrôle doit empêcher, aucune n'est livrée.</p>
<p>Bien le faire demanderait la photométrie au niveau des FFI avec les systématiques modélisées plutôt que filtrées, un contrôle des harmoniques à la moitié et au double du pic, et un accord entre secteurs. Là où l'archive n'a pas de période de rotation, lisez tout résultat de verrouillage en phase de cette page comme non contrôlé contre la rotation.</p>

<h3>9. Comment lire une petite p-valeur ici</h3>
<p>Comme une statistique de tri, pas comme une découverte. Précisément, elle n'est corrigée <b>ni</b> du nombre d'étoiles regardées, <b>ni</b> du nombre de périodes essayées, et elle suppose les flares indépendants, ce qu'ils ne sont pas : les flares se regroupent, et une étoile dont les flares arrivent par tempêtes produira de petites p-valeurs sans aucune planète.</p>
<p>Une vraie interaction magnétique étoile-planète montrerait un signal à la période <b>orbitale</b> mais pas à la période de rotation, persistant d'un secteur à l'autre plutôt que confiné à un seul, et survivant à la réduction au plus brillant par cycle. L'histoire de ce domaine est faite de détections annoncées qui ne se sont pas répétées (Shkolnik et al. 2005, 2008 ; et les non-confirmations de Miller et al. 2015), ce qui justifie la prudence ci-dessus.</p>

<h3>10. Reproduire ceci</h3>
<p>Le catalogue est construit par <code>web/precompute.py</code> dans le dépôt <code>syncflares</code>, qui appelle le même pipeline que la ligne de commande. Les statistiques du navigateur sont dans <code>web/assets/stats.js</code>, un portage de <code>syncflares/stats.py</code> ; <code>tests/test_web_stats.py</code> fait tourner les deux sur les mêmes entrées et exige qu'ils concordent, actuellement à 3×10⁻⁵ près sur le V de Kuiper et 10⁻¹⁴ sur la fonction de survie de Poisson face à SciPy.</p>

<h3>Références</h3>
<ul class="refs">
<li><b>Kuiper, N. H. (1960).</b> Tests concerning random points on a circle. <i>Proc. K. Ned. Akad. Wet. A</i> 63, 38.</li>
<li><b>Stephens, M. A. (1970).</b> Use of the Kolmogorov-Smirnov, Cramér-von Mises and related statistics without extensive tables. <i>J. R. Stat. Soc. B</i> 32, 115.</li>
<li><b>Press, W. H., et al.</b> <i>Numerical Recipes</i>, 3ᵉ éd., §14.3.4 (statistique de Kuiper et sa p-valeur asymptotique).</li>
<li><b>Dunn, O. J. (1961).</b> Multiple comparisons among means. <i>J. Am. Stat. Assoc.</i> 56, 52.</li>
<li><b>Garwood, F. (1936).</b> Fiducial limits for the Poisson distribution. <i>Biometrika</i> 28, 437.</li>
<li><b>Medina, A. A., et al. (2020).</b> Flare rates, rotation periods, and spectroscopic activity indicators of a volume-complete sample of mid- to late-M dwarfs within 15 pc. <i>ApJ</i> 905, 107.</li>
<li><b>Gershberg, R. E. (1972).</b> Some results of the cooperative photometric observations of the UV Cet-type flare stars. <i>Ap&amp;SS</i> 19, 75. (Durée équivalente.)</li>
<li><b>Hunt-Walker, N. M., et al. (2012).</b> The photometric variability of the M dwarfs. <i>PASP</i> 124, 545.</li>
<li><b>West, A. A., et al. (2008).</b> Constraining the age-activity relation for cool stars. <i>AJ</i> 135, 785.</li>
<li><b>Shkolnik, E., et al. (2005).</b> Hot Jupiters and hot spots. <i>ApJ</i> 622, 1075.</li>
<li><b>Shkolnik, E., et al. (2008).</b> Signs of star-planet interactions. <i>ApJ</i> 676, 628.</li>
<li><b>Miller, B. P., et al. (2015).</b> On the search for transiting hot Jupiters and star-planet interaction. <i>ApJ</i> 799, 163.</li>
<li><b>Ricker, G. R., et al. (2015).</b> Transiting Exoplanet Survey Satellite. <i>JATIS</i> 1, 014003.</li>
<li><b>Jenkins, J. M., et al. (2016).</b> The TESS science processing operations center. <i>Proc. SPIE</i> 9913, 99133E. (SPOC.)</li>
<li><b>Huang, C. X., et al. (2020).</b> Photometry of 10 million stars from the first two years of TESS full frame images. <i>RNAAS</i> 4, 204. (QLP.)</li>
<li><b>Lightkurve Collaboration (2018).</b> Lightkurve: Kepler and TESS time series analysis in Python. <i>ascl:1812.013</i>.</li>
<li><b>Astropy Collaboration (2022).</b> The Astropy project. <i>ApJ</i> 935, 167.</li>
<li><b>Virtanen, P., et al. (2020).</b> SciPy 1.0. <i>Nature Methods</i> 17, 261.</li>
</ul>
<p class="hint">Ce travail utilise la NASA Exoplanet Archive, exploitée par Caltech sous contrat avec la NASA dans le cadre du programme d'exploration des exoplanètes, et les données de l'archive MAST au STScI. Le financement de TESS est assuré par la direction des missions scientifiques de la NASA.</p>
`;

export const METHODS = { en: EN, fr: FR };
