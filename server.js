// ChromoQuake - WebSocket relay server
// Run: node server.js
// Requires: npm install ws

const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Serve the HTML file over HTTP so players just visit the URL
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const file = path.join(__dirname, 'chromoquake.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('chromoquake.html not found next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server: httpServer });

// Game state
const players = new Map(); // id -> { ws, state }
let nextId = 1;
const KILLS_TO_WIN = 20;
const scores = new Map(); // id -> kills

let gameOver = false;

function broadcast(data, excludeId = null) {
  const msg = JSON.stringify(data);
  for (const [id, p] of players) {
    if (id !== excludeId && p.ws.readyState === 1) {
      p.ws.send(msg);
    }
  }
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  for (const [, p] of players) {
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
}

function getScoreboard() {
  const board = [];
  for (const [id, kills] of scores) {
    board.push({ id, kills, name: players.get(id)?.state?.name || id });
  }
  return board.sort((a, b) => b.kills - a.kills);
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  players.set(id, { ws, state: { x: 1.5, y: 1.5, a: 0, name: 'Player ' + id } });
  scores.set(id, 0);

  console.log(`[+] Player ${id} connected (${players.size} total)`);

  // Send this player their ID and current game state
  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    players: [...players.entries()]
      .filter(([pid]) => pid !== id)
      .map(([pid, p]) => ({ id: pid, ...p.state })),
    scores: getScoreboard(),
    gameOver
  }));

  // Tell everyone else about the new player
  broadcast({ type: 'join', id, ...players.get(id).state }, id);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'state') {
      // Player broadcasting their position/angle/firing state
      const p = players.get(id);
      if (!p) return;
      p.state = { ...p.state, ...msg, type: undefined };
      // Relay to all other players
      broadcast({ type: 'state', id, ...msg }, id);
    }

    if (msg.type === 'hit') {
      // Player reports they hit someone
      const targetId = msg.targetId;
      if (!players.has(targetId) || gameOver) return;
      const kills = (scores.get(id) || 0) + 1;
      scores.set(id, kills);
      const board = getScoreboard();
      console.log(`[!] Player ${id} hit ${targetId} (${kills} kills)`);
      broadcastAll({ type: 'hit', shooterId: id, targetId, scores: board });
      if (kills >= KILLS_TO_WIN) {
        gameOver = true;
        broadcastAll({ type: 'gameover', winnerId: id, winnerName: players.get(id)?.state?.name || id, scores: board });
        console.log(`[WIN] Player ${id} wins!`);
        // Reset after 10s
        setTimeout(() => {
          gameOver = false;
          for (const [pid] of scores) scores.set(pid, 0);
          broadcastAll({ type: 'reset', scores: getScoreboard() });
        }, 10000);
      }
    }

    if (msg.type === 'name') {
      const p = players.get(id);
      if (p) { p.state.name = String(msg.name).slice(0, 20); }
      broadcast({ type: 'rename', id, name: p.state.name }, id);
    }
  });

  ws.on('close', () => {
    players.delete(id);
    scores.delete(id);
    console.log(`[-] Player ${id} disconnected (${players.size} total)`);
    broadcast({ type: 'leave', id });
  });

  ws.on('error', () => ws.terminate());
});

httpServer.listen(PORT, () => {
  console.log(`\nChromoQuake server running!`);
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`\nPlayers visit that URL to play.\n`);
});
