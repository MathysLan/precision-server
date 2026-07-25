// e2e ws du Party Game de Précision : deux clients jouent une partie complète.
// Lancer le serveur AVANT : PORT=8145 node src/server.js
const WebSocket = require('ws');
const URL = 'ws://localhost:' + (process.env.PORT || 8145);
let f = 0; const check = (l, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + l); if (!c) f++; };

function client() {
  const ws = new WebSocket(URL); const q = [], w = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw); const r = w.shift(); r ? r(m) : q.push(m); });
  const next = () => new Promise((res) => { q.length ? res(q.shift()) : w.push(res); });
  return {
    ws, send: (o) => ws.send(JSON.stringify(o)), open: () => new Promise((r) => ws.on('open', r)),
    async until(p) { for (;;) { const m = await next(); if (p(m)) return m; } },
    async phase(p) { return this.until((m) => m.type === 'phase' && m.phase === p); },
  };
}
// une tentative plausible selon le type
const guessFor = (game, target) => ({
  shape: { x: 50, y: 50, scale: 1, rotation: 0 },
  color: { h: 200, s: 80, l: 45 },
  sound: { frequency: 440 },
  time: { ms: (target && target.target_ms) || 3000 },
}[game]);

(async () => {
  const a = client(), b = client();
  await a.open(); await b.open();
  a.send({ action: 'join', name: 'Alice', avatar: '🦊' });
  const ra = await a.until((m) => m.type === 'room'); const idA = ra.you;
  b.send({ action: 'join', name: 'Bob', code: ra.code, avatar: '🐼' });
  await b.until((m) => m.type === 'room');

  // --- le MJ lance en Facile, 2 rounds, épreuve forcée : color ---
  b.send({ action: 'start', rounds: 2, difficulty: 'facile', game: 'color' });
  check('start refusé au non-MJ', (await b.until((m) => m.type === 'error')).message.includes('MJ'));
  a.send({ action: 'start', rounds: 2, difficulty: 'facile', game: 'color' });

  // --- memorize : la cible est envoyée ---
  const mem = await a.phase('memorize');
  check('memorize : type d\'épreuve respecté (color forcé)', mem.game === 'color');
  check('memorize : difficulté transmise', mem.difficulty === 'facile');
  check('memorize : cible envoyée', mem.target && typeof mem.target.h === 'number');
  check('memorize : durée = celle de Facile', mem.ms === 5000);
  check('memorize : round 1/2', mem.round === 1 && mem.of === 2);
  const target = mem.target;

  // soumettre AVANT la phase play → refusé
  a.send({ action: 'submit', type: 'color', data: guessFor('color') });
  check('submit refusé hors phase play', (await a.until((m) => m.type === 'error')).message.length > 0);

  // --- play : plus aucune cible ---
  const play = await a.phase('play');
  check('play : AUCUNE cible envoyée (anti-triche)', play.target === undefined);
  check('play : durée = celle de Facile', play.ms === 20000);

  // Alice soumet pile la cible, Bob soumet à côté
  a.send({ action: 'submit', type: 'color', data: { h: target.h, s: target.s, l: target.l } });
  const ready = await a.until((m) => m.type === 'ready');
  check('ready : progression des soumissions diffusée', ready.ids.includes(idA) && ready.of === 2);

  const revPromise = a.phase('reveal');
  b.send({ action: 'submit', type: 'color', data: { h: (target.h + 120) % 360, s: target.s, l: target.l } });

  // --- reveal : dès que tout le monde a validé (sans attendre le timer) ---
  const rev = await revPromise;
  check('reveal : déclenché dès que tout le monde a validé', true);
  check('reveal : cible révélée', rev.target && rev.target.h === target.h);
  check('reveal : 2 résultats', rev.results.length === 2);
  check('reveal : Alice à 100 %', rev.results[0].id === idA && rev.results[0].accuracy === 100);
  check('reveal : classement décroissant', rev.results[0].accuracy >= rev.results[1].accuracy);
  check('reveal : valeurs exactes de chacun (superposition)', rev.results.every((r) => r.data && typeof r.data.h === 'number'));
  check('reveal : détail par composante', rev.results[0].parts && 'h' in rev.results[0].parts);
  check('reveal : scoreboard cumulé', Array.isArray(rev.scores) && rev.scores.length === 2);
  check('reveal : pseudo/avatar joints', rev.results.every((r) => r.name && r.avatar));

  // --- round 2 : le MJ enchaîne ---
  b.send({ action: 'next' });
  check('next refusé au non-MJ', (await b.until((m) => m.type === 'error')).message.includes('MJ'));
  a.send({ action: 'next' });
  const mem2 = await a.phase('memorize');
  check('round 2 lancé par le MJ', mem2.round === 2);
  const t2 = mem2.target;
  await a.phase('play');
  a.send({ action: 'submit', type: 'color', data: { h: t2.h, s: t2.s, l: t2.l } });
  b.send({ action: 'submit', type: 'color', data: { h: t2.h, s: t2.s, l: t2.l } });
  const rev2 = await a.phase('reveal');
  check('round 2 : scores cumulés sur 2 rounds', rev2.scores[0].score > 100);

  // --- fin de partie ---
  a.send({ action: 'next' });
  const end = await a.phase('end');
  check('end : podium des 2 joueurs', end.podium.length === 2);

  a.ws.close(); b.ws.close();
  console.log(f === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${f} test(s) échoué(s)`);
  process.exit(f === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
