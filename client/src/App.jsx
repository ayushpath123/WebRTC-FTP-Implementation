import React, { useEffect, useMemo, useRef, useState } from 'react'

// This is where our signaling server lives - it helps peers find each other
const SIGNALING_URL = (import.meta.env.VITE_SIGNALING_URL) || 'ws://localhost:3001/ws'

// This hook manages our WebSocket connection to the signaling server
// It's like a matchmaking service that helps two browsers connect to each other
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

// This creates a WebRTC peer connection - the magic that lets browsers talk directly to each other
// We also set up handlers for when the other peer sends us data or wants to connect
function createPeer(signaling, roomId, onChannel) {
	const pc = new RTCPeerConnection({
		iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
	})

	// When we discover a way to connect (like our IP address), tell the other peer about it
	pc.onicecandidate = (e) => {
		if (e.candidate) {
			signaling.send({ type: 'candidate', roomId, candidate: e.candidate })
		}
	}
	// When the other peer opens a data channel, we'll use it to send messages and files
	pc.ondatachannel = (e) => {
		onChannel(e.channel)
	}

	// Listen for messages from the signaling server and handle the WebRTC handshake
	const unsubscribe = signaling.onMessage(async (msg) => {
		// Someone wants to connect to us - let's accept their offer and send back our answer
		if (msg.type === 'offer') {
			await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
			const answer = await pc.createAnswer()
			await pc.setLocalDescription(answer)
			signaling.send({ type: 'answer', roomId, sdp: pc.localDescription })
		}
		// The other peer accepted our connection offer - great!
		if (msg.type === 'answer') {
			await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
		}
		// The other peer found a way to connect - let's try using this path
		if (msg.type === 'candidate') {
			try {
				await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
			} catch {}
		}
	})

	return { pc, cleanup: unsubscribe }
}

// This is our custom reliability system! WebRTC DataChannels are unreliable by default,
// so we build our own "guaranteed delivery" system on top of it
// Think of it like registered mail - we wait for confirmation before sending the next piece
function ReliabilityLayer(onDeliver, onStats) {
	// This keeps track of our reliability system's state
	const state = {
		nextSeq: 0,                    // What sequence number to send next
		awaitingAckSeq: null,          // Are we waiting for a confirmation?
		inflightPayload: null,         // What message are we currently sending
		inflightTimestamp: 0,          // When did we send it (for timing)
		timer: null,                   // Timer for retrying if no response
		timeoutMs: 600,                // How long to wait before retrying
		stats: { sent: 0, received: 0, acks: 0, retransmits: 0, rttMs: 0, bytesSent: 0, bytesReceived: 0 },
		rttHistory: [],                // Keep track of recent response times
		rttHistoryMax: 40              // Don't store too much history
	}

	// Send a message and wait for confirmation - like sending registered mail
	function send(dc, payload) {
		if (!dc || dc.readyState !== 'open') return false  // Can't send if not connected
		if (state.awaitingAckSeq !== null) return false   // Already waiting for a response
		const seq = state.nextSeq
		state.awaitingAckSeq = seq
		state.inflightPayload = payload
		state.inflightTimestamp = performance.now()
		const serialized = JSON.stringify({ t: 'data', seq, payload })
		dc.send(serialized)
		state.stats.sent++
		state.stats.bytesSent += serialized.length
		update()
		// If we don't hear back in time, try sending again (like following up on an email)
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

	// Handle messages coming in from the other peer
	function handleIncoming(dc, raw) {
		let msg
		try { msg = JSON.parse(raw) } catch { return }  // Ignore malformed messages
		// Got a data message - send back a "got it!" confirmation
		if (msg.t === 'data') {
			state.stats.received++
			state.stats.bytesReceived += raw.length
			update()
			dc.send(JSON.stringify({ t: 'ack', seq: msg.seq }))  // Send "ACK" (acknowledgment)
			onDeliver(msg.payload)  // Actually deliver the message to the app
			return
		}
		// Got a confirmation! The other peer received our message
		if (msg.t === 'ack') {
			if (state.awaitingAckSeq === msg.seq) {
				const now = performance.now()
				state.stats.acks++
				// Calculate how long the round trip took (like ping time)
				const rtt = Math.round(now - state.inflightTimestamp)
				state.stats.rttMs = rtt
				state.rttHistory.push(rtt)  // Keep track for the chart
				if (state.rttHistory.length > state.rttHistoryMax) state.rttHistory.shift()
				// Clear the "waiting" state - we can send the next message now
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

// These functions help us convert file data to text and back again
// Since DataChannels can only send text, we encode binary files as base64 strings
// It's like converting a photo to a really long string of letters and numbers
function arrayBufferToBase64(buffer) {
	let binary = ''
	const bytes = new Uint8Array(buffer)
	const len = bytes.byteLength
	for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i])
	return btoa(binary)  // Built-in browser function to convert to base64
}

// Convert the base64 string back into file data
function base64ToUint8Array(base64) {
	const binary = atob(base64)  // Built-in browser function to decode base64
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

	// Set up our reliability system and tell it what to do when messages arrive
	const reliability = useMemo(() => ReliabilityLayer((payload) => {
		// Make sure we got a valid message
		if (!payload || typeof payload !== 'object') return
		// Handle text messages (like chat)
		if (payload.kind === 'text') {
			if (typeof payload.text === 'string') setReceivedText((prev) => prev + payload.text)
			return
		}
		// Someone is about to send us a file - get ready to receive it
		if (payload.kind === 'file-meta') {
			setRecvFileInfo({ name: payload.name, size: payload.size, type: payload.type })
			recvChunksRef.current = new Array(payload.totalChunks)  // Make space for all the pieces
			setRecvProgress({ receivedChunks: 0, totalChunks: payload.totalChunks })
			return
		}
		// Got a piece of the file - store it in the right spot
		if (payload.kind === 'file-chunk') {
			if (!recvChunksRef.current.length) return
			const idx = payload.index
			recvChunksRef.current[idx] = base64ToUint8Array(payload.data)  // Convert back to file data
			const receivedChunks = recvChunksRef.current.filter(Boolean).length
			setRecvProgress((p) => ({ ...p, receivedChunks }))
			return
		}
		// All pieces received! Put the file back together and make it downloadable
		if (payload.kind === 'file-complete') {
			const parts = recvChunksRef.current
			if (!parts.length) return
			// Glue all the pieces back together into a complete file
			const blob = new Blob(parts, { type: recvFileInfo?.type || 'application/octet-stream' })
			if (downloadUrl) URL.revokeObjectURL(downloadUrl)  // Clean up old download link
			setDownloadUrl(URL.createObjectURL(blob))  // Create new download link
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

	// Start a connection by being the first to reach out (like making a phone call)
	const createOffer = async () => {
		const { pc } = createPeer(signaling, roomId, (chan) => setDc(chan))
		setPc(pc)
		// Create our data channel - this is our unreliable/unordered communication line
		const chan = pc.createDataChannel('data', { ordered: false, maxRetransmits: 0 })
		setDc(chan)
		chan.onmessage = (ev) => reliability.handleIncoming(chan, ev.data)
		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)
		signaling.send({ type: 'offer', roomId, sdp: pc.localDescription })
	}

	// Accept an incoming connection (like answering a phone call)
	const createAnswer = async () => {
		const { pc } = createPeer(signaling, roomId, (chan) => setDc(chan))
		setPc(pc)
	}

	// Send a simple text message to test our connection
	const sendMessage = () => {
		reliability.send(dc, { kind: 'text', text: 'Hello ' + new Date().toLocaleTimeString() + '\n' })
	}

	// Break files into small pieces for sending (like tearing up a photo and mailing each piece)
	const CHUNK_SIZE = 16 * 1024  // 16KB pieces - small enough to be reliable
	const sendFile = async () => {
		if (!fileToSend) return
		const file = fileToSend
		const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
		setSendProgress({ sentChunks: 0, totalChunks })
		// First, tell the other peer what file is coming
		await waitUntilSent(() => reliability.send(dc, { kind: 'file-meta', name: file.name, size: file.size, type: file.type, totalChunks }))
		// Then send each piece one by one, waiting for confirmation each time
		for (let i = 0; i < totalChunks; i++) {
			const start = i * CHUNK_SIZE
			const end = Math.min(start + CHUNK_SIZE, file.size)
			const slice = file.slice(start, end)  // Cut out this piece
			const buf = await slice.arrayBuffer()
			const b64 = arrayBufferToBase64(buf)  // Convert to text
			await waitUntilSent(() => reliability.send(dc, { kind: 'file-chunk', index: i, data: b64 }))
			setSendProgress({ sentChunks: i + 1, totalChunks })
		}
		// Finally, tell them we're done sending
		await waitUntilSent(() => reliability.send(dc, { kind: 'file-complete' }))
	}

	// Helper function: keep trying to send until our reliability layer accepts it
	// (It might be busy waiting for a previous message to be confirmed)
	function waitUntilSent(trySend) {
		return new Promise((resolve) => {
			const tick = () => {
				const ok = trySend()  // Try to send
				if (ok) return resolve()  // Success! We're done
				setTimeout(tick, 10)  // Not ready yet, try again in 10ms
			}
			tick()
		})
	}

	// Draw a simple line chart showing response times (like a heart rate monitor)
	const canvasRef = useRef(null)
	useEffect(() => {
		const canvas = canvasRef.current
		if (!canvas) return
		const ctx = canvas.getContext('2d')
		const w = canvas.width
		const h = canvas.height
		ctx.clearRect(0, 0, w, h)  // Clear the canvas
		const data = stats.rttHistory || []
		if (!data.length) return  // Nothing to draw yet
		const max = Math.max(...data, 1)  // Find the highest point for scaling
		ctx.strokeStyle = '#4da3ff'
		ctx.beginPath()
		// Draw a line connecting all the data points
		for (let i = 0; i < data.length; i++) {
			const x = (i / (data.length - 1)) * (w - 2) + 1  // Spread across width
			const y = h - 1 - (data[i] / max) * (h - 2)     // Scale to height
			if (i === 0) ctx.moveTo(x, y)  // Start the line
			else ctx.lineTo(x, y)          // Continue the line
		}
		ctx.stroke()  // Actually draw it
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

