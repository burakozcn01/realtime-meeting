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
            console.error("Video grid bulunamadı.");
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
        const mediaConstraints = {
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30, max: 60 }
            },
            audio: {
                noiseSuppression: true,
                echoCancellation: true,
                autoGainControl: true,
                voiceIsolation: true
            }
        };

        navigator.mediaDevices.getUserMedia(mediaConstraints)
            .then(stream => {
                videoElement.srcObject = stream;
                window.localStream = stream;
                setAudioMuteState(audioMuted);
                setVideoMuteState(videoMuted);
                myVideo = videoElement;

                if (typeof window.startWebRTC === 'function') window.startWebRTC();
                console.log("Local video started successfully.");
            })
            .catch(error => {
                console.error("Camera could not be started:", error);
                alert("Camera could not be started. Please check your permissions and try again.");
            });
    }

    function toggleScreenShare() {
        if (screenShareInProgress) {
            console.log("Screen share toggle is already in progress.");
            return;
        }
        screenShareInProgress = true;

        if (!isScreenSharing) {
            console.log("Starting screen share...");
            startScreenShare().finally(() => {
                screenShareInProgress = false;
                console.log("Screen share toggle completed.");
            });
        } else {
            console.log("Stopping screen share...");
            stopScreenShare().finally(() => {
                screenShareInProgress = false;
                console.log("Screen share toggle completed.");
            });
        }
    }

    async function startScreenShare() {
        if (isScreenSharing) return;

        try {
            const consent = confirm("Do you want to start screen sharing?");
            if (!consent) {
                console.log("User canceled screen sharing.");
                return;
            }

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
            console.log("Screen share started successfully.");
        } catch (err) {
            console.error("Error starting screen share:", err);
            alert("Failed to start screen sharing. Please try again.");
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
        console.log("Screen share stopped successfully.");
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
            console.log("Reverted to original video stream.");
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
                    console.log(`Replaced video track for peer ${peerId}.`);
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
                    console.log(`Replaced audio track for peer ${peerId}.`);
                }).catch(err => {
                    console.error(`Error replacing audio track for peer ${peerId}:`, err);
                });
            } else {
                peerData.peerConnection.addTrack(newTrack, window.localStream).then(() => {
                    console.log(`Added new audio track for peer ${peerId}.`);
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
        console.log(`Audio mute state set to: ${isMuted}`);
    }

    function setVideoMuteState(isMuted) {
        if (!myVideo || !myVideo.srcObject) return;
        setTrackState(myVideo.srcObject.getVideoTracks(), isMuted);
        const vidMuteIcon = document.getElementById("vid_mute_icon");
        if (vidMuteIcon) vidMuteIcon.innerText = isMuted ? "videocam_off" : "videocam";
        updateMuteButtonStyle('mute_video_btn', isMuted);
        console.log(`Video mute state set to: ${isMuted}`);
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
                    const clickedVideoId = videoContainer.id.replace('container_', '');
                    toggleFocusOnVideo(clickedVideoId);
                }
            });
            console.log("Event delegation for videos set up.");
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
                console.error("Focus container bulunamadı.");
                return;
            }

            const fragment = document.createDocumentFragment();
            fragment.appendChild(videoContainer);

            focusContainer.style.display = 'flex';
            focusContainer.appendChild(fragment);

            const videoGrid = document.getElementById('video_grid');
            videoGrid.style.display = 'none';
            console.log(`Focus set on video: ${videoId}`);
        }
    }

    function removeFocus() {
        if (!focusedVideoId) return;

        const videoContainer = document.getElementById(`container_${focusedVideoId}`);
        if (videoContainer && originalParent) {
            const focusContainer = document.getElementById('focus_container');
            if (!focusContainer) {
                console.error("Focus container bulunamadı.");
                return;
            }

            const fragment = document.createDocumentFragment();
            fragment.appendChild(videoContainer);

            focusContainer.style.display = 'none';
            const videoGrid = document.getElementById('video_grid');
            videoGrid.style.display = 'grid';
            videoGrid.appendChild(fragment);

            console.log(`Focus removed from video: ${focusedVideoId}`);
            focusedVideoId = null;
        }
    }

    function addVideoElement(elementId, displayName) {
        if (document.getElementById(`container_${elementId}`)) return;

        const videoGrid = document.getElementById("video_grid");
        if (!videoGrid) {
            console.error("Video grid bulunamadı.");
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
        console.log(`Video element added: ${elementId}`);
    }

    function removeVideoElement(elementId) {
        const videoElement = getVideoObj(elementId);
        if (videoElement && videoElement.srcObject) stopStream(videoElement.srcObject);
        removeElementById(`container_${elementId}`);
        requestAnimationFrame(checkVideoLayout);
        console.log(`Video element removed: ${elementId}`);
    }

    function getVideoObj(elementId) {
        return document.getElementById(`vid_${elementId}`);
    }

    function stopStream(stream) {
        stream.getTracks().forEach(track => track.stop());
        console.log("Stream stopped.");
    }

    function removeElementById(elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            element.remove();
            console.log(`Element removed: ${elementId}`);
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
        console.log("Video layout checked and updated.");
    }

    function showStatsModal() {
        const statsModalElement = document.getElementById('statsModal');
        if (!statsModalElement) {
            console.error("Stats modal bulunamadı.");
            return;
        }

        const statsModal = new bootstrap.Modal(statsModalElement);
        statsModal.show();
        gatherConnectionStats();
    }

    function gatherConnectionStats() {
        if (!window.peerList || Object.keys(window.peerList).length === 0) {
            console.log("No peers connected.");
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
                console.log("Connection statistics gathered.");
            }).catch(error => {
                console.error("Error gathering stats:", error);
                alert("Failed to gather connection statistics.");
            });
        });
    }

    window.setAudioMuteState = setAudioMuteState;
    window.setVideoMuteState = setVideoMuteState;
    window.addVideoElement = addVideoElement;
    window.removeVideoElement = removeVideoElement;
    window.checkVideoLayout = checkVideoLayout;
    window.toggleFocusOnVideo = toggleFocusOnVideo;

})();
