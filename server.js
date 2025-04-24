const express = require('express');
const http = require('http');
const {WebSocketServer} = require('ws');
const {v4: uuidv4} = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({server});
const PORT = process.env.PORT || 3000;

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
        cells[y * 7 + x] = {type: 'stack', count: 1, player: 'red'}
    );
    cells[0 * 7 + 3] = {type: 'guard', player: 'red'};
    [[0, 6], [1, 6], [2, 5], [3, 4], [4, 5], [5, 6], [6, 6]].forEach(([x, y]) =>
        cells[y * 7 + x] = {type: 'stack', count: 1, player: 'blue'}
    );
    cells[6 * 7 + 3] = {type: 'guard', player: 'blue'};
    return cells;
}

function createGame(playerName, ws) {
    const id = createGameId();
    const game = {
        id,
        board: defaultBoard(),
        players: [{name: playerName, color: 'blue', ws}],
        turn: 'blue',
        moveLog: [],
        history: [],
        winner: null
    };
    games.set(id, game);
    return game;
}

function broadcast(game, data) {
    game.players.forEach(p => p.ws.send(JSON.stringify(data)));
}

wss.on('connection', ws => {
    ws.on('message', msg => {
        const message = JSON.parse(msg);
        const {type, gameId, name, moveIndex, toIndex} = message;

        if (type === 'create') {
            const game = createGame(name, ws);
            ws.send(JSON.stringify({type: 'created', gameId: game.id, color: 'blue'}));
            return;
        }

        if (type === 'join') {
            const game = games.get(gameId);
            if (!game || game.players.length >= 2) {
                ws.send(JSON.stringify({type: 'error', message: 'Game full or not found.'}));
                return;
            }
            game.players.push({name, color: 'red', ws});
            broadcast(game, {
                type: 'start',
                board: game.board,
                players: game.players.map(p => ({name: p.name, color: p.color})),
                turn: game.turn
            });
            return;
        }

        if (type === 'move') {
            const game = games.get(gameId);
            if (!game || game.winner) return;

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
                    if (!to || to.player === from.player || (to.type === 'stack' && from.count >= to.count) || to.type === 'guard') {
                        valid = true;
                        amount = distance;
                    }
                }
            }

            if (!valid) return;

            // Save board to history
            game.history.push(JSON.parse(JSON.stringify(game.board)));

            if (from.type === 'stack') {
                const moving = {type: 'stack', count: amount, player: from.player};
                if (to && to.player === from.player) moving.count += to.count;
                board[toIndex] = moving;
                if (amount === from.count) {
                    board[moveIndex] = null;
                } else {
                    board[moveIndex] = {type: 'stack', count: from.count - amount, player: from.player};
                }
            } else if (from.type === 'guard') {
                board[toIndex] = from;
                board[moveIndex] = null;
            }

            const moveStr = `${indexToLabel(moveIndex)}-${indexToLabel(toIndex)}-${amount}`;
            game.moveLog.push(moveStr);

            // ✅ Win check
            const blueHome = 6 * 7 + 3;
            const redHome = 0 * 7 + 3;

            const redGuardAlive = board.some(c => c?.type === 'guard' && c.player === 'red');
            const blueGuardAlive = board.some(c => c?.type === 'guard' && c.player === 'blue');
            const redGuardInBlueHome = board[blueHome]?.type === 'guard' && board[blueHome].player === 'red';
            const blueGuardInRedHome = board[redHome]?.type === 'guard' && board[redHome].player === 'blue';

            const winner = (!redGuardAlive || blueGuardInRedHome) ? 'blue' : (!blueGuardAlive || redGuardInBlueHome) ? 'red' : null;

            if (winner) {
                game.winner = winner;
                broadcast(game, {
                    type: 'winner',
                    winner,
                    board: JSON.parse(JSON.stringify(board))
                });
                return;
            }

            game.turn = game.turn === 'blue' ? 'red' : 'blue';

            broadcast(game, {
                type: 'update',
                board: JSON.parse(JSON.stringify(board)),
                turn: game.turn,
                lastMove: moveStr
            });
        }

        if (type === 'undoRequest') {
            const game = games.get(gameId);
            if (!game || game.history.length === 0) return;
            const other = game.players.find(p => p.ws !== ws);
            if (other) {
                other.ws.send(JSON.stringify({type: 'undoRequest'}));
            }
        }

        if (type === 'newGameRequest') {
            const game = games.get(gameId);
            if (!game) return;
            const other = game.players.find(p => p.ws !== ws);
            if (other) {
                other.ws.send(JSON.stringify({type: 'newGameRequest'}));
            }
        }

        if (type === 'newGameConfirm') {
            const game = games.get(gameId);
            if (!game) return;

            game.board = defaultBoard();
            game.moveLog = [];
            game.history = [];
            game.winner = null;
            game.turn = 'blue';

            broadcast(game, {
                type: 'start',
                board: JSON.parse(JSON.stringify(game.board)),
                players: game.players,
                turn: game.turn,
                lastMove: '(new game)'
            });
        }

        if (type === 'undoConfirm') {
            const game = games.get(gameId);
            if (!game || game.history.length === 0) return;

            game.board = game.history.pop();
            game.moveLog.pop();
            game.turn = game.turn === 'blue' ? 'red' : 'blue';
            game.winner = null;

            broadcast(game, {
                type: 'update',
                board: JSON.parse(JSON.stringify(game.board)),
                turn: game.turn,
                lastMove: '(undo)'
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
server.listen(PORT, () => console.log(`✅ Server ready at http://localhost:${PORT}`));
