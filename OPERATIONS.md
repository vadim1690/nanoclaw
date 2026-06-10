# NanoClaw Operations — Vadim's VPS

> Deployed 2026-06-10 on the Contabo VPS (144.91.113.230), user `deploy`, checkout at `~/nanoclaw`.
> NanoClaw v2 (fork: `vadim1690/nanoclaw`, upstream: `nanocoai/nanoclaw`).

## What's running

| Thing | Value |
|---|---|
| systemd unit (user) | `nanoclaw-v2-3d7419b0.service` (slug is per-install — derived from checkout path) |
| Host process | Node, `~/nanoclaw/dist/index.js`, `Restart=always` |
| Agent group | `Flooka` (`ag-1781112233717-mnnobm`, folder `groups/dm-with-vadim/`) |
| Channel | Telegram bot `@flooka_vadim_bot`, polling mode (no inbound ports) |
| Owner | `telegram:1434418744` (Vadim) — sole owner, no admins |
| Vault | OneCLI gateway, Docker compose at `~/.onecli/` (ports 127.0.0.1:10254 web UI / 10255 proxy) |
| Claude auth | Personal Max subscription OAuth token, held in OneCLI vault only (1-year expiry, created 2026-06-10 → renew ~June 2027 via `claude setup-token`) |
| Timezone | Asia/Jerusalem |

## Service management (over SSH)

`systemctl --user` needs the runtime dir when connecting via SSH (lingering is already enabled):

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user {status|start|stop|restart} nanoclaw-v2-3d7419b0
```

Logs (files, not journal):

```bash
tail -f ~/nanoclaw/logs/nanoclaw.log          # full routing chain
tail -f ~/nanoclaw/logs/nanoclaw.error.log    # check this FIRST on problems
ls ~/nanoclaw/logs/setup-steps/               # installer step logs
```

Admin CLI (`~/.local/bin/ncl`):

```bash
ncl groups list / ncl messaging-groups list / ncl wirings list / ncl roles list
ncl sessions list                              # active sessions
ncl groups restart --id <group-id> [--rebuild] # restart agent container
ncl dropped-messages list                      # messages silently dropped from strangers
```

AI-native debugging: `cd ~/nanoclaw && claude` then `/debug`, or just ask Flooka on Telegram ("list all scheduled tasks", "pause the morning briefing").

## Security posture (as configured)

- **Mount allowlist** `~/.config/nanoclaw/mount-allowlist.json` — exactly one allowed root: `~/nanoclaw-workspace` (RW). Everything else blocked by default. Never add `.ssh`, `.env`, other projects' dirs, or MongoDB/Postgres volumes.
- **Group mounts**: Flooka has one additional mount — `~/nanoclaw-workspace` → `/workspace/extra/notes` (RW). Stored in `container_configs.additional_mounts` (central DB), change requires `ncl groups restart`.
- **Egress lockdown ON**: `NANOCLAW_EGRESS_LOCKDOWN=true` in the service unit. Agent containers sit on the internal `nanoclaw-egress` Docker network; the OneCLI gateway is their only route out, credentials injected at the proxy (containers hold `placeholder` env values only).
- **Sender policies**: Telegram messaging group `unknown_sender_policy=strict` (strangers silently dropped — see `ncl dropped-messages list`), wiring `sender_scope=known`. The `Local CLI` messaging group is `public` by design (requires shell access anyway).
- **Port 3000** (NanoClaw webhook server) is blocked externally via iptables DNAT (rule persisted with `netfilter-persistent`). Telegram is polling; NanoClaw needs no inbound ports.
- **Docker socket** is NOT mounted into any NanoClaw container (verified).

## Scheduled jobs

- **Morning briefing**: weekdays (Sun–Thu) 07:00 Asia/Jerusalem — Tel Aviv weather + 3–5 tech/AI headlines, kept short. Manage via chat: "pause/resume/list scheduled tasks".

## Quota / billing (June 2026 rules)

- Since **June 15, 2026**, NanoClaw draws from the **$100/month Agent SDK credit pool** included in the Max 5× plan (API list rates, per-user, no rollover). Interactive Claude Code use is a separate bucket and unaffected.
- When credits run out, automated requests **stop with errors** (overflow billing is OFF — deliberately). The bot goes quiet until the monthly reset rather than billing extra.
- Monitor consumption: Claude account settings → usage, or `/status` in `claude` on the VPS. If burn is too high: thin schedules, shorten briefings, or route low-stakes agents through Codex (`/add-codex`, ChatGPT Plus).
- Estimated burn for current setup: ~$10–30/month. **TODO: check actual burn after first week (≈June 17) and update this line.**

## Updating NanoClaw

```bash
cd ~/nanoclaw
git fetch upstream
git log --oneline HEAD..upstream/main           # review what's coming
# read CHANGELOG / release notes for breaking changes & security fixes first
git merge upstream/main
pnpm install --frozen-lockfile && pnpm run build
./container/build.sh                            # rebuild agent image
export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user restart nanoclaw-v2-3d7419b0
```

Or AI-native: run `claude` in the repo and use `/update-nanoclaw`. Cadence: monthly, or immediately on security advisories.

## Backups

Add to the VPS backup routine:
- `~/nanoclaw/groups/` — per-group CLAUDE.local.md + skills (CLAUDE.local.md is **gitignored**, so the fork does NOT back it up)
- `~/nanoclaw/data/` — central DB (users, roles, wirings, schedules) + session DBs
- `~/nanoclaw/.env` — Telegram bot token, OneCLI URL
- `~/.config/nanoclaw/` — mount allowlist
- `~/.onecli/` + its Docker volumes (`onecli_pgdata`, `onecli_app-data`) — the vault (holds the Claude token)
- `~/nanoclaw-workspace/` — Flooka's notes
- Code customizations: committed & pushed to the fork (`vadim1690/nanoclaw`)

## Known quirks (learned during install)

1. **ghcr.io pulls reset over IPv6** (Contabo↔GitHub flakiness). Fixed with IPv4 pins in `/etc/hosts` (`ghcr.io`, `pkg-containers.githubusercontent.com`; backup at `/etc/hosts.bak-nanoclaw`). If ghcr pulls fail with TLS/connect errors someday, re-resolve (`getent ahostsv4 ghcr.io`) and update the pins.
2. **`deploy` has no sudo — by design.** Anything needing root (apt, iptables, Node upgrades) goes through `ssh vps-root`. The NanoClaw installer's Node bootstrap hangs on a hidden sudo prompt — Node 22 + pnpm 10 are installed system-wide; keep them current via root.
3. **`systemctl --user` over SSH** needs `XDG_RUNTIME_DIR=/run/user/$(id -u)` (lingering already enabled via `loginctl enable-linger deploy`).
4. **tmux session `nanoclaw`** on the VPS was used for the interactive install; safe to kill (`tmux kill-session -t nanoclaw`) — the service does not depend on it.
5. **Mount allowlist schema**: `blockedPatterns` is REQUIRED (use `[]` — built-in defaults always merge in). Without it the whole allowlist fails to load and all additional mounts are silently rejected — symptom: `Additional mount REJECTED` in `nanoclaw.error.log` and the agent's notes don't persist.

## Deferred / future (post-setup brainstorm material)

Not built, by deliberate scope decision: Google Workspace access (highest prompt-injection risk — wire read-only via per-group OAuth mounts when wanted), calorie logger, dev sidekick, trip desk, WhatsApp channel. New agent groups = code changes in the fork (ask Flooka to brainstorm; Claude Code implements).
