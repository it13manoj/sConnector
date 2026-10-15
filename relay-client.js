const WebSocket = require('ws');

function createRelayClient({ hubUrl, nodeId, getLocalIps, store, remoteDesktop, onSyncChange }) {
  let ws = null;
  let isConnected = false;
  let reconnectTimer = null;
  let pingInterval = null;

  function getHubWsUrl() {
    let cleanUrl = hubUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i && !/^wss?:\/\//i) {
      cleanUrl = `https://${cleanUrl}`;
    }
    const parsed = new URL(cleanUrl);
    const protocol = (parsed.protocol === 'https:' || parsed.protocol === 'wss:') ? 'wss:' : 'ws:';
    const portStr = (parsed.port && parsed.port !== '80' && parsed.port !== '443') ? `:${parsed.port}` : '';
    return `${protocol}//${parsed.hostname}${portStr}/remote`;
  }

  function send(packet) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(packet));
      return true;
    }
    return false;
  }

  function connect() {
    clearTimeout(reconnectTimer);
    clearInterval(pingInterval);

    let wsUrl;
    try {
      wsUrl = getHubWsUrl();
    } catch (error) {
      console.warn('[RELAY] Invalid HUB_URL:', error.message);
      return;
    }

    try {
      ws = new WebSocket(wsUrl, { family: 4 });
    } catch (error) {
      console.warn('[RELAY] Could not create WebSocket:', error.message);
      scheduleReconnect();
      return;
    }

    ws.on('open', () => {
      isConnected = true;
      const ips = typeof getLocalIps === 'function' ? getLocalIps() : [];
      send({
        type: 'REGISTER_HOST',
        nodeId,
        localIps: ips,
        platform: process.platform
      });

      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 25_000);
    });

    ws.on('message', (data) => {
      let packet;
      try {
        packet = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (packet.type === 'HOST_REGISTERED') {
        console.log(`[RELAY] Registered with Hub (${packet.publicIp || 'online'}). Accessible via local IP or Node ID.`);
      } else if (packet.type === 'RELAY_REQUEST') {
        // Incoming remote desktop request relayed from Hub
        console.log(`[RELAY] Incoming desktop access request from ${packet.requesterName} (${packet.requesterIp})`);
        remoteDesktop.handleIncomingRelayedRequest(packet, (response) => {
          send(response);
        });
      } else if (packet.type === 'RELAY_INPUT') {
        remoteDesktop.handleRelayedInput(packet.sessionId, packet.input);
      } else if (packet.type === 'RELAY_SESSION_ENDED') {
        remoteDesktop.stopRelayedSession(packet.sessionId, packet.reason);
      } else if (packet.type === 'RELAY_SYNC') {
        // Sync payload received over relay
        try {
          if (packet.payload && store) {
            const changed = store.merge(packet.payload);
            if (changed && typeof onSyncChange === 'function') {
              onSyncChange();
            }
          }
          send({
            type: 'RELAY_SYNC_ACK',
            syncId: packet.syncId,
            from: nodeId,
            payload: store ? store.getAll() : {}
          });
        } catch (err) {
          console.warn('[RELAY] Error processing sync packet:', err.message);
        }
      } else if (packet.type === 'RELAY_FORWARD_SYNC_ACK') {
        const pending = pendingForwardSyncs.get(packet.syncId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingForwardSyncs.delete(packet.syncId);
          if (packet.success) {
            pending.resolve(packet);
          } else {
            pending.reject(new Error(packet.error || 'Relay sync failed'));
          }
        }
      }
    });

    ws.on('close', () => {
      isConnected = false;
      clearInterval(pingInterval);
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.warn('[RELAY] Connection error:', err.message);
      ws.close();
    });
  }

  const pendingForwardSyncs = new Map();

  function syncOverHub(target, payload) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Relay client is not connected to Hub.'));
      }
      const syncId = require('crypto').randomUUID();
      const timeout = setTimeout(() => {
        pendingForwardSyncs.delete(syncId);
        reject(new Error('Relay Hub sync timed out.'));
      }, 5000);
      pendingForwardSyncs.set(syncId, { resolve, reject, timeout });

      send({
        type: 'RELAY_FORWARD_SYNC',
        syncId,
        target,
        payload
      });
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connect();
    }, 5000);
  }

  return {
    start: connect,
    send,
    syncOverHub,
    isConnected: () => isConnected
  };
}

module.exports = { createRelayClient };

