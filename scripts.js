/*
  Complete client that implements "offer-list" style signaling.

  How it works (summary):
  - هر کاربر که می‌خواد منتظر تماس بمونه createOffer() میزنه → آفر ساخته و با event "new-offer" به سرور ارسال می‌شه
  - بقیه کاربران لیست آفرها رو از event "offer-list" دریافت و نمایش می‌کنن
  - وقتی کسی روی یک آفر کلیک کنه، emit "select-offer" به سرور زده می‌شه
    → سرور آفر رو به selector می‌فرسته با event "target-offer" که شامل sdp آفره
  - selector سِشن را با setRemoteDescription(offer) و createAnswer() کامل می‌کنه و با "answer" به آفرگذار می‌فرسته
  - آفرگذار (offerer) وقتی "answer" می‌گیره setRemoteDescription می‌کنه و ارتباط تشکیل میشه
  - ICE candidateها بین دو طرف با event "ice-candidate" رد و بدل می‌شه
*/

let socket = null;
let myId = null;
let signalingUrlInput = document.getElementById('inputSignaling');
let turnUserInput = document.getElementById('inputTurnUser');
let turnPassInput = document.getElementById('inputTurnPass');

const myIdBadge = document.getElementById('myIdBadge');
const offersEl = document.getElementById('offers');
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

const btnStartLocal = document.getElementById('btnStartLocal');
const btnCreateOffer = document.getElementById('btnCreateOffer');
const btnStopOffer = document.getElementById('btnStopOffer');
const btnConnectSignal = document.getElementById('btnConnectSignal');

let localStream = null;
let pc = null;
let isOfferPlaced = false;
let placedOfferId = null; // socket id of our own placed offer (== myId)
let currentPeerId = null; // id of the peer we are connected to (other side)
let bufferedCandidates = []; // candidates generated before we know peer id (for offerer)

function log(msg) {
    const time = new Date().toLocaleTimeString();
    logEl.innerText = `[${time}] ${msg}\n` + logEl.innerText;
}

// create RTCPeerConnection with TURN/STUN from inputs
function createPeerConnection() {
    const TURN_USER = turnUserInput.value.trim();
    const TURN_PASS = turnPassInput.value.trim();
    const SIGNALING = signalingUrlInput.value.trim();
    const iceServers = [{
            urls: `stun:${new URL(SIGNALING).hostname}:3478`
        }, // tries STUN via same host as TURN (if accessible)
    ];
    if (TURN_USER && TURN_PASS) {
        iceServers.push({
            urls: [
                `turn:${new URL(SIGNALING).hostname}:3478?transport=udp`,
                `turn:${new URL(SIGNALING).hostname}:3478?transport=tcp`
            ],
            username: TURN_USER,
            credential: TURN_PASS
        });
    }

    console.log(iceServers)
    const config = {
        iceServers
    };

    log("creating RTCPeerConnection with ICE servers: " + JSON.stringify(iceServers.map(s => s.urls || s)));
    const _pc = new RTCPeerConnection(config);

    // attach local tracks
    if (localStream) {
        for (const t of localStream.getTracks()) _pc.addTrack(t, localStream);
    }

    // remote stream handling
    const remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;
    _pc.addEventListener('track', (ev) => {
        ev.streams?.[0] ? ev.streams[0].getTracks().forEach(tr => remoteStream.addTrack(tr)) : remoteStream
            .addTrack(ev.track);
    });

    // ICE candidates
    _pc.onicecandidate = (e) => {
        if (e.candidate) {
	    log("local ICE candidate generated");

	    const c = e.candidate;
	    if (c && c.type === 'relay') {
		log('TURN fallback used at' + JSON.stringify(c));
	    }

            // If we know who to send to use socket directly
            if (currentPeerId) {
                socket.emit('ice-candidate', {
                    to: currentPeerId,
                    candidate: c
                });
            } else {
                // buffer until we know peer id (typical for offerer before someone selects)
                bufferedCandidates.push(c);
            }
        }
    };

    _pc.onconnectionstatechange = () => {
        log("PC connectionState: " + _pc.connectionState);
        statusEl.innerText = "Status: " + _pc.connectionState;
    };

    return _pc;
}

// start camera/mic
btnStartLocal.addEventListener('click', async () => {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        localVideo.srcObject = localStream;
        log("local media started");
        btnCreateOffer.disabled = false;
    } catch (err) {
        log("getUserMedia error: " + err);
        alert("دسترسی میکروفن/وب‌کم لازم است. خطا را در console ببینید.");
        console.error(err);
    }
});

// connect to signaling server
btnConnectSignal.addEventListener('click', () => {
    const url = signalingUrlInput.value.trim();
    if (!url) return alert("لطفاً آدرس signaling را وارد کن.");
    connectSignaling(url);
});

function connectSignaling(url) {
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    log("connecting to signaling: " + url);
    // use websocket only to be deterministic
    socket = io(url, {
        transports: ['websocket']
    });

    socket.on('connect', () => {
        myId = socket.id;
        myIdBadge.innerText = myId;
        log("connected to signaling, myId=" + myId);
        socket.emit('get-offers'); // ask for current offers
    });

    socket.on('offer-list', (list) => {
        renderOfferList(list);
    });

    socket.on('target-offer', async ({
        from,
        sdp
    }) => {
        // We (selector) received the offer of someone (from)
        log("received target-offer from " + from);
        // create pc as answerer
        pc = createPeerConnection();
        currentPeerId = from; // we'll send ICE to this id
        // set remote description as the offer
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        log("setRemoteDescription(offer) done");
        // create answer
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        // send answer back to offerer
        socket.emit('answer', {
            to: from,
            sdp: pc.localDescription
        });
        log("sent answer to " + from);
        // also send any buffered candidates immediately (unlikely needed for answerer)
        // (we buffer locally when candidate fired before any peer id known)
    });

    socket.on('answer', async ({
        from,
        sdp
    }) => {
        // Offerer receives answer
        log("received answer from " + from);
        currentPeerId = from;
        if (!pc) {
            log("No pc yet on offerer side — creating one and setting local stream");
            pc = createPeerConnection();
        }
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        log("offerer setRemoteDescription(answer) done");
        // flush buffered candidates (that were generated before we knew peer id)
        for (const c of bufferedCandidates) {
            socket.emit('ice-candidate', {
                to: currentPeerId,
                candidate: c
            });
        }
        bufferedCandidates = [];
    });

    socket.on('ice-candidate', async ({
        from,
        candidate
    }) => {
        try {
            if (!pc) {
                log(
                "Received ICE candidate but pc missing — creating pc (temporary) and attaching local stream");
                pc = createPeerConnection();
            }
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            log("added remote ICE candidate from " + from);
        } catch (err) {
            console.error(err);
            log("Error adding remote ICE candidate: " + err);
        }
    });

    socket.on('disconnect', () => {
        log("disconnected from signaling");
        myIdBadge.innerText = "—";
    });
}

// create offer and publish it to server (become "waiting" offerer)
btnCreateOffer.addEventListener('click', async () => {
    if (!socket || !socket.connected) return alert("ابتدا به signaling وصل شو.");
    if (!localStream) return alert("ابتدا دوربین/میکروفن را استارت کن.");
    if (isOfferPlaced) return;

    pc = createPeerConnection();
    // add tracks if not already added (createPeerConnection does it)
    // create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // send 'new-offer' with SDP to server
    socket.emit('new-offer', pc.localDescription);
    isOfferPlaced = true;
    placedOfferId = socket.id;
    btnCreateOffer.disabled = true;
    btnStopOffer.disabled = false;
    log("placed new offer (waiting). my offer id = " + placedOfferId);
});

// stop (remove) our placed offer (just disconnect from waiting state)
btnStopOffer.addEventListener('click', () => {
    if (!isOfferPlaced) return;
    // simply disconnect our offer on server by disconnecting or by letting server detect disconnect.
    // we can also just disconnect socket and reconnect — but better to simply emit 'disconnect' by closing.
    // If you want to implement explicit remove, add an event like 'remove-offer' server-side.
    socket.disconnect();
    log("stopped offer and disconnected from signaling. Refresh/connect again to use.");
    btnStopOffer.disabled = true;
    btnCreateOffer.disabled = false;
    isOfferPlaced = false;
});

// render list of offers in UI (list contains socket ids)
function renderOfferList(list) {
    offersEl.innerHTML = '';
    if (!Array.isArray(list) || list.length === 0) {
        offersEl.innerHTML = '<div class="meta">فعلاً آفر فعالی وجود ندارد</div>';
        return;
    }
    list.forEach(id => {
        const item = document.createElement('div');
        item.className = 'offer-item';
        const left = document.createElement('div');
        left.innerHTML =
            `<div style="font-weight:700">${id === myId ? '(شما) ' + id : id}</div><div class="meta">آفر آماده</div>`;
        const right = document.createElement('div');
        // disable selecting our own offer
        if (id === myId) {
            right.innerHTML = `<div class="badge">Your offer</div>`;
        } else {
            const btn = document.createElement('button');
            btn.innerText = 'اتصال';
            btn.onclick = () => selectOffer(id);
            right.appendChild(btn);
        }
        item.appendChild(left);
        item.appendChild(right);
        offersEl.appendChild(item);
    });
}

// when user selects an offer (we are the answerer)
function selectOffer(targetId) {
    if (!socket || !socket.connected) return alert("ابتدا به signaling وصل شو.");
    log("selecting offer: " + targetId);
    socket.emit('select-offer', {
        targetId
    }); // server will respond with target-offer event containing sdp of target
}

// when page unload -> cleanup
window.addEventListener('beforeunload', () => {
    try {
        if (socket) socket.disconnect();
    } catch (e) {}
    try {
        if (pc) pc.close();
    } catch (e) {}
});

// automatically connect to signaller if user hits Connect button or if there is default value and autoconnect
// optional: autoconnect
// connectSignaling(signalingUrlInput.value.trim());
