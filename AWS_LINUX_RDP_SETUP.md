# AWS Linux (Ubuntu) RDP Setup — Working Recipe

Runbook for spinning up a fresh AWS EC2 Ubuntu instance that operators can RDP
into for running the Playwright tool. Written after the 2026-06-30 setup
where troubleshooting took ~2 hours; this recipe is what actually worked and
should get the next instance operational in ~5 minutes.

Companion to [`WINDOWS_INSTALL.md`](WINDOWS_INSTALL.md) — that doc covers
running the tool on a Windows workstation; this one covers hosting it on a
shared Linux server so multiple operators can RDP in concurrently.

---

## Why Linux over Windows for shared RDP hosts

Linux is fundamentally multi-user without any per-user licensing. On Windows
Server, every RDP user needs an RDS CAL (~$10/user/month) on top of the OS
license. Linux + xrdp gets you the same "multiple operators concurrent on one
box" model with the Chrome/Playwright fingerprint being indistinguishable
from Windows to Cloudflare's bot detection.

Ballpark cost for a shared host: **one `t3.xlarge` supports 3-5 concurrent
Playwright users at ~$120/month** — roughly $25/user/month with no
licensing tax.

---

## Prerequisites

- AWS account with EC2 access
- SSH key pair
- Your Mac's public IPv4 (used to lock down port 3389)

---

## 1. Launch the EC2 instance

- **AMI:** Ubuntu Server 22.04 LTS or 24.04 LTS (both work with this recipe)
- **Instance type:** `t3.large` minimum, `t3.xlarge` recommended for
  multi-user (see sizing table at the bottom)
- **Storage:** 30 GB gp3 minimum (Chrome + Playwright browsers eat ~5 GB)
- **Security group:** Default SSH-only for now. We'll add RDP after xrdp is
  installed (Step 3).

---

## 2. Install xrdp + XFCE — run this in one shot from SSH

```bash
sudo apt update && sudo apt upgrade -y

# Core packages. dbus-x11 is load-bearing — without it clicks in XFCE
# are heard but no child process ever spawns.
sudo apt install -y xfce4 xfce4-goodies xrdp dbus-x11

# The modern startwm.sh. Two load-bearing pieces:
#   1. dbus-launch --exit-with-session — starts a fresh dbus session so
#      XFCE can actually spawn processes. Without it: black screen, or
#      desktop appears but clicks do nothing.
#   2. unset DBUS_SESSION_BUS_ADDRESS + XDG_RUNTIME_DIR — clears stale
#      env vars that xrdp inherits, so dbus-launch starts clean.
sudo tee /etc/xrdp/startwm.sh > /dev/null <<'EOF'
#!/bin/sh
if [ -r /etc/default/locale ]; then
    . /etc/default/locale
    export LANG LANGUAGE
fi
unset DBUS_SESSION_BUS_ADDRESS
unset XDG_RUNTIME_DIR
exec dbus-launch --exit-with-session startxfce4
EOF
sudo chmod +x /etc/xrdp/startwm.sh

# CRITICAL: do NOT create ~/.xsession. Older tutorials tell you to. It
# conflicts with startwm.sh and any typo turns the session into a
# broken Frankenstein where the desktop appears but nothing launches.
rm -f ~/.xsession
sudo rm -f /etc/skel/.xsession

# Enable + start xrdp
sudo systemctl enable --now xrdp
sudo systemctl restart xrdp

# RDP needs a password on the ubuntu user (SSH-only key auth won't work)
sudo passwd ubuntu
```

---

## 3. Open port 3389 in the Security Group

- AWS Console → EC2 → Security Groups → the SG attached to your instance
- Inbound rules → Add rule
- **Type:** RDP · **Port:** 3389 · **Source:** My IP

**Do not use `0.0.0.0/0` as the source.** xrdp exposed to the open internet
is a serious security hole. Every operator gets added by IP; if their IP is
dynamic, use a VPN or the AWS bastion pattern.

---

## 4. Connect from Mac

- Install **Microsoft Remote Desktop** from the App Store (free)
- Add PC → PC name = EC2 public IPv4 → User = `ubuntu` / your password
- Connect

You should see the XFCE desktop. Clicking Applications → Terminal Emulator
should open a real terminal. If clicks highlight but nothing opens, see the
"When it doesn't work" section below.

---

## 5. Install Chrome for the Playwright tool

Once you're in the RDP session, open a terminal:

```bash
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
rm google-chrome-stable_current_amd64.deb
google-chrome &   # verify it opens
```

---

## 6. Optional polish — silence the color-manager popup

Ubuntu 22.04+ pops an "Authentication required to create managed color
device" dialog on every login. Nuisance, not blocking. Kills it:

**Ubuntu 24.04+ (rules.d, JavaScript format):**

```bash
sudo tee /etc/polkit-1/rules.d/45-allow-colord.rules > /dev/null <<'EOF'
polkit.addRule(function(action, subject) {
    if ((action.id == "org.freedesktop.color-manager.create-device" ||
         action.id == "org.freedesktop.color-manager.create-profile" ||
         action.id == "org.freedesktop.color-manager.delete-device" ||
         action.id == "org.freedesktop.color-manager.delete-profile" ||
         action.id == "org.freedesktop.color-manager.modify-device" ||
         action.id == "org.freedesktop.color-manager.modify-profile") &&
        subject.isInGroup("ubuntu")) {
        return polkit.Result.YES;
    }
});
EOF
```

**Ubuntu 22.04 and earlier (localauthority, INI format):**

```bash
sudo mkdir -p /etc/polkit-1/localauthority/50-local.d
sudo tee /etc/polkit-1/localauthority/50-local.d/45-allow-colord.pkla > /dev/null <<'EOF'
[Allow Colord all Users]
Identity=unix-user:*
Action=org.freedesktop.color-manager.create-device;org.freedesktop.color-manager.create-profile;org.freedesktop.color-manager.delete-device;org.freedesktop.color-manager.delete-profile;org.freedesktop.color-manager.modify-device;org.freedesktop.color-manager.modify-profile
ResultAny=no
ResultInactive=no
ResultActive=yes
EOF
```

---

## Adding more operators to a shared host

xrdp is fundamentally multi-user, so once the box is set up for `ubuntu`,
adding operators is one command each:

```bash
sudo adduser <username>          # prompts for password interactively
```

They can now RDP in as `<username>` with that password. The startwm.sh
change is system-wide, so every user's session inherits the working
startup. No xrdp restart needed.

Sizing reality for shared Playwright hosts:

| Instance | vCPU / RAM | Realistic concurrent Playwright users |
|---|---|---|
| `t3.large` | 2 / 8 GB | 1-2 active |
| `t3.xlarge` | 4 / 16 GB | 3-5 active |
| `t3.2xlarge` | 8 / 32 GB | 6-10 active |
| `m6i.4xlarge` | 16 / 64 GB | 15-25 active |

Playwright with an active Chrome uses ~2-4 GB per user under sustained
scraping load. Provision for peak-concurrent, not average.

---

## When it doesn't work — troubleshooting

Three specific failure modes we hit during the 2026-06-30 setup, in the
order they bite. Each has a specific symptom, so match to yours.

### Symptom: black screen right after login

Almost always `startxfce4` is failing to launch and xrdp is holding an
empty session open. Two likely causes:

1. **`~/.xsession` exists and has a typo.** Xsession runs it before
   startwm.sh and it silently fails. From SSH:
   ```bash
   ls -la ~/.xsession       # should say "No such file"
   rm -f ~/.xsession        # if it exists
   ```

2. **`startxfce4` isn't actually installed.** Verify:
   ```bash
   which startxfce4         # should print /usr/bin/startxfce4
   ```
   If it prints nothing:
   ```bash
   sudo apt install -y xfce4
   ```

After either fix, kill the stuck session (see below) and reconnect.

### Symptom: desktop appears but clicks don't launch anything

The panel and window manager are running but no dbus session exists, so
every child process the panel spawns dies silently. Usually means
startwm.sh is missing the `dbus-launch` line. Re-apply the startwm.sh
block from Step 2 verbatim, then kill the stuck session and reconnect.

Also verify `dbus-x11` is installed:

```bash
dpkg -l | grep dbus-x11
```

Should show `ii  dbus-x11`. If not:

```bash
sudo apt install -y dbus-x11
```

### Symptom: applied a fix but nothing changed after reconnecting

You're still in the same broken xrdp session — closing the RDP window on
your Mac doesn't log you out, just disconnects the display. Force a clean
session from SSH:

```bash
sudo systemctl restart xrdp
sudo pkill -KILL -u ubuntu -f xfce4      || true
sudo pkill -KILL -u ubuntu -f Xorg       || true
sudo pkill -KILL -u ubuntu -f xrdp-chansrv || true
```

Now reconnect from your Mac — you'll get a fresh session with whatever
config changes you made.

### Reading the actual error

Every failed session logs to `~/.xsession-errors`. From SSH:

```bash
tail -40 ~/.xsession-errors
```

Check timestamps — if the log entries are older than your last RDP
attempt, the failed attempt didn't even reach XFCE (probably an xrdp-level
issue). Check xrdp itself:

```bash
sudo journalctl -u xrdp -n 50 --no-pager
```

---

## What NOT to do (lessons from the 2026-06-30 troubleshooting)

- **Don't create `~/.xsession`.** Every older tutorial tells you to. It
  conflicts with `startwm.sh` and a single typo (like `xfce-session`
  instead of `xfce4-session`) makes the session partially start, showing
  the desktop but blocking any app from launching.
- **Don't `unset DBUS_SESSION_BUS_ADDRESS` in startwm.sh without also
  running `dbus-launch`.** The unset clears stale environment; without
  dbus-launch to replace it there's no session bus at all, and every
  process spawn silently dies.
- **Don't rely on "close RDP window = logout".** It doesn't. Force-kill
  the session from SSH when iterating on fixes.

---

## Related

- [`WINDOWS_INSTALL.md`](WINDOWS_INSTALL.md) — running the tool on a
  Windows workstation
- [`SETUP.md`](SETUP.md) — general Playwright tool setup
