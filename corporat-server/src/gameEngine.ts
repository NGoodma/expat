import { GameRoom, Player, CellData, BOARD_CONFIG, BOARD_SIZE } from './models';

// Utility to push log to everyone
export function logAction(room: GameRoom, msg: string) {
    room.actionLog.push(msg);
    if (room.actionLog.length > 50) room.actionLog.shift();
}

export function endTurn(room: GameRoom) {
    console.log(`[Trace] endTurn called. Room: ${room.id}, turnIndex was: ${room.turnIndex}`);
    const currentPlayer = room.players[room.turnIndex];

    // ---- Bankruptcy check ----
    if (currentPlayer.balance < 0) {
        logAction(room, `Банкротство! ${currentPlayer.name} выбывает из игры.`);
        const creditor = room.players.find(p => p.id === currentPlayer.debtTo);

        if (creditor) {
            creditor.balance += currentPlayer.balance;
            logAction(room, `Его активы уходят к ${creditor.name}.`);
        }

        room.cells.forEach(c => {
            if (c.ownerId === currentPlayer.id) {
                if (creditor) {
                    c.ownerId = creditor.id;
                } else {
                    c.ownerId = null;
                    c.level = 0;
                    c.isMortgaged = false;
                }
            }
        });
        currentPlayer.balance = 0;
        currentPlayer.isReady = false;
    }

    room.activeEvent = null;

    // ---- Check for winner (only non-bankrupt players) ----
    const activePlayers = room.players.filter(p => p.balance >= 0);
    if (activePlayers.length === 1) {
        logAction(room, `🏆 ${activePlayers[0].name} побеждает! Игра окончена!`);
        room.state = 'finished';
        return;
    }
    if (activePlayers.length === 0) {
        room.state = 'finished';
        return;
    }

    // ---- Grant extra turn on double ONLY if player is free (not in jail) ----
    if (currentPlayer.doubleCount > 0 && !currentPlayer.isInJail) {
        logAction(room, `${currentPlayer.name} бросает кубики еще раз (дубль)!`);
        return; // Stay on current player
    }

    // ---- Reset double counter ----
    currentPlayer.doubleCount = 0;

    // ---- Find next active (non-bankrupt) player ----
    const total = room.players.length;
    let nextIndex = (room.turnIndex + 1) % total;
    let tries = 0;
    while (!room.players[nextIndex].isReady && tries < total) {
        nextIndex = (nextIndex + 1) % total;
        tries++;
    }

    room.turnIndex = nextIndex;
    logAction(room, `Ход переходит к ${room.players[nextIndex].name}`);
}

export function sendToJail(room: GameRoom, pIndex: number) {
    const p = room.players[pIndex];
    p.position = 10;          // Jail cell index
    p.isInJail = true;        // canonical jail flag
    p.jailRolls = 0;          // failed attempts: 0 so far
    p.doubleCount = 0;        // no bonus roll when arriving at jail
    logAction(room, `${p.name} отправляется под Арест!`);
}

export function calculateRent(room: GameRoom, cell: CellData, diceTotal?: number): number {
    if (cell.isMortgaged) return 0;

    // ── Utility (Silknet / Magticom) ─────────────────────────────────────────
    if (cell.type === 'utility') {
        const bothOwned = room.cells
            .filter(c => c.type === 'utility')
            .every(c => c.ownerId === cell.ownerId);
        const multiplier = bothOwned ? 10000 : 4000;
        return multiplier * (diceTotal ?? 7);
    }

    // ── Station (Banks) ───────────────────────────────────────────────────────
    if (cell.type === 'station') {
        const stationsOwned = room.cells
            .filter(c => c.type === 'station' && c.ownerId === cell.ownerId).length;
        // 1→25k, 2→50k, 3→100k, 4→200k (doubles each time)
        return 25000 * Math.pow(2, stationsOwned - 1);
    }

    // ── Property ─────────────────────────────────────────────────────────────
    if (!cell.rentBase) return 0;
    if (cell.level === 0) {
        // Check monopoly (owns full color group)
        const groupCells = room.cells.filter(c => c.groupColor === cell.groupColor && c.type === 'property');
        const hasMonopoly = groupCells.every(c => c.ownerId === cell.ownerId);
        return hasMonopoly ? (cell.rentMonopoly ?? cell.rentBase * 2) : cell.rentBase;
    }
    if (cell.level === 1) return cell.rent1h ?? 0;
    if (cell.level === 2) return cell.rent2h ?? 0;
    if (cell.level === 3) return cell.rent3h ?? 0;
    if (cell.level === 4) return cell.rent4h ?? 0;
    if (cell.level >= 5) return cell.rentHotel ?? 0;
    return cell.rentBase;
}

// Returns true if turn was ended, false if activeEvent was set (caller must NOT call endTurn)
export function evaluateCellLanding(room: GameRoom, pIndex: number, cellId: number): boolean {
    const p = room.players[pIndex];
    const cell = room.cells.find(c => c.id === cellId);
    if (!cell) return true;

    if (cell.type === 'property' || cell.type === 'station' || cell.type === 'utility') {
        if (!cell.ownerId) {
            room.activeEvent = { type: 'buy', cell, targetPlayerId: p.id };
            return false;
        } else if (cell.ownerId === p.id) {
            const upgradeCost = cell.buildCost ?? cell.price! * 0.5;
            if (cell.level < 5 && cell.type === 'property') {
                const groupProps = room.cells.filter(c => c.groupColor === cell.groupColor && c.type === 'property');
                const ownsAllGroup = groupProps.every(c => c.ownerId === p.id);
                if (!ownsAllGroup) {
                    logAction(room, `Для улучшения нужно собрать весь цвет: ${cell.groupColor}`);
                    endTurn(room);
                    return true;
                } else {
                    room.activeEvent = { type: 'upgrade', cell, amount: upgradeCost, targetPlayerId: p.id };
                    return false;
                }
            } else {
                endTurn(room);
                return true;
            }
        } else {
            const rent = calculateRent(room, cell);
            room.activeEvent = { type: 'rent', cell, amount: rent, targetPlayerId: p.id };
            return false;
        }
    } else if (cell.type === 'tax') {
        const tax = cell.price || 200000;
        room.activeEvent = { type: 'tax', cell, amount: tax, targetPlayerId: p.id };
        return false;
    } else if (cell.type === 'chance' || cell.type === 'chest') {
        const chanceAmount = Math.random() > 0.5 ? 200000 : -100000;
        const msg = chanceAmount > 0 ? "Удачные дивиденды!" : "Штраф от Налоговой!";
        room.activeEvent = { type: 'chance', cell, amount: chanceAmount, message: msg, targetPlayerId: p.id };
        return false;
    } else {
        if (cell.type === 'gotojail') {
            sendToJail(room, pIndex);        // resets doubleCount + isInJail = true
        } else if (cell.type === 'parking') {
            p.skipNextTurn = true;
            logAction(room, `${p.name} попадает на Визаран и будет пропускать следующий ход!`);
        } else if (cell.type === 'jail') {
            logAction(room, `${p.name} проходит мимо Ареста.`);
        } else {
            logAction(room, `${p.name} отдыхает на ${cell.name}.`);
        }
        endTurn(room);
        return true;
    }
}

export function movePlayer(room: GameRoom, pIndex: number, amount: number): boolean {
    const p = room.players[pIndex];
    let passedGo = false;

    let targetPos = p.position + amount;
    if (targetPos >= BOARD_SIZE) {
        targetPos = targetPos % BOARD_SIZE;
        passedGo = true;
    }

    if (room.lastRoll) {
        room.lastRoll.intermediatePosition = targetPos;
    }

    p.position = targetPos;

    let logMsg = `${p.name} переместился на ${amount}. `;
    if (passedGo) {
        logMsg += 'Круг пройден: +200k ₾. ';
        p.balance += 200000;
    }

    logAction(room, logMsg);
    return evaluateCellLanding(room, pIndex, targetPos);
}

export function rollDice(room: GameRoom, playerId: string) {
    room.lastActionTime = Date.now();
    console.log(`[GameEngine] Roll. Room: ${room.id}, Turn: ${room.turnIndex}, TurnPlayer: ${room.players[room.turnIndex].id}, Requester: ${playerId}`);

    if (room.players[room.turnIndex].id !== playerId) {
        console.log('[GameEngine] Not your turn, ignoring.');
        return;
    }
    if (room.activeEvent) {
        console.log('[GameEngine] Active event blocks roll.');
        return;
    }

    const pIndex = room.turnIndex;
    const p = room.players[pIndex];

    // ---- Визаран skip ----
    if (p.skipNextTurn) {
        p.skipNextTurn = false;
        logAction(room, `${p.name} на Визаране (пропускает ход).`);
        room.lastRoll = { r1: 0, r2: 0, playerId: p.id, wasSkipTurn: true };
        endTurn(room);
        return;
    }

    logAction(room, `${p.name} кидает кубики...`);

    const r1 = Math.floor(Math.random() * 6) + 1;
    const r2 = Math.floor(Math.random() * 6) + 1;
    const total = r1 + r2;
    const isDouble = r1 === r2;

    room.lastRoll = { r1, r2, playerId: p.id };

    logAction(room, `Выпало: ${r1} и ${r2} (всего ${total})`);

    if (p.isInJail) {
        // ---- Player is in JAIL ----
        if (isDouble) {
            logAction(room, `ДУБЛЬ! ${p.name} выходит из Ареста!`);
            p.isInJail = false;
            p.jailRolls = 0;
            p.doubleCount = 0;  // No bonus roll for jail-escape double
            movePlayer(room, pIndex, total);
        } else if (p.jailRolls >= 2) {
            // 3rd failed attempt (jailRolls: 0→1→2) — forced bail
            logAction(room, `Третья неудачная попытка! ${p.name} выходит на залог.`);
            p.isInJail = false;
            p.jailRolls = 0;
            movePlayer(room, pIndex, total);
        } else {
            p.jailRolls += 1;
            logAction(room, `Нет дубля. ${p.name} остаётся под Арестом (попытка ${p.jailRolls}/3).`);
            endTurn(room);
        }
    } else {
        // ---- Normal roll ----
        if (isDouble) {
            logAction(room, `ДУБЛЬ!`);
            p.doubleCount += 1;
            if (p.doubleCount >= 3) {
                logAction(room, `${p.name} выбросил 3 дубля подряд и отправляется под Арест!`);
                sendToJail(room, pIndex);
                endTurn(room);
                return;
            }
        } else {
            p.doubleCount = 0;
        }
        movePlayer(room, pIndex, total);
        // movePlayer → evaluateCellLanding handles endTurn internally
    }
}

// ---- Event Resolvers ----
export function resolveEvent(room: GameRoom, playerId: string, payload: any) {
    room.lastActionTime = Date.now();
    const action = payload.action;
    const cellId = payload.cellId;
    console.log(`[Trace] resolveEvent | playerId: ${playerId}, action: ${action}`);
    console.log(`[Trace] activeEvent:`, JSON.stringify(room.activeEvent));

    const pIndex = room.players.findIndex(p => p.id === playerId);
    if (pIndex === -1) return;
    const p = room.players[pIndex];
    const isTheirTurn = room.turnIndex === pIndex;

    // ---- Free actions (can be done to raise funds even if event is active) ----
    if (isTheirTurn) {
        let isFreeAction = true;

        if (action === 'pay_bail' && !room.activeEvent) {
            if (p.isInJail && p.balance >= 50000) {
                p.balance -= 50000;
                p.isInJail = false;
                p.jailRolls = 0;
                logAction(room, `${p.name} заплатил залог 50k ₾ и вышел на свободу! Теперь бросьте кубики.`);
            }
        } else if (action === 'end_turn' && !room.activeEvent) {
            if (p.balance >= 0) endTurn(room);
        } else if (action === 'declare_bankruptcy') {
            if (p.balance < 0) endTurn(room);
        } else if (action === 'manual_upgrade' && cellId !== undefined && !room.activeEvent) {
            const c = room.cells.find(c => c.id === cellId);
            if (c && c.ownerId === p.id && c.type === 'property' && c.level < 5) {
                const upgradeCost = c.buildCost ?? c.price! * 0.5;
                if (p.balance >= upgradeCost) {
                    p.balance -= upgradeCost;
                    c.level += 1;
                    logAction(room, `${p.name} улучшает ${c.name} (ур. ${c.level})`);
                }
            }
        } else if (action === 'sell_upgrade' && cellId !== undefined) {
            const c = room.cells.find(c => c.id === cellId);
            if (c && c.ownerId === p.id && c.level > 0) {
                const gain = (c.buildCost ?? c.price! * 0.5) * 0.5;
                p.balance += gain;
                c.level -= 1;
                logAction(room, `${p.name} продает филиал ${c.name} (+${gain / 1000}k ₾)`);
            }
        } else if (action === 'mortgage' && cellId !== undefined) {
            const c = room.cells.find(c => c.id === cellId);
            if (c && c.ownerId === p.id && c.level === 0 && !c.isMortgaged) {
                const val = c.price! * 0.5;
                p.balance += val;
                c.isMortgaged = true;
                logAction(room, `${p.name} закладывает ${c.name} (+${val / 1000}k ₾)`);
            }
        } else if (action === 'unmortgage' && cellId !== undefined && !room.activeEvent) {
            const c = room.cells.find(c => c.id === cellId);
            if (c && c.ownerId === p.id && c.isMortgaged) {
                const val = Math.round(c.price! * 0.5 * 1.1);
                if (p.balance >= val) {
                    p.balance -= val;
                    c.isMortgaged = false;
                    logAction(room, `${p.name} выкупает ${c.name} (-${val / 1000}k ₾)`);
                }
            }
        } else if (action === 'propose_trade' && !room.activeEvent) {
            const targetId = payload.tradeTargetPlayerId;
            const offerCellId = payload.tradeOfferPropertyId;
            const requestCellId = payload.tradeRequestPropertyId;
            const offerAmount = payload.tradeOfferAmount || 0;

            if (p.balance >= offerAmount) {
                const targetPlayer = room.players.find(pl => pl.id === targetId);
                let valid = !!targetPlayer;

                if (valid && offerCellId) {
                    const offerCell = room.cells.find(c => c.id === offerCellId);
                    if (!offerCell || offerCell.ownerId !== p.id || offerCell.level > 0) valid = false;
                }

                if (valid && requestCellId) {
                    const requestCell = room.cells.find(c => c.id === requestCellId);
                    if (!requestCell || requestCell.ownerId !== targetId || requestCell.level > 0) valid = false;
                }

                if (valid) {
                    const offerName = offerCellId ? room.cells.find(c => c.id === offerCellId)?.name : '';
                    const requestName = requestCellId ? room.cells.find(c => c.id === requestCellId)?.name : '';

                    let msg = `${p.name} предлагает сделку: `;
                    if (offerName || offerAmount > 0) msg += `Отдает ${offerName} ${offerAmount > 0 ? '+ ' + offerAmount + ' ₾' : ''}`;
                    if (requestName) msg += ` в обмен на ${requestName}`;

                    logAction(room, msg);
                    room.activeEvent = {
                        type: 'trade_proposal',
                        targetPlayerId: targetId,
                        initiatorId: p.id,
                        tradeOfferPropertyId: offerCellId,
                        tradeRequestPropertyId: requestCellId,
                        tradeOfferAmount: offerAmount,
                        message: msg
                    };
                }
            }
        } else {
            isFreeAction = false;
        }

        if (isFreeAction) return; // Return after free-actions to prevent popup-section bleed
    }

    // ---- Popup / modal resolution ----
    const ev = room.activeEvent;
    if (!ev || ev.targetPlayerId !== playerId) return;

    if (action === 'accept_trade' && ev.type === 'trade_proposal') {
        const initiator = room.players.find(pl => pl.id === ev.initiatorId);
        if (!initiator) return;
        if (initiator.balance < ev.tradeOfferAmount) {
            logAction(room, `Сделка сорвалась: у ${initiator.name} недостаточно средств.`);
            room.activeEvent = null;
            return;
        }
        if (ev.tradeOfferPropertyId) {
            const cell = room.cells.find(c => c.id === ev.tradeOfferPropertyId);
            if (cell && cell.ownerId === initiator.id && cell.level === 0) {
                cell.ownerId = p.id;
            } else {
                logAction(room, `Сделка сорвалась: Актив инициатора недоступен.`);
                room.activeEvent = null;
                return;
            }
        }
        if (ev.tradeRequestPropertyId) {
            const cell = room.cells.find(c => c.id === ev.tradeRequestPropertyId);
            if (cell && cell.ownerId === p.id && cell.level === 0) {
                cell.ownerId = initiator.id;
            } else {
                logAction(room, `Сделка сорвалась: Ваш актив недоступен.`);
                room.activeEvent = null;
                return;
            }
        }
        initiator.balance -= ev.tradeOfferAmount;
        p.balance += ev.tradeOfferAmount;
        logAction(room, `${p.name} принимает сделку от ${initiator.name}!`);
        room.activeEvent = null;

    } else if (action === 'reject_trade' && ev.type === 'trade_proposal') {
        logAction(room, `${p.name} отклоняет сделку.`);
        room.activeEvent = null;

    } else if (action === 'buy' && ev.type === 'buy') {
        if (p.balance >= ev.cell.price) {
            p.balance -= ev.cell.price;
            const targetCell = room.cells.find(c => c.id === ev.cell.id);
            if (targetCell) targetCell.ownerId = p.id;
            logAction(room, `${p.name} покупает ${ev.cell.name}!`);
            endTurn(room);
        }

    } else if (action === 'pass' && ev.type === 'buy') {
        logAction(room, `${p.name} отказывается от покупки. Начинается аукцион!`);
        // Only include active (non-bankrupt) players in auction
        const auctionParticipants = room.players.filter(pl => pl.isReady).map(pl => pl.id);
        room.auctionState = {
            cellId: ev.cell.id,
            highestBid: 10000,
            highestBidderId: null,
            participantIds: auctionParticipants,
            activeBidderIndex: (auctionParticipants.indexOf(p.id) + 1) % auctionParticipants.length
        };
        room.activeEvent = {
            type: 'auction',
            cell: ev.cell,
            targetPlayerId: room.auctionState.participantIds[room.auctionState.activeBidderIndex]
        };

    } else if (action === 'bid' && ev.type === 'auction' && room.auctionState) {
        const bidAmount = room.auctionState.highestBid + 10000;
        if (p.balance >= bidAmount) {
            room.auctionState.highestBid = bidAmount;
            room.auctionState.highestBidderId = p.id;
            logAction(room, `${p.name} ставит ${bidAmount} ₾.`);
            nextAuctionTurn(room, true);
        }

    } else if (action === 'pass' && ev.type === 'auction' && room.auctionState) {
        logAction(room, `${p.name} выходит из аукциона.`);
        const pIndexInAuction = room.auctionState.participantIds.indexOf(p.id);
        if (pIndexInAuction !== -1) {
            room.auctionState.participantIds.splice(pIndexInAuction, 1);
            if (room.auctionState.activeBidderIndex >= room.auctionState.participantIds.length) {
                room.auctionState.activeBidderIndex = 0;
            }
            nextAuctionTurn(room, false);
        }

    } else if (action === 'upgrade' && ev.type === 'upgrade') {
        if (p.balance >= ev.amount) {
            p.balance -= ev.amount;
            const targetCell = room.cells.find(c => c.id === ev.cell.id);
            if (targetCell) targetCell.level += 1;
            logAction(room, `${p.name} улучшает ${ev.cell.name} до ур. ${targetCell?.level}!`);
        }
        endTurn(room);

    } else if (action === 'pass' && ev.type === 'upgrade') {
        endTurn(room);

    } else if (action === 'pay' && ev.type === 'rent') {
        const owner = room.players.find(pl => pl.id === ev.cell.ownerId);
        if (owner) {
            owner.balance += ev.amount;
            p.debtTo = owner.id;
        } else {
            p.debtTo = null;
        }
        p.balance -= ev.amount;
        logAction(room, `${p.name} платит аренду ${ev.amount} ₾.`);
        room.activeEvent = null;
        if (p.balance >= 0) {
            p.debtTo = null;
            endTurn(room);
        } else {
            logAction(room, `ВНИМАНИЕ: ${p.name} в ДОЛГАХ! Продайте активы, чтобы выжить.`);
        }

    } else if (action === 'pay' && ev.type === 'tax') {
        p.balance -= ev.amount;
        p.debtTo = null;
        logAction(room, `${p.name} платит налог ${ev.amount} ₾.`);
        room.activeEvent = null;
        if (p.balance >= 0) {
            endTurn(room);
        } else {
            logAction(room, `ВНИМАНИЕ: ${p.name} в ДОЛГАХ! Продайте активы, чтобы выжить.`);
        }

    } else if (action === 'pay' && ev.type === 'chance') {
        p.balance += ev.amount;
        p.debtTo = null;
        room.activeEvent = null;
        if (p.balance >= 0) {
            endTurn(room);
        } else {
            logAction(room, `ВНИМАНИЕ: ${p.name} в ДОЛГАХ! Продайте активы, чтобы выжить.`);
        }
    }
}

// ---- Auction helper ----
function nextAuctionTurn(room: GameRoom, advanceIndex: boolean) {
    if (!room.auctionState) return;

    // ---- Only 1 participant = winner ----
    if (room.auctionState.participantIds.length <= 1) {
        const winnerId = room.auctionState.highestBidderId;
        if (winnerId) {
            const winner = room.players.find(p => p.id === winnerId);
            if (winner) {
                winner.balance -= room.auctionState.highestBid;
                const targetCell = room.cells.find(c => c.id === room.auctionState!.cellId);
                if (targetCell) targetCell.ownerId = winner.id;
                logAction(room, `${winner.name} выигрывает аукцион за ${room.auctionState.highestBid} ₾!`);
            }
        } else {
            logAction(room, `Аукцион завершен без победителя.`);
        }
        room.auctionState = null;
        room.activeEvent = null;
        endTurn(room);
        return;
    }

    // ---- Advance or keep index ----
    if (advanceIndex) {
        room.auctionState.activeBidderIndex = (room.auctionState.activeBidderIndex + 1) % room.auctionState.participantIds.length;
    } else {
        room.auctionState.activeBidderIndex = room.auctionState.activeBidderIndex % room.auctionState.participantIds.length;
    }

    const nextBidderId = room.auctionState.participantIds[room.auctionState.activeBidderIndex];

    // ---- If it's back to the highest bidder, they win ----
    if (nextBidderId === room.auctionState.highestBidderId) {
        const winner = room.players.find(p => p.id === nextBidderId);
        if (winner) {
            winner.balance -= room.auctionState.highestBid;
            const targetCell = room.cells.find(c => c.id === room.auctionState!.cellId);
            if (targetCell) targetCell.ownerId = winner.id;
            logAction(room, `${winner.name} выигрывает аукцион за ${room.auctionState.highestBid} ₾!`);
        }
        room.auctionState = null;
        room.activeEvent = null;
        endTurn(room);
        return;
    }

    if (room.activeEvent) {
        room.activeEvent.targetPlayerId = nextBidderId;
    }
}

// ---- Bot AI ----
export function botTick(room: GameRoom): boolean {
    if (room.state !== 'playing') return false;

    // Pace bots so human can see animations
    if (Date.now() - room.lastActionTime < 1200) return false;

    // ---- Handle events targeting ANY bot regardless of turn ----
    // (e.g. trade_proposal initiated by a human targeting a bot)
    if (room.activeEvent) {
        const targetBot = room.players.find(
            p => p.isBot && p.id === room.activeEvent?.targetPlayerId
        );
        if (targetBot) {
            room.lastActionTime = Date.now();
            const ev = room.activeEvent;
            if (ev.type === 'trade_proposal') {
                resolveEvent(room, targetBot.id, { action: 'reject_trade' });
            } else if (ev.type === 'rent' || ev.type === 'tax' || ev.type === 'chance') {
                resolveEvent(room, targetBot.id, { action: 'pay' });
            } else if (ev.type === 'buy') {
                resolveEvent(room, targetBot.id, { action: targetBot.balance >= ev.cell.price * 1.5 ? 'buy' : 'pass' });
            } else if (ev.type === 'auction' && room.auctionState) {
                const canBid = room.auctionState.highestBid < targetBot.balance * 0.4 && room.auctionState.highestBid < 300000;
                resolveEvent(room, targetBot.id, { action: canBid ? 'bid' : 'pass' });
            } else if (ev.type === 'upgrade') {
                resolveEvent(room, targetBot.id, { action: 'pass' });
            }
            return true;
        }
        // Active event but not targeting a bot — nothing to do
        return false;
    }

    // ---- No active event: handle the current turn player if it's a bot ----
    const currentPlayer = room.players[room.turnIndex];
    if (!currentPlayer || !currentPlayer.isBot) return false;

    room.lastActionTime = Date.now();

    // Handle Визаран skip explicitly
    if (currentPlayer.skipNextTurn) {
        currentPlayer.skipNextTurn = false;
        logAction(room, `${currentPlayer.name} на Визаране (пропускает ход).`);
        room.lastRoll = { r1: 0, r2: 0, playerId: currentPlayer.id, wasSkipTurn: true };
        endTurn(room);
    } else if (currentPlayer.isInJail && currentPlayer.balance >= 50000 && Math.random() > 0.5) {
        resolveEvent(room, currentPlayer.id, { action: 'pay_bail' });
    } else if (currentPlayer.balance >= 0) {
        rollDice(room, currentPlayer.id);
    } else {
        endTurn(room);
    }
    return true;
}
