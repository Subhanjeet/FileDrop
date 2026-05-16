/* ═══════════════════════════════════════════════════════════
   FileDrop — WebRTC P2P File Transfer
   Architecture:
     - RTCPeerConnection with a STUN server for NAT traversal
     - RTCDataChannel for actual binary data transfer
     - Manual signaling: users copy-paste SDP offer/answer
       (no signaling server needed — works completely offline
        once the peer connection is established)
═══════════════════════════════════════════════════════════ */

// ─── STUN server config (Google's public STUN) ──────────────
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Chunk size for splitting files before sending over DataChannel
const CHUNK_SIZE = 16 * 1024; // 16 KB per chunk

// ─── State ───────────────────────────────────────────────────
let senderPc     = null;   // RTCPeerConnection (sender side)
let receiverPc   = null;   // RTCPeerConnection (receiver side)
let dataChannel  = null;   // RTCDataChannel opened by sender
let selectedFile = null;   // File object chosen by sender

// Receiver accumulates incoming chunks here
let recvBuffer   = [];
let recvReceived = 0;     // bytes received so far
let recvMeta     = null;  // { name, size, type } sent ahead of file data

/* ──────────────────────────────────────────────────────────
   UI HELPERS
────────────────────────────────────────────────────────── */

// Map file extension/mime to an emoji icon
function fileIcon(name, type = '') {
  const ext = name.split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','gif','webp','svg','bmp'].includes(ext)) return '🖼️';
  if (['mp4','mov','avi','mkv','webm'].includes(ext)) return '🎬';
  if (['mp3','wav','ogg','flac','aac'].includes(ext)) return '🎵';
  if (['pdf'].includes(ext)) return '📄';
  if (['zip','rar','7z','tar','gz'].includes(ext)) return '🗜️';
  if (['js','ts','py','java','c','cpp','html','css','json'].includes(ext)) return '💻';
  if (['doc','docx'].includes(ext)) return '📝';
  if (['xls','xlsx','csv'].includes(ext)) return '📊';
  if (['ppt','pptx'].includes(ext)) return '📑';
  return '📁';
}

// Format bytes → human-readable string
function formatSize(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

// Append a toast message to a container
function toast(containerId, message, type = 'info') {
  const area = document.getElementById(containerId);
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  area.appendChild(t);
  // Auto-remove after 8 seconds
  setTimeout(() => t.remove(), 8000);
}

// Update the connection status pill in the header
function setStatus(state, label) {
  const pill = document.getElementById('connectionStatus');
  const txt  = document.getElementById('statusText');
  pill.className = `status-pill ${state}`;
  txt.textContent = label;
}

/* ──────────────────────────────────────────────────────────
   FILE SELECTION (Sender)
────────────────────────────────────────────────────────── */

const dropZone  = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

// Triggered when user picks a file via click or drop
function handleFileSelected(file) {
  if (!file) return;
  selectedFile = file;

  // Render file preview card
  const wrap = document.getElementById('fileCardWrap');
  wrap.style.display = 'block';
  wrap.innerHTML = `
    <div class="file-card">
      <div class="file-icon">${fileIcon(file.name, file.type)}</div>
      <div class="file-meta">
        <div class="file-name">${file.name}</div>
        <div class="file-size">${formatSize(file.size)} · ${file.type || 'unknown type'}</div>
      </div>
      <button class="file-remove" title="Remove" onclick="removeFile()">✕</button>
    </div>
  `;

  toast('senderToasts', `Selected: ${file.name} (${formatSize(file.size)})`, 'info');
}

function removeFile() {
  selectedFile = null;
  document.getElementById('fileCardWrap').style.display = 'none';
  fileInput.value = '';
  toast('senderToasts', 'File removed.', 'warn');
}

// Native file input change
if (fileInput) {
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFileSelected(fileInput.files[0]);
  });
}

// Drag-and-drop events
if (dropZone) {
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelected(file);
  });
}

/* ──────────────────────────────────────────────────────────
   SENDER FLOW — Step 1: Create Offer
────────────────────────────────────────────────────────── */

async function startSenderFlow() {
  if (!selectedFile) {
    toast('senderToasts', 'Select a file first.', 'error');
    return;
  }

  document.getElementById('createOfferBtn').disabled = true;
  setStatus('connecting', 'Creating offer…');
  toast('senderToasts', 'Creating WebRTC connection…', 'info');

  // Create peer connection
  senderPc = new RTCPeerConnection(RTC_CONFIG);

  // Open a reliable ordered data channel for file bytes
  dataChannel = senderPc.createDataChannel('filedrop', { ordered: true });
  setupDataChannel(dataChannel);

  // Collect ICE candidates and embed them into the final offer SDP
  // We wait for ICE gathering to complete before showing the offer code
  senderPc.onicecandidate = () => {};
  senderPc.onicegatheringstatechange = async () => {
    if (senderPc.iceGatheringState === 'complete') {
      // Encode the full SDP (with ICE candidates) as base64 for easy copy-paste
      const offerSDP = btoa(JSON.stringify(senderPc.localDescription));
      document.getElementById('offerOutput').value = offerSDP;
      document.getElementById('offerBox').style.display = 'block';
      document.getElementById('sendFileBtn').style.display = 'block';
      toast('senderToasts', 'Offer ready — copy and share it with the receiver.', 'ok');
      setStatus('connecting', 'Waiting for answer…');
    }
  };

  // Create and set local SDP offer
  const offer = await senderPc.createOffer();
  await senderPc.setLocalDescription(offer);
}

/* ──────────────────────────────────────────────────────────
   SENDER FLOW — Step 2: Apply Answer from Receiver
────────────────────────────────────────────────────────── */

async function applyAnswer() {
  const raw = document.getElementById('answerInput').value.trim();
  if (!raw) {
    toast('senderToasts', 'Paste the answer code first.', 'error');
    return;
  }
  try {
    const answer = JSON.parse(atob(raw));
    await senderPc.setRemoteDescription(new RTCSessionDescription(answer));
    setStatus('connecting', 'Connecting…');
    toast('senderToasts', 'Answer applied — establishing connection…', 'info');
  } catch (err) {
    toast('senderToasts', 'Invalid answer code. Check and retry.', 'error');
  }
}

/* ──────────────────────────────────────────────────────────
   DATA CHANNEL EVENTS (Sender side)
────────────────────────────────────────────────────────── */

function setupDataChannel(channel) {
  channel.binaryType = 'arraybuffer';

  channel.onopen = () => {
    setStatus('connected', 'Connected');
    toast('senderToasts', '✅ Peer connected! Ready to send.', 'ok');
    document.getElementById('sendFileBtn').disabled = false;
  };

  channel.onclose = () => {
    setStatus('', 'Disconnected');
    toast('senderToasts', 'Connection closed.', 'warn');
  };

  channel.onerror = (e) => {
    toast('senderToasts', 'Data channel error: ' + e.message, 'error');
  };
}

/* ──────────────────────────────────────────────────────────
   SENDER FLOW — Step 3: Send File
────────────────────────────────────────────────────────── */

async function sendFile() {
  if (!selectedFile) {
    toast('senderToasts', 'No file selected.', 'error');
    return;
  }
  if (!dataChannel || dataChannel.readyState !== 'open') {
    toast('senderToasts', 'Not connected yet. Apply the answer code first.', 'error');
    return;
  }

  const btn = document.getElementById('sendFileBtn');
  btn.disabled = true;

  // 1. Send file metadata as a JSON string so receiver knows name/size/type
  const meta = { name: selectedFile.name, size: selectedFile.size, type: selectedFile.type };
  dataChannel.send(JSON.stringify({ __meta: meta }));

  // 2. Show progress UI
  const progressWrap  = document.getElementById('sendProgress');
  const progressBar   = document.getElementById('sendBar');
  const progressLabel = document.getElementById('sendProgressLabel');
  const progressText  = document.getElementById('sendProgressText');
  const progressPct   = document.getElementById('sendProgressPct');
  progressWrap.classList.add('visible');
  progressLabel.style.display = 'flex';
  progressText.textContent = `Sending ${selectedFile.name}…`;

  // 3. Read file as ArrayBuffer and slice into chunks
  const buffer      = await selectedFile.arrayBuffer();
  const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
  let   sentChunks  = 0;

  // Throttle sending to avoid flooding the buffer
  function sendNextChunk() {
    // Wait if the buffer is backing up (> 1 MB queued)
    if (dataChannel.bufferedAmount > 1024 * 1024) {
      setTimeout(sendNextChunk, 50);
      return;
    }

    const start  = sentChunks * CHUNK_SIZE;
    const end    = Math.min(start + CHUNK_SIZE, buffer.byteLength);
    const chunk  = buffer.slice(start, end);

    dataChannel.send(chunk);
    sentChunks++;

    // Update progress
    const pct = Math.round((sentChunks / totalChunks) * 100);
    progressBar.style.width = pct + '%';
    progressPct.textContent = pct + '%';

    if (sentChunks < totalChunks) {
      // Schedule next chunk on next tick to keep UI responsive
      setTimeout(sendNextChunk, 0);
    } else {
      // All chunks sent — signal EOF
      dataChannel.send(JSON.stringify({ __eof: true }));
      progressText.textContent = '✅ Sent!';
      toast('senderToasts', `✅ "${selectedFile.name}" sent successfully.`, 'ok');
      btn.textContent = '✅ Sent';
    }
  }

  sendNextChunk();
}

/* ──────────────────────────────────────────────────────────
   RECEIVER FLOW — Step 1: Generate Answer
────────────────────────────────────────────────────────── */

async function generateAnswer() {
  const raw = document.getElementById('offerInput').value.trim();
  if (!raw) {
    toast('receiverToasts', 'Paste the sender\'s offer code first.', 'error');
    return;
  }

  let offer;
  try {
    offer = JSON.parse(atob(raw));
  } catch {
    toast('receiverToasts', 'Invalid offer code.', 'error');
    return;
  }

  setStatus('connecting', 'Generating answer…');
  toast('receiverToasts', 'Processing offer…', 'info');

  // Create receiver peer connection
  receiverPc = new RTCPeerConnection(RTC_CONFIG);

  // Listen for the data channel opened by the sender
  receiverPc.ondatachannel = (e) => {
    const channel = e.channel;
    channel.binaryType = 'arraybuffer';
    setupReceiverChannel(channel);
  };

  // Wait for ICE gathering to complete before producing the answer code
  receiverPc.onicegatheringstatechange = async () => {
    if (receiverPc.iceGatheringState === 'complete') {
      const answerSDP = btoa(JSON.stringify(receiverPc.localDescription));
      document.getElementById('answerOutput').value = answerSDP;
      document.getElementById('answerBox').style.display = 'block';
      toast('receiverToasts', 'Answer ready — copy and send it back to the sender.', 'ok');
      setStatus('connecting', 'Waiting for sender…');
    }
  };

  // Set remote description from sender's offer, create and set local answer
  await receiverPc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await receiverPc.createAnswer();
  await receiverPc.setLocalDescription(answer);
}

/* ──────────────────────────────────────────────────────────
   RECEIVER — Data Channel Handler
────────────────────────────────────────────────────────── */

function setupReceiverChannel(channel) {
  channel.onopen = () => {
    setStatus('connected', 'Connected');
    toast('receiverToasts', '✅ Sender connected! Waiting for file…', 'ok');
  };

  channel.onmessage = (e) => {
    // String messages are either metadata or EOF signal
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);

      if (msg.__meta) {
        // New file incoming — reset buffer and store metadata
        recvMeta     = msg.__meta;
        recvBuffer   = [];
        recvReceived = 0;

        // Show receive progress
        document.getElementById('recvProgress').classList.add('visible');
        document.getElementById('recvProgressLabel').style.display = 'flex';
        document.getElementById('recvProgressText').textContent = `Receiving ${recvMeta.name}…`;

        toast('receiverToasts', `Incoming: ${recvMeta.name} (${formatSize(recvMeta.size)})`, 'info');
        return;
      }

      if (msg.__eof) {
        // File fully received — assemble and offer download
        finalizeReceivedFile();
        return;
      }
    }

    // Binary chunk — accumulate into buffer
    if (e.data instanceof ArrayBuffer) {
      recvBuffer.push(e.data);
      recvReceived += e.data.byteLength;

      if (recvMeta) {
        const pct = Math.min(100, Math.round((recvReceived / recvMeta.size) * 100));
        document.getElementById('recvBar').style.width = pct + '%';
        document.getElementById('recvProgressPct').textContent = pct + '%';
      }
    }
  };

  channel.onclose = () => {
    setStatus('', 'Disconnected');
    toast('receiverToasts', 'Connection closed.', 'warn');
  };
}

/* ──────────────────────────────────────────────────────────
   RECEIVER — Assemble + Display Received File
────────────────────────────────────────────────────────── */

function finalizeReceivedFile() {
  if (!recvMeta || recvBuffer.length === 0) return;

  // Merge ArrayBuffer chunks into a single Blob
  const blob = new Blob(recvBuffer, { type: recvMeta.type || 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);

  // Show the received files section
  document.getElementById('emptyReceived').style.display = 'none';
  const list = document.getElementById('receivedList');
  list.style.display = 'flex';

  // Append a received file item with download link
  const item = document.createElement('div');
  item.className = 'received-item';
  item.innerHTML = `
    <div class="file-icon">${fileIcon(recvMeta.name, recvMeta.type)}</div>
    <div class="file-meta">
      <div class="file-name">${recvMeta.name}</div>
      <div class="file-size">${formatSize(recvMeta.size)} · ${recvMeta.type || 'unknown type'}</div>
    </div>
    <a class="dl-btn" href="${url}" download="${recvMeta.name}">⬇ Download</a>
  `;
  list.appendChild(item);

  // Update progress label
  document.getElementById('recvProgressText').textContent = '✅ Received!';
  document.getElementById('recvBar').style.width = '100%';

  toast('receiverToasts', `✅ "${recvMeta.name}" received! Click Download.`, 'ok');

  // Reset state for next file
  recvBuffer   = [];
  recvReceived = 0;
  recvMeta     = null;
}

/* ──────────────────────────────────────────────────────────
   COPY HELPERS
────────────────────────────────────────────────────────── */

async function copyOffer() {
  const text = document.getElementById('offerOutput').value;
  await navigator.clipboard.writeText(text).catch(() => {});
  toast('senderToasts', 'Offer code copied!', 'ok');
}

async function copyAnswer() {
  const text = document.getElementById('answerOutput').value;
  await navigator.clipboard.writeText(text).catch(() => {});
  toast('receiverToasts', 'Answer code copied!', 'ok');
}
