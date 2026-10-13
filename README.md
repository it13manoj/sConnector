# SConnect

SConnect shares key/value records between systems on a local network or a private VPN/mesh network. It also supports consent-based Windows desktop sessions between running SConnect instances. Each system runs its own Node.js server and stores its data in a local `data.json` file.

## Start a system

1. Install Node.js, then install dependencies in this folder:

   ```powershell
   npm install
   ```

2. Start SConnect:

   ```powershell
   npm start
   ```

3. Open one of the `http://<IP>:3000` addresses printed in the terminal. The dashboard also shows this system's listening addresses.

By default, SConnect discovers and listens on this machine's loopback and private network interfaces, including common VPN/mesh addresses. It does not bind to public IP interfaces. To choose specific private addresses, set `BIND_ADDRESSES` to a comma-separated list before starting:

```powershell
$env:BIND_ADDRESSES = '192.168.1.20,100.90.80.70'
npm start
```

Replace those examples with the machine's actual LAN and VPN IP addresses. `PORT` can be set to change the default port of `3000`. Each installation creates and saves a unique node ID in `config.json`.

## Access from another network

For remote access, install and connect both systems to the same trusted VPN/mesh network (for example, a private WireGuard, Tailscale, or ZeroTier network). Private LAN IPs such as `172.30.x.x` only work when those LANs are directly routable; across separate locations, use the VPN IP. Enter the other system's IP in the peer field; the data sync port defaults to `3000`. Only one system needs to add the other as a data peer for sync to work.

Allow the SConnect port through each machine's firewall only for trusted local/VPN addresses. Do not forward the port on your router or expose a public IP. This app does not include login authentication or HTTPS; use a trusted VPN/mesh and restrict firewall access.

## Consent-based Windows remote desktop

Both systems must run SConnect on Windows and keep the portal open in a browser. The Windows desktop helper is included in this project and starts only after the remote user accepts a request; no RDP file is downloaded. Enter only the remote system's private LAN/VPN IP and click **Request access**. SConnect automatically connects using the port serving the current portal (normally `3000`); both systems must use the same port. On the remote PC, the open portal shows the requesting system's IP and provides **Accept access** and **Decline** buttons. Approval streams the remote screen and permits mouse and keyboard input. The remote user can revoke access; closing either portal or disconnecting the controller ends the session. Only one remote-control session is active per host.

Run `npm start` as the signed-in Windows desktop user, not as a Windows service, so the helper can capture and control that user's interactive desktop. Node.js and the built-in Windows PowerShell 5.1 are required. Remote desktop control currently supports Windows hosts only. A separate network/VPN connection is required between systems in different locations; private IPs by themselves are not routable across the public internet.

Remote approval grants interactive screen, mouse, and keyboard access. The helper does not offer a separate file-transfer or clipboard protocol, but a person using the remote desktop can use whatever the signed-in desktop account is already allowed to access. Approve requests only from people you trust.

## Synchronization and data

The peer address is saved in `config.json`; peers exchange updates when connected and retry synchronization every five seconds. Timestamped records and deletions sync automatically. If two systems update the same key concurrently, the later update wins; ties are resolved consistently by node ID.

The dashboard creates text values, while the JSON API can store JSON values. Records are available from `GET /api/data`; create or update a record with `POST /api/data` and a JSON body such as `{"key":"project","value":"demo"}`. The server's node ID, port, listening addresses, and configured peers are available from `GET /api/node`.
