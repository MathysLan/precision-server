// Test du moteur de Précision : purement synchrone, aucun serveur requis.
const e = require('./src/engine-precision');
let f = 0; const check = (l, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + l); if (!c) f++; };

// --- difficultés ------------------------------------------------------------
check('4 difficultés définies', Object.keys(e.DIFFICULTY).length === 4);
check('plus dur = mémorisation plus courte',
  e.DIFFICULTY.facile.memorizeMs > e.DIFFICULTY.moyen.memorizeMs
  && e.DIFFICULTY.moyen.memorizeMs > e.DIFFICULTY.difficile.memorizeMs
  && e.DIFFICULTY.difficile.memorizeMs > e.DIFFICULTY.impossible.memorizeMs);
check('plus dur = temps de jeu plus court',
  e.DIFFICULTY.facile.playMs > e.DIFFICULTY.impossible.playMs);
check('plus dur = tolérance plus serrée',
  e.DIFFICULTY.facile.tol.time.ms > e.DIFFICULTY.impossible.tol.time.ms
  && e.DIFFICULTY.facile.tol.color.h > e.DIFFICULTY.impossible.tol.color.h);
check('difficulté inconnue → repli sur le défaut', e.diffOf('pouet') === e.DIFFICULTY[e.DEFAULT_DIFFICULTY]);

// --- machine à états --------------------------------------------------------
const r0 = e.createRound('color', { h: 10, s: 50, l: 50 }, 'moyen');
check('round démarre en `generate`', r0.phase === 'generate');
check('generate → memorize autorisé', e.canGoTo(r0, 'memorize'));
check('generate → play interdit (pas de saut)', !e.canGoTo(r0, 'play'));
r0.phase = 'play';
check('play → reveal autorisé', e.canGoTo(r0, 'reveal'));
check('play → memorize interdit (pas de retour arrière)', !e.canGoTo(r0, 'memorize'));
check('timings suivent la difficulté', e.timings(r0).playMs === e.DIFFICULTY.moyen.playMs);

// --- génération -------------------------------------------------------------
for (const t of e.TYPES) {
  const tg = e.generateTarget(t, Math.random);
  check(`generateTarget(${t}) : objet non vide`, tg && Object.keys(tg).length > 0);
}
const shp = e.generateTarget('shape', () => 0.5);
check('shape : x,y dans 0..100', shp.x >= 0 && shp.x <= 100 && shp.y >= 0 && shp.y <= 100);
check('shape : une forme est tirée du catalogue', e.SHAPE_KINDS.some((k) => k.id === shp.kind));
check('shape : la symétrie correspond à la forme',
  shp.sym === e.SHAPE_KINDS.find((k) => k.id === shp.kind).sym);
// sur 300 tirages, on doit voir plusieurs formes différentes (pas que du triangle)
const kinds = new Set(Array.from({ length: 300 }, () => e.generateTarget('shape').kind));
check('shape : les formes varient (triangle, cercle, ovale…)', kinds.size >= 5);
check('shape : le cercle n\'a pas d\'angle imposé',
  e.SHAPE_KINDS.find((k) => k.id === 'cercle').sym === 0);
const snd = e.generateTarget('sound', () => 0.5);
check('sound : fréquence dans 200..800 Hz', snd.frequency >= 200 && snd.frequency <= 800);
const tim = e.generateTarget('time', () => 0.5);
check('time : le chrono se cache AVANT la cible', tim.hide_after_ms < tim.target_ms);
check('pickType respecte un type forcé', e.pickType(Math.random, 'sound') === 'sound');
check('pickType tire dans les 4 types', e.TYPES.includes(e.pickType(Math.random)));

// memorizePayload : pour `time` on n'envoie que la consigne
const rT = e.createRound('time', tim, 'moyen');
const payT = e.memorizePayload(rT);
check('memorize(time) : consigne = target_ms', payT.target_ms === tim.target_ms);
const rC = e.createRound('color', { h: 200, s: 80, l: 45 }, 'moyen');
check('memorize(color) : cible complète', e.memorizePayload(rC).h === 200);

// --- validation des soumissions --------------------------------------------
check('submit refusé hors phase play', e.validateSubmission(rC, 'color', { h: 1, s: 1, l: 1 }).ok === false);
rC.phase = 'play';
check('submit refusé si mauvais type', e.validateSubmission(rC, 'sound', { frequency: 440 }).ok === false);
check('submit refusé si données absentes', e.validateSubmission(rC, 'color', null).ok === false);
check('submit refusé si NaN', e.validateSubmission(rC, 'color', { h: 'x', s: 1, l: 1 }).ok === false);
const vOk = e.validateSubmission(rC, 'color', { h: 400, s: 150, l: -20 });
check('submit : teinte repliée et bornes clampées',
  vOk.ok && vOk.data.h === 40 && vOk.data.s === 100 && vOk.data.l === 0);

// --- SCORING : shape --------------------------------------------------------
const tolM = e.DIFFICULTY.moyen.tol;
const tShape = { x: 50, y: 50, scale: 1, rotation: 0, sym: 3 };
check('shape parfait = 100 %', e.scoreShape(tShape, { x: 50, y: 50, scale: 1, rotation: 0 }, tolM.shape).accuracy === 100);
check('shape à l\'opposé = 0 %',
  e.scoreShape(tShape, { x: 0, y: 0, scale: 3, rotation: 60 }, tolM.shape).accuracy === 0);
check('shape : plus proche = meilleur score',
  e.scoreShape(tShape, { x: 53, y: 50, scale: 1, rotation: 0 }, tolM.shape).accuracy
  > e.scoreShape(tShape, { x: 60, y: 50, scale: 1, rotation: 0 }, tolM.shape).accuracy);
// symétrie : un triangle tourné de 120° est visuellement identique
check('shape : rotation 120° = identique (symétrie 3)',
  e.scoreShape(tShape, { x: 50, y: 50, scale: 1, rotation: 120 }, tolM.shape).accuracy === 100);
check('shape : rotation 60° ≠ identique',
  e.scoreShape(tShape, { x: 50, y: 50, scale: 1, rotation: 60 }, tolM.shape).parts.rot < 100);
check('shape : détail par composante fourni',
  ['pos', 'scale', 'rot'].every((k) => k in e.scoreShape(tShape, { x: 50, y: 50, scale: 1, rotation: 0 }, tolM.shape).parts));

// --- cas du cercle : la rotation ne veut rien dire, on ne doit PAS la noter ---
const tCircle = { x: 50, y: 50, scale: 1, rotation: 0, sym: 0 };
const cA = e.scoreShape(tCircle, { x: 50, y: 50, scale: 1, rotation: 0 }, tolM.shape);
const cB = e.scoreShape(tCircle, { x: 50, y: 50, scale: 1, rotation: 217 }, tolM.shape);
check('cercle : position/taille parfaites = 100 % quel que soit l\'angle',
  cA.accuracy === 100 && cB.accuracy === 100);
check('cercle : la rotation n\'est pas notée', cB.parts.rot === null && cB.deltas.rot === null);
check('cercle : la position compte toujours',
  e.scoreShape(tCircle, { x: 50 + tolM.shape.pos + 5, y: 50, scale: 1, rotation: 0 }, tolM.shape).accuracy < 100);

// --- SCORING : color --------------------------------------------------------
const tCol = { h: 10, s: 50, l: 50 };
check('color parfait = 100 %', e.scoreColor(tCol, { h: 10, s: 50, l: 50 }, tolM.color).accuracy === 100);
// la teinte boucle : 350 est à 20° de 10, pas à 340°
check('color : la teinte boucle (350 proche de 10)',
  e.hueDiff(350, 10) === 20 && e.scoreColor(tCol, { h: 350, s: 50, l: 50 }, tolM.color).parts.h > 0);
check('color : teinte à l\'opposé = 0 sur la teinte',
  e.scoreColor(tCol, { h: 190, s: 50, l: 50 }, tolM.color).parts.h === 0);
check('color : la teinte pèse plus que la saturation',
  e.scoreColor(tCol, { h: 10, s: 90, l: 50 }, tolM.color).accuracy
  > e.scoreColor(tCol, { h: 50, s: 50, l: 50 }, tolM.color).accuracy);

// --- SCORING : sound --------------------------------------------------------
const tSnd = { frequency: 400 };
check('sound parfait = 100 %', e.scoreSound(tSnd, { frequency: 400 }, tolM.sound).accuracy === 100);
check('sound : une octave = 1200 cents', Math.round(e.centsDiff(800, 400)) === 1200);
check('sound : une octave au-dessus = 0 %', e.scoreSound(tSnd, { frequency: 800 }, tolM.sound).accuracy === 0);
// équité perceptive : le même ratio donne le même score, en grave comme en aigu
const aigu = e.scoreSound({ frequency: 800 }, { frequency: 848 }, tolM.sound).accuracy;
const grave = e.scoreSound({ frequency: 200 }, { frequency: 212 }, tolM.sound).accuracy;
check('sound : même écart RELATIF = même score (grave vs aigu)', Math.abs(aigu - grave) < 0.2);
check('sound : écart en Hz et en cents fournis',
  'cents' in e.scoreSound(tSnd, { frequency: 420 }, tolM.sound).deltas);

// --- SCORING : time ---------------------------------------------------------
const tTim = { target_ms: 5000 };
check('time parfait = 100 %', e.scoreTime(tTim, { ms: 5000 }, tolM.time).accuracy === 100);
check('time : trop tôt et trop tard pénalisés pareil',
  e.scoreTime(tTim, { ms: 4700 }, tolM.time).accuracy === e.scoreTime(tTim, { ms: 5300 }, tolM.time).accuracy);
check('time : signe de l\'écart conservé (trop tôt = négatif)',
  e.scoreTime(tTim, { ms: 4700 }, tolM.time).deltas.ms === -300);
check('time : au-delà de la tolérance = 0 %',
  e.scoreTime(tTim, { ms: 5000 + tolM.time.ms + 1 }, tolM.time).accuracy === 0);
// la difficulté resserre vraiment l'exigence
check('time : même écart noté plus sévèrement en Impossible',
  e.scoreTime(tTim, { ms: 5200 }, e.DIFFICULTY.impossible.tol.time).accuracy
  < e.scoreTime(tTim, { ms: 5200 }, e.DIFFICULTY.facile.tol.time).accuracy);

// --- soumissions + résultats ------------------------------------------------
const rr = e.createRound('time', { target_ms: 5000 }, 'moyen');
rr.phase = 'play';
e.record(rr, 'pA', { ms: 5010 });     // très bon
e.record(rr, 'pB', { ms: 5600 });     // moyen
// pC ne soumet rien
check('hasSubmitted détecte qui a joué', e.hasSubmitted(rr, 'pA') && !e.hasSubmitted(rr, 'pC'));
check('allSubmitted false tant qu\'il manque quelqu\'un', !e.allSubmitted(rr, ['pA', 'pB', 'pC']));
check('allSubmitted true quand tout le monde a joué', e.allSubmitted(rr, ['pA', 'pB']));

const out = e.computeResults(rr, ['pA', 'pB', 'pC']);
check('résultats : tout le monde est noté (même absent)', out.results.length === 3);
check('résultats : triés par précision décroissante',
  out.results[0].accuracy >= out.results[1].accuracy && out.results[1].accuracy >= out.results[2].accuracy);
check('résultats : le plus précis en tête', out.results[0].id === 'pA');
check('résultats : pas de soumission = 0 %',
  out.results.find((x) => x.id === 'pC').accuracy === 0 && out.results.find((x) => x.id === 'pC').submitted === false);
check('résultats : valeurs exactes renvoyées (superposition front)',
  out.results.find((x) => x.id === 'pA').data.ms === 5010);
check('résultats : cible révélée', out.target.target_ms === 5000);
check('résultats : points = précision arrondie', out.results[0].points === Math.round(out.results[0].accuracy));

// purge : la Map est bien vidée entre deux rounds
e.purge(rr);
check('purge vide les soumissions (zéro accumulation)', rr.submissions.size === 0);

// bornes générales : jamais hors 0..100
let bad = 0;
for (let i = 0; i < 500; i++) {
  const t = e.TYPES[i % 4];
  const tg = e.generateTarget(t);
  const rd = e.createRound(t, tg, 'difficile');
  const guess = e.generateTarget(t);
  const g = t === 'time' ? { ms: guess.target_ms } : guess;
  const a = e.scoreOne(rd, g).accuracy;
  if (!(a >= 0 && a <= 100)) bad++;
}
check('précision toujours bornée 0..100 (500 tirages)', bad === 0);

console.log(f === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${f} test(s) échoué(s)`);
process.exit(f === 0 ? 0 : 1);
