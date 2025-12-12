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

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
      ]
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
      } catch (err) {
        console.error('[RTC] Error handling answer from', from, ':', err);
      }
    });

    this.socket.on('rtc:ice', async ({ from, candidate }: { from: PeerId, candidate: RTCIceCandidateInit }) => {
      const pc = this.peers.get(from);
      if (!pc) return;
      try {
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
      this.events.onParticipantLeft?.(from);
    });
  }
}

export default WebRTCManager;