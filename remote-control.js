const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const WebSocket = require('ws');

const HELPER_FILE = path.join(__dirname, 'remote-desktop.ps1');
const REQUEST_TIMEOUT_MS = 30_000;
const FRAME_INTERVAL_MS = 700;
const MAX_PENDING_REQUESTS = 16;
const MAX_CONNECTIONS = 64;

function normalizeAddress(address) {
  return (address || '').replace(/^::ffff:/i, '').split('%')[0].toLowerCase();
}

function createRemoteDesktop(nodeId) {
  const watchers = new Set();
  const pending = new Map();
  const connections = new Set();
  let activeSession = null;

  // Relay registry: tracks hosts connected across different networks
  const registeredHosts = new Map(); // nodeId -> hostEntry
  const registeredHostsByIp = new Map(); // ip -> hostEntry
  const relayedSessions = new Map(); // sessionId -> relayedSession
  const requesterToRelayedSession = new Map(); // socket -> relayedSession
  const pendingSyncs = new Map(); // syncId -> { resolve, reject, timeout }

  function send(socket, packet) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(packet), (error) => {
        if (error) console.warn('[REMOTE] WebSocket send error:', error.message);
      });
      return true;
    }
    return false;
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
      if (request.isRelayed && typeof request.replyCallback === 'function') {
        request.replyCallback({ type: 'RELAY_DENIED', sessionId: id, reason });
      } else if (request.socket) {
        send(request.socket, { type: 'DENIED', sessionId: id, reason });
        request.socket.close(1008, 'Request denied or expired');
      }
    }
    return request;
  }

  function sendHelperCommand(session, command) {
    if (!session || !session.helper || !session.helper.stdin.writable || session.helper.stdin.destroyed) return false;
    try {
      return session.helper.stdin.write(`${JSON.stringify(command)}\n`);
    } catch (error) {
      console.warn('[REMOTE] Helper input error:', error.message);
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
    if (session.helper && session.helper.stdin.writable && !session.helper.stdin.destroyed) {
      session.helper.stdin.end();
    }
    if (session.helper) {
      const killTimer = setTimeout(() => session.helper.kill(), 500);
      killTimer.unref();
    }

    if (session.isRelayed && typeof session.replyCallback === 'function') {
      session.replyCallback({ type: 'RELAY_SESSION_ENDED', sessionId: session.id, reason });
    } else if (session.requester) {
      send(session.requester, { type: 'SESSION_ENDED', reason });
    }
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
      isRelayed: !!request.isRelayed,
      replyCallback: request.replyCallback,
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

          const framePacket = {
            type: session.isRelayed ? 'RELAY_FRAME' : 'FRAME',
            sessionId: id,
            left: message.left,
            top: message.top,
            width: message.width,
            height: message.height,
            desktopWidth: message.desktopWidth,
            desktopHeight: message.desktopHeight,
            image: message.image
          };

          if (session.isRelayed && typeof session.replyCallback === 'function') {
            session.replyCallback(framePacket);
          } else if (session.requester) {
            send(session.requester, framePacket);
          }
        } else if (message.type === 'error') {
          session.capturePending = false;
          console.error('[REMOTE] Helper error:', message.message);
          const errPacket = { type: 'ERROR', message: 'Desktop capture failed.' };
          if (session.isRelayed && typeof session.replyCallback === 'function') {
            session.replyCallback(errPacket);
          } else if (session.requester) {
            send(session.requester, errPacket);
          }
        }
      } catch (error) {
        console.error('[REMOTE] Invalid helper response:', error.message);
      }
    });

    helper.stderr.on('data', (chunk) => {
      console.error('[REMOTE] Helper stderr:', chunk.toString().trim());
    });
    helper.once('error', (error) => {
      if (activeSession === session) stopSession(`Helper startup error: ${error.message}`);
    });
    helper.once('exit', (code) => {
      if (activeSession === session) stopSession(`Desktop helper stopped (${code ?? 'exit'}).`);
    });

    session.captureTimer = setInterval(() => {
      if (activeSession === session && !session.capturePending && helper.stdin.writable) {
        session.capturePending = true;
        sendHelperCommand(session, { type: 'capture' });
      }
    }, FRAME_INTERVAL_MS);

    session.capturePending = true;
    sendHelperCommand(session, { type: 'capture' });

    if (session.isRelayed && typeof session.replyCallback === 'function') {
      session.replyCallback({ type: 'RELAY_APPROVED', sessionId: id });
    } else if (request.socket) {
      send(request.socket, { type: 'APPROVED', sessionId: id });
    }

    notifyWatchers({
      type: 'SESSION_STARTED',
      sessionId: id,
      requesterAddress: request.remoteAddress,
      requesterName: request.requesterName
    });
    return true;
  }

  function handleIncomingRelayedRequest(packet, replyCallback) {
    const id = packet.sessionId;
    const entry = {
      id,
      socket: null,
      isRelayed: true,
      replyCallback,
      remoteAddress: packet.requesterIp || 'Remote IP',
      requesterName: packet.requesterName || 'Remote system'
    };
    entry.timeout = setTimeout(() => {
      removePending(id, 'The request expired because the remote user did not respond.');
      notifyWatchers({ type: 'REQUEST_EXPIRED', sessionId: id });
    }, REQUEST_TIMEOUT_MS);
    entry.timeout.unref();

    pending.set(id, entry);
    notifyWatchers({
      type: 'REQUEST',
      sessionId: id,
      requesterName: entry.requesterName,
      requesterAddress: entry.remoteAddress,
      requestedAt: Date.now()
    });
  }

  function handleRelayedInput(sessionId, input) {
    if (activeSession && activeSession.id === sessionId) {
      if (input.type === 'MOVE' && Number.isFinite(input.x) && Number.isFinite(input.y)) {
        writeHelper({
          type: 'move',
          x: activeSession.screenLeft + Math.round(input.x * activeSession.screenWidth),
          y: activeSession.screenTop + Math.round(input.y * activeSession.screenHeight)
        });
      } else if (input.type === 'MOUSE' && [1, 2].includes(input.button)) {
        if (input.action === 'down') activeSession.heldButtons.add(input.button);
        else activeSession.heldButtons.delete(input.button);
        writeHelper({ type: `mouse${input.action === 'down' ? 'Down' : 'Up'}`, button: input.button });
      } else if (input.type === 'WHEEL' && Number.isInteger(input.delta)) {
        writeHelper({ type: 'wheel', delta: input.delta });
      } else if (input.type === 'KEY' && Number.isInteger(input.key)) {
        if (input.action === 'down') activeSession.heldKeys.add(input.key);
        else activeSession.heldKeys.delete(input.key);
        writeHelper({ type: `key${input.action === 'down' ? 'Down' : 'Up'}`, key: input.key });
      }
    }
  }

  function hasRegisteredHost(target) {
    if (!target) return false;
    const clean = target.replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
    return registeredHostsByIp.has(clean) || registeredHosts.has(target) || registeredHosts.has(clean);
  }

  function getRegisteredHost(target) {
    if (!target) return null;
    const clean = target.replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
    return registeredHostsByIp.get(clean) || registeredHosts.get(target) || registeredHosts.get(clean) || null;
  }

  function getRegisteredHosts() {
    return Array.from(registeredHosts.values()).map((h) => ({
      nodeId: h.nodeId,
      localIps: h.localIps,
      publicIp: h.publicIp,
      platform: h.platform
    }));
  }

  function syncOverRelay(target, payload) {
    return new Promise((resolve, reject) => {
      const host = getRegisteredHost(target);
      if (!host || host.socket.readyState !== WebSocket.OPEN) {
        return reject(new Error('Target host is not connected to the relay hub.'));
      }
      const syncId = require('crypto').randomUUID();
      const timeout = setTimeout(() => {
        pendingSyncs.delete(syncId);
        reject(new Error('Relayed sync timed out.'));
      }, 4000);
      pendingSyncs.set(syncId, { resolve, reject, timeout });

      send(host.socket, {
        type: 'RELAY_SYNC',
        syncId,
        from: nodeId,
        payload
      });
    });
  }

  function attachRemoteDesktop(server) {
    const wss = new WebSocket.Server({ server, path: '/remote', maxPayload: 8 * 1024 * 1024 });

    wss.on('connection', (socket, request) => {
      if (connections.size >= MAX_CONNECTIONS) {
        socket.close(1013, 'Too many remote connections');
        return;
      }
      connections.add(socket);
      socket.isAlive = true;
      socket.on('pong', () => { socket.isAlive = true; });
      socket.on('error', (err) => console.warn('[REMOTE] WebSocket error:', err.message));

      let role = null;
      let hostNodeId = null;

      const handshakeTimeout = setTimeout(() => {
        if (!role) socket.close(1008, 'Remote role handshake timed out');
      }, 10_000);
      handshakeTimeout.unref();

      socket.on('message', (raw) => {
        let packet;
        try {
          packet = JSON.parse(raw.toString());
        } catch {
          send(socket, { type: 'ERROR', message: 'Invalid JSON payload.' });
          socket.close(1003, 'Invalid JSON');
          return;
        }

        // Host registration
        if (packet.type === 'REGISTER_HOST') {
          clearTimeout(handshakeTimeout);
          role = 'host';
          hostNodeId = packet.nodeId;
          const clientIp = request.headers['x-forwarded-for']?.split(',')[0].trim() || request.socket.remoteAddress || 'unknown';
          const hostEntry = {
            socket,
            nodeId: packet.nodeId,
            localIps: packet.localIps || [],
            publicIp: clientIp,
            platform: packet.platform
          };
          registeredHosts.set(packet.nodeId, hostEntry);
          if (Array.isArray(packet.localIps)) {
            for (const ip of packet.localIps) {
              registeredHostsByIp.set(ip.toLowerCase(), hostEntry);
            }
          }
          if (clientIp && clientIp !== 'unknown') {
            registeredHostsByIp.set(clientIp.toLowerCase(), hostEntry);
          }
          registeredHostsByIp.set(packet.nodeId.toLowerCase(), hostEntry);

          send(socket, { type: 'HOST_REGISTERED', nodeId: packet.nodeId, publicIp: clientIp });
          console.log(`[RELAY] Registered host "${packet.nodeId}" (IPs: ${(packet.localIps || []).join(', ')}, Public: ${clientIp})`);
          return;
        }

        // Messages from a registered host
        if (role === 'host') {
          if (packet.type === 'RELAY_APPROVED') {
            const sess = relayedSessions.get(packet.sessionId);
            if (sess) send(sess.requesterSocket, { type: 'APPROVED', sessionId: packet.sessionId });
          } else if (packet.type === 'RELAY_FRAME') {
            const sess = relayedSessions.get(packet.sessionId);
            if (sess) {
              send(sess.requesterSocket, {
                type: 'FRAME',
                left: packet.left,
                top: packet.top,
                width: packet.width,
                height: packet.height,
                desktopWidth: packet.desktopWidth,
                desktopHeight: packet.desktopHeight,
                image: packet.image
              });
            }
          } else if (packet.type === 'RELAY_DENIED') {
            const sess = relayedSessions.get(packet.sessionId);
            if (sess) {
              send(sess.requesterSocket, { type: 'DENIED', reason: packet.reason });
              relayedSessions.delete(packet.sessionId);
              requesterToRelayedSession.delete(sess.requesterSocket);
            }
          } else if (packet.type === 'RELAY_SESSION_ENDED') {
            const sess = relayedSessions.get(packet.sessionId);
            if (sess) {
              send(sess.requesterSocket, { type: 'SESSION_ENDED', reason: packet.reason });
              relayedSessions.delete(packet.sessionId);
              requesterToRelayedSession.delete(sess.requesterSocket);
            }
          } else if (packet.type === 'RELAY_SYNC_ACK') {
            const pendingSync = pendingSyncs.get(packet.syncId);
            if (pendingSync) {
              clearTimeout(pendingSync.timeout);
              pendingSyncs.delete(packet.syncId);
              pendingSync.resolve(packet);
            }
          }
          return;
        }

        // Watcher handshake (Consent monitor UI)
        if (!role && packet.type === 'WATCH') {
          clearTimeout(handshakeTimeout);
          role = 'watcher';
          watchers.add(socket);
          send(socket, { type: 'READY', nodeId });
          for (const req of pending.values()) {
            send(socket, {
              type: 'REQUEST',
              sessionId: req.id,
              requesterName: req.requesterName,
              requesterAddress: req.remoteAddress,
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

        // Watcher approval/denial actions
        if (role === 'watcher') {
          if (packet.type === 'APPROVE' && typeof packet.sessionId === 'string') {
            if (!startSession(packet.sessionId, socket)) {
              send(socket, { type: 'ERROR', message: 'Session could not be started.' });
            }
          } else if (packet.type === 'DENY' && typeof packet.sessionId === 'string') {
            const denied = removePending(packet.sessionId, 'Declined by host user.');
            if (denied) notifyWatchers({ type: 'REQUEST_CLOSED', sessionId: packet.sessionId });
          } else if (packet.type === 'REVOKE' && activeSession) {
            stopSession('The local user ended the session.');
          }
          return;
        }

        // Requester handshake (Remote Viewer)
        if (!role && packet.type === 'REQUEST') {
          clearTimeout(handshakeTimeout);
          role = 'requester';

          const target = (packet.target || packet.address || '').trim();
          const cleanTarget = target.replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
          const hostEntry = registeredHostsByIp.get(cleanTarget) || registeredHosts.get(target);

          // CASE A: Target host is registered via relay!
          if (hostEntry && hostEntry.socket.readyState === WebSocket.OPEN) {
            const id = require('crypto').randomUUID();
            const clientIp = request.headers['x-forwarded-for']?.split(',')[0].trim() || request.socket.remoteAddress || 'unknown';
            const relayedSession = {
              id,
              requesterSocket: socket,
              hostSocket: hostEntry.socket,
              hostNodeId: hostEntry.nodeId,
              requesterName: typeof packet.requesterName === 'string' ? packet.requesterName.slice(0, 80) : 'Remote user',
              requesterAddress: clientIp,
              createdAt: Date.now()
            };

            relayedSessions.set(id, relayedSession);
            requesterToRelayedSession.set(socket, relayedSession);

            send(socket, { type: 'PENDING', sessionId: id, timeoutMs: REQUEST_TIMEOUT_MS });
            send(hostEntry.socket, {
              type: 'RELAY_REQUEST',
              sessionId: id,
              requesterName: relayedSession.requesterName,
              requesterIp: clientIp
            });
            return;
          }

          // CASE B: Target is local Windows host
          if (process.platform === 'win32') {
            if (activeSession || pending.size >= MAX_PENDING_REQUESTS) {
              send(socket, { type: 'ERROR', message: 'This system is busy or has too many pending requests.' });
              socket.close(1013, 'Remote host busy');
              return;
            }
            const id = require('crypto').randomUUID();
            const clientIp = request.headers['x-forwarded-for']?.split(',')[0].trim() || request.socket.remoteAddress || 'unknown';
            const entry = {
              id,
              socket,
              isRelayed: false,
              remoteAddress: clientIp,
              requesterName: typeof packet.requesterName === 'string' ? packet.requesterName.slice(0, 80) : 'Remote user'
            };
            entry.timeout = setTimeout(() => {
              removePending(id, 'Request expired.');
              notifyWatchers({ type: 'REQUEST_EXPIRED', sessionId: id });
            }, REQUEST_TIMEOUT_MS);
            entry.timeout.unref();

            pending.set(id, entry);
            send(socket, { type: 'PENDING', sessionId: id, timeoutMs: REQUEST_TIMEOUT_MS });
            notifyWatchers({
              type: 'REQUEST',
              sessionId: id,
              requesterName: entry.requesterName,
              requesterAddress: clientIp,
              requestedAt: Date.now()
            });
            return;
          }

          // CASE C: Target not registered and host not Windows
          send(socket, {
            type: 'ERROR',
            message: cleanTarget
              ? `System "${cleanTarget}" is not registered on this hub. Open SConnect on that PC so it connects to this server.`
              : 'Target system address is required.'
          });
          return;
        }

        // Requester inputs during active session
        if (role === 'requester') {
          // If relayed session
          const relayedSess = requesterToRelayedSession.get(socket);
          if (relayedSess && relayedSess.hostSocket.readyState === WebSocket.OPEN) {
            send(relayedSess.hostSocket, {
              type: 'RELAY_INPUT',
              sessionId: relayedSess.id,
              input: packet
            });
            return;
          }

          // If local active session
          if (activeSession && activeSession.requester === socket) {
            if (packet.type === 'MOVE' && Number.isFinite(packet.x) && Number.isFinite(packet.y)) {
              writeHelper({
                type: 'move',
                x: activeSession.screenLeft + Math.round(packet.x * activeSession.screenWidth),
                y: activeSession.screenTop + Math.round(packet.y * activeSession.screenHeight)
              });
            } else if (packet.type === 'MOUSE' && [1, 2].includes(packet.button)) {
              if (packet.action === 'down') activeSession.heldButtons.add(packet.button);
              else activeSession.heldButtons.delete(packet.button);
              writeHelper({ type: `mouse${packet.action === 'down' ? 'Down' : 'Up'}`, button: packet.button });
            } else if (packet.type === 'WHEEL' && Number.isInteger(packet.delta)) {
              writeHelper({ type: 'wheel', delta: packet.delta });
            } else if (packet.type === 'KEY' && Number.isInteger(packet.key)) {
              if (packet.action === 'down') activeSession.heldKeys.add(packet.key);
              else activeSession.heldKeys.delete(packet.key);
              writeHelper({ type: `key${packet.action === 'down' ? 'Down' : 'Up'}`, key: packet.key });
            }
          }
        }
      });

      socket.on('close', () => {
        connections.delete(socket);
        clearTimeout(handshakeTimeout);

        if (role === 'host' && hostNodeId) {
          console.log(`[RELAY] Host "${hostNodeId}" disconnected.`);
          registeredHosts.delete(hostNodeId);
          for (const [ip, entry] of [...registeredHostsByIp.entries()]) {
            if (entry.nodeId === hostNodeId) registeredHostsByIp.delete(ip);
          }
        } else if (role === 'watcher') {
          watchers.delete(socket);
          if (activeSession && activeSession.watcher === socket) {
            stopSession('The local consent portal disconnected.');
          }
        } else if (role === 'requester') {
          const relayedSess = requesterToRelayedSession.get(socket);
          if (relayedSess) {
            send(relayedSess.hostSocket, { type: 'RELAY_SESSION_ENDED', sessionId: relayedSess.id, reason: 'Remote viewer closed connection.' });
            relayedSessions.delete(relayedSess.id);
            requesterToRelayedSession.delete(socket);
          }
          if (activeSession && activeSession.requester === socket) {
            stopSession('The remote viewer disconnected.');
          }
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
    }, 25_000);
    heartbeat.unref();

    wss.on('close', () => clearInterval(heartbeat));
    return wss;
  }

  return {
    attach: attachRemoteDesktop,
    handleIncomingRelayedRequest,
    handleRelayedInput,
    stopRelayedSession: stopSession,
    hasRegisteredHost,
    getRegisteredHost,
    getRegisteredHosts,
    syncOverRelay
  };
}

module.exports = { createRemoteDesktop };
