import Peer from 'simple-peer'
import { socket } from './socket'

let peers: Record<string, { peerConnection: any }> = {}
let localMediaStream: MediaStream | null = null
let hasCamera: boolean = false

export const getLocalStream = () => localMediaStream
export const getConnectedPeers = () => Object.keys(peers)
export const getPeerStream = (peerId: string): MediaStream | null => {
  const el = document.getElementById(`${peerId}_video`) as HTMLVideoElement | null
  return (el?.srcObject as MediaStream) || null
}
export const getHasCamera = () => hasCamera

export const initWebRTC = async () => {
  if (!Peer.WEBRTC_SUPPORT) throw new Error('WebRTC not supported')
  // Detect available devices first
  const devices = await navigator.mediaDevices.enumerateDevices()
  const hasVideoInput = devices.some(d => d.kind === 'videoinput')
  hasCamera = hasVideoInput

  try {
    localMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: hasVideoInput })
  } catch (err: any) {
    // If video was requested and fails, fallback to audio-only
    if (hasVideoInput && err?.name === 'NotFoundError') {
      hasCamera = false
      localMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } else if (err?.name === 'NotAllowedError') {
      // User denied permissions: do not proceed with video; try audio-only
      localMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } else {
      throw err
    }
  }
  bindSocketEvents()
}

function bindSocketEvents() {
  socket.on('introduction', (otherIds: string[]) => {
    otherIds.filter(id => id !== socket.id).slice(0,1).forEach(theirId => {
      peers[theirId] = { peerConnection: createPeerConnection(theirId, true) }
      ensureDomVideo(theirId)
    })
  })
  socket.on('newUserConnected', (theirId: string) => {
    if (Object.keys(peers).length >= 1) return
    if (theirId !== socket.id && !(theirId in peers)) {
      peers[theirId] = { peerConnection: createPeerConnection(theirId, false) }
      ensureDomVideo(theirId)
    }
  })
  socket.on('userDisconnected', (id: string) => {
    removeDomVideo(id)
    delete peers[id]
  })
  socket.on('signal', (to: string, from: string, data: any) => {
    if (to !== socket.id) return
    const p = peers[from]
    if (p) {
      p.peerConnection.signal(data)
    } else if (Object.keys(peers).length < 1) {
      const pc = createPeerConnection(from, false)
      peers[from] = { peerConnection: pc }
      pc.signal(data)
      ensureDomVideo(from)
    }
  })
}

function createPeerConnection(theirId: string, initiator = false) {
  const peer = new Peer({ initiator, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302'}] } })
  peer.on('signal', data => socket.emit('signal', theirId, socket.id, data))
  peer.on('connect', () => peer.addStream(localMediaStream!))
  peer.on('stream', stream => attachStream(theirId, stream))
  return peer
}

function ensureDomVideo(id: string) {
  const existing = document.getElementById(`${id}_video`)
  if (existing) return
  const video = document.createElement('video')
  video.id = `${id}_video`
  video.autoplay = true
  video.playsInline = true
  video.style.display = 'none'
  document.body.appendChild(video)
}

function attachStream(id: string, stream: MediaStream) {
  const el = document.getElementById(`${id}_video`) as HTMLVideoElement
  if (el) el.srcObject = stream
}

function removeDomVideo(id: string) {
  const el = document.getElementById(`${id}_video`)
  if (el) el.remove()
}

export function toggleVideo() {
  if (!hasCamera) return
  const t = localMediaStream?.getVideoTracks()[0]
  if (t) t.enabled = !t.enabled
}

export function toggleAudio() {
  const t = localMediaStream?.getAudioTracks()[0]
  if (t) t.enabled = !t.enabled
}

export function disconnectWebRTC() {
  localMediaStream?.getTracks().forEach(t => t.stop())
  Object.values(peers).forEach(p => p.peerConnection.destroy())
  peers = {}
  localMediaStream = null
  socket.disconnect()
}
