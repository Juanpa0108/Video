import io, { Socket } from 'socket.io-client'

// Prefer explicit env override; otherwise, default to same-origin to avoid mixed-content issues.
const envUrl = import.meta.env.VITE_WEBRTC_URL as string | undefined
const defaultUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'
const url = envUrl || defaultUrl

export const socket: Socket = io(url, {
  transports: ['websocket', 'polling'],
  withCredentials: true
})
