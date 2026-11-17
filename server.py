"""greytHR leave-request dashboard.

  python server.py --setup    # first run: Google credentials, team, CC, Gmail login
  python server.py            # demo data unless gmail_token.json exists
  python server.py --demo     # force demo data (nothing is ever sent)
  python server.py --connect  # redo the Gmail login only (expired / revoked token)
  python server.py --selftest # parser checks

Open http://localhost:8765
"""
import base64, html, http.client, json, os, random, re, sys, threading, time
from datetime import date, datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
CREDENTIALS = os.path.join(HERE, "credentials.json")  # your Google Cloud OAuth client (Desktop app)
TOKEN = os.path.join(HERE, "gmail_token.json")
SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"]
CONFIG_FILE = os.path.join(HERE, "config.json")  # written by --setup
TEAM_FILE = os.path.join(HERE, "team.json")  # {"Full Name": "email"} — replies go here, never to noreply


def _load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


CONFIG = _load(CONFIG_FILE, {})
TEAM = _load(TEAM_FILE, {})
DEFAULT_QUERY = '(from:greythr.com OR subject:"Leave Application") newer_than:120d'
QUERY = os.environ.get("LEAVE_QUERY") or CONFIG.get("query") or DEFAULT_QUERY
MAX_MSGS = int(os.environ.get("LEAVE_MAX") or CONFIG.get("max_messages") or 1500)
CACHE = os.path.join(HERE, "gmail_cache.json")  # parsed mails by id; mails never change, so each is fetched once
PORT = int(os.environ.get("PORT") or CONFIG.get("port") or 8765)
SETUP = "--setup" in sys.argv
DEMO = "--demo" in sys.argv or not (SETUP or "--connect" in sys.argv or os.path.exists(TOKEN))
DECISIONS = os.path.join(HERE, "decisions_demo.json" if DEMO else "decisions.json")
CC = [e.strip() for e in CONFIG.get("cc", []) if e.strip()]  # copied on every reply
NOREPLY = re.compile(r"no-?reply|do-?not-?reply|greythr", re.I)


def _toks(name):
    return re.sub(r"[^a-z ]", " ", (name or "").lower()).split()


def team_email(name):
    """Roster email for a greytHR display name: exact match, else unique first+last-name match."""
    t = _toks(name)
    if not t:
        return None
    for n, e in TEAM.items():
        if _toks(n) == t:
            return e
    hits = {e for n, e in TEAM.items() if (nt := _toks(n)) and nt[0] == t[0] and nt[-1] == t[-1]}
    if len(hits) == 1:
        return hits.pop()
    hits = {e for n, e in TEAM.items() if len(t) == 1 and _toks(n) == t}
    return hits.pop() if len(hits) == 1 else None

lock = threading.Lock()
state = {"requests": [], "me": None, "error": None}

# ---------------------------------------------------------------- parsing
DATE = r"(\d{4}-\d{2}-\d{2}|\d{1,2}[\s\-/](?:[A-Za-z]{3,9}|\d{1,2})[\s\-/,]*\d{2,4})"
DATE_FORMATS = ["%Y-%m-%d", "%d %b %Y", "%d %B %Y", "%d-%b-%Y", "%d-%B-%Y", "%d/%m/%Y", "%d-%m-%Y",
                "%d %b, %Y", "%d %B, %Y", "%d/%m/%y", "%d-%b-%y", "%d %b %y"]


def to_date(s):
    s = re.sub(r"\s+", " ", (s or "").strip().rstrip(".,"))
    for f in DATE_FORMATS:
        try:
            return datetime.strptime(s, f).date()
        except ValueError:
            pass
    return None


def first(patterns, text, flags=re.I | re.M):
    for p in patterns:
        m = re.search(p, text, flags)
        if m:
            return m
    return None


def weekdays(a, b):
    return sum(1 for i in range((b - a).days + 1) if (a + timedelta(i)).weekday() < 5) or 1


def parse_leave(subject, body):
    """Pull leave fields out of a greytHR notification. Unknown fields stay None."""
    text = re.sub(r"(?m)^[ \t]*(?:>[ \t]?)+", "", html.unescape(body))  # "> From Date: ..." in quoted replies
    out = {"employee": None, "emp_id": None, "type": None, "from": None, "to": None,
           "days": None, "reason": None, "employee_email": None, "kind": "application"}

    if re.match(r"\s*(re|fwd?)\s*:", subject, re.I):
        out["kind"] = "reply"
        top = re.split(r"(?im)^\s*(?:On .{5,120}wrote|-+\s*Original Message|From:\s)", text)[0].lower()
        out["decision"] = ("rejected" if re.search(r"reject|declin|not (?:be )?approv|can'?t approve|cannot approve|denied", top)
                           else "approved" if re.search(r"approv|accept|granted|\bok(?:ay)?\b|go ahead", top) else None)
    elif re.match(r"\s*your\b", subject, re.I):
        out["kind"] = "own"  # status of the mailbox owner's own leave
    elif re.search(r"\b(approved|rejected)\b", subject, re.I) and not re.search(r"\bapplied\b|application (?:of|from|by)", subject, re.I):
        out["kind"] = re.search(r"\b(approved|rejected)\b", subject, re.I).group(1).lower()
    elif not re.search(r"has applied|has requested|(?:application|request) from", subject + "\n" + text, re.I):
        out["kind"] = "other"  # payslips, min-hours alerts, ...
    elif re.search(r"cancel|withdraw", subject, re.I):
        out["kind"] = "cancelled"

    m = first([r"^\s*(?:Employee(?: Name)?|Applied By|Applicant|Name)\s*[:\-]\s*(.+)$",
               r"^\s*(?:Dear \w+,?\s*)?([A-Z][\w.' ]+?)\s*(?:[(\[][\w\-/]+[)\]])?\s+has (?:applied|requested)"], text)
    m = m or first([r"Leave (?:Application|Request)\w*\s+(?:of|from|by|for)\s+([A-Z][\w.' ]+?)(?:\s*[(\[]|\s+for\b|\s*[-|:.]|$)"], subject)
    if m:
        out["employee"] = re.sub(r"\s*[(\[].*$", "", m.group(1)).strip()
    m = first([r"^\s*Employee (?:No|ID|Code|Number)\.?\s*[:\-]\s*(\S+)", r"[(\[]([A-Z]{1,6}[\-/]?\d{2,})[)\]]"], text + "\n" + subject)
    if m:
        out["emp_id"] = m.group(1)
    m = first([r"^\s*Leave Type\s*[:\-]\s*(.+)$", r"applied for (?:an? )?([\w ]*?Leave)\b", r"\b((?:Casual|Sick|Earned|Privilege|Maternity|Paternity|Comp[\w\- ]*|Optional|Restricted)\s+(?:Leave|Holiday|Off))\b"], text + "\n" + subject)
    if m:
        out["type"] = m.group(1).strip().title()
    if re.search(r"permission request", subject + "\n" + text, re.I):
        # column table: Attendance Date / Permission Type / Applied / Reason / From / To, then values per row
        ds = [to_date(d) for d in re.findall(r"^\s*(\d{1,2}-[A-Za-z]{3}-\d{4})\s*$", text, re.M)]
        ds = sorted(d for d in ds if d)
        pt = first([r"^\s*(Regularization|On Duty|Short Leave|Permission|Late Coming|Early Going)\s*$"], text)
        ls, stamp = [l.strip() for l in text.splitlines()], re.compile(r"\d{1,2}-[A-Za-z]{3}-\d{4}")
        rs = [ls[i + 1] for i in range(len(ls) - 1) if re.fullmatch(r"\d{1,2}-[A-Za-z]{3}-\d{4} \d{1,2}:\d{2}", ls[i])
              and not stamp.match(ls[i + 1]) and ls[i + 1] not in ("-", "Employee Remarks")]  # line after the "to" time = reason
        out.update(type="Permission · " + (pt.group(1).title() if pt else "Request"), days=float(len(set(ds))) or None,
                   reason="; ".join(dict.fromkeys(rs)) or None)
        if ds:
            out["from"], out["to"] = ds[0], ds[-1]
        out["employee_email"] = team_email(out["employee"])
        for k in ("from", "to"):
            out[k] = out[k].isoformat() if out[k] else None
        return out
    m = first([r"from\s+" + DATE + r"\s+(?:to|till|until|-)\s+" + DATE], text)
    if m:
        out["from"], out["to"] = to_date(m.group(1)), to_date(m.group(2))
    if not out["from"]:
        m = first([r"^\s*(?:From|Start)(?: Date)?\s*[:\-]?\s*" + DATE, r"^\s*(?:Leave )?Date\s*[:\-]?\s*" + DATE], text)
        out["from"] = m and to_date(m.group(1))
        m = first([r"^\s*(?:To|End|Till)(?: Date)?\s*[:\-]?\s*" + DATE], text)
        out["to"] = (m and to_date(m.group(1))) or out["from"]
    m = first([r"(?:No\.? of days|Number of days|Total days|Days|Duration)\s*[:\-]?\s*(\d+(?:\.\d+)?)", r"\((\d+(?:\.\d+)?)\s*days?\)"], text)
    if m:
        out["days"] = float(m.group(1))
    elif out["from"] and out["to"]:
        out["days"] = float(weekdays(out["from"], out["to"]))
    m = first([r"^\s*(?:Reason|Remarks?|Comments?)\s*[:\-]\s*(.+)$"], text)
    if m:
        out["reason"] = m.group(1).strip()
    emails = [e for e in re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+", text) if not NOREPLY.search(e)]
    out["employee_email"] = team_email(out["employee"]) or (emails[0] if emails else None)
    for k in ("from", "to"):
        out[k] = out[k].isoformat() if out[k] else None
    return out


def html_to_text(h):
    h = re.sub(r"(?is)<(script|style).*?</\1>", "", h)
    h = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h\d)>", "\n", h)
    h = re.sub(r"(?i)</t[dh]>", " : ", h)  # table cells "Leave Type | Casual" -> "Leave Type : Casual"
    t = html.unescape(re.sub(r"<[^>]+>", "", h))
    lines = [re.sub(r"[ \t\xa0]+", " ", l).strip(" :") for l in t.splitlines()]
    return "\n".join(l for l in lines if l)


ANCHOR = re.compile(r'(?is)<a\b[^>]*?href=(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))[^>]*>(.*?)</a>')  # greytHR uses unquoted href=


def anchors_only(h):
    return "".join(m.group(0) for m in ANCHOR.finditer(h or ""))


def action_links(h):
    links = {}
    for m in ANCHOR.finditer(h or ""):
        href = html.unescape(m.group(1) or m.group(2) or m.group(3) or "")
        label = re.sub(r"<[^>]+>", "", m.group(4)).strip().lower()
        if not href.lower().startswith("http"):
            continue
        for key in ("approve", "reject"):
            if re.fullmatch(r"\W*" + key + r"\w*\W*", label) and key not in links:
                links[key] = href
        if "open" not in links and ("click here" in label or "review" in label or "greythr" in href.lower()) and not re.search(r"approve|reject", label):
            links["open"] = href  # greytHR "Click here to approve/reject" (tracked redirect)
    return links


# ---------------------------------------------------------------- gmail
_svc = None


def gmail():
    global _svc
    if _svc:
        return _svc
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build
    creds = Credentials.from_authorized_user_file(TOKEN, SCOPES) if os.path.exists(TOKEN) else None
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            creds = InstalledAppFlow.from_client_secrets_file(CREDENTIALS, SCOPES).run_local_server(port=0)
        with open(TOKEN, "w") as f:
            f.write(creds.to_json())
    _svc = build("gmail", "v1", credentials=creds, cache_discovery=False)
    return _svc


def walk(part, acc):
    mt, data = part.get("mimeType", ""), part.get("body", {}).get("data")
    if data and mt in ("text/plain", "text/html"):
        acc.setdefault(mt, base64.urlsafe_b64decode(data).decode("utf-8", "replace"))
    for p in part.get("parts", []) or []:
        walk(p, acc)
    return acc


def call(req, resend=True):
    """execute() with backoff on Gmail per-minute quota / rate errors."""
    from googleapiclient.errors import HttpError
    for n in range(7):
        try:
            return req.execute()
        except (OSError, http.client.HTTPException):  # Google dropped an idle keep-alive connection; a retry reconnects
            if n >= 3 or not resend:  # never re-send mail: Google may have accepted it before the drop
                raise
            time.sleep(1 + n)
        except HttpError as e:
            if e.resp.status in (403, 429) and re.search(r"quota|rate", str(e), re.I) and n < 6:
                time.sleep(min(60, 4 * 2 ** n))
                continue
            raise


def fetch_gmail():
    svc = gmail()
    try:
        with open(CACHE) as f:
            cache = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        cache = {}
    ids, token = [], None
    while len(ids) < MAX_MSGS:
        r = call(svc.users().messages().list(userId="me", q=QUERY, maxResults=500, pageToken=token))
        ids += [m["id"] for m in r.get("messages", [])]
        token = r.get("nextPageToken")
        if not token:
            break
    new = [i for i in ids[:MAX_MSGS] if cache.get(i, {}).get("v") != 2]
    for n, mid in enumerate(new, 1):
        m = call(svc.users().messages().get(userId="me", id=mid, format="full"))
        hdr = {h["name"].lower(): h["value"] for h in m["payload"].get("headers", [])}
        parts = walk(m["payload"], {})
        raw_html = parts.get("text/html", "")
        body = parts.get("text/plain") or html_to_text(raw_html)
        if raw_html and len(html_to_text(raw_html)) > len(body):  # plain part is often a stub
            body = html_to_text(raw_html)
        cache[mid] = {"v": 2, "thread": m["threadId"], "body": body, "anchors": anchors_only(raw_html), "ts": int(m["internalDate"]) // 1000,
                      "unread": "UNREAD" in m.get("labelIds", []), "hdr": {k: hdr.get(k, "") for k in ("subject", "from", "message-id")}}
        if n % 50 == 0 or n == len(new):  # keep progress if interrupted
            with open(CACHE + ".tmp", "w") as f:
                json.dump(cache, f)
            os.replace(CACHE + ".tmp", CACHE)
    return [build_request(i, c["thread"], c["hdr"], c["body"], action_links(c["anchors"]), c["ts"], c["unread"])
            for i in ids[:MAX_MSGS] if (c := cache.get(i)) and c.get("v") == 2]  # ponytail: cached unread flag goes stale; fine for display


def build_request(mid, thread, hdr, body, links, ts, unread):
    subject = hdr.get("subject", "")
    return {"id": mid, "thread": thread, "subject": subject, "sender": hdr.get("from", ""), "sender_name": re.sub(r"\s*<.*", "", hdr.get("from", "")).strip('" ') or hdr.get("from", ""),
            "message_id": hdr.get("message-id"), "ts": ts, "received": datetime.fromtimestamp(ts).isoformat(timespec="minutes"),
            "body": body.strip()[:6000], "links": links, "unread": unread, **parse_leave(subject, body)}


def label_id(svc, name):
    for l in call(svc.users().labels().list(userId="me")).get("labels", []):
        if l["name"] == name:
            return l["id"]
    return call(svc.users().labels().create(userId="me", body={"name": name}))["id"]


def reply_text(req, decision, comment):
    first_name = (req.get("employee") or "").split(" ")[0].title() or "there"
    return (comment or ("Approved." if decision == "approved" else "Rejected.")).replace("{name}", first_name)


def signature(svc):
    """Default send-as Gmail signature (HTML), fetched once."""
    if state.get("sig") is None:
        acc = next((a for a in call(svc.users().settings().sendAs().list(userId="me")).get("sendAs", []) if a.get("isDefault")), {})
        state["sig"] = acc.get("signature", "")
    return state["sig"]


def send_reply(req, decision, comment, to):
    svc = gmail()
    text, sig = reply_text(req, decision, comment), signature(svc)
    msg = MIMEMultipart("alternative")
    sig_text = html.unescape(re.sub(r"<[^>]+>", "", re.sub(r"<(?:br|/div|/p|/tr)[^>]*>", "\n", sig)))
    sig_text = re.sub(r"\n\s*\n+", "\n", sig_text).strip()
    msg.attach(MIMEText(text + ("\n\n-- \n" + sig_text if sig else "") + "\n"))
    msg.attach(MIMEText(f'<div dir="ltr">{html.escape(text).replace(chr(10), "<br>")}</div>'
                        + (f'<br><div class="gmail_signature">{sig}</div>' if sig else ""), "html"))
    msg["To"] = to
    cc = [e for e in CC if e.lower() != to.lower()]
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = req["subject"] if req["subject"].lower().startswith("re:") else "Re: " + req["subject"]
    if req.get("message_id"):
        msg["In-Reply-To"] = msg["References"] = req["message_id"]
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    call(svc.users().messages().send(userId="me", body={"raw": raw, "threadId": req["thread"]}), resend=False)


def apply_label(req, decision):
    svc = gmail()
    lid = label_id(svc, "Leave/" + decision.title())
    call(svc.users().messages().modify(userId="me", id=req["id"], body={"addLabelIds": [lid], "removeLabelIds": ["UNREAD"]}))


# ---------------------------------------------------------------- demo data
def demo_requests():
    rnd = random.Random(7)
    names = list(TEAM)[:14] or ["Priya Nair", "Arjun Mehta", "Sara Khan", "Vikram Rao", "Neha Gupta", "Dev Patel"]
    people = [(n.title(), f"EMP{100 + i}") for i, n in enumerate(names)] + [("Rahul Verma", "EMP900")]  # last one is not in team.json
    types = ["Casual Leave"] * 5 + ["Sick Leave"] * 3 + ["Earned Leave"] * 3 + ["Comp Off", "Work From Home"]
    reasons = ["Family function in hometown", "Fever and doctor visit", "Personal work", "Planned vacation",
               "Child's school event", "Moving to a new flat", "Medical appointment", "Wedding in family", "Festival travel"]
    today, out = date.today(), []
    for i in range(46):
        name, eid = rnd.choice(people)
        applied = datetime.combine(today - timedelta(days=rnd.randint(0, 84)), datetime.min.time()) + timedelta(hours=rnd.randint(8, 20), minutes=rnd.randint(0, 59))
        applied = min(applied, datetime.now() - timedelta(minutes=rnd.randint(5, 300)))
        start = applied.date() + timedelta(days=rnd.randint(1, 21))
        while start.weekday() > 4:
            start += timedelta(1)
        end = start + timedelta(days=rnd.choice([0, 0, 0, 1, 1, 2, 4]))
        lt, reason = rnd.choice(types), rnd.choice(reasons)
        body = (f"Hi,\n\n{name} ({eid}) has applied for {lt} from {start:%d %b %Y} to {end:%d %b %Y}.\n\n"
                f"Employee Name: {name}\nEmployee No: {eid}\nLeave Type: {lt}\nFrom Date: {start:%d %b %Y}\n"
                f"To Date: {end:%d %b %Y}\nNo. of days: {weekdays(start, end)}\nReason: {reason}\n"
                "Reply-to: noreply@greythr.com\n\n"
                "Please review the request on greytHR.\n\n-- greytHR Notification")
        links = {"open": f"https://example.greythr.com/v2/workflow/{1000+i}"}
        r = build_request(f"demo{i:03d}", f"t{i:03d}", {"subject": f"Leave Application of {name} ({eid})", "from": "greytHR <noreply@greythr.com>",
                          "message-id": f"<demo{i}@greythr.com>"}, body, links, int(applied.timestamp()), applied.date() > today - timedelta(days=10))
        if applied.date() < today - timedelta(days=12):  # older ones were already decided in greytHR
            r["decision_hint"], r["decided_by"] = rnd.choice(["approved"] * 5 + ["rejected"]), rnd.choice(["Team Lead", "greytHR"])
        out.append(r)
    return out


# ---------------------------------------------------------------- state
def load_decisions():
    try:
        with open(DECISIONS) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_decisions(d):
    tmp = DECISIONS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2)
    os.replace(tmp, DECISIONS)


def refresh():
    with lock:
        try:
            if not DEMO and not state["me"]:
                state["me"] = call(gmail().users().getProfile(userId="me"))["emailAddress"]
            msgs = demo_requests() if DEMO else fetch_gmail()
            state["error"] = None
        except Exception as e:  # surface to UI (expired token, API disabled, offline)
            state["error"] = f"{type(e).__name__}: {e}"
            return
        me = (state["me"] or "").lower()
        key = lambda m: (m["employee"], m["from"])
        apps = {}
        for m in sorted(msgs, key=lambda m: m["ts"]):
            if m["kind"] == "application" and m["employee"]:
                apps[key(m) + (m["to"], m["type"])] = m  # greytHR re-sends -> keep latest
        app_keys = {key(a) for a in apps.values()}
        by_thread = {}
        for a in apps.values():
            by_thread.setdefault(a["thread"], set()).add(key(a))
        settled = {}  # (employee, from) -> (decision, by, at); later mail wins
        for m in sorted(msgs, key=lambda m: m["ts"]):
            by = "you" if me and me in m["sender"].lower() else m["sender_name"]
            if m["kind"] == "reply" and m.get("decision"):
                t = by_thread.get(m["thread"], set())
                k = key(m) if key(m) in app_keys else (next(iter(t)) if len(t) == 1 else None)
                if k:
                    settled[k] = (m["decision"], by, m["received"])
            elif m["kind"] in ("approved", "rejected", "cancelled"):
                settled[key(m)] = (m["kind"], "greytHR", m["received"])
        dec = load_decisions()
        apps = list(apps.values())
        for a in apps:
            d, st = dec.get(a["id"]), settled.get(key(a))
            if d:
                a.update(status=d["decision"], decided_at=d["at"], decided_by="you (dashboard)", comment=d.get("comment", ""))
            elif st:
                a.update(status=st[0], decided_by=st[1], decided_at=st[2], comment="")
            else:
                # ponytail: no reply + applied >14d ago + leave already over => "stale" (likely handled inside greytHR)
                old = a["received"][:10] < (date.today() - timedelta(days=14)).isoformat() and (a["to"] or a["from"] or "") < date.today().isoformat()
                a.update(status=a.get("decision_hint") or ("stale" if old and not DEMO else "pending"), decided_at=None, decided_by=None, comment="")
        state["requests"] = sorted(apps, key=lambda r: r["received"], reverse=True)


def decide(ids, decision, comment, reply, to_override, comments=None):
    results = []
    with lock:
        dec = load_decisions()
        by_id = {r["id"]: r for r in state["requests"]}
        for i in ids:
            r = by_id.get(i)
            if not r:
                results.append({"id": i, "ok": False, "error": "unknown request"})
                continue
            to = (to_override or r.get("employee_email") or "").strip()
            if reply and (not re.fullmatch(r"[^@\s,]+@[^@\s,]+\.[^@\s,]+", to) or NOREPLY.search(to)):
                results.append({"id": i, "ok": False, "error": f"{r.get('employee') or i}: no employee email (not in team.json) — set To"})
                continue
            raw = (comments or {}).get(i) or comment  # per-request text (type-specific) from the dashboard
            comment_i = reply_text(r, decision, raw)
            sent = False
            try:
                if not DEMO:
                    if reply:
                        send_reply(r, decision, raw, to)
                        sent = True
                    apply_label(r, decision)
            except Exception as e:
                results.append({"id": i, "ok": False, "error": f"{type(e).__name__}: {e}"})
                continue
            at = datetime.now().isoformat(timespec="minutes")
            dec[i] = {"decision": decision, "comment": comment_i, "at": at, "replied_to": to if (reply and (sent or DEMO)) else None}
            r.update(status=decision, decided_at=at, decided_by="you (dashboard)", comment=comment_i, unread=False)
            results.append({"id": i, "ok": True, "replied_to": dec[i]["replied_to"], "comment": comment_i, "demo": DEMO})
        save_decisions(dec)
    return results


# ---------------------------------------------------------------- http
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=STATIC, **k)

    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/api/requests"):
            return self.send_json({"requests": state["requests"], "demo": DEMO, "team": TEAM, "me": state["me"], "error": state["error"], "query": QUERY, "cc": ", ".join(CC)})
        return super().do_GET()

    def do_POST(self):
        # only accept same-origin JSON so other sites can't trigger approvals
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.send_json({"error": "json only"}, 415)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except json.JSONDecodeError:
            return self.send_json({"error": "bad json"}, 400)
        if self.path == "/api/refresh":
            refresh()
            return self.send_json({"ok": state["error"] is None, "error": state["error"], "count": len(state["requests"])})
        if self.path == "/api/decide":
            d = body.get("decision")
            if d not in ("approved", "rejected") or not isinstance(body.get("ids"), list):
                return self.send_json({"error": "decision must be approved|rejected and ids a list"}, 400)
            cm = body.get("comments") if isinstance(body.get("comments"), dict) else {}
            cm = {str(k): str(v)[:4000] for k, v in cm.items()}
            return self.send_json({"results": decide(body["ids"], d, str(body.get("comment", ""))[:4000], bool(body.get("reply")), body.get("to") or None, cm)})
        self.send_json({"error": "not found"}, 404)


def setup():
    """Interactive first-run wizard: credentials.json → team.json → config.json → Gmail login."""
    ask = lambda q, d="": input(f"{q}{f' [{d}]' if d else ''}: ").strip() or d
    print("\nLeave Desk setup\n================\n")
    print("1) Google OAuth client")
    while not os.path.exists(CREDENTIALS):
        print("""   credentials.json not found. Create one (free, ~3 min):
     a. https://console.cloud.google.com/projectcreate  → create a project
     b. https://console.cloud.google.com/apis/library/gmail.googleapis.com → Enable
     c. https://console.cloud.google.com/auth/branding → fill app name + your email
        (Audience: Internal if you use Google Workspace, else External and add yourself as a test user)
     d. https://console.cloud.google.com/auth/clients → Create client → Application type: Desktop app
     e. Download JSON, save it as:\n        """ + CREDENTIALS)
        input("   Press Enter once the file is there… ")
    print("   ✓ credentials.json found\n")

    print("2) Team roster (replies go to these addresses, never to greytHR's no-reply)")
    if TEAM and ask(f"   team.json has {len(TEAM)} people. Keep it? (y/n)", "y").lower().startswith("y"):
        team = TEAM
    else:
        print("   Paste one person per line as  Full Name, email  (exactly as the name appears in greytHR).")
        print("   Blank line to finish. You can edit team.json later.")
        team = {}
        while (line := input("   > ").strip()):
            name, _, email = line.rpartition(",")
            if name.strip() and re.fullmatch(r"[^@\s,]+@[^@\s,]+\.[^@\s,]+", email.strip()):
                team[name.strip()] = email.strip()
            else:
                print("     skipped, expected: Full Name, name@company.com")
    with open(TEAM_FILE, "w") as f:
        json.dump(team, f, indent=2)
    print(f"   ✓ team.json · {len(team)} people\n")

    print("3) Reply settings")
    cc = ask("   CC on every reply (comma-separated emails, blank for none)", ", ".join(CONFIG.get("cc", [])))
    query = ask("   Gmail search for leave mails", CONFIG.get("query", DEFAULT_QUERY))
    port = ask("   Port", str(CONFIG.get("port", 8765)))
    with open(CONFIG_FILE, "w") as f:
        json.dump({"cc": [e.strip() for e in cc.split(",") if e.strip()], "query": query, "port": int(port)}, f, indent=2)
    print("   ✓ config.json\n")

    print("4) Gmail login: a browser window opens. Pick the mailbox that receives greytHR approval mails.")
    print("   (Unverified-app warning on an External app: Advanced → Go to <app> (unsafe). It's your own client.)")
    gmail()
    print(f"   ✓ connected · token saved to {TOKEN}\n\nDone. Start the dashboard with:  python server.py\n")


def selftest():
    global TEAM
    TEAM = {"Nishant Dubey": "nishant.dubey@acme.com", "Aditya Kumar Jha": "aditya.jha@acme.com", "Aditya Singh": "aditya.singh@acme.com",
            "Divya": "divya@acme.com", "Kabir Das": "kabir.das@acme.com", "Rohan Tiwari": "rohan.tiwari@acme.com", "Meera Shah": "meera.shah@acme.com"}
    p = parse_leave("Leave Application of Priya Nair (EMP117)",
                    "Priya Nair (EMP117) has applied for Sick Leave from 12 Nov 2026 to 13 Nov 2026.\nReason: Fever\nContact: priya.n@acme.com")
    assert p["employee"] == "Priya Nair" and p["emp_id"] == "EMP117" and p["type"] == "Sick Leave", p
    assert (p["from"], p["to"], p["days"], p["reason"]) == ("2026-11-12", "2026-11-13", 2.0, "Fever"), p
    assert p["employee_email"] == "priya.n@acme.com" and p["kind"] == "application"
    assert team_email("Nishant Dubey") == "nishant.dubey@acme.com" and team_email("ADITYA KUMAR JHA") == "aditya.jha@acme.com"
    assert team_email("Aditya") is None and team_email("Divya") == "divya@acme.com"  # two Adityas -> ambiguous
    k = parse_leave("Leave Application of Kabir Das (ETH3)", "Kabir Das has applied for Casual Leave from 1 Dec 2026 to 1 Dec 2026\nFrom: noreply@greythr.com")
    assert k["employee_email"] == "kabir.das@acme.com", k
    assert reply_text({"employee": "Sana Mirza"}, "approved", "Hi {name}, approved.") == "Hi Sana, approved."
    g = parse_leave("Leave Application from Rohan Tiwari [GRP1258].", "Hi,\nRohan Tiwari [GRP1258] has applied for a leave.\nFollowing are the applied leave details\n"
                    "Leave type: Sick Leave\nFrom Date: 12 Nov 2026\nTo Date: 13 Nov 2026\nNumber of days: 1.5\nReason: Diwali at home\nLeave Balance: 6.54\nFrom Session: Session1")
    assert (g["kind"], g["employee"], g["emp_id"], g["type"], g["from"], g["to"], g["days"], g["reason"], g["employee_email"]) == \
        ("application", "Rohan Tiwari", "GRP1258", "Sick Leave", "2026-11-12", "2026-11-13", 1.5, "Diwali at home", "rohan.tiwari@acme.com"), g
    h = parse_leave("Restricted Holiday Leave Application from Meera Shah [GRTP1059]", "Hi,\nMeera Shah [GRTP1059] has applied for a restricted leave. Please log on to https://acme.greythr.com/ and review.\n"
                    "Details are as follows\nLeave balance: 1.0\nEmployee: Meera Shah [GRTP1059]\nLeave type: Restricted Holiday\nDate: 11 Nov 2026\nRemarks: Leave Posted for Restricted Holiday")
    assert (h["employee"], h["emp_id"], h["type"], h["from"], h["to"], h["days"], h["employee_email"]) == \
        ("Meera Shah", "GRTP1059", "Restricted Holiday", "2026-11-11", "2026-11-11", 1.0, "meera.shah@acme.com"), h
    rp = parse_leave("Re: Leave Application from Kabir Das [GRP1102].", "Approved\nOn Mon, Nov 9, 2026 at 2:54 PM <no-reply@greythr.com> wrote\nHi,\n"
                     "Kabir Das [GRP1102] has applied for a leave.\nLeave type: Sick Leave\nFrom Date: 09 Nov 2026\nTo Date: 09 Nov 2026")
    assert (rp["kind"], rp["decision"], rp["employee"], rp["from"]) == ("reply", "approved", "Kabir Das", "2026-11-09"), rp
    assert parse_leave("Re: Leave Application from X [G1].", "Sorry, can't approve this week\nOn Mon wrote")["decision"] == "rejected"
    assert parse_leave("Your Leave Application has been Accepted.", "")["kind"] == "own"
    assert action_links('<a target="_blank" href=https://t.awstrack.me/L0/x%2Fgreythr.com>Click here</a>') == {"open": "https://t.awstrack.me/L0/x%2Fgreythr.com"}
    q = parse_leave("Re: Leave Application from Kabir Das [GRP1102].", "Approved\n\n> Hi,\n> Kabir Das [GRP1102] has applied for a leave.\n> From Date: 09 Nov 2026\n> To Date: 09 Nov 2026")
    assert (q["decision"], q["employee"], q["from"]) == ("approved", "Kabir Das", "2026-11-09"), q
    pr = parse_leave("Permission Request from Meera Shah[GRTP1059]", "Hi, Ravi Menon\nMeera Shah [GRTP1059] has applied for permission request. Here are the details\n"
                     "Attendance Date\nPermission Type\nPermissions Applied\nReason\nFrom Date\nTo Date\n04-Nov-2026\nRegularization\n04-Nov-2026 10:00\n04-Nov-2026 19:00\n"
                     "Forgot to clock out\n05-Nov-2026\nRegularization\n05-Nov-2026 10:00\n05-Nov-2026 19:00\nForgot to clock out\nEmployee Remarks\n-")
    assert (pr["employee"], pr["type"], pr["from"], pr["to"], pr["days"], pr["reason"], pr["employee_email"]) == \
        ("Meera Shah", "Permission · Regularization", "2026-11-04", "2026-11-05", 2.0, "Forgot to clock out", "meera.shah@acme.com"), pr
    assert parse_leave("Payslip Released", "Your payslip for October is released")["kind"] == "other"
    assert action_links('<a href="mailto:no-reply@greythr.com">x</a><a href="https://t.awstrack.me/L0/https:%2F%2Facme.greythr.com">Click here</a>') == {"open": "https://t.awstrack.me/L0/https:%2F%2Facme.greythr.com"}
    t = html_to_text("<table><tr><td>Employee Name</td><td>Rahul K</td></tr><tr><td>Leave Type</td><td>Casual Leave</td></tr>"
                     "<tr><td>From Date</td><td>03-Dec-2026</td></tr><tr><td>To Date</td><td>05-Dec-2026</td></tr>"
                     "<tr><td>No. of Days</td><td>3</td></tr></table>")
    q = parse_leave("Leave request", t)
    assert (q["employee"], q["type"], q["from"], q["to"], q["days"]) == ("Rahul K", "Casual Leave", "2026-12-03", "2026-12-05", 3.0), (t, q)
    assert parse_leave("Leave of Sana Mirza has been approved", "")["kind"] == "approved"
    assert {k: v for k, v in action_links('<a href="https://x.greythr.com/a?x=1&amp;y=2"><b>Approve</b></a><a href="https://x.greythr.com/r">Reject</a>').items() if k != "open"} == \
        {"approve": "https://x.greythr.com/a?x=1&y=2", "reject": "https://x.greythr.com/r"}
    assert weekdays(date(2026, 11, 13), date(2026, 11, 16)) == 2  # Fri..Mon
    assert all(r["employee"] and r["from"] and r["days"] for r in demo_requests())
    print("selftest ok")


if __name__ == "__main__":
    if SETUP:
        setup()
        sys.exit()
    if "--selftest" in sys.argv:
        selftest()
        sys.exit()
    if "--connect" in sys.argv:
        gmail()
        print("Gmail connected, token saved to", TOKEN)
    refresh()
    print(f"{'DEMO' if DEMO else 'GMAIL'} mode · {len(state['requests'])} requests · error={state['error']}")
    print(f"Open http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
