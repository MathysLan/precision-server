# engine-precision.js — Party Game de Précision

Moteur PUR (règles + barèmes + scoring) du party game inspiré de dialed.gg.
Aucun socket, aucun `setTimeout` ici : c'est `server.js` qui tient le transport
`ws` et les timers de phase, en lisant les durées dans `DIFFICULTY`.

## Tester
```
node test-engine.js      # 60 assertions, purement synchrone
```

## Boucle d'un round (pilotée par server.js)
```
generate → memorize → play → reveal → (round suivant)
```

## Câblage côté server.js (résumé)

```js
const engine = require('./engine-precision');

function nextRound(room) {
  engine.purge(room.r);
  const type   = engine.pickType(Math.random, room.forcedType);   // ou choix du MJ
  const target = engine.generateTarget(type);
  room.r = engine.createRound(type, target, room.difficulty);
  const t = engine.timings(room.r);

  // memorize : on envoie la cible (pour `time`, juste la consigne)
  room.r.phase = 'memorize';
  broadcast(room, { type:'phase', phase:'memorize', game:type,
                    target: engine.memorizePayload(room.r), ms: t.memorizeMs });

  room.r.timer = setTimeout(() => {
    // play : AUCUNE cible envoyée — les clients repartent de zéro
    room.r.phase = 'play';
    room.r.startedAt = Date.now();
    broadcast(room, { type:'phase', phase:'play', game:type, ms: t.playMs });
    room.r.timer = setTimeout(() => reveal(room), t.playMs);
  }, t.memorizeMs);
}

function onSubmit(ws, m) {                       // { action:'submit', type, data }
  const r = room.r;
  const v = engine.validateSubmission(r, m.type, m.data);
  if (!v.ok) return sendError(ws, v.error);
  engine.record(r, ws.id, v.data, Date.now() - r.startedAt);
  broadcast(room, { type:'ready', ids:[...r.submissions.keys()] });
  if (engine.allSubmitted(r, [...room.players.keys()])) reveal(room);   // tout le monde a validé
}

function reveal(room) {
  clearTimeout(room.r.timer);
  room.r.phase = 'reveal';
  const out = engine.computeResults(room.r, [...room.players.keys()]);
  for (const row of out.results) room.players.get(row.id).score += row.points;
  broadcast(room, { type:'phase', phase:'reveal', ...out, scores: scoreboard(room) });
}
```

## Ce que renvoie `computeResults`

```js
{
  type: 'color', difficulty: 'moyen',
  target: { h: 200, s: 80, l: 45 },            // révélée ICI seulement
  results: [
    { id:'p1', submitted:true, accuracy:92.4, points:92,
      data:{ h:205, s:78, l:44 },               // valeur exacte → superposition front
      parts:{ h:87.5, s:92, l:96 },             // détail par composante
      deltas:{ h:5, s:2, l:1 } },               // écarts bruts
    { id:'p2', submitted:false, accuracy:0, points:0, data:null },
  ],
}
```

## Réglages
Tout est dans `DIFFICULTY` (durées + tolérances par épreuve). La tolérance est
l'écart qui donne 0 % ; en dessous, la note est linéaire jusqu'à 100 %.
# precision-server
