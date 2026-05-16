# FileDrop

**P2P file transfer in the browser — no server, no uploads, no accounts.**

---

## What it is

FileDrop lets two browsers transfer files directly to each other using **WebRTC DataChannel**. Nothing touches a server. The file goes straight from one machine to the other through an encrypted peer-to-peer connection.

---

## How the connection works (manual SDP signaling)

WebRTC needs both sides to exchange *session descriptions* (SDP) before they can talk. Most apps do this automatically via a signaling server. FileDrop skips that — it makes you copy-paste the codes yourself. Thats why theres no backend.

**Step-by-step:**

1. **Sender** picks a file and clicks **Create Connection**
   - `RTCPeerConnection` is created
   - an *offer SDP* is generated via `createOffer()` + `setLocalDescription()`
   - ICE candidates get gathered and bundled into the offer
   - the final offer JSON is shown in a textarea — sender copies it

2. **Receiver** pastes the offer code and clicks **Generate Answer**
   - offer is parsed and set via `setRemoteDescription()`
   - an *answer SDP* is created via `createAnswer()` + `setLocalDescription()`
   - ICE candidates gathered and bundled into the answer
   - answer JSON shown in textarea — receiver copies it

3. **Sender** pastes the answer and clicks **Apply Answer**
   - `setRemoteDescription()` is called with the answer
   - ICE negotiation completes, WebRTC connection opens

4. **DataChannel** is now live — sender clicks **Send File**

---

## How file transfer works (chunked binary)

Sending a whole file in one shot would choke the DataChannel. So `script.js` breaks it into chunks:

```
file → FileReader → ArrayBuffer → split into ~16KB chunks → send one by one
```

- sender reads the file as an `ArrayBuffer`
- first message sent is a metadata JSON: `{ name, size, type }`
- then chunks are sent in order through `dataChannel.send(chunk)`
- receiver accumulates chunks in an array
- when total received bytes === expected size, it reassembles with `new Blob(chunks)`
- a download link is created via `URL.createObjectURL(blob)` and shown in the received files list

Progress bars on both sides update after each chunk based on bytes sent / total size.

---

## File structure

```
FileDrop/
├── index.html   — full UI: both sender and receiver panels in one page
├── script.js    — all the WebRTC + file transfer logic
└── style.css    — responsive layout, dark-themed UI
```

### `index.html`

Two panels side by side — **Send a File** (left) and **Receive a File** (right). Each has textareas for pasting SDP codes and a progress bar. Footer explains the 4-step flow visually.

### `script.js`

Core functions:

| Function | What it does |
|---|---|
| `startSenderFlow()` | Creates `RTCPeerConnection` + DataChannel, generates offer |
| `generateAnswer()` | Reads offer from textarea, creates answer, opens DataChannel listener |
| `applyAnswer()` | Applies answer SDP to sender's peer connection |
| `sendFile()` | Reads file, sends metadata then chunks over DataChannel |
| `copyOffer()` / `copyAnswer()` | Copy SDP codes to clipboard |

DataChannel `onmessage` on receiver side handles both the metadata message and the incoming binary chunks.

### `style.css`

Clean responsive two-panel layout. Uses CSS variables for theming. Works on mobile — panels stack vertically on small screens.

---

## No backend, really?

Correct. Zero server involved in the transfer. The only "external" thing is STUN servers (like `stun.l.google.com`) which WebRTC uses to figure out your public IP for NAT traversal. File data never touches them.

> One limitation: if both peers are behind **symmetric NAT** (some corporate networks), the STUN-only approach may fail. A TURN relay server would fix that but isnt included here.

---

## Run it locally

Just open `index.html` in a browser — no build step, no npm, nothing.

```bash
git clone https://github.com/Subhanjeet/FileDrop
cd FileDrop
open index.html   # or just drag it into a browser
```

To test P2P properly, open it in two different browser windows or on two different devices on the same network.

---

## Tech used

- **WebRTC** — `RTCPeerConnection`, `RTCDataChannel`
- **FileReader API** — read file as ArrayBuffer
- **Blob + URL.createObjectURL** — reassemble and trigger download
- Pure **HTML / CSS / JS** — no frameworks, no dependencies
