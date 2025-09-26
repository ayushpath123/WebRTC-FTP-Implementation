import express from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// We keep track of all the rooms and which WebSocket connections are in each room
// Think of it like chat rooms - each room has a list of people connected to it
const rooms = new Map();

function getOrCreateRoom(roomId) {
	if (!rooms.has(roomId)) {
		rooms.set(roomId, new Set());
	}
	return rooms.get(roomId);
}

wss.on('connection', (ws) => {
	ws._roomId = null;

	ws.on('message', (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch (e) {
			console.warn('Invalid JSON message');
			return;
		}

		const { type } = msg || {};
		if (type === 'join') {
			const { roomId } = msg;
			if (!roomId) return;
			const room = getOrCreateRoom(roomId);
			room.add(ws);
			ws._roomId = roomId;
			ws.send(JSON.stringify({ type: 'joined', roomId }));
			console.log(`Client joined room ${roomId} (size=${room.size})`);
			return;
		}

		// When someone sends an offer, answer, or ICE candidate, we pass it along to everyone else in the same room
		// This is how WebRTC peers find each other and establish a direct connection
		if (['offer', 'answer', 'candidate'].includes(type)) {
			const { roomId } = msg;
			if (!roomId) return;
			const room = rooms.get(roomId);
			if (!room) return;
			for (const client of room) {
				if (client !== ws && client.readyState === 1) {
					client.send(JSON.stringify(msg));
				}
			}
		}
	});

	ws.on('close', () => {
		const roomId = ws._roomId;
		if (!roomId) return;
		const room = rooms.get(roomId);
		if (!room) return;
		room.delete(ws);
		if (room.size === 0) {
			rooms.delete(roomId);
		}
		console.log(`Client left room ${roomId} (size=${room.size || 0})`);
	});
});

server.listen(PORT, () => {
	console.log(`Signaling server on http://localhost:${PORT}`);
});
