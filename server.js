const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = 3000;

const games = new Map();

function createGameId() {
  return uuidv4().slice(0, 6).toUpperCase();
}

function indexToLabel(index) {
  const x = index % 7;
  const y = Math.floor(index / 7);
  return String.fromCharCode(65 + x) + (7 - y);
}

function defaultBoard() {
  const cells = Array(49).fill(null);
  [[0, 0], [1, 0], [2, 1], [3, 2], [4, 1], [5, 0], [6, 0]].forEach(([x, y]) =>
    cells[y * 7 + x] = { type: 'stack', count: 1, player: 'red' }
  );
  cells[0 * 7 + 3] = { type: 'guard', player: 'red' };
  [[0, 6], [1, 6], [2, 5], [3, 4], [4, 5], [5, 6], [6, 6]].forEach(([x, y]) =>
    cells[y * 7 + x] = { type: 'stack', count: 1, player: 'blue' }
  );
  cells[6 * 7 + 3] = { type: 'guard', player: 'blue' };
  return cells;
}

function createGame(playerName, ws) {
  const id = createGameId();
  const game = {
    id,
    board: defaultBoard(),
    players: [{ name: playerName, color: 'blue', ws }],
    turn: 'blue',
    moveLog: []
  };
  games.set(id, game);
  return game;
}

function broadcast(game, data) {
  console.log('[BROADCASTING]', data);
  for (const player of game.players) {
    player.ws.send(JSON.stringify(data));
  }
}

wss.on('connection', ws => {
  ws.on('message', msg => {
    const message = JSON.parse(msg);
    console.log('[RECEIVED]', message);
    const { type, gameId, name, moveIndex, toIndex } = message;

    if (type === 'create') {
      const game = createGame(name, ws);
      ws.send(JSON.stringify({ type: 'created', gameId: game.id, color: 'blue' }));
      return;
    }

    if (type === 'join') {
      const game = games.get(gameId);
      if (!game || game.players.length >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Game full or not found.' }));
        return;
      }
      game.players.push({ name, color: 'red', ws });
      broadcast(game, {
        type: 'start',
        board: game.board,
        players: game.players.map(p => ({ name: p.name, color: p.color })),
        turn: game.turn
      });
      return;
    }

    if (type === 'move') {
      const game = games.get(gameId);
      if (!game) return;

      const playerObj = game.players.find(p => p.ws === ws);
      if (!playerObj || game.turn !== playerObj.color) return;

      const board = game.board;
      const from = board[moveIndex];
      const to = board[toIndex];

      if (!from || from.player !== playerObj.color) return;

      const dx = Math.abs((toIndex % 7) - (moveIndex % 7));
      const dy = Math.abs(Math.floor(toIndex / 7) - Math.floor(moveIndex / 7));
      const distance = Math.max(dx, dy);
      const dirX = Math.sign((toIndex % 7) - (moveIndex % 7));
      const dirY = Math.sign(Math.floor(toIndex / 7) - Math.floor(moveIndex / 7));

      let valid = false;
      let amount = 1;

      if (from.type === 'guard' && dx + dy === 1) {
        valid = !to || to.player !== from.player;
      } else if (from.type === 'stack' && (dx === 0 || dy === 0) && distance <= from.count) {
        let pathClear = true;
        for (let i = 1; i < distance; i++) {
          const x = (moveIndex % 7) + dirX * i;
          const y = Math.floor(moveIndex / 7) + dirY * i;
          if (board[y * 7 + x]) {
            pathClear = false;
            break;
          }
        }

        if (pathClear) {
          if (!to) valid = true;
          else if (to.player === from.player) valid = true;
          else if (to.type === 'stack' && from.count >= to.count) valid = true;
          else if (to.type === 'guard') valid = true;

          amount = distance;
        }
      }

      if (!valid) return;

      // 🛠️ FIX: Explicitly update source and target
      if (from.type === 'stack') {
        let newStack = { type: 'stack', count: amount, player: from.player };
        if (to && to.player === from.player) {
          newStack.count += to.count;
        }

        board[toIndex] = newStack;

        if (amount === from.count) {
          board[moveIndex] = null;
        } else {
          board[moveIndex] = { type: 'stack', count: from.count - amount, player: from.player };
        }
      } else if (from.type === 'guard') {
        board[toIndex] = { ...from };
        board[moveIndex] = null;
      }

      const moveStr = `${indexToLabel(moveIndex)}-${indexToLabel(toIndex)}-${amount}`;
      game.moveLog.push(moveStr);
      game.turn = game.turn === 'blue' ? 'red' : 'blue';

      broadcast(game, {
        type: 'update',
        board: JSON.parse(JSON.stringify(board)), // Deep copy!
        turn: game.turn,
        lastMove: moveStr
      });
    }
  });

  ws.on('close', () => {
    for (const [id, game] of games.entries()) {
      game.players = game.players.filter(p => p.ws !== ws);
      if (game.players.length === 0) games.delete(id);
    }
  });
});

app.use(express.static('public'));
server.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));

