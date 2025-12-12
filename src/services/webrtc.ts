type PeerId = string;

export type RtcEvents = {
  onParticipantJoined?: (id: PeerId) => void;
  onParticipantLeft?: (id: PeerId) => void;
  onStream?: (id: PeerId, stream: MediaStream) => void;
};

class WebRTCManager {
  private meetingId: string;
  private socket: any;
  private localStream: MediaStream | null = null;
  private peers: Map<PeerId, RTCPeerConnection> = new Map();
  private events: RtcEvents;
  private makingOffer: Map<PeerId, boolean> = new Map();
  private ignoreOffer: Map<PeerId, boolean> = new Map();
  private isSettingRemoteAnswerPending: Map<PeerId, boolean> = new Map();
  private pendingCandidates: Map<PeerId, RTCIceCandidateInit[]> = new Map();

  constructor(socket: any, meetingId: string, events: RtcEvents = {}) {
    this.socket = socket;
    this.meetingId = meetingId;
    this.events = events;

    this.handleSocket();
  }

  async initLocalAudio() {
    if (this.localStream) return this.localStream;
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return this.localStream;
  }

  async startCamera() {
    if (this.localStream && this.localStream.getVideoTracks().length > 0) return this.localStream;
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch (err: any) {
      // Fallback si no se encuentra cámara: solo audio para no caer la app
      if (err?.name === 'NotFoundError') {
        media = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } else {
        throw err;
      }
    }
    this.localStream = media;
    // attach tracks to existing peers
    for (const [, pc] of this.peers) {
      media.getTracks().forEach(track => pc.addTrack(track, media));
    }
    return this.localStream;
  }

  stopCamera() {
    if (!this.localStream) return;
    this.localStream.getTracks().forEach(t => t.stop());
    this.localStream = null;
  }

  async join() {
    this.socket.emit('rtc:join', { room: this.meetingId });
  }

  async leave() {
    for (const [, pc] of this.peers) {
      pc.close();
    }
    this.peers.clear();
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    this.socket.emit('rtc:leave', { room: this.meetingId });
  }

  async toggleMic(enabled: boolean) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(t => (t.enabled = enabled));
  }

  toggleVideoEnabled() {
    if (!this.localStream) return;
    const vt = this.localStream.getVideoTracks()[0];
    if (vt) vt.enabled = !vt.enabled;
  }

  toggleAudioEnabled() {
    if (!this.localStream) return;
    const at = this.localStream.getAudioTracks()[0];
    if (at) at.enabled = !at.enabled;
  }

  private createPeer(remoteId: PeerId) {
    if (this.peers.has(remoteId)) return this.peers.get(remoteId)!;

    const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
    const turnUser = import.meta.env.VITE_TURN_USERNAME as string | undefined;
    const turnCred = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined;

    const iceServers: RTCIceServer[] = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }
    ];
    if (turnUrl && turnUser && turnCred) {
      iceServers.push({ urls: [turnUrl], username: turnUser, credential: turnCred });
    }

    const pc = new RTCPeerConnection({
      iceServers
    });

    // ensure an audio transceiver exists for predictable negotiation
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    // ensure a video transceiver so los peers puedan recibir video
    pc.addTransceiver('video', { direction: 'sendrecv' });

    // add local audio
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream!));
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        console.debug('[RTC] ICE candidate ->', remoteId);
        this.socket.emit('rtc:ice', { room: this.meetingId, to: remoteId, candidate: ev.candidate });
      }
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (stream && this.events.onStream) this.events.onStream(remoteId, stream);
    };

    // negotiationneeded -> send offer politely
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer.set(remoteId, true);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.debug('[RTC] Sending offer ->', remoteId);
        this.socket.emit('rtc:offer', { room: this.meetingId, to: remoteId, offer });
      } catch (err) {
        console.error('[RTC] Error creating offer for', remoteId, ':', err);
      } finally { this.makingOffer.set(remoteId, false); }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.peers.delete(remoteId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.debug('[RTC] ICE state ->', remoteId, pc.iceConnectionState);
    };

    pc.onsignalingstatechange = () => {
      console.debug('[RTC] Signaling state ->', remoteId, pc.signalingState);
    };

    pc.onicegatheringstatechange = () => {
      console.debug('[RTC] Gathering state ->', remoteId, pc.iceGatheringState);
    };

    this.pendingCandidates.set(remoteId, []);

    this.peers.set(remoteId, pc);
    return pc;
  }

  private handleSocket() {
    this.socket.on('rtc:joined', async ({ from }: { from: PeerId }) => {
      if (!this.localStream) await this.initLocalAudio();
      const pc = this.createPeer(from);
      // letting onnegotiationneeded drive offers avoids wrong-state errors
      console.debug('[RTC] Peer joined ->', from, 'signaling:', pc.signalingState);
      this.events.onParticipantJoined?.(from);
    });

    this.socket.on('rtc:offer', async ({ from, offer }: { from: PeerId, offer: RTCSessionDescriptionInit }) => {
      if (!this.localStream) await this.initLocalAudio();
      const pc = this.createPeer(from);
      const polite = true;
      const readyForOffer = pc.signalingState === 'stable' || (pc.signalingState === 'have-local-offer' && this.isSettingRemoteAnswerPending.get(from));
      const offerCollision = this.makingOffer.get(from) || !readyForOffer;
      this.ignoreOffer.set(from, !polite && offerCollision);
      if (this.ignoreOffer.get(from)) return;

      try {
        console.debug('[RTC] Received offer <-', from, 'state:', pc.signalingState, 'collision:', offerCollision);
        if (offerCollision) {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit),
            pc.setRemoteDescription(new RTCSessionDescription(offer))
          ]);
        } else {
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
        }
        const queued = this.pendingCandidates.get(from);
        if (queued && queued.length) {
          for (const c of queued) {
            await pc.addIceCandidate(new RTCIceCandidate(c));
          }
          queued.length = 0;
        }
        const answer = await pc.createAnswer();
        this.isSettingRemoteAnswerPending.set(from, true);
        await pc.setLocalDescription(answer);
        this.isSettingRemoteAnswerPending.set(from, false);
        console.debug('[RTC] Sending answer ->', from);
        this.socket.emit('rtc:answer', { room: this.meetingId, to: from, answer });
        this.events.onParticipantJoined?.(from);
      } catch (err) {
        console.error('[RTC] Error handling offer from', from, ':', err);
      }
    });

    this.socket.on('rtc:answer', async ({ from, answer }: { from: PeerId, answer: RTCSessionDescriptionInit }) => {
      const pc = this.peers.get(from);
      if (!pc) return;
      try {
        console.debug('[RTC] Received answer <-', from);
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        const queued = this.pendingCandidates.get(from);
        if (queued && queued.length) {
          for (const c of queued) {
            await pc.addIceCandidate(new RTCIceCandidate(c));
          }
          queued.length = 0;
        }
      } catch (err) {
        console.error('[RTC] Error handling answer from', from, ':', err);
      }
    });

    this.socket.on('rtc:ice', async ({ from, candidate }: { from: PeerId, candidate: RTCIceCandidateInit }) => {
      const pc = this.peers.get(from);
      if (!pc) return;
      try {
        if (!pc.remoteDescription) {
          let q = this.pendingCandidates.get(from);
          if (!q) {
            q = [];
            this.pendingCandidates.set(from, q);
          }
          q.push(candidate);
          return;
        }
        console.debug('[RTC] Received ICE <-', from);
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('[RTC] Error adding ICE candidate from', from, ':', err);
      }
    });

    this.socket.on('rtc:left', ({ from }: { from: PeerId }) => {
      const pc = this.peers.get(from);
      if (pc) pc.close();
      this.peers.delete(from);
      this.pendingCandidates.delete(from);
      this.events.onParticipantLeft?.(from);
    });
  }
}

export default WebRTCManager;
// Legacy API for compatibility with Meeting.tsx
let localStream: MediaStream | null = null;
const peers: Record<string, MediaStream> = {};

export async function initWebRTC(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasVideo = devices.some(d => d.kind === 'videoinput');
    
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: hasVideo
    });
  } catch (err) {
    console.error('Error initializing WebRTC:', err);
    const e = err as any;
    // Only fall back to audio when there is no camera device.
    if (e?.name === 'NotFoundError') {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });
    } else {
      // For NotAllowedError/SecurityError, propagate so UI can prompt user to enable permissions.
      throw err;
    }
  }
}

export function getLocalStream(): MediaStream | null {
  return localStream;
}

export function getConnectedPeers(): string[] {
  return Object.keys(peers);
}

export function getPeerStream(peerId: string): MediaStream | null {
  return peers[peerId] || null;
}

export function disconnectWebRTC(): void {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  Object.keys(peers).forEach(key => delete peers[key]);
}

export function toggleAudio(): void {
  if (localStream) {
    const audioTracks = localStream.getAudioTracks();
    audioTracks.forEach(track => {
      track.enabled = !track.enabled;
    });
  }
}

export function toggleVideo(): void {
  if (localStream) {
    const videoTracks = localStream.getVideoTracks();
    videoTracks.forEach(track => {
      track.enabled = !track.enabled;
    });
  }
}
