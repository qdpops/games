const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Game State ---
let waitingPlayer = null; // { id, socket, name }
const games = {};         // gameId -> game object

function createGame(p1, p2) {
  const gameId = p1.id + '_' + p2.id;
  games[gameId] = {
    id: gameId,
    p1: { id: p1.id, name: p1.name, board: null, ships: null, ready: false, shotsFired: {} },
    p2: { id: p2.id, name: p2.name, board: null, ships: null, ready: false, shotsFired: {} },
    turn: 'p1',
    phase: 'placement', // placement | battle | finished
    winner: null,
    log: [],
    totalCells: 20 // 4+3+3+2+2+2+1+1+1+1
  };
  p1.socket.join(gameId);
  p2.socket.join(gameId);
  p1.socket.gameId = gameId;
  p1.socket.slot = 'p1';
  p2.socket.gameId = gameId;
  p2.socket.slot = 'p2';

  io.to(gameId).emit('game_found', {
    gameId,
    p1Name: p1.name,
    p2Name: p2.name
  });
  console.log(`Game created: ${gameId} | ${p1.name} vs ${p2.name}`);
  return games[gameId];
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Player joins queue
  socket.on('join_queue', ({ name }) => {
    socket.playerName = name;

    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      // Form a pair
      const opponent = waitingPlayer;
      waitingPlayer = null;
      createGame(
        { id: opponent.id, socket: opponent.socket, name: opponent.name },
        { id: socket.id, socket, name }
      );
    } else {
      // Wait in queue
      waitingPlayer = { id: socket.id, socket, name };
      socket.emit('waiting', { position: 1 });
      console.log(`Waiting: ${name}`);
    }
  });

  // Player submits ready board
  socket.on('player_ready', ({ board, ships }) => {
    const gameId = socket.gameId;
    const slot = socket.slot;
    if (!gameId || !games[gameId]) return;

    const game = games[gameId];
    game[slot].board = board;
    game[slot].ships = ships;
    game[slot].ready = true;

    const opponentSlot = slot === 'p1' ? 'p2' : 'p1';
    socket.emit('you_are_ready');

    if (game[opponentSlot].ready) {
      game.phase = 'battle';
      game.log.push({ type: 'system', text: 'БОЙ НАЧАЛСЯ!' });
      io.to(gameId).emit('battle_start', {
        turn: game.turn,
        log: game.log
      });
      console.log(`Battle started: ${gameId}`);
    } else {
      socket.emit('waiting_for_opponent_ready');
    }
  });

  // Player fires a shot
  socket.on('fire', ({ r, c }) => {
    const gameId = socket.gameId;
    const slot = socket.slot;
    if (!gameId || !games[gameId]) return;

    const game = games[gameId];
    if (game.phase !== 'battle') return;
    if (game.turn !== slot) {
      socket.emit('not_your_turn');
      return;
    }

    const opponentSlot = slot === 'p1' ? 'p2' : 'p1';
    const key = r + ',' + c;

    if (game[slot].shotsFired[key]) return; // already shot

    const opponentBoard = game[opponentSlot].board;
    const opponentShips = game[opponentSlot].ships;
    const cellValue = opponentBoard[r][c];
    const isHit = !!cellValue;
    const cols = 'АБВГДЕЖЗИК';
    const coord = cols[c] + (r + 1);

    let resultType = 'miss';
    let affectedCells = [[r, c]];
    let logText = '';
    const shooterName = game[slot].name;

    if (isHit) {
      const shipId = cellValue;
      const shipCells = opponentShips[shipId];
      const prevHits = shipCells.filter(([sr, sc]) => game[slot].shotsFired[sr+','+sc]).length;

      if (prevHits + 1 >= shipCells.length) {
        resultType = 'sunk';
        affectedCells = shipCells;
        logText = `💥 ${shooterName} потопил корабль! (${coord})`;
      } else {
        resultType = 'hit';
        logText = `🎯 ${shooterName} попал! (${coord})`;
      }
    } else {
      logText = `💦 ${shooterName} промахнулся (${coord})`;
    }

    // Record shots
    affectedCells.forEach(([sr, sc]) => {
      game[slot].shotsFired[sr+','+sc] = resultType;
    });

    game.log.push({ type: resultType, text: logText });
    if (game.log.length > 50) game.log = game.log.slice(-50);

    // Switch turn only on miss
    if (resultType === 'miss') game.turn = opponentSlot;

    // Check win
    const totalHits = Object.values(game[slot].shotsFired).filter(v => v === 'hit' || v === 'sunk').length;
    if (totalHits >= game.totalCells) {
      game.phase = 'finished';
      game.winner = slot;
      game.log.push({ type: 'system', text: `🏆 ${game[slot].name} ПОБЕДИЛ!` });
    }

    // Broadcast result
    io.to(gameId).emit('shot_result', {
      shooter: slot,
      r, c,
      resultType,
      affectedCells,
      turn: game.turn,
      phase: game.phase,
      winner: game.winner,
      log: game.log.slice(-10)
    });
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);

    // Remove from queue
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }

    // Notify opponent
    const gameId = socket.gameId;
    if (gameId && games[gameId]) {
      const game = games[gameId];
      if (game.phase !== 'finished') {
        socket.to(gameId).emit('opponent_disconnected');
        game.phase = 'finished';
      }
      // Clean up after 60s
      setTimeout(() => { delete games[gameId]; }, 60000);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Battleship server running on port ${PORT}`);
});
