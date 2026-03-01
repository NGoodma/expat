export interface CellData {
    id: number;
    type: string;
    name: string;
    groupColor: string;
    price: number | null;
    ownerId: string | null;
    level: number;         // 0=no house, 1-4=houses, 5=hotel
    isMortgaged: boolean;
    // Economic fields (null for non-property cells)
    buildCost: number | null;
    rentBase: number | null;       // no monopoly, no houses
    rentMonopoly: number | null;   // owns full color group, no houses
    rent1h: number | null;
    rent2h: number | null;
    rent3h: number | null;
    rent4h: number | null;
    rentHotel: number | null;
}

export interface Player {
    id: string;
    playerId: string;
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
}

// ─── Economic helpers ────────────────────────────────────────────────────────
// Build cost tiers (per house/hotel)
// Brown/Light-blue:  50 000
// Pink/Orange:      100 000
// Red/Yellow:       150 000
// Green/Dark-blue:  200 000

type BoardEntry = {
    name: string; type: string; color: string; price: number | null;
    buildCost?: number | null;
    rentBase?: number | null; rentMonopoly?: number | null;
    rent1h?: number | null; rent2h?: number | null; rent3h?: number | null;
    rent4h?: number | null; rentHotel?: number | null;
};

export const BOARD_CONFIG: BoardEntry[] = [
    // 0
    { name: 'СТАРТ', type: 'go', color: '', price: null },
    // 1-3  Brown  (#8B4513)  price 60k, build 50k, rent ~8%=4.8k→5k
    {
        name: 'Catebi', type: 'property', color: '#8B4513', price: 60000,
        buildCost: 50000, rentBase: 2000, rentMonopoly: 4000,
        rent1h: 10000, rent2h: 30000, rent3h: 90000, rent4h: 160000, rentHotel: 250000
    },
    { name: 'ШАНС', type: 'chest', color: '', price: null },
    {
        name: 'Parki Ar Minda', type: 'property', color: '#8B4513', price: 60000,
        buildCost: 50000, rentBase: 4000, rentMonopoly: 8000,
        rent1h: 20000, rent2h: 60000, rent3h: 180000, rent4h: 320000, rentHotel: 450000
    },
    // 4   Tax
    { name: 'Налог', type: 'tax', color: '', price: 200000 },
    // 5   Station
    {
        name: 'Liberty Bank', type: 'station', color: '#a3a3a3', price: 200000,
        buildCost: null, rentBase: 25000, rentMonopoly: null,
        rent1h: 50000, rent2h: 100000, rent3h: 200000, rent4h: null, rentHotel: null
    },
    // 6-9  Light-blue (#87CEEB) price 100-120k, build 50k
    {
        name: 'Frame', type: 'property', color: '#87CEEB', price: 100000,
        buildCost: 50000, rentBase: 6000, rentMonopoly: 12000,
        rent1h: 30000, rent2h: 90000, rent3h: 270000, rent4h: 400000, rentHotel: 550000
    },
    { name: 'Шанс', type: 'chance', color: '', price: null },
    {
        name: 'Emigration to Action', type: 'property', color: '#87CEEB', price: 100000,
        buildCost: 50000, rentBase: 6000, rentMonopoly: 12000,
        rent1h: 30000, rent2h: 90000, rent3h: 270000, rent4h: 400000, rentHotel: 550000
    },
    {
        name: 'Волонтёры Тбилиси', type: 'property', color: '#87CEEB', price: 120000,
        buildCost: 50000, rentBase: 8000, rentMonopoly: 16000,
        rent1h: 40000, rent2h: 100000, rent3h: 300000, rent4h: 450000, rentHotel: 600000
    },
    // 10  Jail
    { name: 'Арест', type: 'jail', color: '', price: null },
    // 11-14 Pink (#FF69B4) price 140-160k, build 100k
    {
        name: 'surikatamami', type: 'property', color: '#FF69B4', price: 140000,
        buildCost: 100000, rentBase: 10000, rentMonopoly: 20000,
        rent1h: 50000, rent2h: 150000, rent3h: 450000, rent4h: 625000, rentHotel: 750000
    },
    {
        name: 'Silknet', type: 'utility', color: '#c2c2c2', price: 150000,
        buildCost: null, rentBase: 0, rentMonopoly: null,
        rent1h: null, rent2h: null, rent3h: null, rent4h: null, rentHotel: null
    },
    {
        name: 'loly_tattoo', type: 'property', color: '#FF69B4', price: 140000,
        buildCost: 100000, rentBase: 10000, rentMonopoly: 20000,
        rent1h: 50000, rent2h: 150000, rent3h: 450000, rent4h: 625000, rentHotel: 750000
    },
    {
        name: 'NDMA', type: 'property', color: '#FF69B4', price: 160000,
        buildCost: 100000, rentBase: 12000, rentMonopoly: 24000,
        rent1h: 60000, rent2h: 180000, rent3h: 500000, rent4h: 700000, rentHotel: 900000
    },
    // 15  Station
    {
        name: 'Credo', type: 'station', color: '#a3a3a3', price: 200000,
        buildCost: null, rentBase: 25000, rentMonopoly: null,
        rent1h: 50000, rent2h: 100000, rent3h: 200000, rent4h: null, rentHotel: null
    },
    // 16-19 Orange (#FFA500) price 180-200k, build 100k
    {
        name: 'Engineer history', type: 'property', color: '#FFA500', price: 180000,
        buildCost: 100000, rentBase: 14000, rentMonopoly: 28000,
        rent1h: 70000, rent2h: 200000, rent3h: 550000, rent4h: 750000, rentHotel: 950000
    },
    { name: 'ШАНС', type: 'chest', color: '', price: null },
    {
        name: 'Thats my Georgia', type: 'property', color: '#FFA500', price: 180000,
        buildCost: 100000, rentBase: 14000, rentMonopoly: 28000,
        rent1h: 70000, rent2h: 200000, rent3h: 550000, rent4h: 750000, rentHotel: 950000
    },
    {
        name: 'Travel to challenge', type: 'property', color: '#FFA500', price: 200000,
        buildCost: 100000, rentBase: 16000, rentMonopoly: 32000,
        rent1h: 80000, rent2h: 220000, rent3h: 600000, rent4h: 800000, rentHotel: 1000000
    },
    // 20  Parking / Визаран
    { name: 'Визаран', type: 'parking', color: '', price: null },
    // 21-24 Red (#FF0000) price 220-240k, build 150k
    {
        name: 'Paper Kartuli', type: 'property', color: '#FF0000', price: 220000,
        buildCost: 150000, rentBase: 18000, rentMonopoly: 36000,
        rent1h: 90000, rent2h: 250000, rent3h: 700000, rent4h: 875000, rentHotel: 1050000
    },
    { name: 'Шанс', type: 'chance', color: '', price: null },
    {
        name: 'Аудитория', type: 'property', color: '#FF0000', price: 220000,
        buildCost: 150000, rentBase: 18000, rentMonopoly: 36000,
        rent1h: 90000, rent2h: 250000, rent3h: 700000, rent4h: 875000, rentHotel: 1050000
    },
    {
        name: 'Sative Space', type: 'property', color: '#FF0000', price: 240000,
        buildCost: 150000, rentBase: 20000, rentMonopoly: 40000,
        rent1h: 100000, rent2h: 300000, rent3h: 750000, rent4h: 925000, rentHotel: 1100000
    },
    // 25  Station
    {
        name: 'TBC', type: 'station', color: '#a3a3a3', price: 200000,
        buildCost: null, rentBase: 25000, rentMonopoly: null,
        rent1h: 50000, rent2h: 100000, rent3h: 200000, rent4h: null, rentHotel: null
    },
    // 26-29 Yellow (#FFFF00) price 260-280k, build 150k
    {
        name: 'Join Cafe', type: 'property', color: '#FFFF00', price: 260000,
        buildCost: 150000, rentBase: 22000, rentMonopoly: 44000,
        rent1h: 110000, rent2h: 330000, rent3h: 800000, rent4h: 975000, rentHotel: 1150000
    },
    {
        name: 'Mesto', type: 'property', color: '#FFFF00', price: 260000,
        buildCost: 150000, rentBase: 22000, rentMonopoly: 44000,
        rent1h: 110000, rent2h: 330000, rent3h: 800000, rent4h: 975000, rentHotel: 1150000
    },
    {
        name: 'Magticom', type: 'utility', color: '#c2c2c2', price: 150000,
        buildCost: null, rentBase: 0, rentMonopoly: null,
        rent1h: null, rent2h: null, rent3h: null, rent4h: null, rentHotel: null
    },
    {
        name: 'Кофевар', type: 'property', color: '#FFFF00', price: 280000,
        buildCost: 150000, rentBase: 24000, rentMonopoly: 48000,
        rent1h: 120000, rent2h: 360000, rent3h: 850000, rent4h: 1025000, rentHotel: 1200000
    },
    // 30  Go to jail
    { name: 'Досмотр', type: 'gotojail', color: '', price: null },
    // 31-34 Green (#008000) price 300-320k, build 200k
    {
        name: 'Improv Tbilisi', type: 'property', color: '#008000', price: 300000,
        buildCost: 200000, rentBase: 26000, rentMonopoly: 52000,
        rent1h: 130000, rent2h: 390000, rent3h: 900000, rent4h: 1100000, rentHotel: 1275000
    },
    {
        name: 'Biblioteka', type: 'property', color: '#008000', price: 300000,
        buildCost: 200000, rentBase: 26000, rentMonopoly: 52000,
        rent1h: 130000, rent2h: 390000, rent3h: 900000, rent4h: 1100000, rentHotel: 1275000
    },
    { name: 'ШАНС', type: 'chest', color: '', price: null },
    {
        name: 'CHUVI', type: 'property', color: '#008000', price: 320000,
        buildCost: 200000, rentBase: 28000, rentMonopoly: 56000,
        rent1h: 150000, rent2h: 450000, rent3h: 1000000, rent4h: 1200000, rentHotel: 1400000
    },
    // 35  Station
    {
        name: 'BoG', type: 'station', color: '#a3a3a3', price: 200000,
        buildCost: null, rentBase: 25000, rentMonopoly: null,
        rent1h: 50000, rent2h: 100000, rent3h: 200000, rent4h: null, rentHotel: null
    },
    // 36  Chance
    { name: 'Шанс', type: 'chance', color: '', price: null },
    // 37-39 Dark-blue (#0000CD) price 350-400k, build 200k
    {
        name: 'Colibring Nomads', type: 'property', color: '#0000CD', price: 350000,
        buildCost: 200000, rentBase: 35000, rentMonopoly: 70000,
        rent1h: 175000, rent2h: 500000, rent3h: 1100000, rent4h: 1300000, rentHotel: 1500000
    },
    { name: 'Налог', type: 'tax', color: '', price: 100000 },
    {
        name: 'Горизонтальное кафе Фрик', type: 'property', color: '#0000CD', price: 400000,
        buildCost: 200000, rentBase: 50000, rentMonopoly: 100000,
        rent1h: 200000, rent2h: 600000, rent3h: 1400000, rent4h: 1700000, rentHotel: 2000000
    },
];

export const getInitialCells = (): CellData[] => {
    return BOARD_CONFIG.map((c, i) => {
        const p = c as any;
        return {
            id: i,
            type: c.type,
            name: c.name,
            groupColor: c.color,
            price: c.price ?? null,
            ownerId: null,
            level: 0,
            isMortgaged: false,
            buildCost: p.buildCost ?? null,
            rentBase: p.rentBase ?? null,
            rentMonopoly: p.rentMonopoly ?? null,
            rent1h: p.rent1h ?? null,
            rent2h: p.rent2h ?? null,
            rent3h: p.rent3h ?? null,
            rent4h: p.rent4h ?? null,
            rentHotel: p.rentHotel ?? null,
        };
    });
};
