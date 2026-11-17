# Leave Desk — approve greytHR leave requests from Gmail

A small local dashboard for managers who get greytHR leave / WFH / regularization mails in Gmail.
It lists every request, shows who's off when, and lets you approve or reject with a pre-written reply
sent **in the same email thread**, to the employee, CC'd to whoever you choose, with your Gmail signature.

Everything runs on your machine (`127.0.0.1`). Your mail, token and team list never leave it and are git-ignored.

![stack](https://img.shields.io/badge/python-3.9%2B-blue) ![deps](https://img.shields.io/badge/deps-google--api--python--client-lightgrey)

## Quick start

1. **Use this template** (green button on GitHub) → clone your copy.
2. Install:
   ```bash
   cd leave-desk
   python3 -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   ```
3. Try it with sample data (nothing is ever sent): `python server.py --demo` → http://127.0.0.1:8765
4. Connect your mailbox:
   ```bash
   python server.py --setup
   ```
   The wizard walks you through:
   - **Google OAuth client.** Creates `credentials.json` (one-time, free; step-by-step links are printed).
   - **Team roster.** Paste `Full Name, email` lines → `team.json`. Names must match how greytHR writes them.
   - **Reply settings.** CC addresses (e.g. your manager / HR), Gmail search query, port → `config.json`.
   - **Gmail login.** A browser opens; choose the mailbox that receives greytHR approval mails.
5. Run: `python server.py` → http://127.0.0.1:8765. Keep it running; it re-syncs every 5 min (**↻ Sync** forces it).

### Creating `credentials.json` (what the wizard asks for)
1. [Create a Google Cloud project](https://console.cloud.google.com/projectcreate).
2. [Enable the Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
3. [OAuth branding / consent screen](https://console.cloud.google.com/auth/branding): app name + your email.
   Audience **Internal** on Google Workspace; otherwise **External** and add yourself under *Test users*.
4. [Clients](https://console.cloud.google.com/auth/clients) → *Create client* → **Desktop app** → download JSON →
   save as `credentials.json` in this folder.

Scopes requested: `gmail.modify` (read mails, add labels, read your signature) and `gmail.send` (send replies).

## Files

| File | What | In git? |
|---|---|---|
| `server.py` | Gmail sync, parser, HTTP server, setup wizard | ✓ |
| `static/` | Dashboard UI | ✓ |
| `config.example.json` / `team.example.json` | Formats, if you prefer editing by hand | ✓ |
| `config.json` | `cc`, `query`, `port` | ✗ |
| `team.json` | `{"Full Name": "email"}` | ✗ |
| `credentials.json`, `gmail_token.json` | Google OAuth client + your login | ✗ |
| `gmail_cache.json`, `decisions.json` | Downloaded mails, decisions made in the dashboard | ✗ |

Change settings any time: re-run `--setup` or edit the JSON files, then restart.
Env overrides: `PORT`, `LEAVE_QUERY`, `LEAVE_MAX`.

## What it reads
Mails matching the query (default `(from:greythr.com OR subject:"Leave Application") newer_than:120d`):
- **Leave applications** (Sick, WFH, Earned, Casual, Restricted Holiday, …) and **permission requests** (regularization).
- **Replies in the thread** ("Approved" / "Rejected" from anyone) settle the request and show *who* decided.
- Ignored: your own leave status mails, payslips, min-hours alerts.

## Statuses
- **Pending**: no reply yet and still recent.
- **Approved / Rejected**: someone replied in the thread (latest reply wins), or you decided here.
- **No reply**: older than 14 days, leave already over, nobody replied by email (usually handled inside greytHR).

## Approving (nothing is sent until you confirm the dialog)
1. ✓ / ✕ on a row (or open it → Approve / Reject, or press `a` / `r`).
2. **To** is pre-filled from `team.json`, never the greytHR no-reply address. **CC** comes from `config.json`.
3. The message is pre-written for the request type (WFH, sick, bereavement, restricted holiday, regularization, …)
   with the first name and dates; late replies get an apology instead of "enjoy your time off". Edit freely:
   what's in the box is what's sent, followed by your Gmail signature.
4. Confirm → reply in the same thread, Gmail label `Leave/Approved` or `Leave/Rejected`, marked read.

Bulk: tick rows → *Approve selected*; each person gets their own reply worded for their request.

> The email reply does **not** change the status inside greytHR (unless your admin enabled email approvals).
> Use **Review in greytHR ↗** in the details panel for that.

Shortcuts: `/` search · `j`/`k` move · `Enter` open · `a` approve · `r` reject · `x` select · `1–5` tabs · `[` `]` month · `?` help.

## Troubleshooting
- **`invalid_grant` / token expired** (External apps in *Testing* expire every 7 days): `python server.py --connect`.
- **"no employee email"**: the name isn't in `team.json`; add it (spelled as in greytHR) and restart.
- **Different HR tool or mail format**: change the query in `config.json`; parser checks live in `python server.py --selftest`.

## License
MIT
