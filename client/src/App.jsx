import React, { useEffect, useMemo, useRef, useState } from 'react'

const SIGNALING_URL = (import.meta.env.VITE_SIGNALING_URL) || 'ws://localhost:3001/ws'

function useSignaling(roomId) {
	const wsRef = useRef(null)
	const [joined, setJoined] = useState(false)

	useEffect(() => {
		const ws = new WebSocket(SIGNALING_URL)
		wsRef.current = ws
		ws.onopen = () => {
			ws.send(JSON.stringify({ type: 'join', roomId }))
		}
		ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data)
			if (msg.type === 'joined') {
				setJoined(true)
			}
		}
		return () => ws.close()
	}, [roomId])

	const send = (msg) => {
		if (!wsRef.current || wsRef.current.readyState !== 1) return
		wsRef.current.send(JSON.stringify(msg))
	}

	const onMessage = (handler) => {
		if (!wsRef.current) return () => {}
		const ws = wsRef.current
		const listener = (ev) => {
			try {
				const msg = JSON.parse(ev.data)
				if (msg.roomId !== roomId) return
				handler(msg)
			} catch {}
		}
		ws.addEventListener('message', listener)
		return () => ws.removeEventListener('message', listener)
	}

	return { joined, send, onMessage }
}

function createPeer(signaling, roomId, onChannel) {
	const pc = new RTCPeerConnection({
		iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
	})

	pc.onicecandidate = (e) => {
		if (e.candidate) {
			signaling.send({ type: 'candidate', roomId, candidate: e.candidate })
		}
	}
	pc.ondatachannel = (e) => {
		onChannel(e.channel)
	}

	const unsubscribe = signaling.onMessage(async (msg) => {
		if (msg.type === 'offer') {
			await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
			const answer = await pc.createAnswer()
			await pc.setLocalDescription(answer)
			signaling.send({ type: 'answer', roomId, sdp: pc.localDescription })
		}
		if (msg.type === 'answer') {
			await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
		}
		if (msg.type === 'candidate') {
			try {
				await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
			} catch {}
		}
	})

	return { pc, cleanup: unsubscribe }
}

function ReliabilityLayer(onDeliver, onStats) {
	const state = {
		nextSeq: 0,
		awaitingAckSeq: null,
		inflightPayload: null,
		inflightTimestamp: 0,
		timer: null,
		timeoutMs: 600,
		stats: { sent: 0, received: 0, acks: 0, retransmits: 0, rttMs: 0, bytesSent: 0, bytesReceived: 0 },
		rttHistory: [],
		rttHistoryMax: 40
	}

	function send(dc, payload) {
		if (!dc || dc.readyState !== 'open') return false
		if (state.awaitingAckSeq !== null) return false
		const seq = state.nextSeq
		state.awaitingAckSeq = seq
		state.inflightPayload = payload
		state.inflightTimestamp = performance.now()
		const serialized = JSON.stringify({ t: 'data', seq, payload })
		dc.send(serialized)
		state.stats.sent++
		state.stats.bytesSent += serialized.length
		update()
		state.timer = setTimeout(() => {
			if (state.awaitingAckSeq === seq) {
				const retry = JSON.stringify({ t: 'data', seq, payload })
				dc.send(retry)
				state.stats.sent++
				state.stats.retransmits++
				state.stats.bytesSent += retry.length
				update()
				clearTimeout(state.timer)
				state.timer = setTimeout(() => {}, state.timeoutMs)
			}
		}, state.timeoutMs)
		state.nextSeq = (state.nextSeq + 1) >>> 0
		return true
	}

	function handleIncoming(dc, raw) {
		let msg
		try { msg = JSON.parse(raw) } catch { return }
		if (msg.t === 'data') {
			state.stats.received++
			state.stats.bytesReceived += raw.length
			update()
			dc.send(JSON.stringify({ t: 'ack', seq: msg.seq }))
			onDeliver(msg.payload)
			return
		}
		if (msg.t === 'ack') {
			if (state.awaitingAckSeq === msg.seq) {
				const now = performance.now()
				state.stats.acks++
				const rtt = Math.round(now - state.inflightTimestamp)
				state.stats.rttMs = rtt
				state.rttHistory.push(rtt)
				if (state.rttHistory.length > state.rttHistoryMax) state.rttHistory.shift()
				state.awaitingAckSeq = null
				state.inflightPayload = null
				clearTimeout(state.timer)
				update()
			}
		}
	}

	function update() {
		onStats({ ...state.stats, rttHistory: [...state.rttHistory] })
	}

	return { send, handleIncoming }
}

function arrayBufferToBase64(buffer) {
	let binary = ''
	const bytes = new Uint8Array(buffer)
	const len = bytes.byteLength
	for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i])
	return btoa(binary)
}

function base64ToUint8Array(base64) {
	const binary = atob(base64)
	const len = binary.length
	const bytes = new Uint8Array(len)
	for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}

export default function App() {
	const [roomId, setRoomId] = useState('test-room')
	const signaling = useSignaling(roomId)
	const [pc, setPc] = useState(null)
	const [dc, setDc] = useState(null)
	const [connected, setConnected] = useState(false)
	const [stats, setStats] = useState({ sent: 0, received: 0, acks: 0, retransmits: 0, rttMs: 0, bytesSent: 0, bytesReceived: 0, rttHistory: [] })
	const [receivedText, setReceivedText] = useState('')

	const [fileToSend, setFileToSend] = useState(null)
	const [sendProgress, setSendProgress] = useState({ sentChunks: 0, totalChunks: 0 })
	const [recvFileInfo, setRecvFileInfo] = useState(null)
	const recvChunksRef = useRef([])
	const [recvProgress, setRecvProgress] = useState({ receivedChunks: 0, totalChunks: 0 })
	const [downloadUrl, setDownloadUrl] = useState('')

	const reliability = useMemo(() => ReliabilityLayer((payload) => {
		if (!payload || typeof payload !== 'object') return
		if (payload.kind === 'text') {
			if (typeof payload.text === 'string') setReceivedText((prev) => prev + payload.text)
			return
		}
		if (payload.kind === 'file-meta') {
			setRecvFileInfo({ name: payload.name, size: payload.size, type: payload.type })
			recvChunksRef.current = new Array(payload.totalChunks)
			setRecvProgress({ receivedChunks: 0, totalChunks: payload.totalChunks })
			return
		}
		if (payload.kind === 'file-chunk') {
			if (!recvChunksRef.current.length) return
			const idx = payload.index
			recvChunksRef.current[idx] = base64ToUint8Array(payload.data)
			const receivedChunks = recvChunksRef.current.filter(Boolean).length
			setRecvProgress((p) => ({ ...p, receivedChunks }))
			return
		}
		if (payload.kind === 'file-complete') {
			const parts = recvChunksRef.current
			if (!parts.length) return
			const blob = new Blob(parts, { type: recvFileInfo?.type || 'application/octet-stream' })
			if (downloadUrl) URL.revokeObjectURL(downloadUrl)
			setDownloadUrl(URL.createObjectURL(blob))
			return
		}
	}, setStats), [])

	useEffect(() => {
		if (!pc) return
		pc.onconnectionstatechange = () => {
			setConnected(pc.connectionState === 'connected')
		}
	}, [pc])

	useEffect(() => {
		if (!dc) return
		dc.onmessage = (ev) => reliability.handleIncoming(dc, ev.data)
	}, [dc, reliability])

	const createOffer = async () => {
		const { pc } = createPeer(signaling, roomId, (chan) => setDc(chan))
		setPc(pc)
		const chan = pc.createDataChannel('data', { ordered: false, maxRetransmits: 0 })
		setDc(chan)
		chan.onmessage = (ev) => reliability.handleIncoming(chan, ev.data)
		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)
		signaling.send({ type: 'offer', roomId, sdp: pc.localDescription })
	}

	const createAnswer = async () => {
		const { pc } = createPeer(signaling, roomId, (chan) => setDc(chan))
		setPc(pc)
	}

	const sendMessage = () => {
		reliability.send(dc, { kind: 'text', text: 'Hello ' + new Date().toLocaleTimeString() + '\n' })
	}

	const CHUNK_SIZE = 16 * 1024
	const sendFile = async () => {
		if (!fileToSend) return
		const file = fileToSend
		const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
		setSendProgress({ sentChunks: 0, totalChunks })
		await waitUntilSent(() => reliability.send(dc, { kind: 'file-meta', name: file.name, size: file.size, type: file.type, totalChunks }))
		for (let i = 0; i < totalChunks; i++) {
			const start = i * CHUNK_SIZE
			const end = Math.min(start + CHUNK_SIZE, file.size)
			const slice = file.slice(start, end)
			const buf = await slice.arrayBuffer()
			const b64 = arrayBufferToBase64(buf)
			await waitUntilSent(() => reliability.send(dc, { kind: 'file-chunk', index: i, data: b64 }))
			setSendProgress({ sentChunks: i + 1, totalChunks })
		}
		await waitUntilSent(() => reliability.send(dc, { kind: 'file-complete' }))
	}

	function waitUntilSent(trySend) {
		return new Promise((resolve) => {
			const tick = () => {
				const ok = trySend()
				if (ok) return resolve()
				setTimeout(tick, 10)
			}
			tick()
		})
	}

	const canvasRef = useRef(null)
	useEffect(() => {
		const canvas = canvasRef.current
		if (!canvas) return
		const ctx = canvas.getContext('2d')
		const w = canvas.width
		const h = canvas.height
		ctx.clearRect(0, 0, w, h)
		const data = stats.rttHistory || []
		if (!data.length) return
		const max = Math.max(...data, 1)
		ctx.strokeStyle = '#4da3ff'
		ctx.beginPath()
		for (let i = 0; i < data.length; i++) {
			const x = (i / (data.length - 1)) * (w - 2) + 1
			const y = h - 1 - (data[i] / max) * (h - 2)
			if (i === 0) ctx.moveTo(x, y)
			else ctx.lineTo(x, y)
		}
		ctx.stroke()
	}, [stats.rttHistory])

	const sentPct = sendProgress.totalChunks ? Math.round((sendProgress.sentChunks / sendProgress.totalChunks) * 100) : 0
	const recvPct = recvProgress.totalChunks ? Math.round((recvProgress.receivedChunks / recvProgress.totalChunks) * 100) : 0

	return (
		<div className="app">
			<div className="header">
				<div>
					<div className="title">WebRTC Reliability Demo</div>
					<div className="subtitle">Unreliable/Unordered DataChannel with custom stop-and-wait reliability</div>
				</div>
				<div className="row">
					<input className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)} placeholder="Room" />
					<button className="btn" disabled={!signaling.joined} onClick={createOffer}>Create Offer</button>
					<button className="btn secondary" disabled={!signaling.joined} onClick={createAnswer}>Answer</button>
				</div>
			</div>

			<div className="panel" style={{ marginTop: 16 }}>
				<div className="row" style={{ justifyContent: 'space-between' }}>
					<div className="row">
						<button className="btn" disabled={!dc || dc.readyState !== 'open'} onClick={sendMessage}>Send Message</button>
						<span className="small">Status: {connected ? 'Connected' : 'Not connected'}</span>
					</div>
					<div className="row">
						<canvas ref={canvasRef} width={240} height={48} style={{ borderRadius: 8, border: '1px solid var(--border)', background: '#0c121a' }} />
						<div className="small">RTT</div>
					</div>
				</div>
			</div>

			<div className="panel" style={{ marginTop: 16 }}>
				<div className="badges">
					<div className="badge"><strong>Sent</strong><div>{stats.sent}</div></div>
					<div className="badge"><strong>Received</strong><div>{stats.received}</div></div>
					<div className="badge"><strong>ACKs</strong><div>{stats.acks}</div></div>
					<div className="badge"><strong>Retransmits</strong><div>{stats.retransmits}</div></div>
					<div className="badge"><strong>RTT (ms)</strong><div>{stats.rttMs}</div></div>
					<div className="badge"><strong>Bytes Sent</strong><div>{stats.bytesSent}</div></div>
					<div className="badge"><strong>Bytes Recv</strong><div>{stats.bytesReceived}</div></div>
				</div>
			</div>

			<div className="grid-2" style={{ marginTop: 16 }}>
				<div className="panel">
					<div className="card-title">Send File</div>
					<div className="row">
						<input type="file" onChange={(e) => setFileToSend(e.target.files?.[0] || null)} />
						<button className="btn" disabled={!fileToSend || !dc || dc.readyState !== 'open'} onClick={sendFile}>Send</button>
					</div>
					{sendProgress.totalChunks > 0 && (
						<div className="progress" style={{ marginTop: 8 }}>
							<span style={{ width: `${sentPct}%` }} />
						</div>
					)}
					{sendProgress.totalChunks > 0 && (
						<div className="small" style={{ marginTop: 6 }}>
							Sending {sendProgress.sentChunks}/{sendProgress.totalChunks} chunks ({sentPct}%)
						</div>
					)}
				</div>

				<div className="panel">
					<div className="card-title">Receive File</div>
					{recvFileInfo && (
						<div className="small">{recvFileInfo.name} ({recvFileInfo.size} bytes)</div>
					)}
					{recvProgress.totalChunks > 0 && (
						<div className="progress" style={{ marginTop: 8 }}>
							<span style={{ width: `${recvPct}%` }} />
						</div>
					)}
					{recvProgress.totalChunks > 0 && (
						<div className="small" style={{ marginTop: 6 }}>
							Received {recvProgress.receivedChunks}/{recvProgress.totalChunks} chunks ({recvPct}%)
						</div>
					)}
					{downloadUrl && (
						<div style={{ marginTop: 8 }}>
							<a className="link" href={downloadUrl} download={recvFileInfo?.name || 'file'}>Download received file</a>
						</div>
					)}
				</div>
			</div>

			<div className="panel" style={{ marginTop: 16 }}>
				<div className="card-title">Received Text</div>
				<pre className="code" style={{ minHeight: 120 }}>{receivedText}</pre>
			</div>
		</div>
	)
}

