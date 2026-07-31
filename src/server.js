// Serveur arbitre du Party Game de Précision. Node + ws, rien d'autre.
// TOUT LE MONDE joue en même temps. Le serveur tient les timers des phases
// (c'est ça, la difficulté) et le MJ décide quand enchaîner entre deux rounds.
//   lobby → memorize → play → reveal → (round suivant) → … → end
//
// SÉCURITÉ (zéro confiance) : la cible n'est envoyée QU'EN `memorize` (et pour
// `time`, c'est juste la consigne). Pendant `play`, le serveur n'envoie rien :
// impossible de relire la réponse. Les valeurs de tout le monde sortent en
// `reveal` seulement. Pour `time`, le temps annoncé est recoupé à l'horloge
// serveur (le client ne peut pas mentir sur son chrono).
//
// Protocole (JSON) :
//   client → { action:'join', name, code?, avatar? }
//   client → { action:'start', rounds?, difficulty?, game? }   host, lobby
//   client → { action:'next' }                                 host : round suivant
//   client → { action:'submit', type, data }                   pendant `play`
//   serveur → { type:'room', code, phase, you, players[] }
//   serveur → { type:'phase', phase:'memorize', game, target, ms, round, of, difficulty, isHost }
//   serveur → { type:'phase', phase:'play', game, ms, round, of, isHost }
//   serveur → { type:'ready', ids[], of }
//   serveur → { type:'phase', phase:'reveal', game, target, results[], scores[], round, of, isHost }
//   serveur → { type:'phase', phase:'end', podium[] }
//   serveur → { type:'error', message }

const http = require('http');
const { WebSocketServer } = require('ws');
const engine = require('./engine-precision');

const CONFIG = {
  MIN_PLAYERS: 1, MAX_PLAYERS: 12,
  DEFAULT_ROUNDS: 5, MAX_ROUNDS: 20,
  LEAD_MS: +process.env.LEAD_MS || 700,   // petit délai avant `play` (le temps que l'UI se remette à zéro)
  TIME_TOL_MS: 400,                        // écart toléré entre le chrono client et l'horloge serveur
};

const rooms = new Map();
let nextId = 1;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, service: 'precision-server', rooms: rooms.size, difficulties: Object.keys(engine.DIFFICULTY), games: engine.TYPES }, null, 2));
});
const wss = new WebSocketServer({ server });

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() { let c; do { c = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join(''); } while (rooms.has(c)); return c; }

function createRoom(code) {
  return {
    code, phase: 'lobby', players: new Map(), hostId: null,
    rounds: CONFIG.DEFAULT_ROUNDS, roundNo: 0,
    difficulty: engine.DEFAULT_DIFFICULTY, forcedGame: null,
    r: null,
  };
}

// ---------------------------------------------------------------- transport
wss.on('connection', (ws) => {
  ws.id = 'p' + nextId++;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return sendError(ws, 'JSON invalide'); }
    if (m.action === 'join') onJoin(ws, m);
    else if (m.action === 'start') onStart(ws, m);
    else if (m.action === 'next') onNext(ws);
    else if (m.action === 'submit') onSubmit(ws, m);
    else sendError(ws, 'action inconnue');
  });
  ws.on('close', () => onLeave(ws));
});

// ---------------------------------------------------------------- lobby
function onJoin(ws, { name, code, avatar }) {
  if (ws.room) return sendError(ws, 'déjà dans une room');
  const cleanName = String(name || '').trim().slice(0, 16);
  if (!cleanName) return sendError(ws, 'il faut un pseudo');
  let room;
  if (code === undefined) { room = createRoom(newCode()); rooms.set(room.code, room); room.hostId = ws.id; }
  else {
    room = rooms.get(String(code).trim().toUpperCase());
    if (!room) return sendError(ws, 'room introuvable');
    if (room.phase !== 'lobby') return sendError(ws, 'partie en cours');
    if (room.players.size >= CONFIG.MAX_PLAYERS) return sendError(ws, 'room pleine');
  }
  ws.room = room.code;
  room.players.set(ws.id, { id: ws.id, name: cleanName, avatar: String(avatar || '🙂').slice(0, 4), ws, score: 0 });
  sendRoomState(room);
}

function onStart(ws, msg) {
  const room = rooms.get(ws.room);
  if (!room) return sendError(ws, 'aucune room');
  if (ws.id !== room.hostId) return sendError(ws, 'seul le MJ peut lancer');
  if (room.phase !== 'lobby') return sendError(ws, 'partie déjà lancée');
  if (room.players.size < CONFIG.MIN_PLAYERS) return sendError(ws, 'il faut au moins un joueur');
  for (const p of room.players.values()) p.score = 0;
  const asked = Math.trunc(+((msg && msg.rounds)) || 0);
  room.rounds = asked > 0 ? Math.min(CONFIG.MAX_ROUNDS, asked) : CONFIG.DEFAULT_ROUNDS;
  room.difficulty = engine.DIFFICULTY[String(msg && msg.difficulty).toLowerCase()] ? String(msg.difficulty).toLowerCase() : engine.DEFAULT_DIFFICULTY;
  room.forcedGame = engine.TYPES.includes(msg && msg.game) ? msg.game : null;
  room.roundNo = 0;
  nextRound(room);
}

// Le MJ enchaîne (depuis `reveal`).
function onNext(ws) {
  const room = rooms.get(ws.room);
  if (!room) return sendError(ws, 'aucune room');
  if (ws.id !== room.hostId) return sendError(ws, 'seul le MJ pilote');
  if (room.phase !== 'reveal') return sendError(ws, 'rien à passer ici');
  nextRound(room);
}

// ---------------------------------------------------------------- boucle
function nextRound(room) {
  clearRoundTimer(room);
  engine.purge(room.r);
  if (room.roundNo >= room.rounds) return endGame(room);
  room.roundNo++;

  const type = engine.pickType(Math.random, room.forcedGame);
  const target = engine.generateTarget(type);
  room.r = engine.createRound(type, target, room.difficulty);
  const t = engine.timings(room.r);

  // --- memorize : on montre la cible ---
  room.r.phase = 'memorize'; room.phase = 'memorize';
  broadcastPhase(room, 'memorize', {
    game: type, target: engine.memorizePayload(room.r),
    ms: t.memorizeMs, difficulty: room.difficulty,
  });
  console.log(`[round ${room.roundNo}/${room.rounds}] ${type} (${room.difficulty}) — memorize ${t.memorizeMs}ms`);

  room.r.timer = setTimeout(() => startPlay(room, t), t.memorizeMs + CONFIG.LEAD_MS);
}

// --- play : plus AUCUNE cible envoyée, les UI repartent de zéro ---
function startPlay(room, t) {
  const r = room.r;
  if (!r) return;
  r.phase = 'play'; room.phase = 'play';
  r.startedAt = Date.now();
  // pour `shape`, le front doit savoir QUELLE forme dessiner : le type de forme
  // n'est pas le secret (on l'a vu en mémorisation), seule sa pose l'est.
  const extra = { game: r.type, ms: t.playMs };
  if (r.type === 'shape') { extra.kind = r.target.kind; extra.sym = r.target.sym; }
  if (r.type === 'typing') extra.words = r.target.words;   // les mots ne sont pas un secret
  broadcastPhase(room, 'play', extra);
  console.log(`[round ${room.roundNo}] play ${t.playMs}ms`);
  clearRoundTimer(room);

  // REFLEX : c'est le SERVEUR qui donne le top vert, au moment qu'il a tiré.
  // Le client ne connaît jamais le délai à l'avance → impossible de s'armer.
  if (r.type === 'reflex') {
    r.greenTimer = setTimeout(() => {
      if (!room.r || room.r !== r || r.phase !== 'play') return;
      r.greenAt = Date.now();
      roomBroadcast(room, { type: 'green' });
      console.log(`[round ${room.roundNo}] TOP vert après ${r.target.green_after_ms}ms`);
    }, r.target.green_after_ms);
  }

  r.timer = setTimeout(() => reveal(room), t.playMs);
}

function onSubmit(ws, m) {
  const room = rooms.get(ws.room);
  if (!room || !room.r) return sendError(ws, 'aucun round en cours');
  const r = room.r;
  // le moteur vérifie la phase ET la forme des données → erreur explicite au client
  const v = engine.validateSubmission(r, m.type, m.data);
  if (!v.ok) return sendError(ws, v.error);

  let data = v.data;
  // REFLEX : le serveur connaît l'instant du top vert. On recoupe le temps
  // annoncé ; et un clic AVANT le top est un faux départ, quoi qu'en dise le client.
  if (r.type === 'reflex') {
    if (!r.greenAt) data = { ms: null, early: true };          // pas encore vert = faux départ
    else if (!data.early) {
      const serverMs = Date.now() - r.greenAt;
      if (Math.abs(data.ms - serverMs) > CONFIG.TIME_TOL_MS) {
        console.log(`[submit] ${ws.id} reflex recalé : client=${data.ms} serveur=${serverMs}`);
        data = { ms: serverMs, early: false };
      }
    }
  }
  // TIME : on recoupe le chrono annoncé avec l'horloge serveur (anti-triche).
  if (r.type === 'time') {
    const serverMs = Date.now() - r.startedAt;
    if (Math.abs(data.ms - serverMs) > CONFIG.TIME_TOL_MS) {
      console.log(`[submit] ${ws.id} time recalé : client=${data.ms} serveur=${serverMs}`);
      data = { ms: serverMs };
    }
  }
  engine.record(r, ws.id, data, Date.now() - r.startedAt);
  roomBroadcast(room, { type: 'ready', ids: [...r.submissions.keys()], of: room.players.size });
  if (engine.allSubmitted(r, [...room.players.keys()])) reveal(room);   // tout le monde a validé
}

// --- reveal : on révèle la cible + les valeurs exactes de chacun ---
function reveal(room) {
  const r = room.r;
  if (!r || r.phase === 'reveal') return;
  clearRoundTimer(room);
  r.phase = 'reveal'; room.phase = 'reveal';
  const out = engine.computeResults(r, [...room.players.keys()]);
  const results = out.results.map((row) => {
    const p = room.players.get(row.id);
    if (p) p.score += row.points;
    return { ...row, name: p ? p.name : '?', avatar: p ? p.avatar : '🙂' };
  });
  broadcastPhase(room, 'reveal', { game: r.type, target: out.target, results, scores: scoreboard(room) });
  console.log(`[round ${room.roundNo}] reveal — ${results.length} joueur(s)`);
}

function endGame(room) {
  clearRoundTimer(room);
  engine.purge(room.r); room.r = null;
  room.phase = 'lobby';
  roomBroadcast(room, { type: 'phase', phase: 'end', podium: scoreboard(room) });
  sendRoomState(room);
}

// ---------------------------------------------------------------- départs
function onLeave(ws) {
  const room = rooms.get(ws.room);
  if (!room) return;
  room.players.delete(ws.id);
  if (room.r) room.r.submissions.delete(ws.id);
  if (room.players.size === 0) { clearRoundTimer(room); rooms.delete(room.code); return; }
  if (ws.id === room.hostId) room.hostId = room.players.keys().next().value;
  sendRoomState(room);
  // s'il ne manquait plus que lui pour valider, on révèle tout de suite
  if (room.r && room.phase === 'play' && engine.allSubmitted(room.r, [...room.players.keys()])) reveal(room);
}

// ---------------------------------------------------------------- helpers
function clearRoundTimer(room) {
  if (!room.r) return;
  if (room.r.timer) { clearTimeout(room.r.timer); room.r.timer = null; }
  if (room.r.greenTimer) { clearTimeout(room.r.greenTimer); room.r.greenTimer = null; }
}
function scoreboard(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score })).sort((a, b) => b.score - a.score);
}

function broadcastPhase(room, phase, extra) {
  const base = { type: 'phase', phase, round: room.roundNo, of: room.rounds, difficulty: room.difficulty, ...extra };
  for (const p of room.players.values()) sendJson(p.ws, { ...base, isHost: p.id === room.hostId });
}

function sendRoomState(room) {
  const players = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, host: p.id === room.hostId }));
  for (const p of room.players.values()) sendJson(p.ws, { type: 'room', code: room.code, phase: room.phase, you: p.id, players });
}
function roomBroadcast(room, obj) { for (const p of room.players.values()) sendJson(p.ws, obj); }
function sendJson(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
const sendError = (ws, message) => sendJson(ws, { type: 'error', message });

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`precision-server à l'écoute sur :${PORT}`));
