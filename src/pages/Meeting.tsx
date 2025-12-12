import React, { useEffect, useRef, useState } from 'react'
import { initWebRTC, getConnectedPeers, getLocalStream, disconnectWebRTC, toggleAudio, toggleVideo } from '../services/webrtc'

export function Meeting() {
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const [peers, setPeers] = useState<string[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const start = () => initWebRTC().then(() => {
      setReady(true)
      setError(null)
      const local = getLocalStream()
      if (local && localVideoRef.current) {
        localVideoRef.current.srcObject = local
      }
      setPeers(getConnectedPeers())
    }).catch((e: any) => {
      const name = e?.name || ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setError('Camera permission denied or blocked. Please allow camera access in your browser settings and click Retry.')
      } else if (!window.isSecureContext) {
        setError('This page is not secure. Use HTTPS to access camera.')
      } else {
        setError('Could not start camera: ' + (e?.message || name || 'Unknown error'))
      }
    })

    start()
    return () => { disconnectWebRTC() }
  }, [])

  const retryPermissions = () => {
    setError(null)
    setReady(false)
    const local = getLocalStream()
    if (local && localVideoRef.current) {
      localVideoRef.current.srcObject = local
    }
    // rerun init to trigger permission prompt again
    initWebRTC().then(() => {
      setReady(true)
      const ls = getLocalStream()
      if (ls && localVideoRef.current) {
        localVideoRef.current.srcObject = ls
      }
      setPeers(getConnectedPeers())
    }).catch((e: any) => {
      const name = e?.name || ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setError('Camera permission denied or blocked. Please allow camera access in your browser settings and try again.')
      } else if (!window.isSecureContext) {
        setError('This page is not secure. Use HTTPS to access camera.')
      } else {
        setError('Could not start camera: ' + (e?.message || name || 'Unknown error'))
      }
    })
  }

  return (
    <div style={{padding: 16}}>
      <h1>Video Call</h1>
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap: 12}}>
        <div>
          <h3>Local</h3>
          <video ref={localVideoRef} autoPlay playsInline muted style={{width:'100%', background:'#000'}} />
          {error && (
            <div style={{marginTop:8, color:'#b91c1c'}}>
              {error}
              <div>
                <button onClick={retryPermissions} style={{marginTop:8}}>Retry</button>
              </div>
            </div>
          )}
          <div style={{display:'flex', gap:8, marginTop:8}}>
            <button onClick={toggleAudio}>Toggle Audio</button>
            <button onClick={toggleVideo}>Toggle Video</button>
          </div>
        </div>
        <div>
          <h3>Remote</h3>
          {peers.map(id => (
            <video key={id} id={`${id}_ui`} autoPlay playsInline style={{width:'100%', background:'#000'}} />
          ))}
        </div>
      </div>
      {!ready && <p>Connecting...</p>}
    </div>
  )
}
