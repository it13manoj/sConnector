const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const WebSocket = require('ws');

const HELPER_FILE = path.join(__dirname, 'remote-desktop.ps1');
const REQUEST_TIMEOUT_MS = 30_000;
const FRAME_INTERVAL_MS = 700;
const MAX_PENDING_REQUESTS = 3;
const MAX_CONNECTIONS = 32;

function normalizeAddress(address) {
  return (address || '').replace(/^::ffff:/i, '').split('%')[0].toLowerCase();
}

function createRemoteDesktop(nodeId) {
  const watchers = new Set();
  const pending = new Map();
  const connections = new Set();
  let activeSession = null;

  function send(socket, packet) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(packet), (error) => {
        if (error) console.warn('[REMOTE] Could not send WebSocket message:', error.message);
      });
    }
  }

  function notifyWatchers(packet) {
    for (const watcher of watchers) send(watcher, packet);
  }

  function removePending(id, reason) {
    const request = pending.get(id);
    if (!request) return null;
    clearTimeout(request.timeout);
    pending.delete(id);
    if (reason) {
      send(request.socket, { type: 'DENIED', sessionId: id, reason });
      request.socket.close(1008, 'Request denied or expired');
    }
    return request;
  }

  function sendHelperCommand(session, command) {
    if (!session.helper.stdin.writable || session.helper.stdin.destroyed) return false;
    try {
      return session.helper.stdin.write(`${JSON.stringify(command)}\n`);
    } catch (error) {
      console.warn('[REMOTE] Could not send desktop input:', error.message);
      return false;
    }
  }

  function writeHelper(command) {
    if (activeSession) sendHelperCommand(activeSession, command);
  }

  function stopSession(reason) {
    if (!activeSession) return;
    const session = activeSession;
    activeSession = null;
    clearInterval(session.captureTimer);

    for (const key of session.heldKeys) {
      sendHelperCommand(session, { type: 'keyUp', key });
    }
    for (const button of session.heldButtons) {
      sendHelperCommand(session, { type: 'mouseUp', button });
    }
    if (session.helper.stdin.writable && !session.helper.stdin.destroyed) session.helper.stdin.end();
    const killTimer = setTimeout(() => session.helper.kill(), 500);
    killTimer.unref();

    send(session.requester, { type: 'SESSION_ENDED', reason });
    notifyWatchers({ type: 'SESSION_ENDED', sessionId: session.id, reason });
  }

  function startSession(id, watcher) {
    const request = pending.get(id);
    if (!request || activeSession) return false;
    if (process.platform !== 'win32') {
      removePending(id, 'Remote desktop control is currently supported on Windows hosts only.');
      return false;
    }
    if (!fs.existsSync(HELPER_FILE)) {
      removePending(id, 'The Windows desktop helper is missing from this installation.');
      return false;
    }

    clearTimeout(request.timeout);
    pending.delete(id);
    const helper = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', HELPER_FILE
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    const session = {
      id,
      requester: request.socket,
      requesterAddress: request.remoteAddress,
      requesterName: request.requesterName,
      watcher,
      helper,
      screenLeft: 0,
      screenTop: 0,
      screenWidth: 1,
      screenHeight: 1,
      capturePending: false,
      heldKeys: new Set(),
      heldButtons: new Set(),
      captureTimer: null
    };
    activeSession = session;
    for (const pendingId of [...pending.keys()]) {
      removePending(pendingId, 'This PC has accepted another remote session.');
      notifyWatchers({ type: 'REQUEST_CLOSED', sessionId: pendingId });
    }
    const output = readline.createInterface({ input: helper.stdout });
    output.on('line', (line) => {
      if (activeSession !== session) return;
      try {
        const message = JSON.parse(line);
        if (message.type === 'frame') {
          session.capturePending = false;
          session.screenLeft = message.left;
          session.screenTop = message.top;
          session.screenWidth = message.desktopWidth;
          session.screenHeight = message.desktopHeight;
          send(session.requester, {
            type: 'FRAME',
            left: message.left,
            top: message.top,
            width: message.width,
            height: message.height,
            desktopWidth: message.desktopWidth,
            desktopHeight: message.desktopHeight,
            image: message.image
          });
        } else if (message.type === 'error') {
          session.capturePending = false;
          console.error('[REMOTE] Desktop helper error:', message.message);
          send(session.requester, { type: 'ERROR', message: 'The remote desktop helper failed to capture or control the desktop.' });
        }
      } catch (error) {
        console.error('[REMOTE] Invalid desktop helper response:', error.message);
      }
    });
    helper.stderr.on('data', (chunk) => {
      console.error('[REMOTE] Desktop helper:', chunk.toString().trim());
    });
    helper.once('error', (error) => {
      if (activeSession === session) stopSession(`Could not start the desktop helper: ${error.message}`);
    });
    helper.once('exit', (code) => {
      if (activeSession === session) stopSession(`Desktop helper stopped (exit ${code ?? 'unknown'}).`);
    });

    session.captureTimer = setInterval(() => {
      if (activeSession === session &&
          !session.capturePending &&
          helper.stdin.writable &&
          session.requester.bufferedAmount < 4 * 1024 * 1024) {
        session.capturePending = true;
        sendHelperCommand(session, { type: 'capture' });
      }
    }, FRAME_INTERVAL_MS);
    session.capturePending = true;
    sendHelperCommand(session, { type: 'capture' });
    send(request.socket, { type: 'APPROVED', sessionId: id });
    notifyWatchers({
      type: 'SESSION_STARTED',
      sessionId: id,
      requesterAddress: request.remoteAddress,
      requesterName: request.requesterName
    });
    return true;
  }

  function attachRemoteDesktop(server) {
    const wss = new WebSocket.Server({ server, path: '/remote', maxPayload: 8 * 1024 });
    wss.on('connection', (socket, request) => {
      if (connections.size >= MAX_CONNECTIONS) {
        socket.close(1013, 'Too many remote connections');
        return;
      }
      connections.add(socket);
      socket.isAlive = true;
      socket.on('pong', () => { socket.isAlive = true; });
      socket.on('error', (error) => console.warn('[REMOTE] WebSocket error:', error.message));

    let role = null;
    const handshakeTimeout = setTimeout(() => {
      if (!role) socket.close(1008, 'Remote role handshake timed out');
    }, 10_000);
    handshakeTimeout.unref();
    socket.on('message', (raw) => {
      if (raw.length > 4096) {
        socket.close(1009, 'Message too large');
        return;
      }
      let packet;
      try {
        packet = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: 'ERROR', message: 'Invalid remote-control message.' });
        socket.close(1003, 'Invalid JSON');
        return;
      }

      if (!role) {
        if (packet.type === 'WATCH') {
          const remoteAddress = normalizeAddress(request.socket.remoteAddress);
          const localAddress = normalizeAddress(request.socket.localAddress);
          if (remoteAddress !== localAddress) {
            send(socket, { type: 'ERROR', message: 'The consent portal must connect locally on the remote PC.' });
            socket.close(1008, 'Consent monitor must be local');
            return;
          }
          clearTimeout(handshakeTimeout);
          role = 'watcher';
          watchers.add(socket);
          send(socket, { type: 'READY', nodeId });
          for (const request of pending.values()) {
            send(socket, {
              type: 'REQUEST',
              sessionId: request.id,
              requesterName: request.requesterName,
              requesterAddress: request.remoteAddress,
              requestedAt: Date.now()
            });
          }
          if (activeSession) {
            send(socket, {
              type: 'SESSION_STARTED',
              sessionId: activeSession.id,
              requesterAddress: activeSession.requesterAddress,
              requesterName: activeSession.requesterName
            });
          }
          return;
        }
        if (packet.type === 'REQUEST') {
          clearTimeout(handshakeTimeout);
          role = 'requester';
          if (activeSession || pending.size >= MAX_PENDING_REQUESTS) {
            send(socket, { type: 'ERROR', message: 'This system is busy or has too many pending requests.' });
            socket.close(1013, 'Remote host busy');
            return;
          }
          const id = require('crypto').randomUUID();
          const remoteAddress = request.socket.remoteAddress || 'unknown';
          const entry = {
            id,
            socket,
            remoteAddress,
            requesterName: typeof packet.requesterName === 'string' ? packet.requesterName.slice(0, 80) : 'Remote system'
          };
          entry.timeout = setTimeout(() => {
            removePending(id, 'The request expired because the remote user did not respond.');
            notifyWatchers({ type: 'REQUEST_EXPIRED', sessionId: id });
          }, REQUEST_TIMEOUT_MS);
          entry.timeout.unref();
          pending.set(id, entry);
          send(socket, { type: 'PENDING', sessionId: id, timeoutMs: REQUEST_TIMEOUT_MS });
          notifyWatchers({
            type: 'REQUEST',
            sessionId: id,
            requesterName: entry.requesterName,
            requesterAddress: remoteAddress,
            requestedAt: Date.now()
          });
          return;
        }
        send(socket, { type: 'ERROR', message: 'Identify as a consent monitor or request a remote session.' });
        socket.close(1008, 'Handshake required');
        return;
      }

      if (role === 'watcher') {
        if (packet.type === 'APPROVE' && typeof packet.sessionId === 'string') {
          if (!startSession(packet.sessionId, socket)) {
            send(socket, { type: 'ERROR', message: 'That request is no longer available.' });
          }
        } else if (packet.type === 'DENY' && typeof packet.sessionId === 'string') {
          const denied = removePending(packet.sessionId, 'The remote user declined the request.');
          if (denied) notifyWatchers({ type: 'REQUEST_CLOSED', sessionId: packet.sessionId });
        } else if (packet.type === 'REVOKE' && activeSession) {
          stopSession('The remote user ended the session.');
        }
        return;
      }

      if (role === 'requester' && activeSession?.requester === socket) {
        if (packet.type === 'MOVE' &&
            Number.isFinite(packet.x) && packet.x >= 0 && packet.x <= 1 &&
            Number.isFinite(packet.y) && packet.y >= 0 && packet.y <= 1) {
          writeHelper({
            type: 'move',
            x: activeSession.screenLeft + Math.round(packet.x * activeSession.screenWidth),
            y: activeSession.screenTop + Math.round(packet.y * activeSession.screenHeight)
          });
        } else if (packet.type === 'MOUSE' &&
            (packet.action === 'down' || packet.action === 'up') &&
            [1, 2].includes(packet.button)) {
          const field = packet.action === 'down' ? 'heldButtons' : null;
          if (field) activeSession[field].add(packet.button);
          else activeSession.heldButtons.delete(packet.button);
          writeHelper({ type: `mouse${packet.action === 'down' ? 'Down' : 'Up'}`, button: packet.button });
        } else if (packet.type === 'WHEEL' && Number.isInteger(packet.delta) && Math.abs(packet.delta) <= 1200) {
          writeHelper({ type: 'wheel', delta: packet.delta });
        } else if (packet.type === 'KEY' &&
            (packet.action === 'down' || packet.action === 'up') &&
            Number.isInteger(packet.key) && packet.key >= 1 && packet.key <= 255) {
          if (packet.action === 'down') activeSession.heldKeys.add(packet.key);
          else activeSession.heldKeys.delete(packet.key);
          writeHelper({ type: `key${packet.action === 'down' ? 'Down' : 'Up'}`, key: packet.key });
        }
      }
    });

      socket.on('close', () => {
        connections.delete(socket);
        clearTimeout(handshakeTimeout);
        if (role === 'watcher') {
          watchers.delete(socket);
          if (activeSession?.watcher === socket) stopSession('The remote user portal disconnected.');
        } else if (role === 'requester') {
          for (const [id, entry] of pending) {
            if (entry.socket === socket) {
              removePending(id);
              notifyWatchers({ type: 'REQUEST_CLOSED', sessionId: id });
            }
          }
          if (activeSession?.requester === socket) stopSession('The controller disconnected.');
        }
      });
    });

    const heartbeat = setInterval(() => {
      for (const socket of wss.clients) {
        if (!socket.isAlive) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }, 30_000);
    heartbeat.unref();
    wss.on('close', () => clearInterval(heartbeat));
    return wss;
  }

  return { attach: attachRemoteDesktop };
}

module.exports = { createRemoteDesktop };
