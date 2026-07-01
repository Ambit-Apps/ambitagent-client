# ambitagent-client

Local runtime daemon for the Ambit Agent Platform. Runs on a customer's Ubuntu VM (RDP'd into) or bare laptop; maintains an outbound WebSocket to the admin control plane; executes browser tasks locally so Cloudflare / MFA / IP-reputation flags don't fight us.

Companion repo: [`ambitagent-admin`](../ambitagent-admin) — control plane API + web portal.

## Layout

```
src/
  main.ts               # daemon entry, wires config → connection → shutdown
  config.ts             # env-var config loader
  ws/
    connection.ts       # outbound WS w/ reconnect + heartbeat
  runner/
    baseTask.ts         # Playwright wrapper (stub — real execution lands with task_runs)
  protocol/
    ws.ts               # WS message types (vendored copy — see "Protocol sync" below)
install/
  ubuntu/
    install.sh          # curl | bash installer
    ambit-agent.service # systemd unit
```

## Local dev quickstart

Prerequisites: Node.js 20+, the admin API reachable at some URL, an enrollment token for a runtime row on that admin.

```bash
npm install
cp .env.example .env    # then edit .env with your ADMIN_URL + ENROLLMENT_TOKEN
npm run dev
```

The daemon connects, sends `hello`, and starts heartbeating every 15 seconds. Check the admin's `GET /rest/runtimes` — you should see this runtime flip to `online` within a second.

## Protocol sync

For Phase 0 we vendor the WebSocket message types in `src/protocol/ws.ts` — a hand-copied duplicate of `ambitagent-admin/packages/shared-protocol/src/ws.ts`. When you change either side, sync the other by hand.

This is deliberately loose while the protocol is still churning. Before Phase 1 we either:
- Extract `shared-protocol` to its own git repo and consume as a submodule here, or
- Publish it as a private npm package and consume normally.

Either fix removes the hand-sync burden.

## Ubuntu install (target machine)

Once we have a signed release artifact, the flow will be:

```bash
curl -sSL https://<admin-host>/install.sh | sudo bash
sudo systemctl status ambit-agent
```

The installer prompts for the enrollment token, writes it to `/etc/ambit-agent/config`, and enables the systemd unit. See `install/ubuntu/install.sh` for the current placeholder.
