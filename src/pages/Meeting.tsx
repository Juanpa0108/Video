import React, { useEffect, useRef, useState } from 'react'
import { initWebRTC, getConnectedPeers, getPeerStream, getLocalStream, disconnectWebRTC, toggleAudio, toggleVideo } from '../services'

export function Meeting() {
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const [peers, setPeers] = useState<string[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    initWebRTC().then(() => {
      setReady(true)
      const local = getLocalStream()
      if (local && localVideoRef.current) {
        localVideoRef.current.srcObject = local
      }
      setPeers(getConnectedPeers())
    }).catch(console.error)

    return () => {
      disconnectWebRTC()
    }
  }, [])

  return (
    <div style={{padding: 16}}>
      <h1>Video Call</h1>
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap: 12}}>
        <div>
          <h3>Local</h3>
          <video ref={localVideoRef} autoPlay playsInline style={{width:'100%', background:'#000'}} />
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
