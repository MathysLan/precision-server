// Moteur du Party Game de Précision (inspiré des tests dialed.gg).
// Fonctions PURES : un état/des nombres entrent, un résultat sort. Aucun socket,
// aucun setTimeout, aucune horloge lue ici — c'est le seul endroit où vivent les
// RÈGLES (génération des cibles, barèmes, scoring), et il est 100% testable.
//
// Principe : TOUT LE MONDE joue en même temps, contre le serveur. Un round =
// une épreuve parmi 4 (shape / color / sound / time). On mémorise une cible,
// elle disparaît, on la reproduit. Le serveur compare et donne une précision
// de 0 à 100 %.
//
// SÉCURITÉ (zéro confiance) : la cible n'est envoyée qu'en phase `memorize`
// (et pour `time`, c'est juste la consigne). Pendant `play`, le serveur
// n'envoie RIEN : le client ne peut pas relire la réponse. Les valeurs exactes
// de tout le monde ne sortent qu'en `reveal`.

// --- unités (contrat avec le front) ----------------------------------------
// shape : x,y en 0..100 (% du plateau), scale 0.3..2, rotation 0..360 (deg),
//         sym = symétrie de la forme (triangle = 3 → 120° ressemble à 0°).
// color : h 0..360, s 0..100, l 0..100.
// sound : frequency en Hz (comparaison en CENTS : l'oreille est logarithmique).
// time  : millisecondes.

// --- difficultés -----------------------------------------------------------
// `memorizeMs`/`playMs` : durées des phases (le serveur pose les setTimeout).
// `tol` : l'écart qui donne 0 %. Plus c'est petit, plus il faut être précis.
const DIFFICULTY = {
  facile: {
    label: 'Facile', memorizeMs: 5000, playMs: 20000, revealMs: 8000,
    tol: { shape: { pos: 22, scale: 0.50, rot: 60 }, color: { h: 60, s: 35, l: 35 }, sound: { cents: 500 }, time: { ms: 1200 } },
  },
  moyen: {
    label: 'Moyen', memorizeMs: 3000, playMs: 15000, revealMs: 7000,
    tol: { shape: { pos: 15, scale: 0.35, rot: 40 }, color: { h: 40, s: 25, l: 25 }, sound: { cents: 350 }, time: { ms: 800 } },
  },
  difficile: {
    label: 'Difficile', memorizeMs: 2000, playMs: 10000, revealMs: 6000,
    tol: { shape: { pos: 9, scale: 0.22, rot: 25 }, color: { h: 25, s: 16, l: 16 }, sound: { cents: 200 }, time: { ms: 450 } },
  },
  impossible: {
    label: 'Impossible', memorizeMs: 1000, playMs: 7000, revealMs: 5000,
    tol: { shape: { pos: 5, scale: 0.12, rot: 14 }, color: { h: 14, s: 9, l: 9 }, sound: { cents: 110 }, time: { ms: 220 } },
  },
};
const DEFAULT_DIFFICULTY = 'moyen';
const diffOf = (key) => DIFFICULTY[String(key || '').toLowerCase()] || DIFFICULTY[DEFAULT_DIFFICULTY];

const TYPES = ['shape', 'color', 'sound', 'time'];

// Formes possibles de l'épreuve `shape`. `sym` = ordre de symétrie de rotation :
// un carré tourné de 90° est identique, un triangle de 120°, etc. On s'en sert
// pour ne PAS punir un joueur qui a l'angle visuellement juste.
// `sym: 0` = la rotation n'a aucun sens (cercle) → elle n'est pas notée.
const SHAPE_KINDS = [
  { id: 'triangle', sym: 3 },
  { id: 'carre', sym: 4 },
  { id: 'rectangle', sym: 2 },
  { id: 'cercle', sym: 0 },
  { id: 'ovale', sym: 2 },
  { id: 'pentagone', sym: 5 },
  { id: 'hexagone', sym: 6 },
];
const PHASES = ['generate', 'memorize', 'play', 'reveal'];

// --- helpers maths ---------------------------------------------------------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round3 = (v) => Math.round(v * 1000) / 1000;
const rnd = (rng, a, b) => a + rng() * (b - a);

// Écart angulaire replié sur la symétrie de la forme (triangle : période 120°).
function foldAngle(a, b, sym = 1) {
  const period = 360 / Math.max(1, sym);
  let d = Math.abs(a - b) % period;
  return Math.min(d, period - d);
}
// Écart de teinte : le cercle chromatique boucle (350 et 10 sont voisins).
function hueDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}
// Écart de hauteur en CENTS (100 cents = 1 demi-ton) : perception logarithmique.
const centsDiff = (f, target) => Math.abs(1200 * Math.log2(f / target));

// Une erreur + sa tolérance → une note 0..1. Linéaire : simple et lisible.
function grade(err, tol) {
  if (!Number.isFinite(err) || !Number.isFinite(tol) || tol <= 0) return 0;
  return clamp(1 - err / tol, 0, 1);
}
const pct = (x) => Math.round(clamp(x, 0, 1) * 1000) / 10;   // 0..100 avec 1 décimale

// --- état d'un round -------------------------------------------------------
// Les soumissions vivent dans une Map EN RAM, vidée à chaque round → aucune
// accumulation mémoire, aucune base de données.
function createRound(type, target, difficulty = DEFAULT_DIFFICULTY) {
  return {
    phase: 'generate',            // generate → memorize → play → reveal
    type,                         // 'shape' | 'color' | 'sound' | 'time'
    target,                       // la cible SECRÈTE (voir memorizePayload)
    difficulty: String(difficulty || DEFAULT_DIFFICULTY).toLowerCase(),
    startedAt: 0,                 // Date.now() du top départ de `play` (posé par server.js)
    submissions: new Map(),       // playerId -> { data, at, ms }
    timer: null,                  // handle du setTimeout de phase (posé par server.js)
  };
}
const timings = (round) => {
  const d = diffOf(round.difficulty);
  return { memorizeMs: d.memorizeMs, playMs: d.playMs, revealMs: d.revealMs };
};
const tolOf = (round) => diffOf(round.difficulty).tol[round.type];

// Transition de phase autorisée (garde-fou : pas de saut en arrière).
function canGoTo(round, next) {
  const i = PHASES.indexOf(round.phase), j = PHASES.indexOf(next);
  return j === i + 1;
}

// --- génération des cibles -------------------------------------------------
function pickType(rng = Math.random, forced) {
  if (TYPES.includes(forced)) return forced;
  return TYPES[Math.floor(rng() * TYPES.length)];
}

function generateTarget(type, rng = Math.random) {
  if (type === 'shape') {
    const kind = SHAPE_KINDS[Math.floor(rng() * SHAPE_KINDS.length)];
    return {
      kind: kind.id, sym: kind.sym,
      x: round3(rnd(rng, 20, 80)), y: round3(rnd(rng, 20, 80)),
      scale: round3(rnd(rng, 0.5, 1.5)),
      rotation: kind.sym === 0 ? 0 : round3(rnd(rng, 0, 360)),   // un cercle n'a pas d'angle
    };
  }
  if (type === 'color') {
    return { h: round3(rnd(rng, 0, 360)), s: round3(rnd(rng, 40, 100)), l: round3(rnd(rng, 25, 75)) };
  }
  if (type === 'sound') {
    // tirage LOG-uniforme entre 200 et 800 Hz : autant de graves que d'aigus à l'oreille
    return { frequency: round3(200 * Math.pow(4, rng())) };
  }
  // time : la consigne (« arrête à X ms ») + l'instant où le chrono se cache
  const target_ms = Math.round(rnd(rng, 2500, 9000));
  return { target_ms, hide_after_ms: Math.round(target_ms * rnd(rng, 0.25, 0.45)) };
}

// Ce qu'on envoie aux clients en phase `memorize`. Pour `time`, ce n'est pas un
// secret : c'est la consigne (le chrono se cachera pendant `play`).
function memorizePayload(round) {
  const t = round.target;
  if (round.type === 'time') return { target_ms: t.target_ms, hide_after_ms: t.hide_after_ms };
  return { ...t };
}

// --- soumissions -----------------------------------------------------------
// Valide la FORME des données envoyées par le client (jamais confiance aveugle).
function validateSubmission(round, type, data) {
  if (round.phase !== 'play') return fail("ce n'est pas le moment de valider");
  if (type !== round.type) return fail('mauvais type d\'épreuve');
  if (!data || typeof data !== 'object') return fail('données manquantes');
  const n = (v) => Number(v);
  if (type === 'shape') {
    const x = n(data.x), y = n(data.y), scale = n(data.scale), rotation = n(data.rotation);
    if (![x, y, scale, rotation].every(Number.isFinite)) return fail('shape : valeurs invalides');
    return ok({ x: clamp(x, 0, 100), y: clamp(y, 0, 100), scale: clamp(scale, 0.1, 3), rotation: ((rotation % 360) + 360) % 360 });
  }
  if (type === 'color') {
    const h = n(data.h), s = n(data.s), l = n(data.l);
    if (![h, s, l].every(Number.isFinite)) return fail('color : valeurs invalides');
    return ok({ h: ((h % 360) + 360) % 360, s: clamp(s, 0, 100), l: clamp(l, 0, 100) });
  }
  if (type === 'sound') {
    const f = n(data.frequency);
    if (!Number.isFinite(f) || f <= 0) return fail('sound : fréquence invalide');
    return ok({ frequency: clamp(f, 20, 20000) });
  }
  const ms = n(data.ms !== undefined ? data.ms : data.time_ms);
  if (!Number.isFinite(ms) || ms < 0) return fail('time : durée invalide');
  return ok({ ms: clamp(ms, 0, 600000) });
}

// Enregistre (ou remplace) la tentative d'un joueur pour ce round.
function record(round, playerId, data, at = 0) {
  round.submissions.set(playerId, { data, at });
}
const hasSubmitted = (round, playerId) => round.submissions.has(playerId);
const allSubmitted = (round, playerIds) => playerIds.every((id) => round.submissions.has(id));

// --- les 4 calculs de précision (0..100 %) ---------------------------------
// Chacun renvoie { accuracy, parts } : `parts` détaille les sous-notes pour que
// le front puisse expliquer l'écart (« position ok, rotation ratée »).

// Shape : position (40 %), taille (30 %), rotation (30 %).
// Cas du cercle (`sym: 0`) : la rotation n'a aucun sens visuel, on ne la note
// pas et son poids est réparti sur la position et la taille.
function scoreShape(target, data, tol) {
  const dPos = Math.hypot(data.x - target.x, data.y - target.y);
  const dScale = Math.abs(data.scale - target.scale);
  const noRot = !target.sym;
  const dRot = noRot ? 0 : foldAngle(data.rotation, target.rotation, target.sym);
  const parts = {
    pos: pct(grade(dPos, tol.pos)), scale: pct(grade(dScale, tol.scale)),
    rot: noRot ? null : pct(grade(dRot, tol.rot)),
  };
  const acc = noRot
    ? 0.55 * (parts.pos / 100) + 0.45 * (parts.scale / 100)
    : 0.40 * (parts.pos / 100) + 0.30 * (parts.scale / 100) + 0.30 * (parts.rot / 100);
  return { accuracy: pct(acc), parts, deltas: { pos: round3(dPos), scale: round3(dScale), rot: noRot ? null : round3(dRot) } };
}

// Color : teinte (50 %), saturation (25 %), luminosité (25 %). La teinte boucle.
function scoreColor(target, data, tol) {
  const dH = hueDiff(data.h, target.h);
  const dS = Math.abs(data.s - target.s);
  const dL = Math.abs(data.l - target.l);
  const parts = { h: pct(grade(dH, tol.h)), s: pct(grade(dS, tol.s)), l: pct(grade(dL, tol.l)) };
  const acc = 0.50 * (parts.h / 100) + 0.25 * (parts.s / 100) + 0.25 * (parts.l / 100);
  return { accuracy: pct(acc), parts, deltas: { h: round3(dH), s: round3(dS), l: round3(dL) } };
}

// Sound : écart en cents (pas en Hz !). 100 Hz d'écart à 200 Hz s'entend
// énormément, à 800 Hz beaucoup moins : les cents corrigent ça.
function scoreSound(target, data, tol) {
  const dC = centsDiff(data.frequency, target.frequency);
  return {
    accuracy: pct(grade(dC, tol.cents)),
    parts: { cents: pct(grade(dC, tol.cents)) },
    deltas: { cents: round3(dC), hz: round3(data.frequency - target.frequency) },
  };
}

// Time : écart en millisecondes à l'instant demandé.
function scoreTime(target, data, tol) {
  const dMs = Math.abs(data.ms - target.target_ms);
  return {
    accuracy: pct(grade(dMs, tol.ms)),
    parts: { ms: pct(grade(dMs, tol.ms)) },
    deltas: { ms: Math.round(data.ms - target.target_ms) },   // <0 = trop tôt, >0 = trop tard
  };
}

const SCORERS = { shape: scoreShape, color: scoreColor, sound: scoreSound, time: scoreTime };

// Note d'une tentative, quel que soit le type.
function scoreOne(round, data) {
  return SCORERS[round.type](round.target, data, tolOf(round));
}

// --- résultats du round ----------------------------------------------------
// Tous les joueurs présents sont notés : pas de soumission = 0 %.
// `points` = la précision arrondie (0..100) → le classement général s'additionne.
function computeResults(round, playerIds) {
  const rows = playerIds.map((id) => {
    const sub = round.submissions.get(id);
    if (!sub) return { id, submitted: false, data: null, accuracy: 0, points: 0, parts: null, deltas: null };
    const s = scoreOne(round, sub.data);
    return { id, submitted: true, data: sub.data, accuracy: s.accuracy, points: Math.round(s.accuracy), parts: s.parts, deltas: s.deltas };
  });
  rows.sort((a, b) => b.accuracy - a.accuracy);
  return { type: round.type, target: round.target, difficulty: round.difficulty, results: rows };
}

// Vide la Map du round : appelé à chaque rotation (zéro accumulation).
function purge(round) { if (round) { round.submissions.clear(); round.timer = null; } }

const ok = (data) => ({ ok: true, data });
const fail = (error) => ({ ok: false, error });

module.exports = {
  DIFFICULTY, DEFAULT_DIFFICULTY, TYPES, PHASES, diffOf,
  SHAPE_KINDS, createRound, timings, tolOf, canGoTo,
  pickType, generateTarget, memorizePayload,
  validateSubmission, record, hasSubmitted, allSubmitted,
  scoreShape, scoreColor, scoreSound, scoreTime, scoreOne,
  computeResults, purge,
  // exposés pour les tests / le front
  foldAngle, hueDiff, centsDiff, grade,
};
