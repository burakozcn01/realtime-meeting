(function () {
    window.myID = null;
    window.peerList = {};
    const names = {};

    const isMobile = /Mobi|Android/i.test(navigator.userAgent);

    const protocol = window.location.protocol;
    const socket = io(`${protocol}//${document.domain}:${location.port}`, { autoConnect: false });

    document.addEventListener("DOMContentLoaded", () => {
        startCamera()
            .then(() => {
                socket.connect();
                setupChat();
            })
            .catch((error) => {
                logError("Kamera başlatılamadı: ", error);
            });
    });

    function setupChat() {
        const chatForm = document.getElementById('chat-form');
        const chatInput = document.getElementById('chat-input');
        const chatMessages = document.getElementById('chat-messages');

        chatForm.addEventListener('submit', (event) => {
            event.preventDefault();
            const message = chatInput.value;
            if (message.trim() !== "") {
                socket.emit("send_message", {
                    room_id: myRoomID,
                    message: message
                });
                chatInput.value = '';
            }
        });

        socket.on("receive_message", (data) => {
            const { message, display_name } = data;
            const messageElement = document.createElement('li');
            messageElement.textContent = `${display_name}: ${message}`;
            chatMessages.appendChild(messageElement);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        });
    }

    const mediaConstraints = {
        audio: {
            noiseSuppression: true,
            echoCancellation: true, 
            autoGainControl: true,
            voiceIsolation: true 
        },
        video: {
            width: { ideal: isMobile ? 640 : 1280 },
            height: { ideal: isMobile ? 360 : 720 },
            frameRate: { ideal: isMobile ? 15 : 30, max: isMobile ? 30 : 60 }
        }
    };

    async function startCamera() {
        const myVideo = document.getElementById("local_vid");
        try {
            const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
            myVideo.srcObject = stream;

            window.setAudioMuteState(audioMuted);
            window.setVideoMuteState(videoMuted);
            console.log("Yerel video ve ses akışı başlatıldı");
        } catch (error) {
            logError("Medya cihazlarına erişim hatası: ", error);
            throw error;
        }
    }

    socket.on("connect", () => {
        socket.emit("join-room", { room_id: myRoomID });
    });

    socket.on("user-connect", (data) => {
        const peerId = data.sid;
        const displayName = data.name;
        names[peerId] = displayName;
        window.addVideoElement(peerId, displayName);
        createPeerConnection(peerId);
    });

    socket.on("user-disconnect", (data) => {
        const peerId = data.sid;
        closeConnection(peerId);
        window.removeVideoElement(peerId);
        delete names[peerId];
    });

    socket.on("user-list", (data) => {
        window.myID = data.my_id;
        if (data.list) {
            const receivedList = data.list;
            for (const peerId in receivedList) {
                const displayName = receivedList[peerId];
                names[peerId] = displayName;
                window.addVideoElement(peerId, displayName);
                createPeerConnection(peerId);
            }
            startWebRTC();
        }
    });

    socket.on("data", (msg) => {
        switch (msg.type) {
            case "offer":
                handleOfferMsg(msg);
                break;
            case "answer":
                handleAnswerMsg(msg);
                break;
            case "new-ice-candidate":
                handleNewICECandidateMsg(msg);
                break;
            default:
                logError("Bilinmeyen mesaj türü: ", msg.type);
        }
    });

    function startWebRTC() {
        Object.keys(window.peerList).forEach(peerId => {
            invitePeer(peerId);
        });
    }

    async function invitePeer(peerId) {
        const peerConnection = window.peerList[peerId].peerConnection;
        if (peerConnection.localDescription) {
            return;
        }

        if (peerId === window.myID) {
            return;
        }

        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            sendViaServer({
                sender_id: window.myID,
                target_id: peerId,
                type: "offer",
                sdp: peerConnection.localDescription
            });
        } catch (error) {
            logError("Teklif oluşturulurken hata: ", error);
        }
    }

    function createPeerConnection(peerId) {
        if (!window.peerList[peerId]) {
            const peerConnection = new RTCPeerConnection(PC_CONFIG);

            peerConnection.onicecandidate = (event) => handleICECandidateEvent(event, peerId);
            peerConnection.ontrack = (event) => handleTrackEvent(event, peerId);
            peerConnection.oniceconnectionstatechange = () => checkPeerConnection(peerId);

            const senders = {};
            window.peerList[peerId] = {
                peerConnection: peerConnection,
                senders: senders
            };

            const myVideo = document.getElementById("local_vid");
            const localStream = myVideo.srcObject;
            if (localStream) {
                localStream.getTracks().forEach((track) => {
                    senders[track.kind] = peerConnection.addTrack(track, localStream);
                });
                setDynamicBitrate(peerConnection);
                setPreferredCodec(peerConnection);
                monitorMediaStats(peerConnection);
            }
        }
    }

    function setPreferredCodec(peerConnection) {
        const transceivers = peerConnection.getTransceivers();
        transceivers.forEach(transceiver => {
            if (transceiver.sender.track.kind === 'video') {
                const codecs = RTCRtpSender.getCapabilities('video').codecs;
                const preferredCodec = codecs.find(c => c.mimeType === "video/H264");
                if (preferredCodec) {
                    transceiver.setCodecPreferences([preferredCodec, ...codecs.filter(c => c.mimeType !== "video/H264")]);
                }
            }
        });
    }

    function checkPeerConnection(peerId) {
        const peerConnection = window.peerList[peerId].peerConnection;
        if (peerConnection.iceConnectionState === "disconnected" || peerConnection.iceConnectionState === "failed") {
            restartICE(peerConnection);
        }
    }

    function restartICE(peerConnection) {
        peerConnection.restartIce();
    }

    async function handleOfferMsg(msg) {
        const peerId = msg.sender_id;
        let peerData = window.peerList[peerId];

        if (!peerData) {
            createPeerConnection(peerId);
            peerData = window.peerList[peerId];
        }

        const peerConnection = peerData.peerConnection;
        const desc = new RTCSessionDescription(msg.sdp);

        try {
            await peerConnection.setRemoteDescription(desc);
            if (desc.type === "offer") {
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                sendViaServer({
                    sender_id: window.myID,
                    target_id: peerId,
                    type: "answer",
                    sdp: peerConnection.localDescription
                });
            }
        } catch (error) {
            logError("Offer handling error:", error);
        }
    }

    async function handleAnswerMsg(msg) {
        const peerId = msg.sender_id;
        const peerConnection = window.peerList[peerId].peerConnection;
        const desc = new RTCSessionDescription(msg.sdp);
        try {
            await peerConnection.setRemoteDescription(desc);
        } catch (error) {
            logError("Answer handling error:", error);
        }
    }

    function handleICECandidateEvent(event, peerId) {
        if (event.candidate) {
            sendViaServer({
                sender_id: window.myID,
                target_id: peerId,
                type: "new-ice-candidate",
                candidate: event.candidate
            });
        }
    }

    function handleNewICECandidateMsg(msg) {
        const peerId = msg.sender_id;
        const peerConnection = window.peerList[peerId].peerConnection;
        const candidate = new RTCIceCandidate(msg.candidate);
        peerConnection.addIceCandidate(candidate).catch(logError);
    }

    function handleTrackEvent(event, peerId) {
        const streams = event.streams;
        if (streams && streams[0]) {
            const stream = streams[0];
            const videoElement = document.getElementById(`vid_${peerId}`);
            if (videoElement) {
                videoElement.srcObject = stream;
            }
        }
    }

    function closeConnection(peerId) {
        const peerData = window.peerList[peerId];
        if (peerData) {
            const peerConnection = peerData.peerConnection;
            peerConnection.onicecandidate = null;
            peerConnection.ontrack = null;
            peerConnection.oniceconnectionstatechange = null;
            peerConnection.close();
            delete window.peerList[peerId];
        }
    }

    function setDynamicBitrate(peerConnection) {
        peerConnection.getSenders().forEach((sender) => {
            if (sender.track && sender.track.kind === "video") {
                const parameters = sender.getParameters();
                if (!parameters.encodings) {
                    parameters.encodings = [{}];
                }

                let idealBitrate = determineOptimalBitrate();

                if (parameters.encodings[0].maxBitrate !== idealBitrate) {
                    parameters.encodings[0].maxBitrate = idealBitrate;
                    parameters.encodings[0].maxFramerate = 30;

                    sender.setParameters(parameters).catch((error) => {
                        console.error("Video parametreleri ayarlanırken hata:", error);
                    });
                }
            }
        });
    }

    async function determineOptimalBitrate() {
        try {
            const bandwidthInfo = checkCurrentNetworkConditions();
            let bitrate;
            const bandwidth = bandwidthInfo.downlink * 1000;

            if (bandwidth > 5000) {
                bitrate = 5000000;
            } else if (bandwidth > 2500) {
                bitrate = 2500000;
            } else if (bandwidth > 1000) {
                bitrate = 1000000;
            } else {
                bitrate = 500000;
            }

            return bitrate;
        } catch (error) {
            console.error("Ağ hızını ölçerken bir hata oluştu:", error);
            return 500000;
        }
    }

    function checkCurrentNetworkConditions() {
        if ('connection' in navigator) {
            const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (connection) {
                return {
                    type: connection.effectiveType,
                    downlink: connection.downlink,
                    rtt: connection.rtt
                };
            }
        }
        return { downlink: 5 };
    }

    function monitorMediaStats(peerConnection) {
        let previousBytesSent = 0;
        let previousTimestamp = 0;

        const interval = isMobile ? 5000 : 2000;

        setInterval(() => {
            peerConnection.getStats(null).then((stats) => {
                let videoPacketsLost = 0;
                let videoJitter = 0;
                let videoBitrate = 0;
                let audioPacketsLost = 0;
                let audioJitter = 0;
                let audioRoundTripTime = 0;

                stats.forEach((report) => {
                    if (report.type === 'outbound-rtp' && report.kind === 'video') {
                        videoPacketsLost = report.packetsLost || 0;
                        videoJitter = report.jitter ? report.jitter.toFixed(2) : 0;

                        if (previousBytesSent !== 0 && previousTimestamp !== 0 && report.bytesSent) {
                            const timeDiff = (report.timestamp - previousTimestamp) / 1000;
                            const bytesDiff = report.bytesSent - previousBytesSent;
                            videoBitrate = ((bytesDiff * 8) / timeDiff / 1024).toFixed(2);
                        }

                        previousBytesSent = report.bytesSent;
                        previousTimestamp = report.timestamp;
                    }

                    if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                        audioPacketsLost = report.packetsLost || 0;
                        audioJitter = report.jitter ? report.jitter.toFixed(2) : 0;
                        audioRoundTripTime = report.roundTripTime ? report.roundTripTime.toFixed(2) : 0;
                    }
                });

                if (videoPacketsLost > 100 || videoJitter > 30) {
                    setDynamicBitrate(peerConnection);
                }

                updateStatsUI({
                    videoPacketsLost,
                    videoJitter,
                    videoBitrate,
                    audioPacketsLost,
                    audioJitter,
                    audioRoundTripTime
                });
            }).catch(error => {
                console.error('getStats hatası: ', error);
            });
        }, interval);
    }

    function updateStatsUI(stats) {
        document.getElementById('latency').textContent = stats.audioRoundTripTime + ' ms';
        document.getElementById('packets-lost').textContent = stats.videoPacketsLost + ' (Video), ' + stats.audioPacketsLost + ' (Ses)';
        document.getElementById('jitter').textContent = stats.videoJitter + ' ms (Video), ' + stats.audioJitter + ' ms (Ses)';
        document.getElementById('bitrate').textContent = stats.videoBitrate + ' kbps';
    }

    const PC_CONFIG = {
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "turn:your.turn.server:3478", username: "user", credential: "pass" }
        ]
    };

    function logError(error, additionalInfo = "") {
        console.error("[ERROR]: ", additionalInfo, error);
    }

    function sendViaServer(data) {
        socket.emit("data", data);
    }

    socket.on("disconnect", () => {
        console.log("Socket disconnected");
    });

    window.sendViaServer = sendViaServer;
    window.logError = logError;
})();
(function () {
    let myVideo;
    let isScreenSharing = false;
    let screenStream = null;
    let screenShareInProgress = false;
    let focusedVideoId = null;
    let originalParent = null;
    let audioMuted = false; 
    let videoMuted = false; 

    document.addEventListener("DOMContentLoaded", initializeUI);

    function initializeUI() {
        addLocalVideoElement();
        setupEventListeners();
        addEventDelegationForVideos();
    }

    function setupEventListeners() {
        const screenShareButton = document.getElementById("screen_share_btn");
        if (screenShareButton) {
            screenShareButton.addEventListener("click", debounce(toggleScreenShare, 300));
        }

        const statsButton = document.getElementById("stats_btn");
        if (statsButton) {
            statsButton.addEventListener("click", showStatsModal);
        }

        const muteAudioButton = document.getElementById("mute_audio_btn");
        if (muteAudioButton) {
            muteAudioButton.addEventListener("click", toggleAudioMute);
        }

        const muteVideoButton = document.getElementById("mute_video_btn");
        if (muteVideoButton) {
            muteVideoButton.addEventListener("click", toggleVideoMute);
        }
    }

    function debounce(func, wait) {
        let timeout;
        return function (...args) {
            const later = () => {
                clearTimeout(timeout);
                func.apply(this, args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    function addLocalVideoElement() {
        if (document.getElementById('container_local')) return;

        const videoGrid = document.getElementById('video_grid');
        if (!videoGrid) {
            return;
        }

        const fragment = document.createDocumentFragment();
        const videoContainer = createVideoContainer('local');
        const videoElement = createVideoElement('local_vid');
        const nameTag = createNameTag('Me');

        videoContainer.appendChild(videoElement);
        videoContainer.appendChild(nameTag);
        fragment.appendChild(videoContainer);
        videoGrid.appendChild(fragment);

        startLocalVideo(videoElement);
    }

    function createVideoContainer(elementId) {
        const container = document.createElement("div");
        container.className = "video-container";
        container.id = `container_${elementId}`;
        container.dataset.videoId = elementId;
        return container;
    }

    function createVideoElement(elementId) {
        const video = document.createElement("video");
        video.id = elementId;
        video.autoplay = true;
        video.playsInline = true;
        video.muted = (elementId === 'local_vid');
        video.style.width = "100%";
        video.style.height = "100%";
        video.style.objectFit = "contain";
        return video;
    }

    function createNameTag(displayName) {
        const nameTag = document.createElement("div");
        nameTag.className = "name-tag";
        nameTag.textContent = displayName;
        return nameTag;
    }

    function startLocalVideo(videoElement) {
        navigator.mediaDevices.getUserMedia(mediaConstraints)
            .then(stream => {
                videoElement.srcObject = stream;
                window.localStream = stream;
                setAudioMuteState(audioMuted);
                setVideoMuteState(videoMuted);
                myVideo = videoElement;

                if (typeof window.startWebRTC === 'function') window.startWebRTC();
            })
            .catch(error => {
                console.error("Camera could not be started:", error);
                alert("Camera could not be started. Please check your permissions and try again.");
            });
    }

    function toggleScreenShare() {
        if (screenShareInProgress) {
            return;
        }
        screenShareInProgress = true;

        if (!isScreenSharing) {
            startScreenShare().finally(() => {
                screenShareInProgress = false;
            });
        } else {
            stopScreenShare().finally(() => {
                screenShareInProgress = false;
            });
        }
    }

    async function startScreenShare() {
        if (isScreenSharing) return;

        try {
            const consent = confirm("Do you want to start screen sharing?");
            if (!consent) return;

            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: "always",
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 30, max: 60 }
                },
                audio: false
            });

            isScreenSharing = true;
            screenStream = stream;

            updatePeersWithNewStream(stream);
            updateLocalVideoStream(stream);

            stream.getVideoTracks()[0].onended = stopScreenShare;
            updateScreenShareButton(true);
        } catch (err) {
            console.error("Screen share error:", err);
            alert("Ekran paylaşımı başlatılamadı.");
            isScreenSharing = false;
        }
    }

    async function stopScreenShare() {
        if (!isScreenSharing) return;
        isScreenSharing = false;

        if (screenStream) {
            screenStream.getTracks().forEach(track => track.stop());
            screenStream = null;
        }

        await revertToOriginalVideoStream();
        updateScreenShareButton(false);
    }

    function updatePeersWithNewStream(stream) {
        Object.keys(window.peerList).forEach(peerId => {
            replaceVideoTrackForPeer(peerId, stream.getVideoTracks()[0]);
        });
    }

    function updateLocalVideoStream(stream) {
        const localVideo = document.getElementById('local_vid');
        if (localVideo && localVideo.srcObject) {
            const videoTracks = localVideo.srcObject.getVideoTracks();
            videoTracks.forEach(track => track.stop());
            localVideo.srcObject.removeTrack(videoTracks[0]);
            localVideo.srcObject.addTrack(stream.getVideoTracks()[0]);
        }
    }

    async function revertToOriginalVideoStream() {
        try {
            const originalStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            const videoTrack = originalStream.getVideoTracks()[0];
            Object.keys(window.peerList).forEach(peerId => {
                replaceVideoTrackForPeer(peerId, videoTrack);
            });

            const localVideo = document.getElementById('local_vid');
            if (localVideo && localVideo.srcObject) {
                const oldVideoTracks = localVideo.srcObject.getVideoTracks();
                oldVideoTracks.forEach(track => {
                    track.stop();
                    localVideo.srcObject.removeTrack(track);
                });
                localVideo.srcObject.addTrack(videoTrack);
            }
        } catch (error) {
            console.error("Error reverting to original video stream:", error);
            alert("Failed to revert to original video stream. Please check your camera permissions.");
        }
    }

    function replaceVideoTrackForPeer(peerId, newTrack) {
        const peerData = window.peerList[peerId];
        if (peerData && peerData.peerConnection) {
            const sender = peerData.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                sender.replaceTrack(newTrack).then(() => {
                }).catch(err => {
                    console.error(`Error replacing video track for peer ${peerId}:`, err);
                });
            }
        }
    }

    function replaceAudioTrackForPeer(peerId, newTrack) {
        const peerData = window.peerList[peerId];
        if (peerData && peerData.peerConnection) {
            const sender = peerData.peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
            if (sender) {
                sender.replaceTrack(newTrack).then(() => {
                }).catch(err => {
                    console.error(`Error replacing audio track for peer ${peerId}:`, err);
                });
            } else {
                peerData.peerConnection.addTrack(newTrack, window.localStream).then(() => {
                }).catch(err => {
                    console.error(`Error adding audio track for peer ${peerId}:`, err);
                });
            }
        }
    }

    function updateScreenShareButton(isSharing) {
        const screenShareIcon = document.getElementById("screen_share_icon");
        if (screenShareIcon) {
            screenShareIcon.innerText = isSharing ? "stop_screen_share" : "present_to_all";
        }
    }

    function setAudioMuteState(isMuted) {
        if (!myVideo || !myVideo.srcObject) return;
        setTrackState(myVideo.srcObject.getAudioTracks(), isMuted);
        const muteIcon = document.getElementById("mute_icon");
        if (muteIcon) muteIcon.innerText = isMuted ? "mic_off" : "mic";
        updateMuteButtonStyle('mute_audio_btn', isMuted);
    }

    function setVideoMuteState(isMuted) {
        if (!myVideo || !myVideo.srcObject) return;
        setTrackState(myVideo.srcObject.getVideoTracks(), isMuted);
        const vidMuteIcon = document.getElementById("vid_mute_icon");
        if (vidMuteIcon) vidMuteIcon.innerText = isMuted ? "videocam_off" : "videocam";
        updateMuteButtonStyle('mute_video_btn', isMuted);
    }

    function setTrackState(tracks, isMuted) {
        tracks.forEach(track => track.enabled = !isMuted);
    }

    function updateMuteButtonStyle(buttonId, isMuted) {
        const muteButton = document.getElementById(buttonId);
        if (muteButton) {
            muteButton.style.backgroundColor = isMuted ? "#cf711f" : "#e67e22";
        }
    }

    function toggleAudioMute() {
        audioMuted = !audioMuted;
        setAudioMuteState(audioMuted);
    }

    function toggleVideoMute() {
        videoMuted = !videoMuted;
        setVideoMuteState(videoMuted);
    }

    function addEventDelegationForVideos() {
        const videoGrid = document.getElementById('video_grid');
        if (videoGrid) {
            videoGrid.addEventListener('click', (event) => {
                const videoContainer = event.target.closest('.video-container');
                if (videoContainer) {
                    const clickedVideoId = videoContainer.dataset.videoId;
                    toggleFocusOnVideo(clickedVideoId);
                }
            });
        }
    }

    function toggleFocusOnVideo(videoId) {
        if (focusedVideoId === videoId) {
            removeFocus();
        } else {
            setFocus(videoId);
        }
    }

    function setFocus(videoId) {
        focusedVideoId = videoId;
        const videoContainer = document.getElementById(`container_${videoId}`);

        if (videoContainer) {
            originalParent = videoContainer.parentElement;

            const focusContainer = document.getElementById('focus_container');
            if (!focusContainer) {
                return;
            }

            const fragment = document.createDocumentFragment();
            fragment.appendChild(videoContainer);

            focusContainer.style.display = 'flex';
            focusContainer.appendChild(fragment);

            const videoGrid = document.getElementById('video_grid');
            videoGrid.style.display = 'none';
        }
    }

    function removeFocus() {
        if (!focusedVideoId) return;

        const videoContainer = document.getElementById(`container_${focusedVideoId}`);
        if (videoContainer && originalParent) {
            const focusContainer = document.getElementById('focus_container');
            if (!focusContainer) {
                return;
            }

            const fragment = document.createDocumentFragment();
            fragment.appendChild(videoContainer);

            focusContainer.style.display = 'none';
            const videoGrid = document.getElementById('video_grid');
            videoGrid.style.display = 'grid';
            videoGrid.appendChild(fragment);
            focusedVideoId = null;
        }
    }

    function addVideoElement(elementId, displayName) {
        if (document.getElementById(`container_${elementId}`)) return;

        const videoGrid = document.getElementById("video_grid");
        if (!videoGrid) {
            return;
        }

        const fragment = document.createDocumentFragment();
        const videoContainer = createVideoContainer(elementId);
        const videoElement = createVideoElement(`vid_${elementId}`);
        const nameTag = createNameTag(displayName);

        videoContainer.appendChild(videoElement);
        videoContainer.appendChild(nameTag);
        fragment.appendChild(videoContainer);
        videoGrid.appendChild(fragment);

        requestAnimationFrame(checkVideoLayout);
    }

    function removeVideoElement(elementId) {
        const videoElement = getVideoObj(elementId);
        if (videoElement && videoElement.srcObject) stopStream(videoElement.srcObject);
        removeElementById(`container_${elementId}`);
        requestAnimationFrame(checkVideoLayout);
    }

    function getVideoObj(elementId) {
        return document.getElementById(`vid_${elementId}`);
    }

    function stopStream(stream) {
        stream.getTracks().forEach(track => track.stop());
    }

    function removeElementById(elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            element.remove();
        }
    }

    function checkVideoLayout() {
        const videoGrid = document.getElementById("video_grid");
        const videos = videoGrid ? videoGrid.querySelectorAll(".video-container") : [];
        const videoCount = videos.length;

        if (focusedVideoId) {
            return;
        }

        if (videoCount === 0) {
            videoGrid.style.gridTemplateColumns = '';
            return;
        }

        let columns;
        switch (videoCount) {
            case 1:
                columns = '1fr';
                break;
            case 2:
                columns = '1fr 1fr';
                break;
            case 3:
            case 4:
                columns = '1fr 1fr';
                break;
            case 5:
            case 6:
                columns = '1fr 1fr 1fr';
                break;
            default:
                columns = '1fr 1fr 1fr 1fr';
        }

        videoGrid.style.gridTemplateColumns = columns;

        videos.forEach(container => {
            container.style.width = '100%';
            container.style.height = '100%';
            const video = container.querySelector('video');
            if (video) {
                video.style.width = '100%';
                video.style.height = '100%';
                video.style.objectFit = 'cover';
            }
        });
    }

    function showStatsModal() {
        const statsModalElement = document.getElementById('statsModal');
        if (!statsModalElement) {
            return;
        }

        const statsModal = new bootstrap.Modal(statsModalElement);
        statsModal.show();
        gatherConnectionStats();
    }

    function gatherConnectionStats() {
        if (!window.peerList || Object.keys(window.peerList).length === 0) {
            return;
        }

        Object.values(window.peerList).forEach(peerData => {
            const peerConnection = peerData.peerConnection;
            peerConnection.getStats(null).then(stats => {
                stats.forEach(report => {
                    if (report.type === 'outbound-rtp' && report.kind === 'video') {
                        document.getElementById('latency').textContent = report.roundTripTime ? report.roundTripTime.toFixed(2) + " ms" : "No data";
                        document.getElementById('packets-lost').textContent = report.packetsLost !== undefined ? report.packetsLost : "No data";
                        document.getElementById('jitter').textContent = report.jitter ? report.jitter.toFixed(2) + " ms" : "No data";
                        document.getElementById('bitrate').textContent = report.bytesSent ? (report.bytesSent / 1024).toFixed(2) + " KB" : "No data";
                    }
                });
            }).catch(error => {
                console.error("Error gathering stats:", error);
                alert("Failed to gather connection statistics.");
            });
        });
    }

    function addVideoElement(elementId, displayName) {
        if (document.getElementById(`container_${elementId}`)) return;

        const videoGrid = document.getElementById("video_grid");
        if (!videoGrid) {
            return;
        }

        const fragment = document.createDocumentFragment();
        const videoContainer = createVideoContainer(elementId);
        const videoElement = createVideoElement(`vid_${elementId}`);
        const nameTag = createNameTag(displayName);

        videoContainer.appendChild(videoElement);
        videoContainer.appendChild(nameTag);
        fragment.appendChild(videoContainer);
        videoGrid.appendChild(fragment);

        requestAnimationFrame(checkVideoLayout);
    }

    window.setAudioMuteState = setAudioMuteState;
    window.setVideoMuteState = setVideoMuteState;
    window.addVideoElement = addVideoElement;
    window.removeVideoElement = removeVideoElement;
    window.checkVideoLayout = checkVideoLayout;
    window.toggleFocusOnVideo = toggleFocusOnVideo;
})();
