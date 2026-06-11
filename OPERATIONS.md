# NanoClaw Operations — Vadim's VPS

> Deployed 2026-06-10 on the Contabo VPS (144.91.113.230), user `deploy`, checkout at `~/nanoclaw`.
> NanoClaw v2 (fork: `vadim1690/nanoclaw`, upstream: `nanocoai/nanoclaw`).
> Last major update: 2026-06-11 (two agents live, Google connected, voice, security hardening, cost monitoring).

## What's running

| Thing | Value |
|---|---|
| systemd unit (user) | `nanoclaw-v2-3d7419b0.service` (slug is per-install — derived from checkout path) |
| Host process | Node, `~/nanoclaw/dist/index.js`, `Restart=always` |
| **Agent: Flooka** | `ag-1781112233717-mnnobm`, folder `groups/dm-with-vadim/`. Personal Jarvis. Telegram **DM** `@flooka_vadim_bot`. `secretMode=all` (Anthropic + Groq + Google). |
| **Agent: Rocky** | `ef59685c-5755-4127-80d8-ec5951d74e09`, folder `groups/rocky/`. Fitness/nutrition coach. Telegram **group**. `secretMode=selective` (Anthropic + Groq only — no Google). |
| Channel | Telegram, polling mode (no inbound ports) |
| Owner | `telegram:1434418744` (Vadim) — sole owner, no admins |
| Vault | OneCLI gateway, Docker compose at `~/.onecli/` (binds `172.17.0.1:10254` web UI / `10255` proxy — NOT public) |
| Claude auth | Personal Max 5× subscription OAuth token, in OneCLI vault only (1-yr expiry, created 2026-06-10 → renew ~June 2027 via `claude setup-token`) |
| Models | Agents run on **Sonnet 4.6** (main) + **Haiku 4.5** (light), not Opus |
| Timezone | Asia/Jerusalem |

## Connected services (OneCLI vault)

Secrets: **Anthropic** (`5436f0f4`), **Groq** (`6f8370e7-…`, `api.groq.com`, path `/openai/v1/`, `Bearer {value}`).

Google (Flooka only — `secretMode=all` matches all connected Google apps):
- **Gmail** (modify + readonly) — via MCP server `@gongrzhe/server-gmail-autoauth-mcp` baked into the agent image. Policy: **read + draft only**, never auto-send.
- **Google Calendar** — via MCP server `@cocal/google-calendar-mcp` in the image.
- **Google Tasks** + **YouTube** — **no MCP server**; reached by direct REST through the OneCLI gateway (e.g. `curl https://tasks.googleapis.com/...`, `https://www.googleapis.com/youtube/v3/...`). The gateway injects the OAuth token because the host matches a connected app. **Vault connection ≠ MCP server** — don't judge an agent's access by its `mcp_servers` list.

**Voice transcription**: both agents transcribe Telegram voice notes via Groq Whisper (`whisper-large-v3`) — a plain `curl` to `api.groq.com/openai/v1/audio/transcriptions`, key injected by the gateway. Defined in each agent's `CLAUDE.local.md`.

## The two agents (behavior lives in CLAUDE.local.md)

Each agent's personality, formatting rules, proactivity budget, cost discipline, and behaviors are defined in `groups/<folder>/CLAUDE.local.md` (gitignored, VPS-only). **This is the single source of truth** — scheduled tasks are thin pointers that say "run your X per your instructions." To change behavior, edit the `CLAUDE.local.md` (see "Editing agent config" below); no schedule surgery needed.

Shared design baked into both:
- **Telegram formatting contract** — Telegram uses *legacy* Markdown. Only `*bold*`, `_italic_`, `` `code` ``, `[links]`, `•` bullets, emoji pseudo-headers render. NO `##` headings, `**double bold**`, tables, `>` quotes (they show literally / break). Hebrew & English on separate lines (RTL/LTR scramble otherwise).
- **Proactivity** — Flooka budget 3–5 self-initiated msgs/day; Rocky 2–3/day. Quiet hours 22:00–07:00. Prefer silent action + batching into the daily briefs. Self-throttle logs: Flooka `…/notes/flooka-ping-log.md`, Rocky `…/data/rocky-ping-log.md`.
- **Cost discipline** — ≤1 web search per brief, tight outputs, reuse-don't-refetch, cheap tool calls, never loop on failures.
- **Rocky coaching** is evidence-based: no-log nudge fires once and auto-clears on log, streaks always paired with forgiveness, never moralizes food, scales support down when consistent.

## Service management (over SSH)

`systemctl --user` needs the runtime dir over SSH (lingering is enabled):

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user {status|start|stop|restart} nanoclaw-v2-3d7419b0
```

Logs (files, not journal):

```bash
tail -f ~/nanoclaw/logs/nanoclaw.log          # full routing chain
tail -f ~/nanoclaw/logs/nanoclaw.error.log    # check this FIRST on problems
tail -f ~/nanoclaw/logs/usage-report.log      # weekly usage cron output
```

Admin CLI (`~/.local/bin/ncl`):

```bash
ncl groups list / ncl messaging-groups list / ncl wirings list / ncl roles list
ncl sessions list
ncl groups restart --id <group-id> [--rebuild] [--message "<on-wake instruction>"]
ncl destinations list --id <group-id>
ncl dropped-messages list
```

AI-native debugging: `cd ~/nanoclaw && claude` then `/debug`, or just ask Flooka on Telegram.

## Editing agent config (CLAUDE.local.md)

`CLAUDE.local.md` is read on every container spawn, so edits apply on the agent's next wake — no restart needed for content.

- **Write it locally and `scp` it up** — do NOT build the file with a shell heredoc; backticks/asterisks/emoji get mangled. Pattern:
  `scp local.md vps:~/nanoclaw/groups/<folder>/CLAUDE.local.md`
- **Schedules are thin pointers in the session DB.** To retune a scheduled behavior, edit the agent's `CLAUDE.local.md`. To change *timing/cron*, edit the recurrence row directly with Python+sqlite3 (the `ncl` CLI only sets scalar fields), or ask the agent to reschedule. The session DBs:
  - Flooka: `data/v2-sessions/ag-1781112233717-mnnobm/sess-1781112233725-pygsj9/inbound.db`
  - Rocky: `data/v2-sessions/ef59685c-5755-4127-80d8-ec5951d74e09/sess-1781115577045-zwck7s/inbound.db`
  - Recurring tasks = rows with `recurrence` (cron) set; the `content` JSON holds `{prompt, script}`. Rocky's evening row has a `script` gate that only wakes the agent if meals were logged — **preserve it** when editing.

## Scheduled jobs

Agent schedules (cron in Asia/Jerusalem; behavior defined in CLAUDE.local.md):
- **Flooka morning brief** — Sun–Thu 07:00. Calendar + Gmail (needs-reply, drafted) + Google Tasks + weather + 3 tech headlines (one combined search) + "השורה של פלוקה" take.
- **Flooka evening wrap** — Sun–Thu 21:00, sends only if there's something worth saying.
- **Rocky evening summary** — 21:30 daily, script-gated (only wakes if meals logged); on Sundays expands into the weekly adaptive review.
- **Rocky midday check-in** — 13:00 daily, sends only if genuinely useful (no-log nudge / protein-gap / calorie pacing).

Host cron (zero Claude tokens):
- **Weekly usage report** — Sunday 08:00 (`crontab` with `CRON_TZ=Asia/Jerusalem`). Runs `~/nanoclaw-usage-report.py`, which scans both agents' session transcripts, estimates cost at API rates, projects the month vs the $100 pool, and DMs Vadim via the Telegram Bot API. Log: `~/nanoclaw/logs/usage-report.log`.

## Quota / billing (June 2026 rules)

- Since **June 15, 2026**, NanoClaw (Agent SDK) draws from the **$100/month credit pool** in the Max 5× plan — billed at **API list rates**, per-user, no rollover. Interactive Claude Code / claude.ai use is a **separate bucket, unaffected**.
- **Overflow billing is OPT-IN and OFF.** When the $100 is exhausted, automated requests **stop with errors** until the monthly reset — no surprise charges. (Keep it off.)
- **Measured burn**: the 2026-06-10→11 build/test session ran ~**$15–17** (heavy, not representative — lots of brief reruns + research). Steady-state (one brief, conditional wraps, a few chats, Rocky check-ins) is realistically **~$1–3/day**; pool ≈ $3.30/day.
- Biggest cost drivers: **web search** (large results into context) and long outputs / cache writes — hence the per-brief search cap and lean-output rules.
- Monitor: the **weekly Sunday report** (above), or `claude.ai/settings → Usage` for the authoritative figure. If a month runs hot: trim brief search depth, reduce schedule frequency, or route a low-stakes agent through Codex.

## Security posture (as configured)

- **Mount allowlist** `~/.config/nanoclaw/mount-allowlist.json` — three RW roots: `~/nanoclaw-workspace` (agent scratch/notes), `~/.gmail-mcp` and `~/.calendar-mcp` (OneCLI-managed Google OAuth stubs, placeholders only). `blockedPatterns: []` is **required** (built-in defaults still merge in). Never add `.ssh`, `.env`, other projects' dirs, or DB volumes.
- **Per-agent mounts**: Flooka → `~/nanoclaw-workspace/flooka` (notes, inbox, ping log); Rocky → `~/nanoclaw-workspace/coach` (profile/log/insights, ping log). In `container_configs.additional_mounts`; change needs `ncl groups restart`.
- **Egress lockdown ON** (`NANOCLAW_EGRESS_LOCKDOWN=true`): agent containers sit on the internal `nanoclaw-egress` network; the OneCLI gateway is their only egress, credentials injected at the proxy (containers hold `placeholder` env values).
- **Sender policies**: Telegram messaging groups `unknown_sender_policy=strict` (strangers dropped — `ncl dropped-messages list`), wiring `sender_scope=known`.
- **SSH**: key-only (`PasswordAuthentication no`), `fail2ban` active. `deploy` has **no sudo** (root via `ssh vps-root`). `authorized_keys` holds 3 keys: `vadim@laptop`, `github-actions-deploy`, `vadim`. ⚠️ **This laptop's key is the one labelled `vadim`** (= `~/.ssh/id_ed25519`), NOT `vadim@laptop`. `vadim@laptop` is unverified — candidate for removal once confirmed unused. The `github-actions-vps` key (= `github-actions-deploy`) is the fallback for getting back in.
- **Firewall**:
  - IPv4 — app/vault/DB ports (3000–3006, 10254/5, 5432) blocked externally via iptables NAT DNAT-to-blackhole, persisted with `netfilter-persistent`.
  - IPv6 — the VPS has a public IPv6 and previously had **no** v6 firewall. Added an `ip6tables` INPUT default-deny (allow `lo`, established, ICMPv6, tcp 22/80/443; DROP the rest), persisted to `/etc/iptables/rules.v6`. Closes the class of "process binds `[::]` and is exposed."
  - **OurDay (port 3001)** was exposed over IPv6 (its compose published `0.0.0.0`/`[::]`). Rebound to `127.0.0.1:3001` both on the VPS and in the **WeddingOrganizer** repo (commit `0cbaa90`) so CI/CD won't re-expose it. Honeymoon (3003) and Reps (3006) already bind localhost.
- **File perms**: `~/nanoclaw/.env` = `600`, `~/.onecli` = `700`.
- **Docker socket** is NOT mounted into any NanoClaw container (verified). No privileged containers.

## Updating NanoClaw

```bash
cd ~/nanoclaw
git fetch upstream
git log --oneline HEAD..upstream/main           # review; read release notes for breaking/security changes
git merge upstream/main
pnpm install --frozen-lockfile && pnpm run build
./container/build.sh                            # rebuild agent image (has Gmail+Calendar MCP, Groq used at runtime)
export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user restart nanoclaw-v2-3d7419b0
```

Or AI-native: `/update-nanoclaw`. Cadence: monthly, or immediately on security advisories.

## Backups (note: not currently automated — by choice)

If you ever want a backup routine, the critical paths are:
- `~/nanoclaw/groups/` — per-group CLAUDE.local.md + skills (**gitignored**, so the fork does NOT hold them)
- `~/nanoclaw/data/` — central DB + session DBs (schedules live here)
- `~/nanoclaw/.env`, `~/.config/nanoclaw/`, `~/nanoclaw-usage-report.py`
- `~/.onecli/` + Docker volumes (`onecli_pgdata`, `onecli_app-data`) — the vault (holds the Claude token)
- `~/nanoclaw-workspace/` — Flooka notes + Rocky's coaching memory
- Code customizations: committed to the fork (`vadim1690/nanoclaw`)

## Known quirks (learned during install/operation)

1. **ghcr.io pulls reset over IPv6** (Contabo↔GitHub). Fixed with IPv4 pins in `/etc/hosts` (`ghcr.io`, `pkg-containers.githubusercontent.com`; backup `/etc/hosts.bak-nanoclaw`). If pulls fail with TLS/connect errors, re-resolve (`getent ahostsv4 ghcr.io`) and update.
2. **`deploy` has no sudo — by design.** Root work via `ssh vps-root`. Node 22 + pnpm 10 installed system-wide; keep current via root.
3. **`systemctl --user` over SSH** needs `XDG_RUNTIME_DIR=/run/user/$(id -u)` (lingering enabled).
4. **Mount allowlist** `blockedPatterns` is REQUIRED (`[]`). Without it the allowlist fails to load and mounts are silently rejected (`Additional mount REJECTED` in error log).
5. **`ncl groups restart --message` does nothing if no container is running** (`restarted: 0`). The on-wake message is only consumed by a fresh container's first poll. To make an agent act on a setup instruction, trigger a real spawn (send it a Telegram message) — or edit the DB/files directly.
6. **Edit CLAUDE.local.md via `scp`, never a shell heredoc** — heredocs mangle backticks/asterisks/emoji.
7. **SSH key labels are misleading** — see Security posture. Removing the `vadim` key locks this laptop out; recover via the `github-actions-vps` key (`ssh -i ~/.ssh/github-actions-vps -o IdentitiesOnly=yes deploy@144.91.113.230`).
8. **tmux session `nanoclaw`** from install is safe to kill; the service doesn't depend on it.

## Done (was deferred at install)

Google Workspace (Gmail read+draft, Calendar, Tasks, YouTube — Flooka only), the fitness/nutrition coach (Rocky), and voice transcription (Groq) are all **built and live**. Remaining future ideas: dev/work sidekick agent, personal-CRM/finance behaviors inside Flooka, WhatsApp channel. New agent groups may need fork code changes (brainstorm with Flooka; Claude Code implements).
