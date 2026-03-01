import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { GameRoom, Player, getInitialCells } from './models';
import { rollDice, resolveEvent, botTick, logAction, endTurn, removePlayerFromAuction } from './gameEngine';

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const rooms = new Map<string, GameRoom>();

// Tick bots at 500ms for consistent timing (bot delay is enforced inside botTick via lastActionTime)
setInterval(() => {
    rooms.forEach(room => {
        if (room.state === 'playing') {
            try {
                if (botTick(room)) {
                    io.to(room.id).emit('room_update', room);
                }
            } catch (err) {
                console.error('[Bot AI] Error ticking bot for room', room.id, err);
            }
        }
    });
}, 500);

const generateRoomCode = () => {
    return Math.floor(1000 + Math.random() * 9000).toString();
};

io.on('connection', (socket: Socket) => {
    console.log(`User connected: ${socket.id}`);

    // Colour palette mirrors the client PALETTE array (same order)
    const ALL_COLORS = ['#E53935', '#FB8C00', '#FDD835', '#43A047', '#1E88E5', '#8E24AA', '#F06292', '#00ACC1', '#7CB342', '#6D4C41'];
    const ALL_ICONS = ['🚀', '🤠', '⭐', '💵', '🧊', '🔮', '💅', '🐬', '🍀', '☕'];
    const pickFreeColor = (takenColors: string[], preferred: string, preferredIcon: string): { color: string; icon: string } => {
        if (!takenColors.includes(preferred)) return { color: preferred, icon: preferredIcon };
        for (let i = 0; i < ALL_COLORS.length; i++) {
            if (!takenColors.includes(ALL_COLORS[i])) return { color: ALL_COLORS[i], icon: ALL_ICONS[i] };
        }
        return { color: preferred, icon: preferredIcon }; // fallback
    };

    socket.on('create_room', (data: { name: string, icon: string, color: string, playerId: string }, callback) => {
        let code = generateRoomCode();
        while (rooms.has(code)) code = generateRoomCode();

        const takenColors: string[] = [];
        const { color: assignedColor, icon: assignedIcon } = pickFreeColor(takenColors, data.color || '#E53935', data.icon || '🚀');

        const newRoom: GameRoom = {
            id: code,
            players: [{
                id: socket.id,
                playerId: data.playerId || socket.id,
                name: data.name || 'Игрок 1',
                balance: 1500000,
                position: 0,
                color: assignedColor,
                icon: assignedIcon,
                isInJail: false,
                jailRolls: 0,
                skipNextTurn: false,
                isReady: true,
                doubleCount: 0
            }],
            cells: getInitialCells(),
            turnIndex: 0,
            state: 'lobby',
            activeEvent: null,
            auctionState: null,
            actionLog: [],
            lastActionTime: Date.now()
        };

        rooms.set(code, newRoom);
        socket.join(code);
        callback({ success: true, roomCode: code });
        io.to(code).emit('room_update', newRoom);
    });

    socket.on('join_room', (data: { code: string, name: string, icon: string, color: string, playerId: string }, callback) => {
        const room = rooms.get(data.code);
        if (!room) return callback({ success: false, error: 'Комната не найдена.' });
        if (room.state !== 'lobby') return callback({ success: false, error: 'Игра уже идет.' });
        if (room.players.length >= 6) return callback({ success: false, error: 'Комната полна.' });

        const takenColors = room.players.map(p => p.color);
        const { color: assignedColor, icon: assignedIcon } = pickFreeColor(takenColors, data.color || '#E53935', data.icon || '🚀');

        const newPlayer: Player = {
            id: socket.id,
            playerId: data.playerId || socket.id,
            name: data.name || `Игрок ${room.players.length + 1}`,
            balance: 1500000,
            position: 0,
            color: assignedColor,
            icon: assignedIcon,
            isInJail: false,
            jailRolls: 0,
            skipNextTurn: false,
            isReady: false,
            doubleCount: 0
        };

        room.players.push(newPlayer);
        socket.join(data.code);
        callback({ success: true, roomCode: data.code });
        io.to(data.code).emit('room_update', room);
    });

    socket.on('rejoin_room', (data: { code: string, playerId: string }, callback) => {
        const room = rooms.get(data.code);
        if (!room) return callback({ success: false, error: 'Комната не найдена.' });

        const existingPlayer = room.players.find(p => p.playerId === data.playerId);
        if (existingPlayer) {
            const oldId = existingPlayer.id;
            // Update socket ID for the rejoining player
            existingPlayer.id = socket.id;

            // Migrate all state references to the new socket ID
            room.cells.forEach(c => {
                if (c.ownerId === oldId) c.ownerId = socket.id;
            });
            if (room.lastRoll?.playerId === oldId) room.lastRoll.playerId = socket.id;
            if (room.activeEvent?.targetPlayerId === oldId) room.activeEvent.targetPlayerId = socket.id;
            if (room.auctionState) {
                if (room.auctionState.highestBidderId === oldId) room.auctionState.highestBidderId = socket.id;
                const pIdx = room.auctionState.participantIds.indexOf(oldId);
                if (pIdx !== -1) room.auctionState.participantIds[pIdx] = socket.id;
            }
            room.players.forEach(p => {
                if (p.debtTo === oldId) p.debtTo = socket.id;
            });

            existingPlayer.isReady = true; // Mark as ready again
            socket.join(data.code);
            callback({ success: true, roomCode: data.code });
            io.to(data.code).emit('room_update', room);
        } else {
            callback({ success: false, error: 'Игрок не найден в этой комнате.' });
        }
    });

    socket.on('toggle_ready', (data: { code: string }) => {
        const room = rooms.get(data.code);
        if (room && room.state === 'lobby') {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                player.isReady = !player.isReady;
                io.to(data.code).emit('room_update', room);
            }
        }
    });

    socket.on('update_player_info', (data: { code: string, color: string, icon: string }) => {
        const room = rooms.get(data.code);
        if (room && room.state === 'lobby') {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                // Reject if another player already has this color
                const colorTakenByOther = room.players.some(p => p.id !== socket.id && p.color === data.color);
                if (!colorTakenByOther) {
                    player.color = data.color;
                    player.icon = data.icon;
                    io.to(data.code).emit('room_update', room);
                }
            }
        }
    });

    socket.on('leave_room', (data: { code: string }) => {
        const room = rooms.get(data.code);
        if (room) {
            removePlayerFromAuction(room, socket.id);
            room.players = room.players.filter(p => p.id !== socket.id);
            socket.leave(data.code);
            if (room.players.length === 0) {
                rooms.delete(data.code);
            } else {
                io.to(data.code).emit('room_update', room);
            }
        }
    });

    socket.on('add_bot', (data: { code: string }) => {
        const room = rooms.get(data.code);
        if (room && room.state === 'lobby' && room.players.length > 0 && room.players[0].id === socket.id && room.players.length < 6) {
            const botId = 'bot_' + Math.random().toString(36).substr(2, 9);
            const botCount = room.players.filter(p => p.isBot).length;
            const BOT_NAMES = ['бот Руслан', 'бот Марат', 'бот Ваня', 'бот Даша', 'бот Никита'];
            const botName = BOT_NAMES[botCount] || `Бот ${botCount + 1}`;

            const PALETTE = [
                '#E53935', '#FB8C00', '#FDD835', '#43A047', '#1E88E5',
                '#8E24AA', '#F06292', '#00ACC1', '#7CB342', '#6D4C41'
            ];
            const takenColors = room.players.map(p => p.color);
            const availableColors = PALETTE.filter(c => !takenColors.includes(c));
            const botColor = availableColors.length > 0 ? availableColors[0] : `hsl(${Math.random() * 360}, 70%, 50%)`;

            const newBot = {
                id: botId,
                playerId: botId,
                name: botName,
                balance: 1500000,
                position: 0,
                color: botColor,
                icon: '🤖',
                isInJail: false,
                jailRolls: 0,
                skipNextTurn: false,
                isReady: true,
                isBot: true,
                doubleCount: 0
            };
            room.players.push(newBot as any);
            io.to(data.code).emit('room_update', room);
        }
    });

    socket.on('remove_bot', (data: { code: string }) => {
        const room = rooms.get(data.code);
        if (room && room.state === 'lobby' && room.players.length > 0 && room.players[0].id === socket.id) {
            const lastBotIndex = room.players.map(p => p.isBot).lastIndexOf(true);
            if (lastBotIndex !== -1) {
                room.players.splice(lastBotIndex, 1);
                io.to(data.code).emit('room_update', room);
            }
        }
    });

    socket.on('start_game', (data: { code: string }) => {
        const room = rooms.get(data.code);
        if (room && room.state === 'lobby') {
            // Check if requester is the room creator
            if (room.players[0].id === socket.id) {
                // Ensure all are ready
                const allReady = room.players.every(p => p.isReady);
                if (allReady && room.players.length > 1) {
                    room.state = 'playing';
                    room.actionLog = ['Игра началась! Удачи!'];
                    io.to(data.code).emit('room_update', room);
                }
            }
        }
    });

    socket.on('roll_dice', (data: { code: string }) => {
        const room = rooms.get(data.code);
        if (room && room.state === 'playing') {
            try {
                rollDice(room, socket.id);
                if ((room.state as string) === 'finished' && !(room as any)._deletionScheduled) {
                    (room as any)._deletionScheduled = true;
                    setTimeout(() => rooms.delete(data.code), 5 * 60 * 1000);
                }
                console.log(`[Socket] Broadcasting room_update for ${data.code}`);
                io.to(data.code).emit('room_update', room);
            } catch (err) {
                console.error('[Socket] Error in rollDice:', err);
            }
        }
    });

    socket.on('resolve_event', (data: any) => {
        const room = rooms.get(data.code);
        if (room && room.state === 'playing') {
            try {
                resolveEvent(room, socket.id, data);
                if ((room.state as string) === 'finished' && !(room as any)._deletionScheduled) {
                    (room as any)._deletionScheduled = true;
                    setTimeout(() => rooms.delete(data.code), 5 * 60 * 1000);
                }
                console.log(`[Socket] Broadcasting room_update for ${data.code} after resolve`);
                io.to(data.code).emit('room_update', room);
            } catch (err) {
                console.error('[Socket] Error in resolveEvent:', err);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        for (const [code, room] of rooms.entries()) {
            const pIndex = room.players.findIndex(p => p.id === socket.id);
            if (pIndex !== -1) {
                const disconnectedPlayer = room.players[pIndex];
                if (room.state === 'lobby') {
                    room.players.splice(pIndex, 1);
                    if (room.players.length === 0) {
                        rooms.delete(code);
                    } else {
                        io.to(code).emit('room_update', room);
                    }
                } else {
                    // Game is running — keep player alive, give 90s to rejoin
                    removePlayerFromAuction(room, disconnectedPlayer.id);
                    disconnectedPlayer.isReady = false;
                    disconnectedPlayer.doubleCount = 0; // prevent stuck on extra turn
                    logAction(room, `${disconnectedPlayer.name} потерял связь. 90 сек на переподключение.`);

                    if (room.turnIndex === pIndex) {
                        endTurn(room);
                    }

                    io.to(code).emit('room_update', room);

                    setTimeout(() => {
                        // If they haven't rejoined (id still matches the disconnected socket), remove them
                        if (disconnectedPlayer.id === socket.id) {
                            const currentRoom = rooms.get(code);
                            if (!currentRoom) return;
                            const idx = currentRoom.players.indexOf(disconnectedPlayer);
                            if (idx === -1) return;
                            logAction(currentRoom, `${disconnectedPlayer.name} удалён (тайм-аут 90 сек).`);
                            currentRoom.players.splice(idx, 1);
                            if (currentRoom.players.length === 0) {
                                rooms.delete(code);
                            } else {
                                if (currentRoom.turnIndex >= currentRoom.players.length) currentRoom.turnIndex = 0;
                                io.to(code).emit('room_update', currentRoom);
                            }
                        }
                    }, 90_000);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 8081;
httpServer.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

