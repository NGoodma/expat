import { io } from 'socket.io-client';

const socket = io(import.meta.env.VITE_WEBSOCKET_URL || 'http://localhost:8081', {
    autoConnect: false
});

export default socket;
