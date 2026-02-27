import React, { useState, useEffect } from 'react';
import socket from '../socket';
import type { GameRoom } from '../types';

interface LobbyProps {
    onGameStart: (room: GameRoom, socketId: string) => void;
}

// ─── Persistent player ID ────────────────────────────────────────────────────
function getOrCreatePlayerId(): string {
    const key = 'corporat_playerId';
    let id = localStorage.getItem(key);
    if (!id) {
        id = `pid_${Math.random().toString(36).slice(2)}_${Date.now()}`;
        localStorage.setItem(key, id);
    }
    return id;
}

function saveSession(roomCode: string) {
    localStorage.setItem('corporat_roomCode', roomCode);
}

function clearSession() {
    localStorage.removeItem('corporat_roomCode');
}

// ─── Color palette ───────────────────────────────────────────────────────────
const PALETTE: { label: string; value: string; icon: string }[] = [
    { label: 'Красный', value: '#E53935', icon: '🚀' },
    { label: 'Оранжевый', value: '#FB8C00', icon: '🤠' },
    { label: 'Жёлтый', value: '#FDD835', icon: '⭐' },
    { label: 'Зелёный', value: '#43A047', icon: '💵' },
    { label: 'Синий', value: '#1E88E5', icon: '🧊' },
    { label: 'Фиолетов.', value: '#8E24AA', icon: '🔮' },
    { label: 'Розовый', value: '#F06292', icon: '💅' },
    { label: 'Бирюза', value: '#00ACC1', icon: '🐬' },
    { label: 'Лайм', value: '#7CB342', icon: '🍀' },
    { label: 'Коричнев.', value: '#6D4C41', icon: '☕' },
];
const DEFAULT = PALETTE[0];

const Lobby: React.FC<LobbyProps> = ({ onGameStart }) => {
    const [view, setView] = useState<'home' | 'create' | 'join' | 'waiting' | 'rejoining'>('home');
    const [name, setName] = useState('');
    const [selectedPalette, setSelectedPalette] = useState(DEFAULT);
    const [roomCode, setRoomCode] = useState('');
    const [room, setRoom] = useState<GameRoom | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const playerId = getOrCreatePlayerId();

    // ── Auto-rejoin on mount if a session was saved ──────────────────────────
    useEffect(() => {
        socket.connect();
        const savedCode = localStorage.getItem('corporat_roomCode');

        const handleRoomUpdate = (updatedRoom: GameRoom) => {
            setRoom(updatedRoom);
            const myPlayer = updatedRoom.players.find(p => p.playerId === playerId);
            if (myPlayer) {
                const match = PALETTE.find(e => e.value === myPlayer.color);
                if (match) setSelectedPalette(match);
                setRoomCode(updatedRoom.id);
            }
            if (updatedRoom.state === 'playing') {
                onGameStart(updatedRoom, socket.id as string);
            } else {
                setView('waiting');
            }
        };

        socket.on('room_update', handleRoomUpdate);

        // Try to rejoin a saved session
        if (savedCode) {
            setView('rejoining');
            socket.emit('rejoin_room', { code: savedCode, playerId }, (res: any) => {
                if (!res.success) {
                    // Room gone — clear saved session and go home
                    clearSession();
                    setError('Сессия устарела. Создайте новую комнату.');
                    setView('home');
                }
                // On success room_update will fire automatically
            });
        }

        return () => { socket.off('room_update', handleRoomUpdate); };
    }, [onGameStart, playerId]);

    // ── Socket reconnect: re-emit rejoin_room ────────────────────────────────
    useEffect(() => {
        const handleReconnect = () => {
            const savedCode = localStorage.getItem('corporat_roomCode');
            if (savedCode) {
                socket.emit('rejoin_room', { code: savedCode, playerId }, (res: any) => {
                    if (!res.success) {
                        clearSession();
                        setView('home');
                    }
                });
            }
        };
        socket.on('connect', handleReconnect);
        return () => { socket.off('connect', handleReconnect); };
    }, [playerId]);

    const handleCreateRoom = () => {
        if (!name) return setError('Введите ваше имя');
        setLoading(true);
        setError('');
        socket.emit('create_room',
            { name, icon: selectedPalette.icon, color: selectedPalette.value, playerId },
            (res: any) => {
                setLoading(false);
                if (res.success) {
                    setRoomCode(res.roomCode);
                    saveSession(res.roomCode);
                    setView('waiting');
                } else {
                    setError(res.error);
                }
            }
        );
    };

    const handleJoinRoom = () => {
        if (!name) return setError('Введите ваше имя');
        if (!roomCode) return setError('Введите код комнаты');
        setLoading(true);
        setError('');
        socket.emit('join_room',
            { code: roomCode, name, icon: selectedPalette.icon, color: selectedPalette.value, playerId },
            (res: any) => {
                setLoading(false);
                if (res.success) {
                    saveSession(roomCode);
                    setView('waiting');
                } else {
                    setError(res.error || 'Ошибка входа');
                }
            }
        );
    };

    const handlePickColor = (entry: typeof PALETTE[0]) => {
        const takenByOther = (room?.players || []).find(
            p => p.playerId !== playerId && p.color === entry.value
        );
        if (takenByOther) return;
        setSelectedPalette(entry);
        if (roomCode) {
            socket.emit('update_player_info', { code: roomCode, color: entry.value, icon: entry.icon });
        }
    };

    const handleLeave = () => {
        if (roomCode) socket.emit('leave_room', { code: roomCode });
        clearSession();
        setRoom(null);
        setRoomCode('');
        setView('home');
    };

    const toggleReady = () => { if (roomCode) socket.emit('toggle_ready', { code: roomCode }); };
    const startGame = () => { if (roomCode) socket.emit('start_game', { code: roomCode }); };

    // ── Rejoining spinner ────────────────────────────────────────────────────
    if (view === 'rejoining') {
        return (
            <div className="app-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                <div className="glass-panel" style={{ padding: '32px', textAlign: 'center' }}>
                    <p style={{ fontSize: '20px', fontWeight: 'bold' }}>🔄 Переподключение к игре…</p>
                </div>
            </div>
        );
    }

    // ── Waiting room ─────────────────────────────────────────────────────────
    if (view === 'waiting' && room) {
        const myPlayer = room.players.find(p => p.playerId === playerId);
        const amIHost = room.players[0].playerId === playerId;
        const amIReady = myPlayer?.isReady;
        const allReady = room.players.every(p => p.isReady);
        const takenColors = (room.players || [])
            .filter(p => p.playerId !== playerId)
            .map(p => p.color);

        return (
            <div className="app-container" style={{ display: 'flex', flexDirection: 'column', padding: '20px', justifyContent: 'center', alignItems: 'center' }}>
                <div className="glass-panel" style={{ padding: '24px', width: '100%', maxWidth: '420px', textAlign: 'center' }}>
                    <h2 style={{ fontSize: '32px', marginBottom: '4px', color: 'var(--text-color)' }}>Комната: {room.id}</h2>
                    <p style={{ margin: '0 0 16px', color: 'var(--text-muted)' }}>Ожидание игроков… ({room.players.length}/6)</p>

                    {/* Player list */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
                        {room.players.map(p => (
                            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: 'rgba(0,0,0,0.1)', borderRadius: '8px', border: '3px solid #000' }}>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <div style={{ width: '18px', height: '18px', borderRadius: '50%', background: p.color, border: '2px solid #000', flexShrink: 0 }} />
                                    <span style={{ fontSize: '20px' }}>{p.icon}</span>
                                    <strong>{p.name}{p.playerId === room.players[0].playerId ? ' (Хост)' : ''}</strong>
                                </div>
                                <span style={{ color: p.isReady ? 'var(--success)' : 'var(--danger)', fontWeight: 'bold' }}>
                                    {p.isReady ? 'ГОТОВ' : 'НЕ ГОТОВ'}
                                </span>
                            </div>
                        ))}
                    </div>

                    {/* Color picker */}
                    <div style={{ marginBottom: '16px', textAlign: 'left' }}>
                        <label style={{ fontWeight: 'bold', fontSize: '13px', display: 'block', marginBottom: '8px' }}>Выбери фишку:</label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {PALETTE.map(entry => {
                                const taken = takenColors.includes(entry.value);
                                const selected = selectedPalette.value === entry.value;
                                return (
                                    <button
                                        key={entry.value}
                                        title={taken ? `${entry.label} — занято` : entry.label}
                                        disabled={taken}
                                        onClick={() => handlePickColor(entry)}
                                        style={{
                                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                            width: '52px', padding: '6px 4px', borderRadius: '10px',
                                            border: selected ? '3px solid #000' : '2px solid rgba(0,0,0,0.2)',
                                            background: selected ? entry.value : 'rgba(255,255,255,0.6)',
                                            cursor: taken ? 'not-allowed' : 'pointer',
                                            opacity: taken ? 0.3 : 1, transform: selected ? 'scale(1.1)' : 'scale(1)',
                                            transition: 'all 0.15s',
                                        }}
                                    >
                                        <span style={{ fontSize: '20px' }}>{entry.icon}</span>
                                        <div style={{ width: '14px', height: '14px', borderRadius: '50%', background: entry.value, border: '2px solid #000' }} />
                                        <span style={{ fontSize: '9px', fontWeight: 'bold', color: selected ? '#fff' : '#333', textShadow: selected ? '0 0 2px #000' : 'none' }}>
                                            {entry.label}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <button className="action-btn" onClick={toggleReady} style={{ background: amIReady ? 'var(--danger)' : 'var(--success)' }}>
                            {amIReady ? 'НЕ ГОТОВ' : 'ГОТОВ'}
                        </button>

                        {amIHost && (
                            <>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <button className="action-btn" style={{ flex: 1, padding: '10px', fontSize: '12px' }} disabled={room.players.length >= 6} onClick={() => socket.emit('add_bot', { code: roomCode })}>+ Бот</button>
                                    <button className="action-btn" style={{ flex: 1, padding: '10px', fontSize: '12px', background: 'var(--danger)', color: '#fff' }} onClick={() => socket.emit('remove_bot', { code: roomCode })}>- Бот</button>
                                </div>
                                <button className="action-btn" onClick={startGame} disabled={!allReady || room.players.length < 2} style={{ opacity: (!allReady || room.players.length < 2) ? 0.5 : 1, background: 'var(--primary-glow)' }}>
                                    НАЧАТЬ ИГРУ
                                </button>
                            </>
                        )}

                        <button className="action-btn" onClick={handleLeave} style={{ background: '#eee', color: '#333', fontSize: '13px' }}>
                            Покинуть комнату
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ── Home / Create / Join ─────────────────────────────────────────────────
    return (
        <div className="app-container" style={{ display: 'flex', flexDirection: 'column', padding: '20px', justifyContent: 'center', alignItems: 'center' }}>
            <div className="glass-panel" style={{ padding: '24px', width: '100%', maxWidth: '400px', textAlign: 'center' }}>
                <h1 style={{ fontSize: '42px', marginBottom: '8px', color: 'var(--primary-glow)', textShadow: '2px 2px 0px #000', WebkitTextStroke: '2px black' }}>ЭКСПАТ</h1>
                <p style={{ marginBottom: '24px', fontSize: '18px', fontWeight: 'bold' }}>Мультиплеер</p>

                {error && <div style={{ background: 'var(--danger)', color: '#fff', padding: '8px', borderRadius: '4px', border: '3px solid #000', marginBottom: '16px' }}>{error}</div>}

                {view === 'home' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <input type="text" placeholder="Ваше Имя" value={name} onChange={e => setName(e.target.value)} style={{ padding: '12px', fontSize: '16px', border: '3px solid #000', borderRadius: '8px', fontWeight: 'bold' }} />
                        <button className="action-btn" onClick={() => setView('create')} style={{ background: 'var(--primary-color)' }}>Создать Комнату</button>
                        <button className="action-btn" onClick={() => setView('join')} style={{ background: 'var(--secondary)' }}>Войти в Комнату</button>
                    </div>
                )}

                {view === 'create' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <button className="action-btn" onClick={handleCreateRoom} disabled={loading} style={{ background: 'var(--success)' }}>
                            {loading ? 'Создание...' : 'Подтвердить Создание'}
                        </button>
                        <button className="action-btn" onClick={() => setView('home')} style={{ background: '#eee', color: '#000' }}>Назад</button>
                    </div>
                )}

                {view === 'join' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <input type="text" placeholder="Код комнаты (4 цифры)" value={roomCode} onChange={e => setRoomCode(e.target.value)} style={{ padding: '12px', fontSize: '16px', border: '3px solid #000', borderRadius: '8px', fontWeight: 'bold', textAlign: 'center', letterSpacing: '4px' }} maxLength={4} />
                        <button className="action-btn" onClick={handleJoinRoom} disabled={loading} style={{ background: 'var(--success)' }}>
                            {loading ? 'Подключение...' : 'Присоединиться'}
                        </button>
                        <button className="action-btn" onClick={() => setView('home')} style={{ background: '#eee', color: '#000' }}>Назад</button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Lobby;
