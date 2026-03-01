import React, { useEffect, useState } from 'react';
import './index.css';

// Type definitions
declare global {
    interface Window {
        Telegram?: {
            WebApp?: any;
        };
    }
}

import type { CellData, Player, GameRoom, AuctionState } from './types';
import { getInitialCells, BOARD_SIZE } from './types';
import Lobby from './components/Lobby';
import socket from './socket';

const App: React.FC = () => {
    // Multiplayer State
    const [roomState, setRoomState] = useState<'lobby' | 'playing'>('lobby');
    const [myId, setMyId] = useState<string>('');
    const [winner, setWinner] = useState<Player | null>(null);
    const [roomId, setRoomId] = useState<string>('');

    // Game State
    const [players, setPlayers] = useState<Player[]>([]);
    const [visualPlayers, setVisualPlayers] = useState<Player[]>([]);
    const [turnIndex, setTurnIndex] = useState(0); // index in players array
    const [cells, setCells] = useState<CellData[]>(getInitialCells());

    // UI State
    const [actionLog, setActionLog] = useState<string[]>(['Игра началась! Ваш ход.']);
    const [lastRoll, setLastRoll] = useState<{ r1: number, r2: number, playerId: string, intermediatePosition?: number } | null>(null);
    const [isRolling, setIsRolling] = useState(false);

    // Event Modals
    const [activeEvent, setActiveEvent] = useState<{
        type: 'buy' | 'upgrade' | 'rent' | 'chance' | 'tax' | 'trade' | 'bankrupt' | 'win' | 'auction' | 'trade_proposal';
        cell?: CellData;
        amount?: number;
        message?: string;
        targetPlayerId?: string;
    } | null>(null);

    const setMyIdSynced = (id: string) => {
        setMyId(id);
        myIdRef.current = id;
    };
    const [auctionState, setAuctionState] = useState<AuctionState | null>(null);

    // Assets Modal
    const [showAssetsModal, setShowAssetsModal] = useState<boolean>(false);

    // Trade State
    const [tradeOfferAmount, setTradeOfferAmount] = useState<number>(0);
    const [tradeOfferPropertyId, setTradeOfferPropertyId] = useState<number | null>(null);
    const [tradeRequestPropertyId, setTradeRequestPropertyId] = useState<number | null>(null);
    const [tradeTargetPlayerId, setTradeTargetPlayerId] = useState<string>('');

    const orchestratorRef = React.useRef({ isAnimating: false });
    // Use a ref for myId so handleRoomUpdate always reads the current value (avoids stale closure)
    const myIdRef = React.useRef('');
    const animatingTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // Generation counter: each roll increments this so old Stage-2 timers don't
    // accidentally clear isAnimating while a newer roll is already in flight.
    const rollGenerationRef = React.useRef(0);

    const tg = window.Telegram?.WebApp;

    useEffect(() => {
        if (tg) {
            tg.expand();
            tg.ready();
        }
    }, [tg]);

    // Animate visual players to catch up to real Server given players
    useEffect(() => {
        const interval = setInterval(() => {
            setVisualPlayers(prev => {
                let changed = false;

                // Catch new joins or drops
                if (prev.length !== players.length) {
                    return players;
                }

                // If any player ID changed (e.g. from a reconnect), instantly snap the visuals
                const idsMatch = players.every(p => prev.some(vp => vp.id === p.id));
                if (!idsMatch) {
                    return players;
                }

                // Do not move anyone while the dice are visually rolling
                if (isRolling) return prev;

                const next = prev.map(vp => {
                    const rp = players.find(p => p.id === vp.id);
                    if (!rp) return vp;

                    // Only use intermediatePosition while still in transit (not yet at final destination)
                    const targetPos = (lastRoll?.intermediatePosition !== undefined && lastRoll.playerId === vp.id && !isRolling && vp.position !== rp.position)
                        ? lastRoll.intermediatePosition
                        : rp.position;

                    if (vp.position === targetPos) {
                        if (vp.position !== rp.position) {
                            // Reached intermediate, now teleport to real target (e.g., Jail)
                            changed = true;
                            return { ...rp, position: rp.position };
                        }
                        // Fully matched. Sync any changing text/balance fields
                        if (JSON.stringify(vp) !== JSON.stringify(rp)) {
                            changed = true;
                            return rp;
                        }
                        return vp;
                    }

                    // Detect teleport: if destination is impossibly far or backwards — snap immediately
                    const forwardDist = (targetPos - vp.position + BOARD_SIZE) % BOARD_SIZE;
                    if (forwardDist > 12) {
                        // Can't be a normal dice move — teleport snap
                        changed = true;
                        return { ...rp, position: targetPos };
                    }

                    changed = true;
                    // Move forward 1 step
                    let nextPos = vp.position + 1;
                    if (nextPos >= BOARD_SIZE) nextPos = 0;

                    // Keep real data, but fake the position so it matches visual iteration
                    return { ...rp, position: nextPos };
                });

                return changed ? next : prev;
            });
        }, 125); // Hop interval

        return () => clearInterval(interval);
    }, [players, isRolling]);

    // Bot functionality removed in multiplayer logic for now
    // In future versions, server will operate bots.

    // Remote actions wrapper
    const rollDice = () => {
        const isUserTurn = players[turnIndex]?.id === myId;
        if (!isUserTurn) return; // Client side protection
        if (activeEvent) return;

        setIsRolling(true);
        orchestratorRef.current.isAnimating = true;
        // Reset last roll visual so we can spin empty dice if we want
        socket.emit('roll_dice', { code: roomId });
    };

    const handleUserAction = (actionType: string) => {
        if (!activeEvent) return;
        if (actionType === 'propose_trade') {
            const targetId = tradeRequestPropertyId ? cells.find(c => c.id === tradeRequestPropertyId)?.ownerId : tradeTargetPlayerId;
            if (!targetId) {
                alert('Выберите игрока или его имущество для сделки!');
                return;
            }
            socket.emit('resolve_event', {
                code: roomId,
                action: 'propose_trade',
                tradeTargetPlayerId: targetId,
                tradeOfferPropertyId,
                tradeRequestPropertyId,
                tradeOfferAmount
            });
            setActiveEvent(null);
            setTradeRequestPropertyId(null);
            setTradeOfferPropertyId(null);
            setTradeOfferAmount(0);
        } else if (actionType === 'cancel_trade') {
            setActiveEvent(null);
            setTradeRequestPropertyId(null);
            setTradeOfferPropertyId(null);
            setTradeOfferAmount(0);
        } else {
            console.log(`[App] Resolving event: ${actionType}. Clearing activeEvent.`);
            socket.emit('resolve_event', { code: roomId, action: actionType });
            setActiveEvent(null);
            orchestratorRef.current.isAnimating = false; // reset failsafe
        }
        if (tg?.HapticFeedback) toggleHaptic('light');
    };

    const toggleHaptic = (style: 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error') => {
        if (tg?.HapticFeedback) {
            if (['light', 'medium', 'heavy'].includes(style)) {
                tg.HapticFeedback.impactOccurred(style as any);
            } else {
                tg.HapticFeedback.notificationOccurred(style as any);
            }
        }
    };

    const calculateRent = (cell: CellData) => {
        if (cell.isMortgaged) return 0;
        if (cell.type === 'station') {
            const owned = cells.filter(c => c.type === 'station' && c.ownerId === cell.ownerId).length;
            return 25000 * Math.pow(2, owned - 1);
        }
        if (cell.type === 'utility') {
            const bothOwned = cells.filter(c => c.type === 'utility').every(c => c.ownerId === cell.ownerId);
            return bothOwned ? 'x10' : 'x4';
        }
        if (!cell.rentBase) return 0;
        if (cell.level === 0) {
            const groupCells = cells.filter(c => c.groupColor === cell.groupColor && c.type === 'property');
            const hasMonopoly = groupCells.every(c => c.ownerId === cell.ownerId && !c.isMortgaged);
            return hasMonopoly ? (cell.rentMonopoly ?? cell.rentBase * 2) : cell.rentBase;
        }
        const rentByLevel = [0, cell.rent1h, cell.rent2h, cell.rent3h, cell.rent4h, cell.rentHotel];
        return rentByLevel[Math.min(cell.level, 5)] ?? cell.rentBase;
    };

    const getCellColor = (type: string) => {
        if (type === 'go') return 'cell-go';
        if (type === 'gotojail' || type === 'jail') return 'cell-jail';
        return '';
    };

    // Dynamic font size: full name always shown, just smaller for longer names
    const cellNameFontSize = (name: string): string => {
        if (name === '❓') return '16px'; // Make the chance tile large

        const len = name.length;
        if (len <= 5) return '7.5px';
        if (len <= 9) return '6.5px';
        if (len <= 14) return '5.5px';
        if (len <= 20) return '4.8px';
        return '4px';
    };

    // Format long names specifically for the small board cells
    const formatBoardName = (name: string) => {
        switch (name) {
            case 'surikatamami': return 'surikata\nmami';
            case 'loly_tattoo': return 'loly\ntattoo';
            case 'Аудитория': return 'Ауди\nтория';
            case 'Magticom': return 'Magti\ncom';
            case 'Biblioteka': return 'Biblio\nteka';
            case 'Горизонтальное кафе Фрик': return 'Горизонт.\nкафе Фрик';
            default: return name;
        }
    };

    const getGridPos = (index: number) => {
        if (index >= 0 && index <= 10) return { row: 1, col: 1 + index };            // top row: 0=TL → 10=TR
        if (index >= 11 && index <= 20) return { row: 1 + (index - 10), col: 11 };  // right col: top → bottom
        if (index >= 21 && index <= 30) return { row: 11, col: 11 - (index - 20) }; // bottom row: right → left
        if (index >= 31 && index <= 39) return { row: 11 - (index - 30), col: 1 };  // left col: bottom → top
        return { row: 1, col: 1 };
    };

    // Calculate UI derivations based on the new multiplayer state
    const isUserInDebt = players.find(p => p.id === myId)?.balance !== undefined && (players.find(p => p.id === myId)?.balance as number) < 0;

    useEffect(() => {
        const handleRoomUpdate = (room: GameRoom) => {
            console.log('--- ROOM UPDATE RECEIVED ---', room);
            if (room.state === 'finished') {
                setPlayers(room.players || []);
                // The winner is the only player still on the board (position >= 0)
                const w = room.players.find(p => p.position >= 0) || null;
                setWinner(w);
                // Reset animation state so UI doesn't stay locked
                if (animatingTimeoutRef.current) clearTimeout(animatingTimeoutRef.current);
                orchestratorRef.current.isAnimating = false;
                setIsRolling(false);
                return;
            }
            if (room.state === 'playing') {
                setPlayers(room.players || []);
                setCells(room.cells || []);
                if (room.turnIndex !== undefined) setTurnIndex(room.turnIndex);

                if (orchestratorRef.current.isAnimating) {
                    // Use ref to avoid stale closure on myId
                    const currentMyId = myIdRef.current;
                    // wasSkipTurn is explicitly set by server; fallback: playerId !== mine
                    const isSkipTurn = room.lastRoll?.wasSkipTurn === true
                        || !room.lastRoll
                        || room.lastRoll.playerId !== currentMyId;

                    if (isSkipTurn) {
                        // No dice rolled — cancel animation immediately
                        if (animatingTimeoutRef.current) clearTimeout(animatingTimeoutRef.current);
                        setIsRolling(false);
                        setLastRoll(null);
                        setActiveEvent(room.activeEvent as any);
                        orchestratorRef.current.isAnimating = false;
                    } else {
                        // Clear any previous failsafe
                        if (animatingTimeoutRef.current) clearTimeout(animatingTimeoutRef.current);

                        // Bump generation so any Stage‑2 timer from a prior roll knows it's stale.
                        rollGenerationRef.current += 1;
                        const gen = rollGenerationRef.current;

                        // Stage 1: dice spin
                        setTimeout(() => {
                            setIsRolling(false);
                            setLastRoll(room.lastRoll || null);

                            // Stage 2: pawn walk — only finalise if no newer roll has started
                            setTimeout(() => {
                                if (rollGenerationRef.current === gen) {
                                    setActiveEvent(room.activeEvent as any);
                                    orchestratorRef.current.isAnimating = false;
                                }
                            }, 1500);
                        }, 1000);

                        // Failsafe: force-reset after 5s to prevent permanent lock
                        animatingTimeoutRef.current = setTimeout(() => {
                            if (orchestratorRef.current.isAnimating && rollGenerationRef.current === gen) {
                                console.warn('[App] isAnimating failsafe triggered — resetting');
                                setIsRolling(false);
                                setLastRoll(room.lastRoll || null);
                                setActiveEvent(room.activeEvent as any);
                                orchestratorRef.current.isAnimating = false;
                            }
                        }, 5000);
                    }
                } else {
                    // Not our animation — but always ensure dice aren't stuck spinning.
                    setIsRolling(false);
                    setLastRoll(room.lastRoll || null);
                    setActiveEvent(room.activeEvent as any);
                }

                if (room.auctionState !== undefined) setAuctionState(room.auctionState as any);
                if (room.actionLog && room.actionLog.length > 0) {
                    setActionLog(room.actionLog.slice(-6).reverse());
                }
            }
        };

        const handleReconnect = () => {
            console.log('[App] Socket reconnected silently! Re-joining room...');
            if (roomId) {
                const playerId = localStorage.getItem('corporat_playerId');
                if (playerId) {
                    socket.emit('rejoin_room', { code: roomId, playerId }, (res: any) => {
                        if (res.success && socket.id) {
                            console.log('[App] Rejoin successful. Updating myId to new socket.id:', socket.id);
                            setMyIdSynced(socket.id);
                        }
                    });
                }
            }
        };

        socket.on('room_update', handleRoomUpdate);
        socket.on('connect', handleReconnect);

        return () => {
            socket.off('room_update', handleRoomUpdate);
            socket.off('connect', handleReconnect);
        };
    }, [roomId]);

    if (roomState === 'lobby') {
        return <Lobby onGameStart={(room, id) => {
            setMyIdSynced(id);
            setRoomId(room.id);
            setPlayers(room.players);
            setVisualPlayers(room.players);
            setCells(room.cells);
            setTurnIndex(room.turnIndex);
            setRoomState('playing');
        }} />;
    }

    if (winner) {
        const isMe = winner.id === myId;
        return (
            <div className="app-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                <div className="glass-panel" style={{ padding: '40px 32px', textAlign: 'center', maxWidth: '360px', width: '100%' }}>
                    <div style={{ fontSize: '72px', marginBottom: '8px' }}>🏆</div>
                    <h1 style={{ fontSize: '28px', margin: '0 0 8px', color: 'var(--primary-glow)', WebkitTextStroke: '1px black' }}>
                        {isMe ? 'Вы победили!' : `${winner.name} победил!`}
                    </h1>
                    <div style={{
                        display: 'inline-flex', alignItems: 'center', gap: '10px',
                        background: winner.color, borderRadius: '12px',
                        padding: '10px 20px', margin: '12px 0', border: '3px solid #000'
                    }}>
                        <span style={{ fontSize: '32px' }}>{winner.icon}</span>
                        <span style={{ fontWeight: 'bold', fontSize: '20px', color: '#fff', textShadow: '1px 1px 0 #000' }}>{winner.name}</span>
                    </div>
                    <p style={{ color: 'var(--text-muted)', margin: '12px 0 24px' }}>
                        Все остальные игроки обанкротились.<br />
                        {isMe ? 'Экспат-магнат! 🎉' : 'В следующий раз повезёт!'}
                    </p>
                    <button
                        className="action-btn"
                        style={{ background: 'var(--primary-glow)', width: '100%', fontSize: '16px' }}
                        onClick={() => {
                            setWinner(null);
                            setRoomState('lobby');
                        }}
                    >
                        В главное меню
                    </button>
                </div>
            </div>
        );
    }

    if (!players || players.length === 0) return null;

    const isUserTurn = players[turnIndex]?.id === myId;

    return (
        <div className="app-container">
            <header className="glass-panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', minHeight: '34px', alignItems: 'center' }}>
                    <h3 style={{ margin: 0, opacity: 0.8 }}>Игроки</h3>
                    <div style={{ display: 'flex', gap: '4px', visibility: (isUserTurn && (!activeEvent || activeEvent.type === 'buy') && !showAssetsModal) ? 'visible' : 'hidden' }}>
                        <button onClick={() => setShowAssetsModal(true)} className="action-btn" style={{ padding: '4px 10px', fontSize: '12px' }}>Мои Активы</button>
                        <button onClick={() => setActiveEvent({ type: 'trade' })} className="action-btn" style={{ background: '#fff', padding: '4px 10px', fontSize: '12px' }}>Сделка</button>
                    </div>
                </div>
                <div className="players-grid">
                    {players.map((p, idx) => (
                        <div key={p.id} className="user-info" style={{ opacity: turnIndex === idx ? 1 : 0.5, marginBottom: '0' }}>
                            <div className="avatar" style={{ background: p.color }}>{p.icon}</div>
                            <div className="details">
                                <h2>{p.name}</h2>
                                <div className="balance">
                                    <span className="currency">₾</span> <span>{p.balance.toLocaleString('ru-RU')}</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </header>

            <main className="board-container">
                <div className="board glass-panel">
                    <div className="board-center">
                        <h1 className="logo-title">ЭКСПАТ</h1>

                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '8px', minHeight: '46px' }}>
                            {lastRoll && (
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <div className={`dice ${isRolling ? 'rolling-dice' : ''}`} style={{ width: '40px', height: '40px', background: '#fff', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '24px', fontWeight: 'bold', color: '#000', border: '3px solid #000' }}>
                                        {isRolling ? '❓' : lastRoll.r1}
                                    </div>
                                    <div className={`dice ${isRolling ? 'rolling-dice' : ''}`} style={{ width: '40px', height: '40px', background: '#fff', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '24px', fontWeight: 'bold', color: '#000', border: '3px solid #000' }}>
                                        {isRolling ? '❓' : lastRoll.r2}
                                    </div>
                                </div>
                            )}

                            {(() => {
                                const myPlayer = players.find(p => p.id === myId);
                                const isSkipping = myPlayer?.skipNextTurn === true;
                                return (
                                    <button
                                        className="action-btn primary-glow"
                                        onClick={rollDice}
                                        disabled={!isUserTurn || isUserInDebt || activeEvent !== null || isRolling || orchestratorRef.current.isAnimating}
                                        style={{
                                            padding: '8px 10px',
                                            fontSize: window.innerWidth < 400 ? '11px' : '14px',
                                            whiteSpace: 'nowrap',
                                            opacity: (!isUserTurn || isUserInDebt || activeEvent !== null) ? 0.5 : 1,
                                            ...(isSkipping && isUserTurn && { background: 'var(--action-color)' })
                                        }}
                                    >
                                        {isSkipping && isUserTurn ? '✈️ Вернуться из Армении' : 'Бросить кубики'}
                                    </button>
                                );
                            })()}
                        </div>

                        {/* Bail button — shown whenever in jail on your turn */}
                        {(() => {
                            const myPlayer = players.find(p => p.id === myId);
                            if (!isUserTurn || !myPlayer?.isInJail) return null;
                            const canAfford = (myPlayer.balance ?? 0) >= 50000;
                            return (
                                <button
                                    className="action-btn"
                                    onClick={() => {
                                        socket.emit('resolve_event', { code: roomId, action: 'pay_bail' });
                                    }}
                                    disabled={!canAfford || activeEvent !== null}
                                    style={{
                                        background: canAfford ? 'var(--success)' : '#aaa',
                                        color: '#fff',
                                        marginBottom: '8px',
                                        padding: '10px 20px',
                                        fontSize: '14px',
                                        opacity: canAfford ? 1 : 0.6,
                                    }}
                                >
                                    🔓 Выплатить залог (50k){!canAfford ? ' — не хватает средств' : ''}
                                </button>
                            );
                        })()}

                        {isUserTurn && isUserInDebt && (() => {
                            const myBalance = players.find(p => p.id === myId)?.balance ?? 0;
                            return (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '8px', zIndex: 10 }}>
                                    <p style={{ color: 'var(--danger)', fontWeight: 'bold', margin: '0', textAlign: 'center' }}>У вас долг! Продайте имущество.</p>
                                    <button
                                        className="action-btn"
                                        onClick={() => {
                                            if (window.confirm("Вы уверены, что хотите СДАТЬСЯ? Вы покинете игру, а всё ваше имущество уйдет за долги!")) {
                                                socket.emit('resolve_event', { code: roomId, action: 'declare_bankruptcy', force: true });
                                            }
                                        }}
                                        style={{ background: '#555', color: '#fff', fontSize: '12px' }}
                                    >
                                        ☠️ Сдаться и выйти из игры
                                    </button>
                                    <button
                                        className="action-btn"
                                        onClick={() => socket.emit('resolve_event', { code: roomId, action: 'end_turn' })}
                                        disabled={myBalance < 0}
                                        style={{ background: 'var(--primary-color)', color: '#fff', opacity: myBalance < 0 ? 0.5 : 1 }}
                                    >
                                        Погасил долг - Завершить ход
                                    </button>
                                </div>
                            );
                        })()}



                        {/* Action log feed inside board-center */}
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '2px',
                            marginTop: '6px',
                            width: '100%',
                            maxHeight: '150px',
                            overflowY: 'auto',
                            textAlign: 'left',
                        }}>
                            {actionLog.map((entry, i) => (
                                <div key={i} style={{
                                    fontSize: i === 0 ? '13px' : '11px',
                                    fontWeight: i === 0 ? 'bold' : 'normal',
                                    opacity: Math.max(1 - i * 0.2, 0.2),
                                    padding: '2px 6px',
                                    borderRadius: '4px',
                                    background: i === 0 ? 'rgba(0,0,0,0.07)' : 'transparent',
                                    color: 'var(--text-main)',
                                    lineHeight: '1.4',
                                    whiteSpace: 'normal',
                                    wordBreak: 'break-word',
                                }}>
                                    {entry}
                                </div>
                            ))}
                        </div>
                    </div>{/* /board-center */}

                    {cells.map((cell) => {
                        const pos = getGridPos(cell.id);
                        const isProperty = cell.type === 'property' || cell.type === 'station' || cell.type === 'utility';
                        const owner = players.find(p => p.id === cell.ownerId);

                        return (
                            <div
                                key={cell.id}
                                className={`cell ${getCellColor(cell.type)}`}
                                style={{
                                    gridArea: `${pos.row} / ${pos.col} / span 1 / span 1`
                                }}
                            >
                                {owner && <div className="owner-indicator" style={{ background: owner.color }}></div>}
                                {isProperty && cell.groupColor && (
                                    <div className="cell-color-band" style={{ background: cell.groupColor }}>
                                        {cell.level > 0 && (
                                            <div style={{ position: 'absolute', top: 0, left: 0, display: 'flex', width: '100%', justifyContent: 'center', color: '#FFF' }}>
                                                {'⭑'.repeat(cell.level)}
                                            </div>
                                        )}
                                    </div>
                                )}

                                <div className="cell-content">
                                    <span className="cell-name" style={{ fontSize: cellNameFontSize(cell.name), whiteSpace: 'pre-wrap' }}>{formatBoardName(cell.name)}</span>
                                    {cell.price && cell.type !== 'tax' && cell.type !== 'chance' && (
                                        <span className="cell-price">
                                            {owner
                                                ? (typeof calculateRent(cell) === 'string' ? calculateRent(cell) : `${(calculateRent(cell) as number) / 1000}k`)
                                                : `${cell.price / 1000}k`}
                                        </span>
                                    )}
                                </div>

                                {cell.isMortgaged && (
                                    <div className="mortgaged-overlay"><span>Заложено</span></div>
                                )}

                                <div style={{ position: 'absolute', bottom: '10%', left: 0, width: '100%', display: 'flex', flexDirection: 'column-reverse', alignItems: 'center' }}>
                                    {visualPlayers.filter(p => p.position === cell.id).map((p, idx, arr) => {
                                        const isOverlapping = arr.length > 2;
                                        return (
                                            <div
                                                key={p.id}
                                                className="player-token"
                                                style={{
                                                    marginBottom: (isOverlapping && idx > 0) ? '-16px' : (idx > 0 && !isOverlapping ? '2px' : '0'),
                                                    zIndex: 10 + idx
                                                }}
                                            >
                                                {p.icon}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>{/* /board */}
            </main>


            {/* Event Modals — only shown to the targeted player */}
            {
                activeEvent && (activeEvent.targetPlayerId === myId || activeEvent.type === 'trade') && (
                    <div className="modal-overlay">
                        <div className="modal-content">
                            {activeEvent.cell?.groupColor && (
                                <div className="property-banner" style={{ background: activeEvent.cell.groupColor }}>
                                    <div className="property-banner-inner">АКТИВ</div>
                                </div>
                            )}
                            <div className="modal-inner">
                                <div className="modal-title">{activeEvent.cell?.name || (activeEvent.type === 'trade' && 'Сделка')}</div>

                                {activeEvent.type === 'trade' && (
                                    <>
                                        <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '16px' }}>Обмен с Конкурентом.</p>

                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', textAlign: 'left', fontSize: '14px' }}>
                                            <div>
                                                <label>Игрок (если только деньги):</label>
                                                <select
                                                    style={{ width: '100%', padding: '8px', background: '#e0e0e0', color: '#000', border: '3px solid #000', borderRadius: '4px', marginTop: '4px', fontWeight: 'bold' }}
                                                    value={tradeTargetPlayerId}
                                                    onChange={(e) => setTradeTargetPlayerId(e.target.value)}
                                                >
                                                    <option value="">Выберите...</option>
                                                    {players.filter(p => p.id !== myId).map(p => (
                                                        <option key={p.id} value={p.id}>{p.name}</option>
                                                    ))}
                                                </select>
                                            </div>

                                            <div>
                                                <label>Запросить Актив:</label>
                                                <select
                                                    style={{ width: '100%', padding: '8px', background: '#e0e0e0', color: '#000', border: '3px solid #000', borderRadius: '4px', marginTop: '4px', fontWeight: 'bold' }}
                                                    value={tradeRequestPropertyId || ''}
                                                    onChange={(e) => setTradeRequestPropertyId(e.target.value ? Number(e.target.value) : null)}
                                                >
                                                    <option value="">Ничего</option>
                                                    {cells.filter(c => c.ownerId !== myId && c.ownerId !== null).map(c => (
                                                        <option key={c.id} value={c.id}>
                                                            {c.name} ({players.find(p => p.id === c.ownerId)?.name})
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>

                                            <div>
                                                <label>Ваш Актив:</label>
                                                <select
                                                    style={{ width: '100%', padding: '8px', background: '#e0e0e0', color: '#000', border: '3px solid #000', borderRadius: '4px', marginTop: '4px', fontWeight: 'bold' }}
                                                    value={tradeOfferPropertyId || ''}
                                                    onChange={(e) => setTradeOfferPropertyId(e.target.value ? Number(e.target.value) : null)}
                                                >
                                                    <option value="">Ничего</option>
                                                    {cells.filter(c => c.ownerId === myId).map(c => (
                                                        <option key={c.id} value={c.id}>{c.name}</option>
                                                    ))}
                                                </select>
                                            </div>

                                            <div>
                                                <label>Ваша доплата (₾):</label>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    style={{ width: '100%', padding: '8px', background: '#e0e0e0', color: '#000', border: '3px solid #000', borderRadius: '4px', marginTop: '4px', fontWeight: 'bold' }}
                                                    value={tradeOfferAmount}
                                                    onChange={(e) => setTradeOfferAmount(Number(e.target.value))}
                                                />
                                            </div>
                                        </div>

                                        <div className="btn-row" style={{ marginTop: '24px' }}>
                                            <button className="btn-pass" onClick={() => handleUserAction('cancel_trade')}>Отмена</button>
                                            <button className="btn-buy" onClick={() => handleUserAction('propose_trade')}>Предложить</button>
                                        </div>
                                    </>
                                )}

                                {activeEvent.type === 'trade_proposal' && (
                                    <>
                                        <div className="modal-title" style={{ color: 'var(--action-color)' }}>ПРЕДЛОЖЕНИЕ О СДЕЛКЕ</div>
                                        <p style={{ fontSize: '16px', fontWeight: 'bold' }}>{activeEvent.message}</p>
                                        <div className="btn-row" style={{ marginTop: '24px' }}>
                                            <button className="btn-pass" onClick={() => handleUserAction('reject_trade')}>Отклонить</button>
                                            <button className="btn-buy" onClick={() => handleUserAction('accept_trade')}>Принять</button>
                                        </div>
                                    </>
                                )}

                                {activeEvent.type === 'buy' && activeEvent.cell && (
                                    <>
                                        <p style={{ color: 'var(--text-muted)', fontSize: '14px', fontWeight: 'bold' }}>Свободная территория</p>
                                        <div className="modal-price">{activeEvent.cell.price?.toLocaleString('ru-RU')} ₾</div>
                                        {(players.find(p => p.id === myId)?.balance ?? 0) < (activeEvent.cell.price ?? 0) && (
                                            <button
                                                className="action-btn"
                                                style={{ width: '100%', marginBottom: '12px', padding: '8px', fontSize: '13px', background: '#f5f5f5', color: '#333', border: '2px solid #ccc' }}
                                                onClick={() => setShowAssetsModal(true)}
                                            >
                                                💼 Заложить активы для покупки
                                            </button>
                                        )}
                                        <div className="btn-row">
                                            <button className="btn-buy" onClick={() => handleUserAction('buy')}>Купить</button>
                                            <button className="btn-pass" onClick={() => handleUserAction('pass')}>Аукцион</button>
                                        </div>
                                    </>
                                )}

                                {activeEvent.type === 'auction' && activeEvent.cell && auctionState && (
                                    <>
                                        <div className="modal-title" style={{ color: 'var(--primary-color)' }}>АУКЦИОН</div>
                                        <p style={{ fontWeight: 'bold' }}>{activeEvent.cell.name}</p>
                                        <div className="modal-price" style={{ background: 'var(--primary-color)' }}>{auctionState.highestBid.toLocaleString()} ₾</div>
                                        <p style={{ color: 'var(--text-muted)' }}>
                                            Лидер: {auctionState.highestBidderId ? players.find(p => p.id === auctionState.highestBidderId)?.name : 'Нет'}
                                        </p>
                                        {(() => {
                                            const isMyTurnToBid = auctionState.participantIds && auctionState.participantIds[auctionState.activeBidderIndex] === myId;
                                            const nextBidAmount = auctionState.highestBidderId ? auctionState.highestBid + 10000 : auctionState.highestBid;
                                            const canAfford = (players.find(p => p.id === myId)?.balance || 0) >= nextBidAmount;

                                            return isMyTurnToBid ? (
                                                <div className="btn-row">
                                                    <button
                                                        className="btn-buy"
                                                        disabled={!canAfford}
                                                        onClick={() => socket.emit('resolve_event', { code: roomId, action: 'bid' })}
                                                    >
                                                        Ставить ({nextBidAmount.toLocaleString()} ₾)
                                                    </button>
                                                    <button className="btn-pass" onClick={() => socket.emit('resolve_event', { code: roomId, action: 'pass' })}>Пас</button>
                                                </div>
                                            ) : (
                                                <p style={{ textAlign: 'center', marginTop: '16px', fontWeight: 'bold' }}>
                                                    Ожидание: {players.find(p => p.id === auctionState.participantIds?.[auctionState.activeBidderIndex])?.name || 'Игрока'}...
                                                </p>
                                            );
                                        })()}
                                    </>
                                )}

                                {activeEvent.type === 'upgrade' && activeEvent.cell && (
                                    <>
                                        <p style={{ color: 'var(--text-muted)', fontSize: '14px', fontWeight: 'bold' }}>Желаете улучшить бизнес?</p>
                                        <div className="modal-price" style={{ color: 'var(--text-main)' }}>-{activeEvent.amount?.toLocaleString('ru-RU')} ₾</div>
                                        <div className="btn-row">
                                            <button className="btn-buy" onClick={() => handleUserAction('upgrade')}>Улучшить</button>
                                            <button className="btn-pass" onClick={() => handleUserAction('pass')}>Пропустить</button>
                                        </div>
                                    </>
                                )}

                                {activeEvent.type === 'rent' && (
                                    <>
                                        <p style={{ color: 'var(--text-muted)', fontSize: '18px', fontWeight: 'bold' }}>Чужая территория</p>
                                        <div className="modal-price" style={{ color: 'var(--text-main)', background: 'var(--action-color)' }}>-{activeEvent.amount?.toLocaleString('ru-RU')} ₾</div>
                                        <div className="btn-row">
                                            <button className="btn-buy" style={{ background: 'var(--action-color)' }} onClick={() => handleUserAction('pay')}>Оплатить</button>
                                        </div>
                                    </>
                                )}

                                {activeEvent.type === 'chance' && (
                                    <>
                                        <div className="modal-title" style={{ color: 'var(--action-color)' }}>СЛУЧАЙНОСТЬ</div>
                                        <p style={{ fontSize: '16px', fontWeight: 'bold' }}>{activeEvent.message}</p>
                                        <div className="modal-price" style={{ background: activeEvent.amount! > 0 ? 'var(--success)' : 'var(--danger)' }}>
                                            {activeEvent.amount! > 0 ? '+' : ''}{Math.abs(activeEvent.amount!).toLocaleString('ru-RU')} ₾
                                        </div>
                                        <div className="btn-row">
                                            <button
                                                className="btn-buy"
                                                style={{ background: activeEvent.amount! < 0 ? 'var(--danger)' : undefined }}
                                                onClick={() => handleUserAction('pay')}
                                            >
                                                {activeEvent.amount! < 0 ? 'Оплатить' : 'Принять'}
                                            </button>
                                        </div>
                                    </>
                                )}

                                {activeEvent.type === 'tax' && activeEvent.cell && (
                                    <>
                                        <div className="modal-title" style={{ color: 'var(--danger)' }}>НАЛОГОВАЯ СЛУЖБА</div>
                                        <p style={{ color: 'var(--text-muted)', fontSize: '14px', fontWeight: 'bold' }}>Оплатите налог государству.</p>
                                        <div className="modal-price" style={{ background: 'var(--danger)' }}>-{activeEvent.amount?.toLocaleString('ru-RU')} ₾</div>
                                        <div className="btn-row">
                                            <button className="btn-buy" style={{ background: 'var(--danger)' }} onClick={() => handleUserAction('pay')}>Оплатить</button>
                                        </div>
                                    </>
                                )}

                            </div>
                        </div>
                    </div>
                )
            }

            {/* Manage Assets Modal */}
            {
                showAssetsModal && (
                    <div className="modal-overlay">
                        <div className="modal-content" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
                            <div className="modal-title" style={{ color: 'var(--text-main)' }}>УПРАВЛЕНИЕ АКТИВАМИ</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
                                {cells.filter(c => c.ownerId === myId && c.type === 'property').length === 0 && (
                                    <p style={{ color: 'var(--text-muted)' }}>У вас пока нет активов.</p>
                                )}
                                {cells.filter(c => c.ownerId === myId && c.type === 'property').map(c => {
                                    const mortgageValue = (c.price || 0) * 0.5;
                                    const unmortgageCost = Math.round(mortgageValue * 1.10);
                                    const upgradeCost = c.buildCost ?? (c.price || 0) * 0.5;
                                    const sellUpgradeGain = upgradeCost * 0.5;

                                    const groupProps = cells.filter(gc => gc.groupColor === c.groupColor && gc.type === 'property');
                                    const ownsAllGroup = groupProps.every(gc => gc.ownerId === myId);

                                    return (
                                        <div key={c.id} style={{ display: 'flex', flexDirection: 'column', padding: '8px', border: '1px solid #ccc', borderRadius: '8px', background: c.isMortgaged ? '#fdd' : '#fff' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <span style={{ fontWeight: 'bold', color: c.groupColor }}>{c.name} {c.isMortgaged ? '(В залоге)' : ''}</span>
                                                <span style={{ fontSize: '12px' }}>Ур. {c.level}</span>
                                            </div>

                                            <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
                                                {!c.isMortgaged && ownsAllGroup && c.level < 5 && (
                                                    <button
                                                        className="action-btn"
                                                        style={{ padding: '8px', fontSize: '12px', background: 'var(--success)', flex: 1 }}
                                                        onClick={() => {
                                                            const myPlayer = players.find(p => p.id === myId);
                                                            if ((myPlayer?.balance ?? 0) >= upgradeCost) {
                                                                socket.emit('resolve_event', { code: roomId, action: 'manual_upgrade', cellId: c.id });
                                                            } else {
                                                                alert('Недостаточно средств!');
                                                            }
                                                        }}
                                                    >
                                                        + Улучшить ({Math.round(upgradeCost / 1000)}k ₾)
                                                    </button>
                                                )}
                                                {!c.isMortgaged && c.level > 0 && (
                                                    <button
                                                        className="action-btn"
                                                        style={{ padding: '8px', fontSize: '12px', background: 'var(--danger)', color: '#fff', flex: 1 }}
                                                        onClick={() => {
                                                            if (window.confirm(`Продать филиал «${c.name}»? Вы получите +${Math.round(sellUpgradeGain / 1000)}k ₾.`)) {
                                                                socket.emit('resolve_event', { code: roomId, action: 'sell_upgrade', cellId: c.id });
                                                            }
                                                        }}
                                                    >
                                                        - Продать филиал (+{Math.round(sellUpgradeGain / 1000)}k ₾)
                                                    </button>
                                                )}
                                                {!c.isMortgaged && c.level === 0 && (
                                                    <button
                                                        className="action-btn"
                                                        style={{ padding: '8px', fontSize: '12px', background: 'var(--danger)', color: '#fff', flex: 1 }}
                                                        onClick={() => {
                                                            if (window.confirm(`Заложить «${c.name}»? Вы получите +${Math.round(mortgageValue / 1000)}k ₾, но аренда с неё не будет взиматься.`)) {
                                                                socket.emit('resolve_event', { code: roomId, action: 'mortgage', cellId: c.id });
                                                            }
                                                        }}
                                                    >
                                                        Заложить (+{Math.round(mortgageValue / 1000)}k ₾)
                                                    </button>
                                                )}
                                                {c.isMortgaged && (
                                                    <button
                                                        className="action-btn"
                                                        style={{ padding: '8px', fontSize: '12px', background: 'var(--success)', flex: 1 }}
                                                        onClick={() => {
                                                            const myPlayer = players.find(p => p.id === myId);
                                                            if ((myPlayer?.balance ?? 0) >= unmortgageCost) {
                                                                socket.emit('resolve_event', { code: roomId, action: 'unmortgage', cellId: c.id });
                                                            } else {
                                                                alert('Недостаточно средств!');
                                                            }
                                                        }}
                                                    >
                                                        Выкупить (-{Math.round(unmortgageCost / 1000)}k ₾)
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            <div className="btn-row" style={{ marginTop: '16px' }}>
                                <button className="btn-pass" style={{ width: '100%' }} onClick={() => setShowAssetsModal(false)}>Закрыть</button>
                            </div>
                        </div>
                    </div>
                )
            }
        </div >
    );
};

export default App;
