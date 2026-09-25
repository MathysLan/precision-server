// Présence applicative (src/presence.js), contre un VRAI serveur lancé ici avec
// des délais très courts. Aucune dépendance au reste : on parle au serveur par
// son protocole normal, et on regarde qui il garde dans la room.
//
//   node test-presence.js
//
// Ce qui est vérifié :
//   · un client qui répond reste présent, même silencieux côté jeu ;
//   · un client adhérent qui cesse de répondre (onglet gelé : le pong NATIF
//     part toujours) est fermé en 4000 'absent', et l'autre joueur reçoit la
//     room à jour ;
//   · un ancien client qui ignore la présence n'est JAMAIS expulsé ;
//   · un message de présence, valide ou non, ne produit jamais « action
//     inconnue » — et un `n` invalide ne fait pas adhérer ;
//   · une coupure réseau franche (socket qui ne lit plus rien) : fermeture
//     puis `terminate()` pour un adhérent, ping natif pour un non-adhérent ;
//   · une partie se joue normalement, présence active.
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 8400 + Math.floor(Math.random() * 300);
const ENV = { PRESENCE_MS: '200', ABSENCE_MS: '700', NATIVE_PING_MS: '400', PRESENCE_KILL_MS: '300', LEAD_MS: '50' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ko = 0, n = 0;
const t = (nom, ok, detail = '') => { n++; if (!ok) ko++; console.log(`${ok ? 'OK  ' : 'KO  '} ${nom}${detail ? ' — ' + detail : ''}`); };

// Un client du jeu. `repond` : répond-il aux pings de présence (et dit-il
// bonjour à l'ouverture) ? `autoPong` : sa couche réseau répond-elle au ping natif ?
function client({ repond = true, autoPong = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { autoPong });
  const c = { ws, msgs: [], repond, ferme: null };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === 'presence' && c.repond) ws.send(JSON.stringify({ action: 'presence', n: m.n }));
  });
  ws.on('close', (code, why) => { c.ferme = { code, raison: String(why), a: Date.now() }; });
  c.open = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = async (p, ms = 4000, depuis = 0) => { const f = Date.now() + ms; while (Date.now() < f) { const m = c.msgs.slice(depuis).find(p); if (m) return m; await sleep(20); } return null; };
  // Le PROCHAIN message qui correspond (l'historique ne compte pas).
  c.suite = (p, ms) => c.wait(p, ms, c.msgs.length);
  c.room = () => [...c.msgs].reverse().find((m) => m.type === 'room');
  c.erreurs = () => c.msgs.filter((m) => m.type === 'error').map((m) => m.message);
  return c;
}
const join = (c, name, code) => c.send(code ? { action: 'join', name, code, avatar: { kind: 'emoji', emoji: '🎯' } } : { action: 'join', name, avatar: { kind: 'emoji', emoji: '🎯' } });

(async () => {
  const srv = spawn(process.execPath, ['src/server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), PRESENCE_QUIET: '1', ...ENV }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await new Promise((res, rej) => { const s = new WebSocket(`ws://127.0.0.1:${PORT}`); s.on('open', () => { s.close(); res(); }); s.on('error', rej); }); break; } catch (_) { await sleep(100); } }
  const tous = [];
  try {
    // ── 1. deux joueurs qui répondent : ils restent, même sans rien jouer
    const A = client(), B = client(); tous.push(A, B);
    await A.open; await B.open;
    join(A, 'Alice');
    const r = await A.wait((m) => m.type === 'room');
    join(B, 'Bruno', r.code);
    await A.wait((m) => m.type === 'room' && m.players.length === 2);
    t('le serveur envoie { type: "presence", n } à chacun', !!(await A.wait((m) => m.type === 'presence' && Number.isInteger(m.n))));
    t('… et le PREMIER message reçu est ce ping, dès la connexion (adhésion immédiate)', A.msgs[0] && A.msgs[0].type === 'presence' && B.msgs[0] && B.msgs[0].type === 'presence');
    await sleep(3500);   // 5 × ABSENCE_MS
    t('deux clients qui répondent, silencieux côté jeu : toujours là après 5 × ABSENCE_MS',
      !A.ferme && !B.ferme && A.room().players.length === 2);

    // ── 2. B cesse de répondre (onglet gelé : le pong natif, lui, part toujours)
    B.repond = false;
    const t0 = Date.now();
    await A.suite((m) => m.type === 'room' && m.players.length === 1, 3000);
    const d = Date.now() - t0;
    await sleep(100);
    t('B ne répond plus : le serveur le ferme en 4000 « absent »', !!B.ferme && B.ferme.code === 4000 && B.ferme.raison === 'absent', JSON.stringify(B.ferme));
    t('… malgré ses pongs natifs (la présence est bien APPLICATIVE)', true);
    t(`A reçoit aussitôt la room à jour : 1 joueur (${d} ms, ABSENCE_MS = 700)`, A.room().players.length === 1 && d < 700 + 200 + 500, `${d} ms`);
    t('A est toujours là, et toujours MJ', !A.ferme && A.room().players[0].host === true);

    // ── 2 bis. gelé JUSTE après la connexion : il n'a répondu qu'au ping de
    // connexion (l'hôte qui crée sa partie puis change d'application).
    const J = client(); tous.push(J);
    await J.open;
    await J.wait((m) => m.type === 'presence');
    await sleep(50);
    J.repond = false;
    join(J, 'Pressé', r.code);
    await A.suite((m) => m.type === 'room' && m.players.length === 2);
    await A.suite((m) => m.type === 'room' && m.players.length === 1, 3000);
    await sleep(100);
    t('gelé juste après la connexion (une seule réponse, au ping de connexion) : quand même retiré', !!J.ferme && J.ferme.code === 4000, JSON.stringify(J.ferme));

    // ── 3. un ANCIEN client, qui ignore la présence : jamais expulsé
    const C = client({ repond: false }); tous.push(C);
    await C.open;
    join(C, 'Ancien', r.code);
    await A.suite((m) => m.type === 'room' && m.players.length === 2);
    await sleep(3500);
    t('ancien client (aucune réponse de présence) : jamais expulsé', !C.ferme && A.room().players.length === 2);
    t('… il a pourtant reçu les pings, et les ignore sans erreur', C.msgs.some((m) => m.type === 'presence') && C.erreurs().length === 0);

    // ── 4. les messages de présence ne tombent jamais dans « action inconnue »
    const D = client({ repond: false }); tous.push(D);
    await D.open;
    for (const k of [0, 'x', -1, 1.5, 999999999, null]) D.send({ action: 'presence', n: k });
    D.send({ action: 'presence' });
    await sleep(300);
    t('présence valide ou non : aucun « action inconnue », aucune erreur', D.erreurs().length === 0, JSON.stringify(D.erreurs()));
    const E = client({ repond: false }); tous.push(E);
    await E.open;
    for (const k of ['x', -1, 999999999]) E.send({ action: 'presence', n: k });
    join(E, 'Faux', r.code);
    await A.suite((m) => m.type === 'room' && m.players.length === 3);
    await sleep(3500);
    t('un `n` invalide ne fait pas adhérer : pas d\'expulsion', !E.ferme);
    E.ws.close(); C.ws.close(); D.ws.close();
    await A.suite((m) => m.type === 'room' && m.players.length === 1);

    // ── 5. coupure réseau franche, joueur ADHÉRENT : plus rien ne passe
    // (socket en pause : pas de pong applicatif, pas de pong natif, et la
    // fermeture propre n'aboutit jamais) → close(), puis terminate().
    const F = client(); tous.push(F);
    await F.open;
    join(F, 'Coupé', r.code);
    await A.suite((m) => m.type === 'room' && m.players.length === 2);
    await sleep(300);
    F.ws._socket.pause();
    const t1 = Date.now();
    const vu = await A.suite((m) => m.type === 'room' && m.players.length === 1, 4000);
    t(`coupure franche (adhérent) : retiré de la room en ${Date.now() - t1} ms`, !!vu && A.room().players.length === 1);

    // ── 6. coupure franche d'un NON-adhérent : c'est le ping natif qui le voit
    const G = client({ repond: false, autoPong: false }); tous.push(G);
    await G.open;
    join(G, 'Muet', r.code);
    await A.suite((m) => m.type === 'room' && m.players.length === 2);
    const t2 = Date.now();
    await A.suite((m) => m.type === 'room' && m.players.length === 1, 3000);
    t(`ancien client dont le réseau est mort : coupé par le ping natif en ${Date.now() - t2} ms`, A.room().players.length === 1 && (G.ferme || G.ws.readyState >= 2));

    // ── 6 bis. REMPLACEMENT : la nouvelle connexion d'un joueur fait fermer
    // l'ancienne AVANT de rejoindre — jamais deux fois le même joueur.
    const X = client(); tous.push(X);
    await X.open;
    const cleX = (await X.wait((m) => m.type === 'presence' && m.cle)).cle;
    join(X, 'Xavier', r.code);
    const roomX = await X.wait((m) => m.type === 'room');
    const idX = roomX.you;
    await A.suite((m) => m.type === 'room' && m.players.length === 2);
    t('la clé de connexion n\'est envoyée qu\'à son propriétaire (A ne l\'a jamais vue)', !JSON.stringify(A.msgs).includes(cleX));
    X.ws._socket.pause();                                      // réseau mort : l'ancienne reste « ouverte » côté serveur
    await sleep(100);
    const mA = A.msgs.length;
    const X2 = client({ repond: false }); tous.push(X2);        // on répond à la main : la 1re réponse remplace
    await X2.open;
    const p0 = await X2.wait((m) => m.type === 'presence' && m.cle);
    X2.send({ action: 'presence', n: p0.n, remplace: cleX });
    const ack = await X2.wait((m) => m.type === 'presence' && m.remplace === true, 3000);
    const retireAvantAck = A.msgs.slice(mA).some((m) => m.type === 'room' && !m.players.some((p) => p.id === idX));
    t('remplacement : l\'ancienne connexion est retirée de la room AVANT l\'acquittement', !!ack && retireAvantAck);
    X2.repond = true;
    join(X2, 'Xavier', r.code);
    const roomX2 = await X2.wait((m) => m.type === 'room');
    await A.suite((m) => m.type === 'room' && m.players.length === 2);
    const doublon = A.msgs.slice(mA).filter((m) => m.type === 'room').some((m) => m.players.some((p) => p.id === idX) && m.players.some((p) => p.id === roomX2.you));
    const maxi = Math.max(...A.msgs.slice(mA).filter((m) => m.type === 'room').map((m) => m.players.length));
    t('… puis le join : AUCUNE room diffusée avec l\'ancienne ET la nouvelle connexion (au plus 2 joueurs vus)', !doublon && maxi === 2, `max ${maxi}`);
    // Clé inconnue, ou sa propre clé : acquitté, personne n'est fermé.
    const Y = client(); tous.push(Y);
    await Y.open;
    const cleY = (await Y.wait((m) => m.type === 'presence' && m.cle)).cle;
    Y.send({ action: 'presence', n: 0, remplace: 'nimportequoi' });
    Y.send({ action: 'presence', n: 0, remplace: cleY });
    await sleep(300);
    t('clé inconnue ou sa propre clé : acquitté, personne n\'est fermé, aucune erreur',
      Y.msgs.filter((m) => m.remplace === true).length === 2 && !Y.ferme && A.room().players.length === 2 && Y.erreurs().length === 0);
    Y.ws.close(); X2.ws.close();
    await A.suite((m) => m.type === 'room' && m.players.length === 1);

    // ── 7. une partie se joue normalement, présence active
    const H = client(); tous.push(H);
    await H.open;
    join(H, 'Hugo', r.code);
    await A.suite((m) => m.type === 'room' && m.players.length === 2);
    A.send({ action: 'start', rounds: 1, difficulty: 'impossible', game: 'color' });
    await A.wait((m) => m.type === 'phase' && m.phase === 'play', 5000);
    for (const X of [A, H]) X.send({ action: 'submit', type: 'color', data: { h: 10, s: 50, l: 50 } });
    const rev = await H.wait((m) => m.type === 'phase' && m.phase === 'reveal', 5000);
    A.send({ action: 'next' });
    const fin = await H.wait((m) => m.type === 'phase' && m.phase === 'end', 5000);
    t('une partie complète se joue, présence active (reveal à 2, podium à 2)', !!rev && rev.results.length === 2 && !!fin && fin.podium.length === 2);
    t('aucune erreur côté joueurs pendant la partie', A.erreurs().length === 0 && H.erreurs().length === 0, JSON.stringify(A.erreurs().concat(H.erreurs())));
  } catch (e) {
    t('EXCEPTION', false, e.stack || e.message);
  } finally {
    for (const c of tous) { try { c.ws.terminate(); } catch (_) {} }
    srv.kill();
  }

  // ── 8. le dernier recours SEUL : ping natif quasi coupé (60 s), réseau mort.
  // close(4000) ne peut pas aboutir (rien ne passe) : seul terminate() libère la place.
  const PORT2 = PORT + 1;
  const srv2 = spawn(process.execPath, ['src/server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT2), PRESENCE_QUIET: '1', ...ENV, NATIVE_PING_MS: '60000' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await new Promise((res, rej) => { const s = new WebSocket(`ws://127.0.0.1:${PORT2}`); s.on('open', () => { s.close(); res(); }); s.on('error', rej); }); break; } catch (_) { await sleep(100); } }
    const A2 = new WebSocket(`ws://127.0.0.1:${PORT2}`), F2 = new WebSocket(`ws://127.0.0.1:${PORT2}`);
    const msgsA = [];
    const repondre = (ws, liste) => ws.on('message', (raw) => { const m = JSON.parse(raw); if (liste) liste.push(m); if (m.type === 'presence') ws.send(JSON.stringify({ action: 'presence', n: m.n })); });
    repondre(A2, msgsA); repondre(F2);
    await Promise.all([A2, F2].map((w) => new Promise((r) => w.on('open', r))));
    A2.send(JSON.stringify({ action: 'join', name: 'Alice', avatar: { kind: 'emoji', emoji: '🎯' } }));
    let room = null; for (let i = 0; i < 100 && !room; i++) { room = msgsA.find((m) => m.type === 'room'); await sleep(20); }
    F2.send(JSON.stringify({ action: 'join', name: 'Coupé', code: room.code, avatar: { kind: 'emoji', emoji: '🎯' } }));
    for (let i = 0; i < 100 && !msgsA.some((m) => m.type === 'room' && m.players.length === 2); i++) await sleep(20);
    await sleep(300);
    const avant = msgsA.length;
    F2._socket.pause();
    const t3 = Date.now();
    let vu = null; for (let i = 0; i < 200 && !vu; i++) { vu = msgsA.slice(avant).find((m) => m.type === 'room' && m.players.length === 1); await sleep(20); }
    const d3 = Date.now() - t3;
    t(`réseau mort, ping natif hors jeu : close() n'aboutit pas, terminate() libère la place en ${d3} ms`,
      !!vu && d3 >= 300 && d3 < 700 + 200 + 300 + 600, `${d3} ms (ABSENCE 700 + KILL 300)`);
    A2.terminate(); F2.terminate();
  } catch (e) {
    t('EXCEPTION (bloc 8)', false, e.stack || e.message);
  } finally {
    srv2.kill();
  }
  console.log(`\n${ko ? `${ko} test(s) échoué(s)` : 'TOUS LES TESTS PASSENT'} — ${n} vérifications`);
  process.exit(ko ? 1 : 0);
})();
