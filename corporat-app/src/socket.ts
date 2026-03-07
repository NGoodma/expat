import { io } from 'socket.io-client';

const SERVER_URL = import.meta.env.VITE_WEBSOCKET_URL || 'http://localhost:8081';

const socket = io(SERVER_URL, {
    // Fail each attempt quickly so reconnects cycle faster while server wakes up
    timeout: 5000,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 2000,
});

export { SERVER_URL };
export default socket;
