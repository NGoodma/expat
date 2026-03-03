import { GameRoom, Player, CellData, BOARD_CONFIG, BOARD_SIZE } from './models';

// Utility to push log to everyone
export function logAction(room: GameRoom, msg: string) {
    room.actionLog.push(msg);
    if (room.actionLog.length > 50) room.actionLog.shift();
}

export function endTurn(room: GameRoom) {
    console.log(`[Trace] endTurn called. Room: ${room.id}, turnIndex was: ${room.turnIndex}`);
    const currentPlayer = room.players[room.turnIndex];

    // Guard: turnIndex out of bounds (e.g. player was spliced out)
    if (!currentPlayer) {
        console.error(`[endTurn] currentPlayer is undefined (turnIndex=${room.turnIndex}, players=${room.players.length}). Resetting to 0.`);
        room.turnIndex = 0;
        return;
    }

    // ---- Bankruptcy check ----
    if (currentPlayer.balance < 0) {
        logAction(room, `Банкротство! ${currentPlayer.name} выбывает из игры.`);

        const creditorId = currentPlayer.debtTo ?? null;
        const debtAmount = -currentPlayer.balance; // positive number

        if (creditorId) {
            // Creditor receives the debt amount in cash; assets go back to the market
            const creditor = room.players.find(p => p.id === creditorId);
            if (creditor) {
                creditor.balance += debtAmount;
                logAction(room, `${creditor.name} получает ${debtAmount.toLocaleString('ru-RU')} ₾ от банкротства ${currentPlayer.name}.`);
            }
        }

        // All assets go back to the market (improvements stripped, mortgages cleared)
        room.cells.forEach(c => {
            if (c.ownerId === currentPlayer.id) {
                c.ownerId = null;
                c.level = 0;
                c.isMortgaged = false;
            }
        });

        currentPlayer.balance = 0;
        currentPlayer.isReady = false;
        currentPlayer.doubleCount = 0; // prevent bankrupt player from getting an extra turn
        // position = -1 is the "off-board" sentinel: token won't render on any cell
        currentPlayer.position = -1;
    }

    room.activeEvent = null;

    // ---- Check for winner (only non-bankrupt players) ----
    // position >= 0 is the reliable "still in the game" marker;
    // bankrupt players are set to position = -1 above.
    const activePlayers = room.players.filter(p => p.position >= 0);
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
    // Skip: bankrupt players (position < 0)  OR  disconnected humans (!isReady && !isBot).
    // Bots are always isReady=true so they're never skipped by the second condition.
    const canTakeTurn = (p: Player) => p.position >= 0 && (p.isReady || !!p.isBot);
    const total = room.players.length;
    let nextIndex = (room.turnIndex + 1) % total;
    let tries = 0;
    while (!canTakeTurn(room.players[nextIndex]) && tries < total) {
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
        const hasMonopoly = groupCells.every(c => c.ownerId === cell.ownerId && !c.isMortgaged);
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
            // Own property: no modal — upgrades are done via the Assets menu
            endTurn(room);
            return true;
        } else {
            const diceTotal = room.lastRoll ? (room.lastRoll.r1 + room.lastRoll.r2) : 7;
            const rent = calculateRent(room, cell, diceTotal);
            room.activeEvent = { type: 'rent', cell, amount: rent, targetPlayerId: p.id };
            return false;
        }
    } else if (cell.type === 'tax') {
        const tax = cell.price || 200000;
        room.activeEvent = { type: 'tax', cell, amount: tax, targetPlayerId: p.id };
        return false;
    } else if (cell.type === 'chance' || cell.type === 'chest') {
        const CHANCE_CARDS = [
            { amount: 200000, msg: "Нашел 'своего' риелтора. Сдали старую квартиру айтишникам вдвое дороже." },
            { amount: 150000, msg: "Внезапный проект на Бали. Старый заказчик закрыл сделку в крипте." },
            { amount: 50000, msg: "Обменник у Авлабари. Поменяли валюту по невероятно выгодному курсу." },
            { amount: 300000, msg: "Удачный нетворкинг в Фабрике. Нашли инвестора за пинтой крафта." },
            { amount: 50000, msg: "Сосед угостил домашним вином. Сэкономили на походе в бар." },
            { amount: 100000, msg: "Выиграл в нарды у таксиста. Он расстроился и не взял деньги за поездку." },
            { amount: 80000, msg: "Открытие ИП в Доме Юстиции. Одобрили за 15 минут, сэкономили на помогаторе." },
            { amount: 120000, msg: "Tax Free сработал. Вернули налог за купленный в поездке Макбук." },
            { amount: 250000, msg: "Нашли ковёр у Сухого Моста. Продали как антиквариат коллекционеру." },
            { amount: 100000, msg: "Провели экскурсию. Приехали друзья и оплачивали все счета всю неделю." },
            { amount: -100000, msg: "Оплата коммуналки зимой. Счет за газ от Tbilisi Energy пришел космический." },
            { amount: -200000, msg: "Хозяин 'делает ремонт'. Попросили съехать завтра, пришлось платить комиссию за новое жилье." },
            { amount: -50000, msg: "Модное кафе в Ваке. Фильтр-кофе и авокадо тост по цене ужина в ресторане." },
            { amount: -80000, msg: "Купили Б/У Мак на MyMarket. Оказался с привязанным профилем чьей-то компании." },
            { amount: -150000, msg: "Отравление хинкали. Три дня на полисорбе и визит в клинику." },
            { amount: -250000, msg: "Кошка порвала обои. Хозяин снял с вас полную стоимость ремонта новостройки." },
            { amount: -300000, msg: "Отказал банк TBC. Заморозили счет без причин, пришлось платить юристам." },
            { amount: -70000, msg: "Штраф за парковку на Ваке. Припарковались «на 5 минут» за врапом." },
            { amount: -30000, msg: "Чурчхела на Руставели. Продавец понял, что вы иностранец, и продал втридорога." },
            { amount: -100000, msg: "Подписка на 5 VPN. Забыли отменить, со всех карт списались деньги за год вперед." }
        ];

        const card = CHANCE_CARDS[Math.floor(Math.random() * CHANCE_CARDS.length)];

        room.activeEvent = { type: 'chance', cell, amount: card.amount, message: card.msg, targetPlayerId: p.id };
        return false;
    } else {
        if (cell.type === 'gotojail') {
            sendToJail(room, pIndex);        // resets doubleCount + isInJail = true
        } else if (cell.type === 'parking') {
            p.skipNextTurn = true;
            p.doubleCount = 0; // Prevent extra turn if landed here via double roll
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

    const currentTurnPlayer = room.players[room.turnIndex];
    if (!currentTurnPlayer) {
        console.error(`[rollDice] turnIndex ${room.turnIndex} out of bounds (players: ${room.players.length}). Skipping.`);
        return;
    }
    console.log(`[GameEngine] Roll. Room: ${room.id}, Turn: ${room.turnIndex}, TurnPlayer: ${currentTurnPlayer.id}, Requester: ${playerId}`);

    if (currentTurnPlayer.id !== playerId) {
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
            logAction(room, `Третья неудачная попытка! ${p.name} принудительно платит штраф 50k ₾, ход окончен.`);
            p.balance -= 50000;
            p.isInJail = false;
            p.jailRolls = 0;
            if (p.balance >= 0) {
                endTurn(room);
            } else {
                logAction(room, `ВНИМАНИЕ: ${p.name} в ДОЛГАХ! Продайте активы, чтобы выжить.`);
            }
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
            if (p.balance < 0 || payload.force) {
                // If they have positive balance but force bankruptcy, set it to negative so endTurn() picks it up
                if (p.balance >= 0 && payload.force) p.balance = -1;
                endTurn(room);
            }
        } else if (action === 'manual_upgrade' && cellId !== undefined && !room.activeEvent) {
            const c = room.cells.find(c => c.id === cellId);
            if (c && c.ownerId === p.id && c.type === 'property' && c.level < 5) {
                const groupProps = room.cells.filter(gc => gc.groupColor === c.groupColor && gc.type === 'property');
                const ownsAll = groupProps.every(gc => gc.ownerId === p.id);
                const noneMortgaged = groupProps.every(gc => !gc.isMortgaged);
                const minLevel = groupProps.length > 0 ? Math.min(...groupProps.map(gc => gc.level)) : 0;

                if (!ownsAll) {
                    logAction(room, `Для улучшения нужно собрать весь цвет: ${c.groupColor}`);
                } else if (!noneMortgaged) {
                    logAction(room, `Нельзя строить, пока в группе есть заложенные карточки!`);
                } else if (c.level > minLevel) {
                    logAction(room, `Нужно строить равномерно! Сначала улучшите другие карточки цвета ${c.groupColor}`);
                } else {
                    const upgradeCost = c.buildCost ?? (c.price ?? 0) * 0.5;
                    if (p.balance >= upgradeCost) {
                        p.balance -= upgradeCost;
                        c.level += 1;
                        logAction(room, `${p.name} улучшает ${c.name} (ур. ${c.level})`);
                    }
                }
            }
        } else if (action === 'sell_upgrade' && cellId !== undefined) {
            const c = room.cells.find(c => c.id === cellId);
            if (c && c.ownerId === p.id && c.type === 'property' && c.level > 0) {
                const groupProps = room.cells.filter(gc => gc.groupColor === c.groupColor && gc.type === 'property');
                const maxLevel = groupProps.length > 0 ? Math.max(...groupProps.map(gc => gc.level)) : c.level;

                if (c.level < maxLevel) {
                    logAction(room, `Нужно продавать равномерно! Сначала продайте филиалы с более развитых карточек.`);
                } else {
                    const gain = (c.buildCost ?? (c.price ?? 0) * 0.5) * 0.5;
                    p.balance += gain;
                    c.level -= 1;
                    logAction(room, `${p.name} продает филиал ${c.name} (+${gain / 1000}k ₾)`);
                }
            }
        } else if (action === 'mortgage' && cellId !== undefined) {
            const c = room.cells.find(c => c.id === cellId);
            if (c && c.ownerId === p.id && c.level === 0 && !c.isMortgaged) {
                const groupProps = room.cells.filter(gc => gc.groupColor === c.groupColor && gc.type === 'property');
                const hasBranches = groupProps.some(gc => gc.level > 0);

                if (hasBranches) {
                    logAction(room, `Нельзя закладывать карточку, пока в этой группе есть филиалы!`);
                } else {
                    const val = c.price! * 0.5;
                    p.balance += val;
                    c.isMortgaged = true;
                    logAction(room, `${p.name} закладывает ${c.name} (+${val / 1000}k ₾)`);
                }
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
            const targetId       = payload.tradeTargetPlayerId;
            const offerCellIds: number[]   = (payload.tradeOfferPropertyIds   || []).slice(0, 3);
            const requestCellIds: number[] = (payload.tradeRequestPropertyIds || []).slice(0, 3);
            const offerAmount   = Math.max(0, payload.tradeOfferAmount   || 0);
            const requestAmount = Math.max(0, payload.tradeRequestAmount || 0);

            const targetPlayer = room.players.find(pl => pl.id === targetId);
            let valid = !!targetPlayer && p.balance >= offerAmount;

            // Validate offered cells (must be owned by initiator, no upgrades)
            for (const id of offerCellIds) {
                const cell = room.cells.find(c => c.id === id);
                if (!cell || cell.ownerId !== p.id || cell.level > 0) { valid = false; break; }
            }
            // Validate requested cells (must be owned by target, no upgrades)
            for (const id of requestCellIds) {
                const cell = room.cells.find(c => c.id === id);
                if (!cell || cell.ownerId !== targetId || cell.level > 0) { valid = false; break; }
            }
            // At least something must be on the table
            if (offerCellIds.length === 0 && requestCellIds.length === 0 && offerAmount === 0 && requestAmount === 0) valid = false;

            if (valid) {
                const offerNames   = offerCellIds.map(id   => room.cells.find(c => c.id === id)?.name).filter(Boolean).join(', ');
                const requestNames = requestCellIds.map(id => room.cells.find(c => c.id === id)?.name).filter(Boolean).join(', ');

                const offerParts: string[]   = [];
                const requestParts: string[] = [];
                if (offerNames)   offerParts.push(offerNames);
                if (offerAmount)  offerParts.push(`${offerAmount.toLocaleString('ru-RU')} ₾`);
                if (requestNames) requestParts.push(requestNames);
                if (requestAmount) requestParts.push(`${requestAmount.toLocaleString('ru-RU')} ₾`);

                let msg = `${p.name} предлагает сделку`;
                if (offerParts.length)   msg += `: отдаёт [${offerParts.join(' + ')}]`;
                if (requestParts.length) msg += ` за [${requestParts.join(' + ')}]`;

                logAction(room, msg);
                room.activeEvent = {
                    type: 'trade_proposal',
                    targetPlayerId: targetId,
                    initiatorId: p.id,
                    tradeOfferPropertyIds:   offerCellIds,
                    tradeRequestPropertyIds: requestCellIds,
                    tradeOfferAmount:   offerAmount,
                    tradeRequestAmount: requestAmount,
                    message: msg
                };
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

        const offerIds:   number[] = ev.tradeOfferPropertyIds   || (ev.tradeOfferPropertyId   != null ? [ev.tradeOfferPropertyId]   : []);
        const requestIds: number[] = ev.tradeRequestPropertyIds || (ev.tradeRequestPropertyId != null ? [ev.tradeRequestPropertyId] : []);
        const offerAmt   = ev.tradeOfferAmount   || 0;
        const requestAmt = ev.tradeRequestAmount || 0;

        if (initiator.balance < offerAmt) {
            logAction(room, `Сделка сорвалась: у ${initiator.name} недостаточно средств.`);
            room.activeEvent = null;
            return;
        }
        if (p.balance < requestAmt) {
            logAction(room, `Сделка сорвалась: у ${p.name} недостаточно средств.`);
            room.activeEvent = null;
            return;
        }

        // Validate offered cells still available
        for (const id of offerIds) {
            const cell = room.cells.find(c => c.id === id);
            if (!cell || cell.ownerId !== initiator.id || cell.level > 0) {
                logAction(room, `Сделка сорвалась: актив инициатора недоступен.`);
                room.activeEvent = null;
                return;
            }
        }
        // Validate requested cells still available
        for (const id of requestIds) {
            const cell = room.cells.find(c => c.id === id);
            if (!cell || cell.ownerId !== p.id || cell.level > 0) {
                logAction(room, `Сделка сорвалась: запрошенный актив недоступен.`);
                room.activeEvent = null;
                return;
            }
        }

        // Execute transfers
        for (const id of offerIds)   { room.cells.find(c => c.id === id)!.ownerId = p.id; }
        for (const id of requestIds) { room.cells.find(c => c.id === id)!.ownerId = initiator.id; }
        initiator.balance -= offerAmt;
        p.balance         += offerAmt;
        initiator.balance += requestAmt;
        p.balance         -= requestAmt;

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
        // Only include active (non-bankrupt) players in auction; exclude the player who passed
        const auctionParticipants = room.players.filter(pl => pl.isReady && pl.id !== p.id).map(pl => pl.id);
        if (auctionParticipants.length === 0) {
            // No one to auction to — skip
            logAction(room, `Аукцион отменён: нет участников.`);
            room.activeEvent = null;
            endTurn(room);
        } else {
            room.auctionState = {
                cellId: ev.cell.id,
                highestBid: ev.cell.price || 10000,
                highestBidderId: null,
                participantIds: auctionParticipants,
                activeBidderIndex: 0
            };
            room.activeEvent = {
                type: 'auction',
                cell: ev.cell,
                targetPlayerId: room.auctionState.participantIds[0]
            };
        }

    } else if (action === 'bid' && ev.type === 'auction' && room.auctionState) {
        const bidAmount = room.auctionState.highestBidderId ? room.auctionState.highestBid + 10000 : room.auctionState.highestBid;
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
        room.activeEvent = null; // Prevent double-clicks
        const owner = room.players.find(pl => pl.id === ev.cell.ownerId);
        if (owner) {
            owner.balance += ev.amount;
            p.debtTo = owner.id;
        } else {
            p.debtTo = null;
        }
        p.balance -= ev.amount;
        logAction(room, `${p.name} платит аренду ${ev.amount} ₾.`);

        if (p.balance >= 0) {
            p.debtTo = null;
            endTurn(room);
        } else {
            logAction(room, `ВНИМАНИЕ: ${p.name} в ДОЛГАХ! Продайте активы, чтобы выжить.`);
        }

    } else if (action === 'pay' && ev.type === 'tax') {
        room.activeEvent = null; // Prevent double-clicks
        p.balance -= ev.amount;
        p.debtTo = null;
        logAction(room, `${p.name} платит налог ${ev.amount} ₾.`);

        if (p.balance >= 0) {
            endTurn(room);
        } else {
            logAction(room, `ВНИМАНИЕ: ${p.name} в ДОЛГАХ! Продайте активы, чтобы выжить.`);
        }

    } else if (action === 'pay' && ev.type === 'chance') {
        room.activeEvent = null; // Prevent double-clicks
        p.balance += ev.amount;
        p.debtTo = null;

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

export function removePlayerFromAuction(room: GameRoom, playerId: string) {
    if (!room.auctionState) return;
    const idx = room.auctionState.participantIds.indexOf(playerId);
    if (idx !== -1) {
        room.auctionState.participantIds.splice(idx, 1);
        logAction(room, `Игрок удален из аукциона из-за отключения.`);
        if (room.auctionState.activeBidderIndex >= room.auctionState.participantIds.length) {
            room.auctionState.activeBidderIndex = 0;
        }
        if (room.activeEvent && room.activeEvent.type === 'auction') {
            room.activeEvent.targetPlayerId = room.auctionState.participantIds[room.auctionState.activeBidderIndex] || '';
        }
        nextAuctionTurn(room, false);
    }
}

// ---- Bot AI ----
// ---- Bot helpers ----

/** How many cells of this color group does the bot already own? */
function botGroupOwned(room: GameRoom, groupColor: string, botId: string): number {
    return room.cells.filter(c => c.groupColor === groupColor && c.type === 'property' && c.ownerId === botId).length;
}

/** Total cells in a color group */
function groupSize(room: GameRoom, groupColor: string): number {
    return room.cells.filter(c => c.groupColor === groupColor && c.type === 'property').length;
}

/** Does any opponent own (groupSize-1) cells of this color (one away from monopoly)? */
function opponentNearMonopoly(room: GameRoom, groupColor: string, botId: string): boolean {
    const size = groupSize(room, groupColor);
    if (size < 2) return false;
    const opponents = room.players.filter(p => p.id !== botId && p.position >= 0);
    return opponents.some(op =>
        room.cells.filter(c => c.groupColor === groupColor && c.type === 'property' && c.ownerId === op.id).length >= size - 1
    );
}

/** Does the bot own a complete color monopoly (none mortgaged)? */
function botHasMonopoly(room: GameRoom, botId: string): boolean {
    const colors = [...new Set(
        room.cells.filter(c => c.type === 'property' && c.groupColor).map(c => c.groupColor)
    )];
    return colors.some(color => {
        const group = room.cells.filter(c => c.groupColor === color && c.type === 'property');
        return group.length > 0 && group.every(c => c.ownerId === botId && !c.isMortgaged);
    });
}

/** Calculate the maximum bid a bot is willing to place for a cell. */
function botMaxBid(room: GameRoom, bot: Player, cellId: number): number {
    const cell = room.cells.find(c => c.id === cellId);
    if (!cell || !cell.price) return 0;

    if (cell.type === 'property' && cell.groupColor) {
        const owned = botGroupOwned(room, cell.groupColor, bot.id);
        const size  = groupSize(room, cell.groupColor);
        if (owned === size - 1) return cell.price * 2.0;            // completes monopoly — pay a lot
        if (opponentNearMonopoly(room, cell.groupColor, bot.id)) return cell.price * 1.5; // block opponent
        return cell.price * 1.1;                                    // ordinary property
    }
    if (cell.type === 'station') return cell.price * 1.3;
    if (cell.type === 'utility') return cell.price * 1.1;
    return cell.price;
}

export function botTick(room: GameRoom): boolean {
    if (room.state !== 'playing') return false;

    // Pace bots so humans can see animations
    if (Date.now() - room.lastActionTime < 1200) return false;

    // ---- Handle events targeting ANY bot regardless of turn ----
    if (room.activeEvent) {
        const targetBot = room.players.find(
            p => p.isBot && p.id === room.activeEvent?.targetPlayerId
        );
        if (targetBot) {
            room.lastActionTime = Date.now();
            const ev = room.activeEvent;

            // ── Trade proposal ───────────────────────────────────────────────
            if (ev.type === 'trade_proposal') {
                let accept = false;
                const offerIds: number[] = ev.tradeOfferPropertyIds || (ev.tradeOfferPropertyId != null ? [ev.tradeOfferPropertyId] : []);
                // Accept if ANY offered property completes our monopoly
                for (const id of offerIds) {
                    const offerCell = room.cells.find(c => c.id === id);
                    if (offerCell && offerCell.groupColor) {
                        const owned = botGroupOwned(room, offerCell.groupColor, targetBot.id);
                        const size  = groupSize(room, offerCell.groupColor);
                        if (owned === size - 1 && size > 1) { accept = true; break; }
                    }
                }
                // Accept pure-money offer that covers ≥ 80 % of all requested cells' total price
                if (!accept && ev.tradeOfferAmount > 0) {
                    const reqIds: number[] = ev.tradeRequestPropertyIds || (ev.tradeRequestPropertyId != null ? [ev.tradeRequestPropertyId] : []);
                    const totalReqPrice = reqIds.reduce((sum, id) => sum + (room.cells.find(c => c.id === id)?.price ?? 0), 0);
                    if (ev.tradeOfferAmount >= totalReqPrice * 0.8) accept = true;
                }
                // Never accept if we'd have to pay money
                if ((ev.tradeRequestAmount || 0) > targetBot.balance * 0.3) accept = false;
                resolveEvent(room, targetBot.id, { action: accept ? 'accept_trade' : 'reject_trade' });

            // ── Mandatory payments ───────────────────────────────────────────
            } else if (ev.type === 'rent' || ev.type === 'tax' || ev.type === 'chance') {
                resolveEvent(room, targetBot.id, { action: 'pay' });

            // ── Buy decision ─────────────────────────────────────────────────
            } else if (ev.type === 'buy') {
                const cell  = ev.cell;
                const price = cell?.price ?? 0;
                let shouldBuy = false;

                if (targetBot.balance >= price && cell) {
                    if (cell.type === 'property' && cell.groupColor) {
                        const owned = botGroupOwned(room, cell.groupColor, targetBot.id);
                        const size  = groupSize(room, cell.groupColor);
                        if (owned === size - 1) {
                            // Completes monopoly — always buy if we can afford it
                            shouldBuy = true;
                        } else if (opponentNearMonopoly(room, cell.groupColor, targetBot.id)) {
                            // Block opponent — buy if we keep at least 10 % reserve
                            shouldBuy = targetBot.balance >= price * 1.1;
                        } else {
                            // Normal purchase — buy if we keep a comfortable reserve
                            shouldBuy = targetBot.balance >= price * 1.3;
                        }
                    } else {
                        // Stations and utilities: buy if we have a small reserve
                        shouldBuy = targetBot.balance >= price * 1.2;
                    }
                }
                resolveEvent(room, targetBot.id, { action: shouldBuy ? 'buy' : 'pass' });

            // ── Auction bidding ───────────────────────────────────────────────
            } else if (ev.type === 'auction' && room.auctionState) {
                const nextBid = room.auctionState.highestBidderId
                    ? room.auctionState.highestBid + 10000
                    : room.auctionState.highestBid;
                const maxBid = botMaxBid(room, targetBot, room.auctionState.cellId);
                // Never let bidding exceed 50 % of current balance
                const hardCap = targetBot.balance * 0.5;
                const canBid  = nextBid <= Math.min(maxBid, hardCap);
                resolveEvent(room, targetBot.id, { action: canBid ? 'bid' : 'pass' });

            // ── Upgrade prompt ────────────────────────────────────────────────
            } else if (ev.type === 'upgrade') {
                // Accept if we can still keep a healthy cash reserve afterwards
                const cost    = ev.amount ?? 0;
                const reserve = 400000;
                resolveEvent(room, targetBot.id, { action: targetBot.balance >= cost + reserve ? 'upgrade' : 'pass' });
            }
            return true;
        }
        // Active event not targeting any bot — nothing to do
        return false;
    }

    // ---- No active event: handle the current turn player if it's a bot ----
    const bot = room.players[room.turnIndex];
    if (!bot || !bot.isBot) return false;

    room.lastActionTime = Date.now();

    // ── Визаран skip ──────────────────────────────────────────────────────────
    if (bot.skipNextTurn) {
        bot.skipNextTurn = false;
        logAction(room, `${bot.name} на Визаране (пропускает ход).`);
        room.lastRoll = { r1: 0, r2: 0, playerId: bot.id, wasSkipTurn: true };
        endTurn(room);
        return true;
    }

    // ── In debt: sell upgrades → mortgage least-valuable cells ───────────────
    if (bot.balance < 0) {
        // 1. Sell upgrades first — only cells that are at the max level of their group
        //    (server requires even downgrade: c.level must equal maxLevel in group)
        const upgradedCell = room.cells
            .filter(c => {
                if (c.ownerId !== bot.id || c.level <= 0) return false;
                const group = room.cells.filter(gc => gc.groupColor === c.groupColor && gc.type === 'property');
                const maxLevel = Math.max(...group.map(gc => gc.level));
                return c.level === maxLevel;
            })
            .sort((a, b) => (b.buildCost ?? 0) - (a.buildCost ?? 0))[0];
        if (upgradedCell) {
            resolveEvent(room, bot.id, { action: 'sell_upgrade', cellId: upgradedCell.id });
            return true;
        }
        // 2. Mortgage cheapest unmortgaged property with no group upgrades
        const mortgageCandidate = room.cells
            .filter(c => {
                if (c.ownerId !== bot.id || c.level > 0 || c.isMortgaged) return false;
                const group = room.cells.filter(gc => gc.groupColor === c.groupColor && gc.type === 'property');
                return !group.some(gc => gc.level > 0);
            })
            .sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0];
        if (mortgageCandidate) {
            resolveEvent(room, bot.id, { action: 'mortgage', cellId: mortgageCandidate.id });
            return true;
        }
        // Nothing else to sell — declare bankruptcy
        endTurn(room);
        return true;
    }

    // ── Proactive upgrade: build evenly on monopoly groups ───────────────────
    // (Runs before rolling so the bot spends money wisely each turn)
    const UPGRADE_RESERVE = 500000;
    const upgradeTarget = room.cells
        .filter(c => {
            if (c.ownerId !== bot.id || c.type !== 'property' || c.level >= 5 || c.isMortgaged) return false;
            const group = room.cells.filter(gc => gc.groupColor === c.groupColor && gc.type === 'property');
            if (!group.every(gc => gc.ownerId === bot.id && !gc.isMortgaged)) return false;
            const minLevel = Math.min(...group.map(gc => gc.level));
            return c.level === minLevel; // only upgrade the cell(s) at minimum level
        })
        .sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0]; // start with cheapest group

    if (upgradeTarget) {
        const cost = upgradeTarget.buildCost ?? (upgradeTarget.price ?? 0) * 0.5;
        if (bot.balance >= cost + UPGRADE_RESERVE) {
            resolveEvent(room, bot.id, { action: 'manual_upgrade', cellId: upgradeTarget.id });
            return true;
        }
    }

    // ── Jail ─────────────────────────────────────────────────────────────────
    if (bot.isInJail) {
        // Pay bail if: 3rd attempt, OR has a monopoly and enough cash to keep spending
        const mustPay   = bot.jailRolls >= 2;
        const wantsPay  = botHasMonopoly(room, bot.id) && bot.balance >= 200000;
        if (bot.balance >= 50000 && (mustPay || wantsPay)) {
            resolveEvent(room, bot.id, { action: 'pay_bail' });
            return true;
        }
    }

    rollDice(room, bot.id);
    return true;
}
