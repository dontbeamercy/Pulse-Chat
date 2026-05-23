'use strict';

const PulseCalls = (() => {
  const ICE = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }],
  };

  let api = null;
  let $ = null;
  let getPeer = null;

  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let iceQueue = [];
  let callId = null;
  let role = null;
  let callType = 'audio';
  let remoteUser = null;
  let callTimerIv = null;
  let callStart = 0;
  let ringOsc = null;
  let ringIv = null;
  let muted = false;
  let listenOnly = false;
  let pendingIncoming = null;

  function init(deps) {
    api = deps.api;
    $ = deps.$;
    getPeer = deps.getPeer;
    bindUi();
  }

  function bindUi() {
    $('btn-call-audio')?.addEventListener('click', () => startOutgoing('audio'));
    $('btn-call-video')?.addEventListener('click', () => startOutgoing('video'));
    $('btn-incoming-accept')?.addEventListener('click', () => acceptIncoming());
    $('btn-incoming-reject')?.addEventListener('click', () => rejectIncoming());
    $('btn-call-hangup')?.addEventListener('click', () => hangup());
    $('btn-call-mute')?.addEventListener('click', () => toggleMute());
    $('btn-unlock-audio')?.addEventListener('click', () => unlockRemoteAudio());
    $('call-hear-self')?.addEventListener('change', () => updateLocalMonitor());
    $('call-overlay')?.addEventListener('click', () => unlockRemoteAudio());
  }

  function isActive() {
    return !!callId;
  }

  function updateCallButtons() {
    const wrap = $('chat-call-actions');
    if (!wrap) return;
    wrap.classList.toggle('hidden', !getPeer?.() || isActive());
  }

  function setStatus(text) {
    const st = $('call-overlay-status');
    if (st) st.textContent = text;
  }

  function isListenOnly() {
    return !!$('call-listen-only')?.checked;
  }

  function resetIce() {
    iceQueue = [];
  }

  async function flushIce() {
    if (!pc?.remoteDescription) return;
    while (iceQueue.length) {
      const candidate = iceQueue.shift();
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        /* skip bad candidate */
      }
    }
  }

  async function queueIce(candidate) {
    if (!pc?.remoteDescription) {
      iceQueue.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      iceQueue.push(candidate);
    }
  }

  function playRing() {
    stopRing();
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ringOsc = ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 440;
      g.gain.value = 0.06;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      ringIv = setInterval(() => {
        o.frequency.value = o.frequency.value === 440 ? 480 : 440;
      }, 500);
      ringOsc._osc = o;
    } catch {
      /* ignore */
    }
  }

  function stopRing() {
    clearInterval(ringIv);
    ringIv = null;
    try {
      ringOsc?._osc?.stop();
      ringOsc?.close?.();
    } catch {
      /* ignore */
    }
    ringOsc = null;
  }

  async function unlockRemoteAudio() {
    const remoteA = $('call-remote-audio');
    const btn = $('btn-unlock-audio');
    if (!remoteA) return;
    try {
      if (remoteStream) {
        const tracks = remoteStream.getAudioTracks();
        remoteA.srcObject = tracks.length ? new MediaStream(tracks) : remoteStream;
      }
      remoteA.volume = 1;
      await remoteA.play();
      btn?.classList.add('hidden');
      updateConnectionStatus();
    } catch {
      setStatus('Не удалось включить звук — проверьте громкость системы');
    }
  }

  function updateLocalMonitor() {
    const el = $('call-local-monitor');
    const on = $('call-hear-self')?.checked;
    if (!el) return;
    if (on && localStream) {
      el.srcObject = localStream;
      el.volume = 0.4;
      el.play().catch(() => {});
    } else {
      el.srcObject = null;
    }
  }

  async function playRemoteStream(stream) {
    if (!stream) return;
    remoteStream = stream;
    const remoteA = $('call-remote-audio');
    const remoteV = $('call-remote-video');
    const audioTracks = stream.getAudioTracks();
    const audioStream = audioTracks.length ? new MediaStream(audioTracks) : stream;

    if (callType === 'video' && remoteV) {
      remoteV.srcObject = stream;
      remoteV.muted = false;
      await remoteV.play?.().catch(() => {});
    }

    if (remoteA) {
      remoteA.srcObject = audioStream;
      remoteA.volume = 1;
      try {
        await remoteA.play();
        $('btn-unlock-audio')?.classList.add('hidden');
      } catch {
        $('btn-unlock-audio')?.classList.remove('hidden');
        setStatus('Нажмите «Включить звук» или кликните по экрану');
      }
    }
    updateConnectionStatus();
  }

  function updateConnectionStatus() {
    if (!pc) return;
    const ice = pc.iceConnectionState;
    const conn = pc.connectionState;
    const hasRemote = remoteStream?.getAudioTracks?.().some((t) => t.readyState === 'live');
    const hasLocal = localStream?.getAudioTracks?.().some((t) => t.enabled);
    let parts = [];
    if (conn === 'connected' || ice === 'connected' || ice === 'completed') {
      parts.push(listenOnly ? 'Связь есть' : hasLocal ? 'Микрофон OK' : 'Без микрофона');
      parts.push(hasRemote ? 'Звук собеседника OK' : 'Ждём звук…');
    } else {
      parts.push('Подключение: ' + (ice || conn));
    }
    if ($('call-overlay')?.dataset.mode === 'active') setStatus(parts.join(' · '));
  }

  function showOverlay(mode, user, type) {
    const ov = $('call-overlay');
    if (!ov) return;
    ov.classList.remove('hidden');
    ov.dataset.mode = mode;
    $('call-overlay-name').textContent = user?.displayName || 'Звонок';
    if (mode === 'incoming') {
      setStatus(type === 'video' ? 'Видеозвонок…' : 'Аудиозвонок…');
    } else if (mode === 'outgoing') {
      setStatus('Вызов…');
    }

    $('incoming-actions')?.classList.toggle('hidden', mode !== 'incoming');
    $('active-call-actions')?.classList.toggle('hidden', mode !== 'active' && mode !== 'outgoing');
    $('btn-call-mute')?.classList.toggle('hidden', mode !== 'active' || listenOnly);
    $('call-timer')?.classList.toggle('hidden', mode !== 'active');
    $('call-test-options')?.classList.toggle('hidden', mode === 'active');

    const av = $('call-overlay-avatar');
    if (av && user) {
      av.textContent = (user.displayName || '?')
        .split(/\s+/)
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
      av.style.background = user.avatarColor || '#5288c1';
    }

    $('call-video-wrap')?.classList.toggle('hidden', type !== 'video' || mode === 'incoming');
  }

  function hideOverlay() {
    $('call-overlay')?.classList.add('hidden');
    $('btn-unlock-audio')?.classList.add('hidden');
  }

  function startCallTimer() {
    clearInterval(callTimerIv);
    callStart = Date.now();
    const el = $('call-timer');
    callTimerIv = setInterval(() => {
      if (el) el.textContent = formatDur((Date.now() - callStart) / 1000);
    }, 500);
  }

  function formatDur(sec) {
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  async function getMedia(type) {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: type === 'video',
    });
  }

  function attachLocalPreview() {
    const localV = $('call-local-video');
    if (localV && localStream) {
      localV.srcObject = localStream;
      localV.muted = true;
    }
    updateLocalMonitor();
  }

  async function createPeerConnection() {
    resetIce();
    remoteStream = null;
    pc = new RTCPeerConnection(ICE);

    pc.ontrack = (e) => {
      const stream = e.streams?.[0] || (e.track ? new MediaStream([e.track]) : null);
      if (stream) playRemoteStream(stream);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && callId) {
        sendSignal({ type: 'ice', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      updateConnectionStatus();
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        unlockRemoteAudio();
      }
      if (pc.iceConnectionState === 'failed') hangup();
    };

    pc.onconnectionstatechange = () => {
      updateConnectionStatus();
      if (pc.connectionState === 'connected') unlockRemoteAudio();
      if (pc.connectionState === 'failed') hangup();
    };

    if (localStream) {
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    } else if (listenOnly) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      if (callType === 'video') pc.addTransceiver('video', { direction: 'recvonly' });
    }
  }

  async function sendSignal(signal) {
    if (!callId) return;
    await api('/api/calls/' + callId + '/signal', {
      method: 'POST',
      body: JSON.stringify({ signal }),
    });
  }

  async function handleSignal(signal) {
    if (!pc || !signal) return;

    if (signal.type === 'ice' && signal.candidate) {
      await queueIce(signal.candidate);
      return;
    }

    if (signal.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal({ type: 'answer', sdp: answer });
      return;
    }

    if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      await flushIce();
    }
  }

  async function cleanup() {
    stopRing();
    clearInterval(callTimerIv);
    hideOverlay();
    resetIce();
    if (pc) {
      pc.close();
      pc = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    remoteStream = null;
    ['call-local-video', 'call-remote-video', 'call-remote-audio', 'call-local-monitor'].forEach((id) => {
      const el = $(id);
      if (el) el.srcObject = null;
    });
    callId = null;
    role = null;
    remoteUser = null;
    pendingIncoming = null;
    muted = false;
    listenOnly = false;
    if ($('call-listen-only')) $('call-listen-only').checked = false;
    if ($('call-hear-self')) $('call-hear-self').checked = false;
    $('btn-call-mute')?.classList.remove('active');
    updateCallButtons();
  }

  async function hangup() {
    const id = callId;
    await cleanup();
    if (id) {
      try {
        await api('/api/calls/' + id + '/hangup', { method: 'POST', body: '{}' });
      } catch {
        /* ignore */
      }
    }
  }

  async function setupLocalMedia(type) {
    listenOnly = isListenOnly();
    if (listenOnly) {
      localStream = null;
      return;
    }
    localStream = await getMedia(type);
  }

  async function startOutgoing(type) {
    const peer = getPeer?.();
    if (!peer) {
      alert('Звонки доступны только в личных чатах');
      return;
    }
    if (isActive()) return;
    try {
      callType = type;
      role = 'caller';
      remoteUser = peer;
      const res = await api('/api/calls', {
        method: 'POST',
        body: JSON.stringify({ calleeId: peer.id, type }),
      });
      callId = res.call.id;
      await setupLocalMedia(type);
      await createPeerConnection();
      attachLocalPreview();
      showOverlay('outgoing', peer, type);
      playRing();
      updateCallButtons();
    } catch (e) {
      await cleanup();
      alert(e.message || 'Не удалось позвонить');
    }
  }

  function showIncoming(call) {
    pendingIncoming = call;
    callId = call.id;
    role = 'callee';
    callType = call.type;
    remoteUser = call.caller;
    showOverlay('incoming', call.caller, call.type);
    playRing();
    updateCallButtons();
  }

  async function acceptIncoming() {
    if (!callId) return;
    stopRing();
    try {
      await api('/api/calls/' + callId + '/accept', { method: 'POST', body: '{}' });
      await setupLocalMedia(callType);
      await createPeerConnection();
      attachLocalPreview();
      showOverlay('active', remoteUser, callType);
      startCallTimer();
      pendingIncoming = null;
      await unlockRemoteAudio();
    } catch (e) {
      await rejectIncoming();
      alert(e.message || 'Не удалось принять звонок');
    }
  }

  async function rejectIncoming() {
    stopRing();
    const id = callId;
    pendingIncoming = null;
    await cleanup();
    if (id) {
      try {
        await api('/api/calls/' + id + '/reject', { method: 'POST', body: '{}' });
      } catch {
        /* ignore */
      }
    }
  }

  async function onAccepted() {
    stopRing();
    if (role !== 'caller' || !pc) return;
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: callType === 'video' });
      await pc.setLocalDescription(offer);
      await sendSignal({ type: 'offer', sdp: offer });
      showOverlay('active', remoteUser, callType);
      startCallTimer();
      await unlockRemoteAudio();
    } catch (e) {
      console.error(e);
      hangup();
    }
  }

  function toggleMute() {
    if (!localStream) return;
    muted = !muted;
    localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    $('btn-call-mute')?.classList.toggle('active', muted);
    updateConnectionStatus();
  }

  function handleEvent(event, payload) {
    if (event === 'call_incoming') {
      if (isActive()) {
        api('/api/calls/' + payload.call.id + '/reject', { method: 'POST', body: '{}' }).catch(() => {});
        return true;
      }
      showIncoming(payload.call);
      return true;
    }
    if (event === 'call_accepted' && payload.callId === callId) {
      onAccepted();
      return true;
    }
    if (event === 'call_signal' && payload.callId === callId) {
      handleSignal(payload.signal).catch((err) => console.error('signal', err));
      return true;
    }
    if (event === 'call_ended' && payload.callId === callId) {
      cleanup();
      return true;
    }
    return false;
  }

  return {
    init,
    handleEvent,
    hangup,
    isActive,
    updateCallButtons,
    cleanup,
  };
})();
