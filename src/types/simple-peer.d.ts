declare module 'simple-peer' {
  const WEBRTC_SUPPORT: boolean
  export default class Peer {
    static WEBRTC_SUPPORT: boolean
    constructor(opts?: any)
    on(event: string, cb: (...args: any[]) => void): void
    signal(data: any): void
    addStream(stream: MediaStream): void
    destroy(): void
  }
  export { WEBRTC_SUPPORT }
}
