import { io } from 'socket.io-client';

const socket = io(import.meta.env.VITE_WEBSOCKET_URL || 'http://localhost:8081');

export default socket;
