# WebRTC Unreliable DataChannel Reliability Demo

A full-stack demo showcasing a custom reliability mechanism built on top of an unreliable and unordered WebRTC DataChannel. Includes a simple signaling server (Express + WebSocket) and a React UI that can transfer files/messages reliably with live stats.

## Features
- Single unreliable/unordered DataChannel (`ordered: false`, `maxRetransmits: 0`)
- Custom reliability (stop-and-wait ARQ) with sequencing, ACKs, retransmits, and timeouts
- File transfer with chunking and reassembly
- Live stats: packets sent/received, ACKs, retransmits, RTT estimate, bytes transferred
- Simple RTT history sparkline

## Project Structure
```
/server        Express + ws signaling server (rooms)
/client        React (Vite) frontend
```

## Prerequisites
- Node.js 18+

## Setup
```bash
# in project root
cd /home/ayush/code/WebRTC-Assignments

# install server deps
cd server
npm install

# install client deps
cd ../client
npm install
```

Optional: configure signaling URL for the client (default ws://localhost:3001/ws):
```bash
# /home/ayush/code/WebRTC-Assignments/client/.env
VITE_SIGNALING_URL=ws://localhost:3001/ws
```

## Run
Open two terminals:

Terminal 1 (server):
```bash
cd /home/ayush/code/WebRTC-Assignments/server
npm start
```

Terminal 2 (client):
```bash
cd /home/ayush/code/WebRTC-Assignments/client
npm run dev
```

Open two different browser windows/tabs to the printed client URL (default `http://localhost:5173`). Use the same Room ID in both, join, then:
- On one peer click "Create Offer"
- On the other peer click "Answer"
- When connected, try "Send Message" and try sending a file.

## How It Works
- Signaling is done over WebSocket; peers join a room and exchange SDP offers/answers and ICE candidates.
- DataChannel is configured as unreliable and unordered.
- Reliability is implemented with a stop-and-wait ARQ:
  - Sender sends one chunk with a sequence number and timestamp, waits for ACK.
  - If timeout elapses before ACK, retransmit.
  - Receiver ACKs the last seen sequence number and buffers file chunks.
- File transfer protocol:
  - Send `file-meta` (name/size/type/totalChunks)
  - Send `file-chunk` messages sequentially
  - Send `file-complete` and reassemble on receiver into a Blob (download link)
- Stats are updated in real time; RTT is estimated using send/ACK timestamps and plotted as a small sparkline.

## Demo Video
Add your short demo video link here: [Demo Video](https://example.com)

## Notes
- This demo favors clarity over maximum throughput. Consider a sliding window (Selective Repeat) for higher throughput.
- Tested locally with Chromium-based and Firefox browsers.

## License
MIT
