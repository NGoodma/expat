export interface CellData {
    id: number;
    type: string;
    name: string;
    groupColor: string;
    price: number | null;
    ownerId: string | null;
    level: number;
    isMortgaged: boolean;
    buildCost: number | null;
    rentBase: number | null;
    rentMonopoly: number | null;
    rent1h: number | null;
    rent2h: number | null;
    rent3h: number | null;
    rent4h: number | null;
    rentHotel: number | null;
}

export interface Player {
    id: string;
    playerId: string;     // stable UUID, persists across reconnections
    name: string;
    balance: number;
    position: number;
    color: string;
    icon: string;
    isInJail: boolean;
    jailRolls: number;
    skipNextTurn: boolean;
    isReady: boolean;
    doubleCount: number;
    isBot?: boolean;
    debtTo?: string | null;
}

export interface AuctionState {
    cellId: number;
    highestBid: number;
    highestBidderId: string | null;
    participantIds: string[];
    activeBidderIndex: number;
}

export const BOARD_SIZE = 40;

export const GO_PAYOUT = 200000;
export const START_BALANCE = 1500000;

export interface GameRoom {
    id: string;
    players: Player[];
    cells: CellData[];
    turnIndex: number;
    state: 'lobby' | 'playing' | 'finished';
    activeEvent: null | any;
    auctionState: AuctionState | null;
    actionLog: string[];
    lastRoll?: { r1: number, r2: number, playerId: string, intermediatePosition?: number, wasSkipTurn?: boolean };
    lastActionTime: number;
}

const B = (
    name: string, color: string, price: number,
    buildCost: number,
    rentBase: number, rentMonopoly: number,
    rent1h: number, rent2h: number, rent3h: number, rent4h: number, rentHotel: number,
) => ({ name, type: 'property' as const, color, price, buildCost, rentBase, rentMonopoly, rent1h, rent2h, rent3h, rent4h, rentHotel });

const S = (name: string, price: number) => ({
    name, type: 'station' as const, color: '#a3a3a3', price,
    buildCost: null, rentBase: 25000, rentMonopoly: null,
    rent1h: 50000, rent2h: 100000, rent3h: 200000, rent4h: null, rentHotel: null,
});

const U = (name: string) => ({
    name, type: 'utility' as const, color: '#c2c2c2', price: 150000,
    buildCost: null, rentBase: 0, rentMonopoly: null,
    rent1h: null, rent2h: null, rent3h: null, rent4h: null, rentHotel: null,
});

const X = (name: string, type: string, price: number | null = null) => ({
    name, type, color: '', price,
    buildCost: null, rentBase: null, rentMonopoly: null,
    rent1h: null, rent2h: null, rent3h: null, rent4h: null, rentHotel: null,
});

export const BOARD_CONFIG = [
    X('СТАРТ', 'go'),
    B('Catebi', '#8B4513', 60000, 50000, 2000, 4000, 10000, 30000, 90000, 160000, 250000),
    X('Общ. Казна', 'chest'),
    B('Parki Ar Minda', '#8B4513', 60000, 50000, 4000, 8000, 20000, 60000, 180000, 320000, 450000),
    X('Налог', 'tax', 200000),
    S('Liberty Bank', 200000),
    B('Frame', '#87CEEB', 100000, 50000, 6000, 12000, 30000, 90000, 270000, 400000, 550000),
    X('Шанс', 'chance'),
    B('Emigration to Action', '#87CEEB', 100000, 50000, 6000, 12000, 30000, 90000, 270000, 400000, 550000),
    B('Волонтёры Тбилиси', '#87CEEB', 120000, 50000, 8000, 16000, 40000, 100000, 300000, 450000, 600000),
    X('Арест', 'jail'),
    B('surikata mami', '#FF69B4', 140000, 100000, 10000, 20000, 50000, 150000, 450000, 625000, 750000),
    U('Silknet'),
    B('loly tattoo', '#FF69B4', 140000, 100000, 10000, 20000, 50000, 150000, 450000, 625000, 750000),
    B('NDMA', '#FF69B4', 160000, 100000, 12000, 24000, 60000, 180000, 500000, 700000, 900000),
    S('Credo', 200000),
    B('Engineer history', '#FFA500', 180000, 100000, 14000, 28000, 70000, 200000, 550000, 750000, 950000),
    X('Общ. Казна', 'chest'),
    B('Thats my Georgia', '#FFA500', 180000, 100000, 14000, 28000, 70000, 200000, 550000, 750000, 950000),
    B('Travel to challenge', '#FFA500', 200000, 100000, 16000, 32000, 80000, 220000, 600000, 800000, 1000000),
    X('Визаран', 'parking'),
    B('Paper Kartuli', '#FF0000', 220000, 150000, 18000, 36000, 90000, 250000, 700000, 875000, 1050000),
    X('Шанс', 'chance'),
    B('Ауди тория', '#FF0000', 220000, 150000, 18000, 36000, 90000, 250000, 700000, 875000, 1050000),
    B('Sative Space', '#FF0000', 240000, 150000, 20000, 40000, 100000, 300000, 750000, 925000, 1100000),
    S('TBC', 200000),
    B('Join Cafe', '#FFFF00', 260000, 150000, 22000, 44000, 110000, 330000, 800000, 975000, 1150000),
    B('Mesto', '#FFFF00', 260000, 150000, 22000, 44000, 110000, 330000, 800000, 975000, 1150000),
    U('Magti com'),
    B('Кофевар', '#FFFF00', 280000, 150000, 24000, 48000, 120000, 360000, 850000, 1025000, 1200000),
    X('Досмотр', 'gotojail'),
    B('Improv Tbilisi', '#008000', 300000, 200000, 26000, 52000, 130000, 390000, 900000, 1100000, 1275000),
    B('Biblio teka', '#008000', 300000, 200000, 26000, 52000, 130000, 390000, 900000, 1100000, 1275000),
    X('Общ. Казна', 'chest'),
    B('CHUVI', '#008000', 320000, 200000, 28000, 56000, 150000, 450000, 1000000, 1200000, 1400000),
    S('BoG', 200000),
    X('Шанс', 'chance'),
    B('Colibring Nomads', '#0000CD', 350000, 200000, 35000, 70000, 175000, 500000, 1100000, 1300000, 1500000),
    X('Налог', 'tax', 100000),
    B('Горизонт. кафе Фрик', '#0000CD', 400000, 200000, 50000, 100000, 200000, 600000, 1400000, 1700000, 2000000),
];

export const getInitialCells = (): CellData[] => {
    return BOARD_CONFIG.map((c, i) => ({
        id: i,
        type: c.type,
        name: c.name,
        groupColor: c.color,
        price: c.price ?? null,
        ownerId: null,
        level: 0,
        isMortgaged: false,
        buildCost: c.buildCost ?? null,
        rentBase: c.rentBase ?? null,
        rentMonopoly: c.rentMonopoly ?? null,
        rent1h: c.rent1h ?? null,
        rent2h: c.rent2h ?? null,
        rent3h: c.rent3h ?? null,
        rent4h: c.rent4h ?? null,
        rentHotel: c.rentHotel ?? null,
    }));
};
