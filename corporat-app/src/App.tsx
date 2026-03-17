import React, { useCallback, useEffect, useState } from 'react';
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

// Feed entry: player chat message
type FeedEntry =
    { kind: 'chat'; text: string; id: number; playerId: string; playerName: string; playerColor: string };

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
    const [feedEntries, setFeedEntries] = useState<FeedEntry[]>([]);
    const [chatInput, setChatInput] = useState('');
    const [lastRoll, setLastRoll] = useState<{ r1: number, r2: number, playerId: string, intermediatePosition?: number } | null>(null);
    const [isRolling, setIsRolling] = useState(false);

    // Event Modals
    const [activeEvent, setActiveEvent] = useState<{
        type: 'buy' | 'upgrade' | 'rent' | 'chance' | 'tax' | 'trade' | 'bankrupt' | 'win' | 'auction' | 'trade_proposal';
        cell?: CellData;
        amount?: number;
        message?: string;
        targetPlayerId?: string;
        // trade_proposal fields
        initiatorId?: string;
        tradeOfferPropertyIds?: number[];
        tradeRequestPropertyIds?: number[];
        tradeOfferAmount?: number;
        tradeRequestAmount?: number;
    } | null>(null);

    const setMyIdSynced = (id: string) => {
        setMyId(id);
        myIdRef.current = id;
    };
    const [auctionState, setAuctionState] = useState<AuctionState | null>(null);

    // Assets Modal
    const [showAssetsModal, setShowAssetsModal] = useState<boolean>(false);

    // Connection status
    const [connectionStatus, setConnectionStatus] = useState<'connected' | 'reconnecting'>('connected');
    const [serverNotice, setServerNotice] = useState<string | null>(null);

    // Trade State
    const [tradeOfferAmount,   setTradeOfferAmount]   = useState<number>(0);
    const [tradeRequestAmount, setTradeRequestAmount] = useState<number>(0);
    const [tradeOfferPropertyIds,   setTradeOfferPropertyIds]   = useState<number[]>([]);
    const [tradeRequestPropertyIds, setTradeRequestPropertyIds] = useState<number[]>([]);
    const [tradeTargetPlayerId, setTradeTargetPlayerId] = useState<string>('');

    const resetTradeState = () => {
        setTradeOfferAmount(0);
        setTradeRequestAmount(0);
        setTradeOfferPropertyIds([]);
        setTradeRequestPropertyIds([]);
        setTradeTargetPlayerId('');
    };

    const sendChatMessage = () => {
        const text = chatInput.trim().slice(0, 200);
        if (!text || !roomId) return;
        socket.emit('chat_message', { code: roomId, text });
        setChatInput('');
    };

    useEffect(() => {
        feedEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [feedEntries]);

    const toggleId = (list: number[], setList: (v: number[]) => void, id: number) => {
        setList(list.includes(id) ? list.filter(x => x !== id) : list.length < 3 ? [...list, id] : list);
    };

    const orchestratorRef = React.useRef({ isAnimating: false });
    // Use a ref for myId so handleRoomUpdate always reads the current value (avoids stale closure)
    const myIdRef = React.useRef('');
    const animatingTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // Client-side failsafe: started at the moment of click, independent of room_update
    const clickFailsafeRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const feedEndRef = React.useRef<HTMLDivElement>(null);
    const feedIdRef = React.useRef(0);

    const [keyboardHeight, setKeyboardHeight] = useState(0);
    const [vvHeight, setVvHeight] = useState(0);

    const tg = window.Telegram?.WebApp;

    useEffect(() => {
        if (tg) {
            tg.expand();
            tg.ready();
        }
    }, [tg]);

    // Detect keyboard via VisualViewport
    useEffect(() => {
        const vv = window.visualViewport;
        if (!vv) return;
        let baseHeight = vv.height;
        const t = setTimeout(() => { baseHeight = vv.height; }, 600);
        const handleResize = () => {
            const kh = Math.max(0, baseHeight - vv.height);
            setKeyboardHeight(kh);
            setVvHeight(kh > 50 ? vv.height : 0);
        };
        vv.addEventListener('resize', handleResize);
        return () => { clearTimeout(t); vv.removeEventListener('resize', handleResize); };
    }, []);

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

        // Clear any previous failsafe
        if (clickFailsafeRef.current) clearTimeout(clickFailsafeRef.current);
        if (animatingTimeoutRef.current) clearTimeout(animatingTimeoutRef.current);
        animatingTimeoutRef.current = null;

        // CLIENT-SIDE failsafe: if no room_update resets us within 8 seconds, force reset.
        // This catches: disconnects, deleted rooms, server crashes — anything that prevents
        // a room_update from arriving.
        clickFailsafeRef.current = setTimeout(() => {
            if (orchestratorRef.current.isAnimating) {
                console.warn('[App] Click failsafe triggered — no room_update received in 8s');
                setIsRolling(false);
                orchestratorRef.current.isAnimating = false;
            }
        }, 8000);

        socket.emit('roll_dice', { code: roomId });
    };

    const handleUserAction = (actionType: string) => {
        if (!activeEvent) return;
        if (actionType === 'propose_trade') {
            if (!tradeTargetPlayerId) {
                alert('Выберите игрока для сделки!');
                return;
            }
            if (tradeOfferPropertyIds.length === 0 && tradeOfferAmount === 0 &&
                tradeRequestPropertyIds.length === 0 && tradeRequestAmount === 0) {
                alert('Добавьте хотя бы один актив или сумму в сделку!');
                return;
            }
            socket.emit('resolve_event', {
                code: roomId,
                action: 'propose_trade',
                tradeTargetPlayerId,
                tradeOfferPropertyIds,
                tradeRequestPropertyIds,
                tradeOfferAmount,
                tradeRequestAmount,
            });
            setActiveEvent(null);
            resetTradeState();
        } else if (actionType === 'cancel_trade') {
            setActiveEvent(null);
            resetTradeState();
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
            const owned = cells.filter(c => c.type === 'station' && c.ownerId === cell.ownerId && !c.isMortgaged).length;
            return 25000 * Math.pow(2, owned - 1);
        }
        if (cell.type === 'utility') {
            const bothOwned = cells.filter(c => c.type === 'utility').every(c => c.ownerId === cell.ownerId && !c.isMortgaged);
            return bothOwned ? '🎲x10k' : '🎲x4k';
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
            //case 'Горизонтальное кафе Фрик': return 'Горизонт.\nкафе Фрик';
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
                    // We clicked "roll dice" and are waiting for the result.
                    // Cancel the click-failsafe since we got a room_update.
                    if (clickFailsafeRef.current) {
                        clearTimeout(clickFailsafeRef.current);
                        clickFailsafeRef.current = null;
                    }

                    const currentMyId = myIdRef.current;
                    // Determine if this room_update contains OUR dice result
                    const isOurRoll = room.lastRoll
                        && !room.lastRoll.wasSkipTurn
                        && room.lastRoll.playerId === currentMyId;

                    if (isOurRoll) {
                        // Only start the animation timer once per roll.
                        // Subsequent room_updates (e.g. from bot actions) must NOT
                        // restart it, otherwise the dice spin indefinitely.
                        if (!animatingTimeoutRef.current) {

                        // Stage 1: show dice spin for 1s, then reveal result
                        // We capture room in closure — this is the authoritative state for THIS roll.
                        const capturedRoom = room;
                        animatingTimeoutRef.current = setTimeout(() => {
                            setIsRolling(false);
                            setLastRoll(capturedRoom.lastRoll || null);

                            // Stage 2: let pawn walk, then show event modal
                            animatingTimeoutRef.current = setTimeout(() => {
                                setActiveEvent(capturedRoom.activeEvent as any);
                                orchestratorRef.current.isAnimating = false;
                                animatingTimeoutRef.current = null;
                            }, 1500);
                        }, 1000);
                        }
                    } else {
                        // Got a room_update but it's not our roll result (e.g. bot move,
                        // skip turn, or stale). Reset animation immediately.
                        if (animatingTimeoutRef.current) clearTimeout(animatingTimeoutRef.current);
                        setIsRolling(false);
                        setLastRoll(room.lastRoll || null);
                        setActiveEvent(room.activeEvent as any);
                        orchestratorRef.current.isAnimating = false;
                        animatingTimeoutRef.current = null;
                    }
                } else {
                    // Not our animation — but always ensure dice aren't stuck spinning.
                    setIsRolling(false);
                    setLastRoll(room.lastRoll || null);
                    setActiveEvent(room.activeEvent as any);
                    // Close Assets modal if a blocking event arrived (rent, tax, trade proposal, etc.)
                    if (room.activeEvent && room.activeEvent.type !== 'buy') {
                        setShowAssetsModal(false);
                    }
                }

                if (room.auctionState !== undefined) setAuctionState(room.auctionState as any);
                // Close assets modal if it's no longer the user's turn
                const updatedMyId = myIdRef.current;
                const updatedIsUserTurn = room.players[room.turnIndex]?.id === updatedMyId;
                if (!updatedIsUserTurn) {
                    setShowAssetsModal(false);
                }
                // Refresh session TTL while the game is active
                localStorage.setItem('corporat_roomTimestamp', String(Date.now()));
            }
        };

        const handleReconnect = () => {
            console.log('[App] Socket reconnected! Re-joining room...');
            setConnectionStatus('connected');
            if (roomId) {
                const playerId = localStorage.getItem('corporat_playerId');
                if (playerId) {
                    socket.emit('rejoin_room', { code: roomId, playerId }, (res: any) => {
                        if (res.success && socket.id) {
                            console.log('[App] Rejoin successful. New socket.id:', socket.id);
                            setMyIdSynced(socket.id);
                        } else {
                            // Server restarted and lost the room — go back to lobby
                            console.warn('[App] Rejoin failed — room was lost (server restart?).');
                            setServerNotice('Сервер перезапустился, комната потеряна. Начните новую игру.');
                            setRoomState('lobby');
                        }
                    });
                }
            }
        };

        const handleDisconnect = (reason: string) => {
            console.warn('[App] Socket disconnected. Reason:', reason);
            setConnectionStatus('reconnecting');
        };

        const handleServerNotice = (data: { type: string; message: string }) => {
            console.warn('[App] Server notice received:', data);
            setServerNotice(data.message);
        };

        const handleChatBroadcast = (data: { playerId: string; playerName: string; playerColor: string; text: string }) => {
            setFeedEntries(prev => [...prev, {
                kind: 'chat' as const,
                text: data.text,
                id: feedIdRef.current++,
                playerId: data.playerId,
                playerName: data.playerName,
                playerColor: data.playerColor,
            }]);
        };

        socket.on('room_update', handleRoomUpdate);
        socket.on('connect', handleReconnect);
        socket.on('disconnect', handleDisconnect);
        socket.on('server_notice', handleServerNotice);
        socket.on('chat_broadcast', handleChatBroadcast);

        return () => {
            socket.off('room_update', handleRoomUpdate);
            socket.off('connect', handleReconnect);
            socket.off('disconnect', handleDisconnect);
            socket.off('server_notice', handleServerNotice);
            socket.off('chat_broadcast', handleChatBroadcast);
        };
    }, [roomId]);

    const handleGameStart = useCallback((room: GameRoom, id: string) => {
        setMyIdSynced(id);
        setRoomId(room.id);
        setPlayers(room.players);
        setVisualPlayers(room.players);
        setCells(room.cells);
        setTurnIndex(room.turnIndex);
        setRoomState('playing');
        setFeedEntries([]);
        setChatInput('');
        feedIdRef.current = 0;
    }, []);

    const connectionBanner = (connectionStatus === 'reconnecting' || serverNotice) ? (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0,
            background: serverNotice ? '#c0392b' : '#e67e22',
            color: '#fff', padding: '10px 16px', textAlign: 'center',
            fontSize: '14px', fontWeight: 'bold', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
        }}>
            {serverNotice
                ? <>{serverNotice} <button onClick={() => setServerNotice(null)} style={{ marginLeft: '8px', background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '18px', lineHeight: '1' }}>✕</button></>
                : '⏳ Переподключение к серверу…'
            }
        </div>
    ) : null;

    if (roomState === 'lobby') {
        return (
            <>
                {connectionBanner}
                <Lobby onGameStart={handleGameStart} />
            </>
        );
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
            {connectionBanner}
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

            <main
                className="board-container"
            >
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
                                        disabled={!isUserTurn || isUserInDebt || activeEvent !== null || isRolling}
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

            {/* Chat + Log feed panel */}
            <div className="comic-panel" style={keyboardHeight > 0 ? {
                position: 'fixed' as const,
                top: 0,
                left: 0,
                right: 0,
                height: `${vvHeight}px`,
                zIndex: 500,
                display: 'flex',
                flexDirection: 'column',
                padding: '6px 8px',
                gap: '4px',
                borderRadius: 0,
            } : {
                display: 'flex',
                flexDirection: 'column',
                flexShrink: 0,
                height: '170px',
                padding: '6px 8px 6px',
                gap: '4px',
            }}>
                {/* Scrollable feed */}
                <div style={{
                    flex: 1,
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '3px',
                    textAlign: 'left',
                    minHeight: 0,
                }}>
                    {feedEntries.length === 0 && (
                        <div style={{ fontSize: '11px', fontStyle: 'italic', opacity: 0.4, padding: '2px 4px' }}>Чат появится здесь…</div>
                    )}
                    {feedEntries.map(entry => (
                        <div key={entry.id} style={{
                            padding: '4px 8px',
                            borderRadius: '6px',
                            borderLeft: `4px solid ${entry.playerColor}`,
                            background: 'rgba(255,255,255,0.65)',
                            wordBreak: 'break-word',
                            flexShrink: 0,
                        }}>
                            <div style={{ marginBottom: '2px' }}>
                                {(() => {
                                    const hex = entry.playerColor.replace('#', '');
                                    const r = parseInt(hex.substr(0, 2), 16) / 255;
                                    const g = parseInt(hex.substr(2, 2), 16) / 255;
                                    const b = parseInt(hex.substr(4, 2), 16) / 255;
                                    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                                    return (
                                        <span style={{
                                            display: 'inline-block',
                                            background: lum > 0.5 ? '#1a1a1a' : entry.playerColor,
                                            color: lum > 0.5 ? entry.playerColor : '#fff',
                                            borderRadius: '4px',
                                            padding: '1px 5px',
                                            fontSize: '10px',
                                            fontWeight: 'bold',
                                            letterSpacing: '0.3px',
                                        }}>
                                            {entry.playerName}
                                        </span>
                                    );
                                })()}
                            </div>
                            <div style={{ fontSize: '13px', color: 'var(--text-main)', lineHeight: '1.4' }}>
                                {entry.text}
                            </div>
                        </div>
                    ))}
                    <div ref={feedEndRef} />
                </div>
                {/* Chat input row */}
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                    <input
                        type="text"
                        value={chatInput}
                        onChange={e => setChatInput(e.target.value.slice(0, 200))}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); } }}
                        placeholder="Сообщение..."
                        style={{
                            flex: 1,
                            padding: '6px 8px',
                            border: '2px solid var(--border-color)',
                            borderRadius: '6px',
                            background: 'rgba(255,255,255,0.85)',
                            fontSize: '12px',
                            color: 'var(--text-main)',
                            minWidth: 0,
                            outline: 'none',
                            fontFamily: 'var(--font-family)',
                        }}
                    />
                    <button
                        onClick={sendChatMessage}
                        disabled={!chatInput.trim()}
                        style={{
                            padding: '6px 12px',
                            border: '2px solid var(--border-color)',
                            borderRadius: '6px',
                            background: 'var(--primary-color)',
                            color: '#111',
                            fontWeight: 'bold',
                            fontSize: '16px',
                            cursor: chatInput.trim() ? 'pointer' : 'default',
                            opacity: chatInput.trim() ? 1 : 0.45,
                            flexShrink: 0,
                            lineHeight: '1',
                            minHeight: '36px',
                        }}
                    >
                        ➤
                    </button>
                </div>
            </div>

            {/* Event Modals — only shown to the targeted player */}
            {
                activeEvent && (activeEvent.targetPlayerId === myId || activeEvent.type === 'trade') && (
                    <div className="modal-overlay">
                        <div className="modal-content" style={activeEvent.type === 'trade' ? { maxHeight: '90vh', overflowY: 'auto' } : undefined}>
                            {activeEvent.cell?.groupColor && (
                                <div className="property-banner" style={{ background: activeEvent.cell.groupColor }}>
                                    <div className="property-banner-inner">АКТИВ</div>
                                </div>
                            )}
                            <div className="modal-inner">
                                <div className="modal-title">{activeEvent.cell?.name || (activeEvent.type === 'trade' && 'Сделка')}</div>

                                {activeEvent.type === 'trade' && (() => {
                                    const otherPlayers = players.filter(p => p.id !== myId && p.position >= 0);
                                    const target = players.find(p => p.id === tradeTargetPlayerId);
                                    // Assets filtered by selected target
                                    const theirCells = cells.filter(c =>
                                        tradeTargetPlayerId ? c.ownerId === tradeTargetPlayerId : (c.ownerId !== myId && c.ownerId !== null)
                                    ).filter(c => c.level === 0);
                                    const myCells = cells.filter(c => c.ownerId === myId && c.level === 0);

                                    const AssetChip = ({ cell, selected, onToggle }: { cell: any, selected: boolean, onToggle: () => void }) => (
                                        <button
                                            onClick={onToggle}
                                            style={{
                                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                padding: '4px 8px', borderRadius: '6px', cursor: 'pointer',
                                                border: selected ? '2px solid #000' : '2px solid transparent',
                                                background: selected ? cell.groupColor || '#555' : 'rgba(0,0,0,0.08)',
                                                color: selected ? '#fff' : '#222',
                                                fontWeight: 'bold', fontSize: '11px',
                                                textShadow: selected ? '0 0 3px #000' : 'none',
                                                opacity: (!selected && (cell.ownerId === myId ? tradeOfferPropertyIds.length >= 3 : tradeRequestPropertyIds.length >= 3)) ? 0.4 : 1,
                                                transition: 'all 0.12s',
                                            }}
                                        >
                                            {cell.groupColor && (
                                                <span style={{ width: 8, height: 8, borderRadius: '50%', background: cell.groupColor, border: '1px solid rgba(0,0,0,0.4)', flexShrink: 0 }} />
                                            )}
                                            {cell.name}
                                        </button>
                                    );

                                    return (
                                        <>
                                            {/* ── Top: choose player + what you want ── */}
                                            <div style={{ background: 'rgba(0,0,0,0.04)', borderRadius: '10px', padding: '10px', marginBottom: '8px', textAlign: 'left' }}>
                                                <div style={{ fontWeight: 'bold', fontSize: '11px', textTransform: 'uppercase', opacity: 0.5, marginBottom: '6px' }}>Я хочу получить от…</div>

                                                {/* Player picker */}
                                                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
                                                    {otherPlayers.map(op => (
                                                        <button
                                                            key={op.id}
                                                            onClick={() => {
                                                                setTradeTargetPlayerId(op.id);
                                                                setTradeRequestPropertyIds([]);
                                                            }}
                                                            style={{
                                                                display: 'inline-flex', alignItems: 'center', gap: '5px',
                                                                padding: '5px 10px', borderRadius: '20px', cursor: 'pointer',
                                                                border: tradeTargetPlayerId === op.id ? '2px solid #000' : '2px solid transparent',
                                                                background: tradeTargetPlayerId === op.id ? op.color : 'rgba(0,0,0,0.08)',
                                                                color: tradeTargetPlayerId === op.id ? '#fff' : '#222',
                                                                fontWeight: 'bold', fontSize: '12px',
                                                                textShadow: tradeTargetPlayerId === op.id ? '0 0 4px #000' : 'none',
                                                            }}
                                                        >
                                                            <span>{op.icon}</span>
                                                            <span>{op.name}</span>
                                                        </button>
                                                    ))}
                                                </div>

                                                {/* Their assets */}
                                                {theirCells.length > 0 && (
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '6px' }}>
                                                        {theirCells.map(c => (
                                                            <AssetChip key={c.id} cell={c}
                                                                selected={tradeRequestPropertyIds.includes(c.id)}
                                                                onToggle={() => {
                                                                    if (!tradeTargetPlayerId && c.ownerId) {
                                                                        setTradeTargetPlayerId(c.ownerId);
                                                                        setTradeRequestPropertyIds([c.id]);
                                                                    } else {
                                                                        toggleId(tradeRequestPropertyIds, setTradeRequestPropertyIds, c.id);
                                                                    }
                                                                }}
                                                            />
                                                        ))}
                                                    </div>
                                                )}

                                                {/* Request cash */}
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                                                    <span style={{ fontSize: '12px', opacity: 0.6, whiteSpace: 'nowrap' }}>+ Доплата:</span>
                                                    <input type="number" min="0" step="10000"
                                                        value={tradeRequestAmount || ''}
                                                        onChange={e => setTradeRequestAmount(Math.max(0, Number(e.target.value)))}
                                                        placeholder="0 ₾"
                                                        style={{ flex: 1, padding: '4px 6px', border: '2px solid #ccc', borderRadius: '6px', fontWeight: 'bold', fontSize: '13px', minWidth: 0 }}
                                                    />
                                                    <span style={{ fontSize: '12px' }}>₾</span>
                                                </div>
                                            </div>

                                            {/* ── Bottom: what you offer ── */}
                                            <div style={{ background: 'rgba(0,0,0,0.04)', borderRadius: '10px', padding: '10px', textAlign: 'left' }}>
                                                <div style={{ fontWeight: 'bold', fontSize: '11px', textTransform: 'uppercase', opacity: 0.5, marginBottom: '6px' }}>Я предлагаю взамен</div>

                                                {myCells.length > 0 && (
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '6px' }}>
                                                        {myCells.map(c => (
                                                            <AssetChip key={c.id} cell={c}
                                                                selected={tradeOfferPropertyIds.includes(c.id)}
                                                                onToggle={() => toggleId(tradeOfferPropertyIds, setTradeOfferPropertyIds, c.id)}
                                                            />
                                                        ))}
                                                    </div>
                                                )}

                                                {/* Offer cash */}
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                                                    <span style={{ fontSize: '12px', opacity: 0.6, whiteSpace: 'nowrap' }}>+ Доплата:</span>
                                                    <input type="number" min="0" step="10000"
                                                        value={tradeOfferAmount || ''}
                                                        onChange={e => setTradeOfferAmount(Math.max(0, Number(e.target.value)))}
                                                        placeholder="0 ₾"
                                                        style={{ flex: 1, padding: '4px 6px', border: '2px solid #ccc', borderRadius: '6px', fontWeight: 'bold', fontSize: '13px', minWidth: 0 }}
                                                    />
                                                    <span style={{ fontSize: '12px' }}>₾</span>
                                                </div>
                                            </div>

                                            {/* ── Summary line ── */}
                                            {(tradeRequestPropertyIds.length > 0 || tradeOfferPropertyIds.length > 0 || tradeOfferAmount > 0 || tradeRequestAmount > 0) && (
                                                <div style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '8px 0 0', textAlign: 'center' }}>
                                                    {tradeOfferPropertyIds.length > 0 && <span>Вы отдаёте: {tradeOfferPropertyIds.map(id => cells.find(c => c.id === id)?.name).join(', ')}{tradeOfferAmount > 0 ? ` + ${tradeOfferAmount.toLocaleString('ru-RU')} ₾` : ''}</span>}
                                                    {tradeOfferPropertyIds.length === 0 && tradeOfferAmount > 0 && <span>Вы отдаёте: {tradeOfferAmount.toLocaleString('ru-RU')} ₾</span>}
                                                    {(tradeRequestPropertyIds.length > 0 || tradeRequestAmount > 0) && (
                                                        <span> → {tradeRequestPropertyIds.map(id => cells.find(c => c.id === id)?.name).join(', ')}{tradeRequestAmount > 0 ? ` + ${tradeRequestAmount.toLocaleString('ru-RU')} ₾` : ''}</span>
                                                    )}
                                                </div>
                                            )}

                                            <div className="btn-row" style={{ marginTop: '12px' }}>
                                                <button className="btn-pass" onClick={() => handleUserAction('cancel_trade')}>Отмена</button>
                                                <button className="btn-buy"
                                                    disabled={!tradeTargetPlayerId}
                                                    style={{ opacity: tradeTargetPlayerId ? 1 : 0.5 }}
                                                    onClick={() => handleUserAction('propose_trade')}
                                                >
                                                    Предложить {target ? `→ ${target.name}` : ''}
                                                </button>
                                            </div>
                                        </>
                                    );
                                })()}

                                {activeEvent.type === 'trade_proposal' && (() => {
                                    const initiator = players.find(p => p.id === activeEvent.initiatorId);
                                    const offerIds:   number[] = activeEvent.tradeOfferPropertyIds   || [];
                                    const requestIds: number[] = activeEvent.tradeRequestPropertyIds || [];
                                    const offerAmt   = activeEvent.tradeOfferAmount   || 0;
                                    const requestAmt = activeEvent.tradeRequestAmount || 0;

                                    const CellBadge = ({ id }: { id: number }) => {
                                        const c = cells.find(x => x.id === id);
                                        if (!c) return null;
                                        return (
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: c.groupColor || '#555', color: '#fff', borderRadius: '6px', padding: '3px 8px', fontSize: '12px', fontWeight: 'bold', textShadow: '0 0 3px #000' }}>
                                                {c.groupColor && <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff', opacity: 0.8, flexShrink: 0 }} />}
                                                {c.name}
                                            </span>
                                        );
                                    };

                                    return (
                                        <>
                                            <div className="modal-title" style={{ color: 'var(--action-color)' }}>ПРЕДЛОЖЕНИЕ О СДЕЛКЕ</div>
                                            {initiator && (
                                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: initiator.color, borderRadius: '20px', padding: '4px 12px', margin: '4px 0 10px', border: '2px solid #000' }}>
                                                    <span>{initiator.icon}</span>
                                                    <span style={{ fontWeight: 'bold', color: '#fff', textShadow: '0 0 3px #000', fontSize: '13px' }}>{initiator.name}</span>
                                                </div>
                                            )}
                                            {/* What initiator offers */}
                                            <div style={{ background: 'rgba(0,0,0,0.04)', borderRadius: '8px', padding: '8px 10px', marginBottom: '6px', textAlign: 'left' }}>
                                                <div style={{ fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', opacity: 0.5, marginBottom: '5px' }}>Предлагает вам</div>
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                                                    {offerIds.map(id => <CellBadge key={id} id={id} />)}
                                                    {offerAmt > 0 && <span style={{ fontWeight: 'bold', color: 'var(--success)', fontSize: '13px' }}>+{offerAmt.toLocaleString('ru-RU')} ₾</span>}
                                                    {offerIds.length === 0 && offerAmt === 0 && <span style={{ opacity: 0.4, fontSize: '12px' }}>ничего</span>}
                                                </div>
                                            </div>
                                            {/* What initiator requests */}
                                            <div style={{ background: 'rgba(0,0,0,0.04)', borderRadius: '8px', padding: '8px 10px', textAlign: 'left' }}>
                                                <div style={{ fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', opacity: 0.5, marginBottom: '5px' }}>Хочет получить</div>
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                                                    {requestIds.map(id => <CellBadge key={id} id={id} />)}
                                                    {requestAmt > 0 && <span style={{ fontWeight: 'bold', color: 'var(--danger)', fontSize: '13px' }}>−{requestAmt.toLocaleString('ru-RU')} ₾</span>}
                                                    {requestIds.length === 0 && requestAmt === 0 && <span style={{ opacity: 0.4, fontSize: '12px' }}>ничего</span>}
                                                </div>
                                            </div>
                                            <div className="btn-row" style={{ marginTop: '16px' }}>
                                                <button className="btn-pass" onClick={() => handleUserAction('reject_trade')}>Отклонить</button>
                                                <button className="btn-buy" onClick={() => handleUserAction('accept_trade')}>Принять</button>
                                            </div>
                                        </>
                                    );
                                })()}

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
                                {cells.filter(c => c.ownerId === myId && (c.type === 'property' || c.type === 'station' || c.type === 'utility')).length === 0 && (
                                    <p style={{ color: 'var(--text-muted)' }}>У вас пока нет активов.</p>
                                )}
                                {cells.filter(c => c.ownerId === myId && (c.type === 'property' || c.type === 'station' || c.type === 'utility')).map(c => {
                                    const mortgageValue = (c.price ?? 0) * 0.5;
                                    const unmortgageCost = mortgageValue > 0 ? Math.round(mortgageValue * 1.10) : 0;
                                    const upgradeCost = c.buildCost ?? (c.price ?? 0) * 0.5;
                                    const sellUpgradeGain = upgradeCost > 0 ? upgradeCost * 0.5 : 0;

                                    const groupProps = c.type === 'property'
                                        ? cells.filter(gc => gc.groupColor === c.groupColor && gc.type === 'property')
                                        : [];
                                    const ownsAllGroup = groupProps.length > 0 && groupProps.every(gc => gc.ownerId === myId);
                                    const noneMortgaged = groupProps.length === 0 || groupProps.every(gc => !gc.isMortgaged);
                                    const minGroupLevel = groupProps.length > 0 ? Math.min(...groupProps.map(gc => gc.level)) : 0;
                                    const maxGroupLevel = groupProps.length > 0 ? Math.max(...groupProps.map(gc => gc.level)) : 0;
                                    const groupHasBranches = groupProps.some(gc => gc.level > 0);
                                    const myPlayer = players.find(p => p.id === myId);

                                    // Причины блокировки кнопок монополией
                                    const upgradeMonopolyReason =
                                        !noneMortgaged ? 'Нельзя строить, пока в монополии есть заложенные карточки' :
                                        c.level > minGroupLevel ? 'Все активы одной монополии должны развиваться равномерно' :
                                        '';
                                    const sellMonopolyReason =
                                        c.level < maxGroupLevel ? 'Все активы одной монополии должны сворачиваться равномерно' :
                                        '';
                                    const mortgageMonopolyReason =
                                        groupHasBranches ? 'Нельзя заложить актив, пока в монополии есть филиалы' :
                                        '';

                                    const disabledStyle: React.CSSProperties = { opacity: 0.45, cursor: 'not-allowed' };

                                    return (
                                        <div key={c.id} style={{ display: 'flex', flexDirection: 'column', padding: '8px', border: '1px solid #ccc', borderRadius: '8px', background: c.isMortgaged ? '#fdd' : '#fff' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <span style={{ fontWeight: 'bold', color: c.groupColor, textShadow: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000' }}>{c.name} {c.isMortgaged ? '(В залоге)' : ''}</span>
                                                <span style={{ fontSize: '12px' }}>Ур. {c.level}</span>
                                            </div>

                                            <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
                                                {c.type === 'property' && !c.isMortgaged && ownsAllGroup && c.level < 5 && (
                                                    <button
                                                        className="action-btn"
                                                        disabled={!!upgradeMonopolyReason}
                                                        title={upgradeMonopolyReason || undefined}
                                                        style={{ padding: '8px', fontSize: '12px', background: 'var(--success)', flex: 1, ...(upgradeMonopolyReason ? disabledStyle : {}) }}
                                                        onClick={() => {
                                                            if (upgradeMonopolyReason) { alert(upgradeMonopolyReason); return; }
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
                                                {c.type === 'property' && !c.isMortgaged && c.level > 0 && (
                                                    <button
                                                        className="action-btn"
                                                        disabled={!!sellMonopolyReason}
                                                        title={sellMonopolyReason || undefined}
                                                        style={{ padding: '8px', fontSize: '12px', background: 'var(--danger)', color: '#fff', flex: 1, ...(sellMonopolyReason ? disabledStyle : {}) }}
                                                        onClick={() => {
                                                            if (sellMonopolyReason) { alert(sellMonopolyReason); return; }
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
                                                        disabled={!!mortgageMonopolyReason}
                                                        title={mortgageMonopolyReason || undefined}
                                                        style={{ padding: '8px', fontSize: '12px', background: 'var(--danger)', color: '#fff', flex: 1, ...(mortgageMonopolyReason ? disabledStyle : {}) }}
                                                        onClick={() => {
                                                            if (mortgageMonopolyReason) { alert(mortgageMonopolyReason); return; }
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
