import io, { Socket } from 'socket.io-client'

const url = import.meta.env.VITE_WEBRTC_URL || 'http://localhost:3000'
export const socket: Socket = io(url, { transports: ['websocket', 'polling'] })
