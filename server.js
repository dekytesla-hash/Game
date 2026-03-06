// Simple Socket.IO arena server:
// - Matchmaking queue (pairs 2 players)
// - Creates a room per match
// - Requests inventory snapshots
// - Rolls 3 dice per player (server-authoritative)
// - Declares winner and sends loot-transfer payload
// - Disconnect safety: opponent auto-wins

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const BASE_PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const app = express();
app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'Game.html')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

const queued = new Set();          // socket.id
const queue = [];                 // FIFO of socket.id
const socketToRoom = new Map();   // socket.id -> roomId
const matches = new Map();        // roomId -> match

function randDie() {
  return 1 + Math.floor(Math.random() * 6);
}

function removeFromQueue(id) {
  if (!queued.has(id)) return;
  queued.delete(id);
  const idx = queue.indexOf(id);
  if (idx !== -1) queue.splice(idx, 1);
}

function safeLootFromState(state) {
  // Expected: { hero:{gold}, bag:[...], equipped:{...} }
  const hero = state && state.hero ? state.hero : {};
  const gold = Number(hero.gold || 0) || 0;
  const bag = Array.isArray(state?.bag) ? state.bag : [];
  const equipped = state && typeof state.equipped === 'object' && state.equipped ? state.equipped : {};
  const items = [];
  for (const it of bag) if (it) items.push(it);
  for (const it of Object.values(equipped)) if (it) items.push(it);
  return { gold, items };
}

function cleanupMatch(roomId) {
  const m = matches.get(roomId);
  if (!m) return;
  for (const t of m.timeouts) clearTimeout(t);
  matches.delete(roomId);
  if (m.a) socketToRoom.delete(m.a);
  if (m.b) socketToRoom.delete(m.b);
}

function startRollSequence(roomId) {
  const m = matches.get(roomId);
  if (!m || m.started) return;
  m.started = true;

  const a = m.a, b = m.b;
  const rollsA = [randDie(), randDie(), randDie()];
  const rollsB = [randDie(), randDie(), randDie()];
  const sumA = rollsA.reduce((s, x) => s + x, 0);
  const sumB = rollsB.reduce((s, x) => s + x, 0);

  // Emit rolls one-by-one so clients can animate.
  // Timing is intentionally a bit slower than the client animation loop.
  const STEP_MS = 1150;
  let step = 0;
  for (let i = 0; i < 3; i++) {
    m.timeouts.push(setTimeout(() => {
      io.to(roomId).emit('arena:roll', { by: a, value: rollsA[i], rollIndex: i });
    }, step * STEP_MS));
    step++;
    m.timeouts.push(setTimeout(() => {
      io.to(roomId).emit('arena:roll', { by: b, value: rollsB[i], rollIndex: i });
    }, step * STEP_MS));
    step++;
  }

  m.timeouts.push(setTimeout(() => {
    // Winner calculation
    const winnerId = sumA === sumB ? (Math.random() < 0.5 ? a : b) : (sumA > sumB ? a : b);
    const loserId = winnerId === a ? b : a;

    const loserState = m.states.get(loserId);
    const transfer = safeLootFromState(loserState);

    io.to(roomId).emit('arena:result', {
      roomId,
      winnerId,
      totals: { [a]: sumA, [b]: sumB },
      transfer,
      reason: sumA === sumB ? 'tie_break' : 'normal'
    });

    cleanupMatch(roomId);
  }, step * STEP_MS + 450));
}

io.on('connection', (socket) => {
  socket.on('arena:queue_join', () => {
    if (queued.has(socket.id)) {
      socket.emit('arena:error', { code: 'ALREADY_QUEUED', message: 'Already queued' });
      return;
    }
    if (socketToRoom.has(socket.id)) {
      socket.emit('arena:error', { code: 'IN_MATCH', message: 'Already in match' });
      return;
    }

    queued.add(socket.id);
    queue.push(socket.id);
    socket.emit('arena:queued');

    // Try to match immediately.
    while (queue.length >= 2) {
      const aId = queue.shift();
      const bId = queue.shift();
      if (!aId || !bId) break;
      if (aId === bId) continue;

      const aSock = io.sockets.sockets.get(aId);
      const bSock = io.sockets.sockets.get(bId);
      if (!aSock || !bSock) {
        if (aSock) { queued.add(aId); queue.unshift(aId); }
        if (bSock) { queued.add(bId); queue.unshift(bId); }
        break;
      }

      queued.delete(aId);
      queued.delete(bId);

      const roomId = `arena_${aId.slice(0, 6)}_${bId.slice(0, 6)}_${Date.now()}`;
      aSock.join(roomId);
      bSock.join(roomId);
      socketToRoom.set(aId, roomId);
      socketToRoom.set(bId, roomId);

      matches.set(roomId, {
        roomId,
        a: aId,
        b: bId,
        started: false,
        states: new Map(), // socket.id -> snapshot
        timeouts: []
      });

      aSock.emit('arena:matched', { roomId, opponentId: bId });
      bSock.emit('arena:matched', { roomId, opponentId: aId });

      // Ask both clients for their current inventory/gold snapshot.
      aSock.emit('arena:request_state');
      bSock.emit('arena:request_state');

      // If someone never answers, opponent wins after timeout (if possible).
      const m = matches.get(roomId);
      m.timeouts.push(setTimeout(() => {
        const mm = matches.get(roomId);
        if (!mm) return;
        const hasA = mm.states.has(aId);
        const hasB = mm.states.has(bId);
        if (hasA && hasB) return;

        const winnerId = hasA ? aId : (hasB ? bId : null);
        const loserId = winnerId === aId ? bId : aId;
        if (!winnerId) {
          cleanupMatch(roomId);
          return;
        }
        const transfer = safeLootFromState(mm.states.get(loserId));
        io.to(roomId).emit('arena:result', {
          roomId,
          winnerId,
          totals: { [aId]: 0, [bId]: 0 },
          transfer,
          reason: 'state_timeout'
        });
        cleanupMatch(roomId);
      }, 9000));

      break; // only one match attempt per join tick
    }
  });

  socket.on('arena:queue_leave', () => {
    removeFromQueue(socket.id);
    socket.emit('arena:queue_left');
  });

  socket.on('arena:state', (state) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const m = matches.get(roomId);
    if (!m) return;
    if (typeof state !== 'object' || !state || state.error) {
      // Keep it; timeout logic can resolve.
      return;
    }
    m.states.set(socket.id, state);
    if (m.states.has(m.a) && m.states.has(m.b)) {
      startRollSequence(roomId);
    }
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);

    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const m = matches.get(roomId);
    if (!m) {
      socketToRoom.delete(socket.id);
      return;
    }

    const opponentId = m.a === socket.id ? m.b : m.a;
    const transfer = safeLootFromState(m.states.get(socket.id));

    // Tell opponent immediately.
    io.to(opponentId).emit('arena:opponent_left', { message: 'Gegner hat verlassen — Auto-Sieg.' });
    io.to(roomId).emit('arena:result', {
      roomId,
      winnerId: opponentId,
      totals: { [m.a]: 0, [m.b]: 0 },
      transfer,
      reason: 'opponent_disconnected'
    });

    cleanupMatch(roomId);
  });
});

function listenWithFallback(port, remainingTries) {
  const onError = (err) => {
    if (err && err.code === 'EADDRINUSE' && remainingTries > 0) {
      const next = port + 1;
      console.warn(`Port ${port} is already in use. Trying ${next}...`);
      // Remove listener before retry to avoid piling up handlers.
      server.off('error', onError);
      setTimeout(() => listenWithFallback(next, remainingTries - 1), 150);
      return;
    }

    console.error('Server failed to start:', err);
    console.error('Tip: stop the process using the port, or start with a different port:');
    console.error('  PORT=3001 npm start');
    process.exit(1);
  };

  server.on('error', onError);
  server.listen(port, () => {
    server.off('error', onError);
    console.log(`Arena server running at http://localhost:${port}`);
  });
}

listenWithFallback(BASE_PORT, 20);

