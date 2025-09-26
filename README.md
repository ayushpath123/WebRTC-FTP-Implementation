# WebRTC Reliability Demo 🚀

Ever wondered how to make unreliable things reliable? This demo shows you exactly that!

We take WebRTC's intentionally unreliable DataChannel and build our own "guaranteed delivery " system on top of it. It's like building a reliable postal service using carrier pigeons - challenging but totally doable!

## What's Cool About This? ✨
- **Unreliable by Design**: We intentionally use the least reliable DataChannel settings possible
- **Custom Reliability**: Built our own "registered mail" system that waits for confirmations
- **File Transfer**: Send any file by breaking it into pieces and reassembling it perfectly
- **Live Dashboard**: Watch packets fly back and forth with real-time stats
- **Pretty Charts**: See your connection quality with a live response time graph

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

## How Does This Magic Work? 🎭

**The Matchmaking**: Two browsers find each other through our WebSocket signaling server (like a dating app for browsers)

**The Unreliable Channel**: We deliberately choose the most unreliable DataChannel settings - no ordering, no retries

**Our Reliability Layer**: Think of it like registered mail:
- 📦 Send one package at a time with a tracking number
- ⏰ Wait for "got it!" confirmation
- 🔄 If no response in 600ms, try again
- ✅ Only send the next package after confirmation

**File Transfer Magic**:
- 📄 First: "Hey, I'm sending you cat.jpg (2MB, 125 pieces)"
- 🧩 Then: Send each 16KB piece one by one, waiting for each "got it!"
- 🎉 Finally: "All done!" and the receiver glues the pieces back together

**Live Stats**: Every message, confirmation, and retry is counted and graphed in real-time!

## Demo Video
Add your short demo video link here: [Demo Video](https://example.com)

## Fun Facts & Limitations 🤓
- **It's Deliberately Slow**: We chose simplicity over speed. A real system might send multiple pieces at once!
- **Browser Tested**: Works great in Chrome, Firefox, and other modern browsers
- **Educational**: This is more about understanding the concepts than building a production system
- **Expandable**: You could easily upgrade this to a sliding window protocol for better performance

## License
MIT
