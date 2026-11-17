// Leave Desk — vanilla JS, Chart.js for graphs. All email-derived text goes through esc().
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => /^https?:\/\//i.test(u || "") ? u : null;
const PAGE = 12;
// Reply templates per request kind. {name} first name · {type} leave type · {dates} "12 Nov" / "11–13 Nov".
// [[future text|past text]] picks by whether the dates have already passed (past replies also start with an apology).
const TEMPLATES = {
  wfh: {
    approved: ["Hi {name},\n\nYour work from home for {dates} is approved.[[ Please stay available on chat and calls during working hours.|]]\n\nRegards",
      "Hi {name},\n\nWFH approved for {dates}.[[ Please keep your status updated and join the stand-ups as usual.|]]\n\nRegards",
      "Hi {name},\n\nWFH approved for {dates}. [[Take care, and take it easy if you're unwell.|Hope you're feeling better now.]]\n\nRegards"],
    rejected: ["Hi {name},\n\nSorry, I can't approve WFH for {dates}, as [[I need you in the office for team work then.|it wasn't agreed in advance and I needed you in the office then.]]\n\nRegards",
      "Hi {name},\n\nI can't approve WFH for {dates}. If you were unwell, please apply for sick leave instead.\n\nRegards"],
  },
  permission: {
    approved: ["Hi {name},\n\nYour attendance regularization for {dates} is approved.\n\nRegards",
      "Hi {name},\n\nApproved your regularization for {dates}. Please remember to clock in and out every day.\n\nRegards"],
    rejected: ["Hi {name},\n\nI can't approve the regularization for {dates}, as I couldn't confirm your working hours. Please share the details and re-apply.\n\nRegards",
      "Hi {name},\n\nThe regularization for {dates} doesn't match our records. Let's discuss it before you re-apply.\n\nRegards"],
  },
  sick: {
    approved: ["Hi {name},\n\nYour sick leave for {dates} is approved. [[Take rest and get well soon!|Hope you're feeling better now.]]\n\nRegards",
      "Hi {name},\n\nSick leave approved for {dates}. [[Take care of your health, and let me know if you need more time off.|Hope you're doing better — take care.]]\n\nRegards"],
    rejected: ["Hi {name},\n\nI can't approve this as sick leave for {dates}. Please re-apply under the correct leave type, or let's talk.\n\nRegards",
      "Hi {name},\n\nYour sick leave balance doesn't cover {dates}. Please re-apply under a different leave type.\n\nRegards"],
  },
  menstrual: {
    approved: ["Hi {name},\n\nYour menstrual leave for {dates} is approved. [[Take care and rest well.|Hope you're feeling better.]]\n\nRegards",
      "Hi {name},\n\nApproved for {dates}. Take care, and reach out if you need anything.\n\nRegards"],
    rejected: ["Hi {name},\n\nI can't approve this request for {dates} as applied. Please check the leave type and dates and re-apply, or let's talk.\n\nRegards"],
  },
  bereavement: {
    approved: ["Hi {name},\n\nI'm very sorry for your loss. Your bereavement leave for {dates} is approved. Take the time you need and don't worry about work.\n\nRegards",
      "Hi {name},\n\nMy condolences to you and your family. Your leave for {dates} is approved — let me know if you need more days.\n\nRegards"],
    rejected: ["Hi {name},\n\nI'm sorry for your loss. I couldn't approve this request as applied for {dates} — please check the dates and leave type and re-apply, and reach out to me directly if you need any support.\n\nRegards"],
  },
  restricted: {
    approved: ["Hi {name},\n\nYour restricted holiday for {dates} is approved.[[ Happy celebrations!| Hope you had a great celebration!]]\n\nRegards",
      "Hi {name},\n\nApproved your restricted holiday for {dates}.[[ Enjoy the festival with your family!|]]\n\nRegards"],
    rejected: ["Hi {name},\n\nSorry, I can't approve the restricted holiday for {dates} because of team coverage. [[Could you pick another restricted holiday?|Please choose another restricted holiday next time and let me know in advance.]]\n\nRegards",
      "Hi {name},\n\nThe restricted holiday for {dates} can't be approved. Please check your restricted holiday balance and re-apply.\n\nRegards"],
  },
  leave: {
    approved: ["Hi {name},\n\nYour {type} for {dates} is approved.[[ Enjoy your time off!|]]\n\nRegards",
      "Hi {name},\n\nApproved your {type} for {dates}.[[ Please hand over any pending work and set an out-of-office before you leave.|]]\n\nRegards"],
    rejected: ["Hi {name},\n\nSorry, I can't approve your {type} for {dates} [[as we have critical deliverables then. Can we look at other dates?|as it wasn't planned with the team in advance. Let's talk about it.]]\n\nRegards",
      "Hi {name},\n\nI'm unable to approve your {type} for {dates} due to team coverage. [[Please pick alternate dates and re-apply.|Please speak to me about it.]]\n\nRegards"],
  },
};
const kindOf = r => { const t = (r.type || "").toLowerCase();
  return /work from home|wfh/.test(t) ? "wfh" : /^permission/.test(t) ? "permission" : /sick/.test(t) ? "sick" : /menstrual/.test(t) ? "menstrual"
    : /bereavement/.test(t) ? "bereavement" : /restricted/.test(t) ? "restricted" : "leave"; };
const KIND_LABEL = { wfh: "WFH", permission: "regularization", sick: "sick leave", menstrual: "menstrual leave", bereavement: "bereavement leave", restricted: "restricted holiday", leave: "leave" };
function dateText(r) {
  if (!r.from) return "the requested dates";
  const a = new Date(r.from + "T00:00"), b = new Date((r.to || r.from) + "T00:00"), mon = d => d.toLocaleDateString("en-GB", { month: "short" });
  if (+a === +b) return `${a.getDate()} ${mon(a)}`;
  return a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear() ? `${a.getDate()}–${b.getDate()} ${mon(a)}` : `${a.getDate()} ${mon(a)} – ${b.getDate()} ${mon(b)}`;
}
// "Mohd Rafey" → Rafey, "Kumari Anjali" → Anjali: skip abbreviations/honorifics people aren't called by
function firstName(full) {
  const parts = (full || "").trim().split(/\s+/).filter(Boolean);
  const skip = /^(mohd|md|mohd\.|md\.|mohammad|mohammed|muhammad|kumari|km|smt|shri|sri|mr|mrs|ms|dr)\.?$/i;
  const p = parts.length > 1 && skip.test(parts[0]) ? parts[1] : parts[0] || "there";
  return p[0].toUpperCase() + p.slice(1).toLowerCase();
}
const isPast = r => (r.to || r.from || "9") < iso(new Date());
const fillPlaceholders = (t, r) => t.replaceAll("{name}", firstName(r.employee)).replaceAll("{type}", (r.type || "leave").toLowerCase())
  .replaceAll("{dates}", dateText(r)).replaceAll("{days}", r.days ?? "");
function fillTemplate(t, r) {  // built-in template → exact email text (past/future wording + one apology if late)
  const past = isPast(r);
  let out = fillPlaceholders(t.replace(/\[\[(.*?)(?:\|(.*?))?\]\]/gs, (_, fut, pst) => past ? (pst || "") : fut), r);
  if (past) {  // one apology, worded to fit: after condolences, merged into a leading "Sorry,", else in front
    const head = /^(Hi [^\n]*\n\n)/;
    if (/^Hi [^\n]*\n\n(I'm (very )?sorry for your loss|My condolences)/.test(out)) out = out.replace(/^(Hi [^\n]*\n\n[^.]*\.) /, "$1 Apologies for the late reply. ");
    else if (/^Hi [^\n]*\n\nSorry, /.test(out)) out = out.replace(/^(Hi [^\n]*\n\n)Sorry, /, "$1Sorry for the late reply — ");
    else out = out.replace(head, "$1Sorry for the late reply. ");
  }
  return out.replace(/[ \t]+\n/g, "\n");
}
const suggest = (r, decision) => {  // best default template index for this request
  const k = kindOf(r);
  if (k === "wfh" && decision === "approved" && /unwell|not feeling|fever|cold|sick|headache|health|ill\b/i.test(r.reason || "")) return 2;
  return 0;
};

const busy = new Set();  // ids being sent right now — blocks double submits
let current = [], current_tpls = [];  // rows / templates in the open decision dialog
let all = [], demo = false, me = "", sort = { k: "received", dir: -1 }, page = 0, focus = 0, selected = new Set(), charts = {};
const f = { status: "all", type: "", q: "", from: "", to: "", employee: "", day: "", week: "" };

const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const iso = d => { const z = new Date(d); z.setMinutes(z.getMinutes() - z.getTimezoneOffset()); return z.toISOString().slice(0, 10); };
const fmt = s => s ? new Date(s + (s.length === 10 ? "T00:00" : "")).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "—";
const ago = s => { const m = (Date.now() - new Date(s)) / 6e4; return m < 1 ? "just now" : m < 60 ? `${m | 0}m ago` : m < 1440 ? `${m / 60 | 0}h ago` : `${m / 1440 | 0}d ago`; };
const hue = s => [...(s || "?")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const initials = s => (s || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
const weekStart = s => { const d = new Date(s); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return iso(d); };
const covers = (r, day) => r.from && r.from <= day && (r.to || r.from) >= day;
const statusColor = s => css(`--${s}`) || css("--muted");
const isOpen = r => r.status === "pending" || r.status === "stale";  // stale = old request nobody answered by email
const LABEL = { stale: "No reply" };
const isWfh = r => /work from home|wfh/i.test(r.type || "");
const isOff = r => !isWfh(r) && !/^permission/i.test(r.type || "");  // WFH / attendance permissions are not time off

function toast(msg, err) {
  const t = document.createElement("div"); t.className = "toast" + (err ? " err" : ""); t.textContent = msg;
  $("#toasts").append(t); setTimeout(() => t.remove(), err ? 6000 : 3200);
}

async function api(path, body) {
  let r;
  try { r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}); }
  catch { throw new Error("can't reach the dashboard server — is server.py still running?"); }
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

let loaded = false;
async function load(sync, quiet) {
  $("#refresh").disabled = true;
  try {
    if (sync) { const s = await api("/api/refresh", {}); if (!s.ok) toast("Sync failed: " + s.error, true); else if (!quiet) toast(`Synced · ${s.count} requests`); }
    const d = await api("/api/requests");
    all = d.requests; demo = d.demo; me = d.me || "";
    $("#teamList").innerHTML = Object.entries(d.team || {}).map(([n, e]) => `<option value="${esc(e)}">${esc(n)}</option>`).join("");
    $("#mCc").textContent = (d.cc ? "Cc " + d.cc + " · " : "") + "Your Gmail signature is added below the message";
    $("#mode").textContent = demo ? "Demo data" : "● " + (d.me || "Gmail");
    $("#mode").className = "pill " + (demo ? "demo" : "live");
    $("#mode").title = demo ? "Sample data. Run `python server.py --setup` to use your Gmail." : "Gmail query: " + d.query;
    $("#banner").hidden = !d.error;
    $("#banner").textContent = d.error ? "Mailbox error — " + d.error : "";
    $("#synced").textContent = "synced " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const types = [...new Set(all.map(r => r.type).filter(Boolean))].sort();
    $("#type").innerHTML = `<option value="">All types</option>` + types.map(t => `<option ${t === f.type ? "selected" : ""}>${esc(t)}</option>`).join("");
    loaded = true;
    render();
  } catch (e) { toast("Could not load: " + e.message, true); }
  $("#refresh").disabled = false;
}

function filtered(ignoreStatus) {
  const q = f.q.toLowerCase();
  return all.filter(r =>
    (ignoreStatus || f.status === "all" || r.status === f.status) &&
    (!f.type || r.type === f.type) &&
    (!f.employee || r.employee === f.employee) &&
    (!f.day || covers(r, f.day)) &&
    (!f.week || weekStart(r.received) === f.week) &&
    (!f.from || (r.to || r.from || "") >= f.from) &&
    (!f.to || (r.from || "") <= f.to) &&
    (!q || [r.employee, r.emp_id, r.type, r.reason, r.subject].join(" ").toLowerCase().includes(q)));
}

function sorted(rows) {
  const k = sort.k;
  return rows.slice().sort((a, b) => {
    const x = a[k] ?? "", y = b[k] ?? "";
    return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
  });
}

function render() {
  renderKpis(); renderCharts(); renderHeat(); renderTable();
  const n = all.filter(r => r.status === "pending").length;
  document.title = (n ? `(${n}) ` : "") + "Leave Desk · greytHR";
}

function renderKpis() {
  const base = filtered(true), c = s => base.filter(r => r.status === s).length;
  const ap = c("approved"), rj = c("rejected"), pend = c("pending");
  const today = iso(new Date()), in30 = iso(Date.now() + 30 * 864e5);
  const upcoming = base.filter(r => isOff(r) && (r.status === "approved" || r.status === "pending") && r.from && r.to >= today && r.from <= in30).reduce((s, r) => s + (r.days || 0), 0);
  const oldest = base.filter(r => r.status === "pending").map(r => r.received).sort()[0];
  const tiles = [
    { s: "pending", lbl: "Pending", val: pend, sub: oldest ? "oldest " + ago(oldest) : "inbox zero ✦", c: "--pending" },
    { s: "approved", lbl: "Approved", val: ap, sub: "decided requests", c: "--approved" },
    { s: "rejected", lbl: "Rejected", val: rj, sub: "decided requests", c: "--rejected" },
    { s: "all", lbl: "Approval rate", val: ap + rj ? Math.round(ap / (ap + rj) * 100) + "%" : "—", sub: `${ap + rj} decided`, c: "--info" },
    { s: null, lbl: "Days off · next 30d", val: upcoming % 1 ? upcoming.toFixed(1) : upcoming, sub: "leave days, excl. WFH", c: "--accent" },
  ];
  $("#kpis").innerHTML = tiles.map(t => `<button class="kpi ${t.s && t.s !== "all" && f.status === t.s ? "on" : ""}" data-s="${t.s ?? ""}" style="--c:var(${t.c})">
    <div class="lbl"><i></i>${t.lbl}</div><div class="val">${t.val}</div><div class="sub">${t.sub}</div></button>`).join("");
  $$("#seg button").forEach(b => {
    const n = b.dataset.s === "all" ? base.length : c(b.dataset.s);
    b.innerHTML = `${LABEL[b.dataset.s] || b.dataset.s[0].toUpperCase() + b.dataset.s.slice(1)}<span class="c">${n}</span>`;
    b.classList.toggle("on", b.dataset.s === f.status); b.setAttribute("aria-pressed", b.dataset.s === f.status);
  });
}

function chartDefaults() {
  Chart.defaults.color = css("--muted");
  Chart.defaults.font.family = "Inter Tight, system-ui";
  Chart.defaults.borderColor = css("--line");
  Chart.defaults.plugins.tooltip.backgroundColor = css("--text");
  Chart.defaults.plugins.tooltip.titleColor = css("--bg");
  Chart.defaults.plugins.tooltip.bodyColor = css("--bg");
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
}

function upsert(id, cfg) {
  if (charts[id]) { charts[id].data = cfg.data; charts[id].update("none"); return; }  // no re-animation on every filter change
  charts[id] = new Chart($("#" + id), cfg);
}

function renderCharts() {
  if (!window.Chart) return;
  chartDefaults();
  const rows = all.filter(r => (!f.type || r.type === f.type) && (!f.employee || r.employee === f.employee));
  // weekly stacked bars
  const weeks = [...Array(12)].map((_, i) => weekStart(Date.now() - (11 - i) * 7 * 864e5));
  const statuses = ["approved", "pending", "rejected", "stale"];
  upsert("cWeek", {
    type: "bar",
    data: {
      labels: weeks.map(w => fmt(w)), weeks,
      datasets: statuses.map(s => ({
        label: LABEL[s] || s[0].toUpperCase() + s.slice(1), backgroundColor: statusColor(s), borderRadius: 4, borderSkipped: false, maxBarThickness: 34,
        data: weeks.map(w => rows.filter(r => r.status === s && weekStart(r.received) === w).length),
      })),
    },
    options: {
      maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true } } },
      onClick: (_, els, ch) => { const w = els[0] && ch.data.weeks[els[0].index]; if (w) setF({ week: f.week === w ? "" : w }); },  // read from live data, not a stale closure
    },
  });
  // type doughnut
  const byType = {}; all.forEach(r => byType[r.type || "Unknown"] = (byType[r.type || "Unknown"] || 0) + 1);
  const tl = Object.keys(byType).sort((a, b) => byType[b] - byType[a]);
  const pal = ["#8fd14f", "#6f9bff", "#f0a43a", "#b48cff", "#3fc9d9", "#ff8a7a", "#d9c84a", "#f06fb0", "#9aa6bd", "#2fb67c", "#c98b5a", "#7c6cf0"]; // categorical: 12 distinct before any repeat
  upsert("cType", {
    type: "doughnut",
    data: { labels: tl, datasets: [{ data: tl.map(t => byType[t]), backgroundColor: tl.map((t, i) => f.type && f.type !== t ? pal[i % pal.length] + "40" : pal[i % pal.length]), borderColor: css("--surface"), borderWidth: 3, hoverOffset: 8 }] },
    options: {
      maintainAspectRatio: false, cutout: "68%",
      onResize: (ch, size) => { const p = size.width < 520 ? "bottom" : "right"; if (ch.options.plugins.legend.position !== p) { ch.options.plugins.legend.position = p; ch.update("none"); } },
      plugins: { legend: { position: $("#cType").clientWidth < 520 ? "bottom" : "right", labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true } } },
      onClick: (_, els, ch) => { const t = els[0] && ch.data.labels[els[0].index]; if (t) { setF({ type: f.type === t ? "" : t }); $("#type").value = f.type; } },
    },
  });
  // days per person
  const byP = {}, wP = {};
  all.filter(r => r.status !== "rejected" && r.status !== "cancelled" && !/^permission/i.test(r.type || "") && (!f.type || r.type === f.type))
    .forEach(r => { const t = isWfh(r) ? wP : byP; t[r.employee] = (t[r.employee] || 0) + (r.days || 0); });
  const pl = [...new Set([...Object.keys(byP), ...Object.keys(wP)])].sort((a, b) => (byP[b] || 0) + (wP[b] || 0) - (byP[a] || 0) - (wP[a] || 0)).slice(0, 10);
  upsert("cPeople", {
    type: "bar",
    data: { labels: pl, datasets: [
      { label: "Leave days", data: pl.map(p => byP[p] || 0), borderRadius: 4, maxBarThickness: 16, backgroundColor: pl.map(p => f.employee && f.employee !== p ? css("--accent") + "40" : css("--accent")) },
      { label: "WFH days", data: pl.map(p => wP[p] || 0), borderRadius: 4, maxBarThickness: 16, backgroundColor: pl.map(p => f.employee && f.employee !== p ? css("--info") + "40" : css("--info")) }] },
    options: {
      indexAxis: "y", maintainAspectRatio: false,
      scales: { x: { stacked: true, beginAtZero: true, grid: { color: css("--line") } }, y: { stacked: true, grid: { display: false }, ticks: { autoSkip: false } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true } } },
      onClick: (_, els, ch) => { const p = els[0] && ch.data.labels[els[0].index]; if (p) setF({ employee: f.employee === p ? "" : p }); },
    },
  });
}

let calMonth = iso(new Date()).slice(0, 7);  // month shown in the calendar, "YYYY-MM"
const addMonth = (m, k) => { const [y, mo] = m.split("-").map(Number), d = new Date(y, mo - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
function calBounds() {  // months that have leave data (always includes this month)
  const ms = [iso(new Date()).slice(0, 7), ...all.flatMap(r => [r.from, r.to]).filter(Boolean).map(d => d.slice(0, 7))].sort();
  return [ms[0], ms.at(-1)];
}

function renderHeat() {
  const [lo, hi] = calBounds();
  calMonth = calMonth < lo ? lo : calMonth > hi ? hi : calMonth;
  const [y, mo] = calMonth.split("-").map(Number), today = iso(new Date());
  const days = [...Array(new Date(y, mo, 0).getDate())].map((_, i) => iso(new Date(y, mo - 1, i + 1)));
  const monthName = new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  $("#calTitle").textContent = `Who's off · ${monthName}`;
  Object.assign($("#calMonth"), { value: calMonth, min: lo, max: hi });
  $("#calPrev").disabled = calMonth <= lo; $("#calNext").disabled = calMonth >= hi;
  $("#calToday").disabled = calMonth === today.slice(0, 7);
  const active = all.filter(r => r.status === "approved" || r.status === "pending" || r.status === "stale");
  const people = (d, pred) => [...new Map(active.filter(r => pred(r) && covers(r, d)).map(r => [r.employee, r])).values()];  // people, not requests
  const counts = days.map(d => people(d, isOff)), wfh = days.map(d => people(d, isWfh));
  const max = Math.max(1, ...counts.map(c => c.length));
  const pad = (new Date(days[0] + "T00:00").getDay() + 6) % 7;
  const ppl = new Set(counts.flat().map(r => r.employee)), personDays = counts.reduce((s, c, i) => s + (new Date(days[i] + "T00:00").getDay() % 6 ? c.length : 0), 0);
  const wfhDays = wfh.reduce((s, c) => s + c.length, 0);
  $("#calSum").textContent = ppl.size ? `${ppl.size} ${ppl.size === 1 ? "person" : "people"} off · ${personDays} working day${personDays === 1 ? "" : "s"} of leave${wfhDays ? ` · ${wfhDays} WFH day${wfhDays === 1 ? "" : "s"}` : ""}` : `Nobody off in ${monthName}${wfhDays ? ` · ${wfhDays} WFH days` : ""}`;
  $("#heat").innerHTML = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => `<div class="dow">${d}</div>`).join("") +
    "<div></div>".repeat(pad) +
    days.map((d, i) => {
      const n = counts[i].length, dt = new Date(d + "T00:00"), we = dt.getDay() % 6 === 0, isToday = d === today;
      const names = counts[i].map(r => `${r.employee}${r.status === "pending" ? " (pending)" : r.status === "stale" ? " (no reply)" : ""}`);
      // name = visible text ("12 Nov 4"); who's off is the description (hidden .tip, referenced by id)
      return `<button class="day ${we ? "we" : ""} ${f.day === d ? "on" : ""} ${isToday ? "today" : ""}" data-day="${d}" aria-describedby="tip-${d}" aria-pressed="${f.day === d}" ${isToday ? 'aria-current="date"' : ""}
        style="background:color-mix(in srgb,var(--accent) ${n ? 10 + 20 * n / max : 0}%,var(--surface2));${n ? "border-color:color-mix(in srgb,var(--accent) " + (30 + 50 * n / max) + "%,transparent)" : ""}">
        <div class="d"><b>${dt.getDate()}</b>${isToday ? '<span class="todaytag">Today</span>' : ""}</div><div class="n">${n || ""}</div>
        <div class="tip" id="tip-${d}"><b>${dt.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}${isToday ? " · today" : ""}</b><br>${n ? n + " off: " : ""}${n ? names.map(esc).join("<br>") : "Nobody off"}${wfh[i].length ? `<br><i>WFH: ${wfh[i].map(r => esc(r.employee)).join(", ")}</i>` : ""}</div></button>`;
    }).join("");
}

function renderTable() {
  const rows = sorted(filtered());
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  page = Math.min(page, pages - 1);
  const view = rows.slice(page * PAGE, page * PAGE + PAGE);
  focus = Math.min(focus, Math.max(0, view.length - 1));
  $("#tbl tbody").innerHTML = view.map((r, i) => `<tr data-id="${esc(r.id)}" class="${r.unread ? "unread" : ""} ${i === focus ? "focus" : ""}">
    <td class="chk"><input type="checkbox" ${selected.has(r.id) ? "checked" : ""} ${!isOpen(r) ? "disabled" : ""} aria-label="Select ${esc(r.employee || "")}"></td>
    <td><div class="emp"><span class="av" style="background:hsl(${hue(r.employee)} 72% 74%)">${esc(initials(r.employee))}</span>
      <span><button type="button" class="namebtn" data-open aria-label="Open details for ${esc(r.employee || "Unknown")}">${esc(r.employee || "Unknown")}</button><small>${esc(r.emp_id || r.sender)}</small></span></div></td>
    <td>${esc(r.type || "—")}</td>
    <td>${fmt(r.from)}${r.to && r.to !== r.from ? " → " + fmt(r.to) : ""}</td>
    <td class="num">${r.days ?? "—"}</td>
    <td class="muted" title="${esc(r.received)}">${ago(r.received)}</td>
    <td><span class="badge ${esc(r.status)}">${esc(LABEL[r.status] || r.status)}</span></td>
    <td class="act">${isOpen(r) ? `<div class="rowact"><button class="btn ok" data-act="approved" title="Approve (a)" aria-label="Approve ${esc(r.employee || "")}">✓</button><button class="btn bad" data-act="rejected" title="Reject (r)" aria-label="Reject ${esc(r.employee || "")}">✕</button></div>` : `<span class="muted small" title="${esc(r.decided_at || "")}">${r.decided_by ? "by " + esc(r.decided_by) : r.decided_at ? ago(r.decided_at) : "—"}</span>`}</td>
  </tr>`).join("");
  $("#empty").hidden = rows.length > 0;
  $("#empty").textContent = !loaded ? "Loading your mailbox…" : f.status === "pending" && !f.q && !f.type && !f.employee && !f.day && !f.week && !f.from && !f.to ? "No pending requests — you're all caught up ✦" : "No requests match these filters.";
  $("#pinfo").textContent = rows.length ? `${page * PAGE + 1}–${page * PAGE + view.length} of ${rows.length}` : "0 results";
  $("#prev").disabled = page === 0; $("#next").disabled = page >= pages - 1;
  $$("th[data-k]").forEach(th => { th.querySelector(".ar")?.remove(); if (th.dataset.k === sort.k) th.insertAdjacentHTML("beforeend", `<span class="ar">${sort.dir > 0 ? "↑" : "↓"}</span>`); });
  const pend = view.filter(r => isOpen(r));
  $("#all").checked = pend.length > 0 && pend.every(r => selected.has(r.id));
  $("#bulk").hidden = selected.size === 0;
  $("#selCount").textContent = `${selected.size} selected`;
  const chips = [["employee", "Person"], ["day", "Off on"], ["week", "Week of"], ["type", "Type"], ["from", "From"], ["to", "To"], ["q", "Search"]].filter(([k]) => f[k]);
  $("#chips").innerHTML = chips.map(([k, l]) => `<span class="chip">${l}: ${esc(k === "day" || k === "week" ? fmt(f[k]) : f[k])}<button data-clear="${k}" aria-label="Clear">✕</button></span>`).join("") +
    (chips.length > 1 ? `<span class="chip"><button data-clear="*">Clear all</button></span>` : "");
}

function setF(patch) { Object.assign(f, patch); page = 0; focus = 0; render(); }

// ---------------------------------------------------------------- drawer
function openDrawer(id) {
  const r = all.find(x => x.id === id); if (!r) return;
  const overlap = r.from && isOff(r) ? all.filter(o => o.id !== r.id && isOff(o) && (o.status === "approved" || o.status === "pending") && o.from && o.from <= (r.to || r.from) && (o.to || o.from) >= r.from) : [];
  const mine = all.filter(o => o.employee === r.employee && o.status !== "rejected");
  const yearDays = mine.filter(o => (o.from || "").slice(0, 4) === String(new Date().getFullYear())).reduce((s, o) => s + (o.days || 0), 0);
  const months = [...Array(6)].map((_, i) => { const d = new Date(); d.setMonth(d.getMonth() - 5 + i); return iso(d).slice(0, 7); });
  const perMonth = months.map(m => mine.filter(o => (o.from || "").startsWith(m)).reduce((s, o) => s + (o.days || 0), 0));
  const mx = Math.max(1, ...perMonth);
  const links = r.links || {};
  $("#dBody").innerHTML = `
    <div class="emp" style="margin-right:40px"><span class="av" style="width:44px;height:44px;font-size:14px;background:hsl(${hue(r.employee)} 72% 74%)">${esc(initials(r.employee))}</span>
      <div><h3>${esc(r.employee || "Unknown")}</h3><span class="badge ${esc(r.status)}">${esc(LABEL[r.status] || r.status)}</span></div></div>
    <dl class="dl">
      <dt>Employee ID</dt><dd class="mono">${esc(r.emp_id || "—")}</dd>
      <dt>Leave type</dt><dd>${esc(r.type || "—")}</dd>
      <dt>Dates</dt><dd>${fmt(r.from)} → ${fmt(r.to)} · <b>${r.days ?? "?"}</b> day(s)</dd>
      <dt>Reason</dt><dd>${esc(r.reason || "—")}</dd>
      <dt>Applied</dt><dd>${esc(r.received.replace("T", " "))} (${ago(r.received)})</dd>
      <dt>Reply goes to</dt><dd class="mono small">${r.employee_email ? esc(r.employee_email) : `<span style="color:var(--rejected)">⚠ not in team list — set To when replying</span>`}</dd>
      ${r.decided_by ? `<dt>Decided by</dt><dd>${esc(r.decided_by)}${r.decided_at ? " · " + esc(r.decided_at.replace("T", " ")) : ""}</dd>` : ""}
      ${r.comment ? `<dt>Your message</dt><dd>${esc(r.comment)}</dd>` : ""}
      <dt>This year</dt><dd>${yearDays} day(s) across ${mine.length} request(s)
        <div class="hist" title="last 6 months">${perMonth.map((v, i) => `<span title="${months[i]}: ${v}d" style="height:${v / mx * 100}%"></span>`).join("")}</div></dd>
    </dl>
    ${overlap.length ? `<div class="warn">⚠ Overlaps with ${overlap.length} other leave(s): ${overlap.slice(0, 5).map(o => esc(o.employee) + " (" + fmt(o.from) + ")").join(", ")}</div>` : ""}
    <div class="dact">
      ${isOpen(r) ? `<button class="btn ok" data-dact="approved">✓ Approve</button><button class="btn bad" data-dact="rejected">✕ Reject</button>` : ""}
      ${safeUrl(links.approve) ? `<a class="btn ghost" target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(links.approve))}" title="greytHR email-approval link">Approve in greytHR ↗</a>` : ""}
      ${safeUrl(links.reject) ? `<a class="btn ghost" target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(links.reject))}">Reject in greytHR ↗</a>` : ""}
      ${safeUrl(links.open) ? `<a class="btn ghost" target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(links.open))}" title="greytHR approve/reject page">Review in greytHR ↗</a>` : ""}
      ${!demo ? `<a class="btn ghost" target="_blank" rel="noopener noreferrer" href="https://mail.google.com/mail/u/${encodeURIComponent(me || "0")}/#all/${esc(r.thread)}">Open in Gmail ↗</a>` : ""}
    </div>
    <h2 style="margin:18px 0 8px">Original email · <span class="muted">${esc(r.subject)}</span></h2>
    <div class="mail">${esc(r.body)}</div>`;
  $("#drawer").dataset.id = id;
  $("#drawer").classList.add("on"); $("#scrim").classList.add("on"); $("#drawer").inert = false; $("#dClose").focus();
}
function closeDrawer() { $("#drawer").classList.remove("on"); $("#scrim").classList.remove("on"); $("#drawer").inert = true; }

// ---------------------------------------------------------------- decide
// final email text for one request: typed text (placeholders filled) or that request type's default template
// untouched built-in template → full template treatment; anything the user typed/edited → only placeholders filled, words kept verbatim
const BUILTIN = new Set(Object.values(TEMPLATES).flatMap(k => [...k.approved, ...k.rejected]));
const messageFor = (r, typed, decision = currentDecision) =>
  typed ? (BUILTIN.has(typed) ? fillTemplate(typed, r) : fillPlaceholders(typed, r))
    : fillTemplate(bulkTpl || TEMPLATES[kindOf(r)][decision][suggest(r, decision)], r);
let currentDecision = "approved", bulkTpl = null;  // bulkTpl: template chip picked in bulk mode
function askDecision(ids, decision) {
  currentDecision = decision; bulkTpl = null;
  const rows = ids.map(i => all.find(r => r.id === i)).filter(r => r && isOpen(r) && !busy.has(r.id));
  if (!rows.length) return;
  const m = $("#modal"), word = decision === "approved" ? "Approve" : "Reject", done = decision === "approved" ? "Approved" : "Rejected";
  const kinds = [...new Set(rows.map(kindOf))], single = rows.length === 1;
  $("#mTitle").textContent = `${word} ${single ? `${rows[0].employee}'s ${kinds[0] === "leave" ? (rows[0].type || "leave").toLowerCase() : KIND_LABEL[kinds[0]]}` : rows.length + " requests"}?`;
  $("#mSub").textContent = rows.length === 1 ? `${rows[0].type || "Leave"} · ${dateText(rows[0])} · ${rows[0].days ?? "?"} day${rows[0].days === 1 ? "" : "s"}${isPast(rows[0]) ? " · dates already passed" : ""}${rows[0].reason ? ` · “${rows[0].reason.slice(0, 60)}”` : ""}` : rows.map(r => r.employee).join(", ");
  $("#mComment").value = "";
  $("#mTo").value = rows.length === 1 ? rows[0].employee_email || "" : "";
  $("#mToRow").style.display = rows.length === 1 ? "" : "none";
  const missing = rows.filter(r => !r.employee_email).map(r => r.employee);
  $("#mReply").checked = true;  // never carry an unticked "send reply" over to the next request
  const syncReq = () => { $("#mTo").required = rows.length === 1 && $("#mReply").checked; };
  $("#mReply").onchange = syncReq; syncReq();
  // templates for this request type; single → shown fully filled in (exactly what is sent)
  const tpls = kinds.length === 1 ? TEMPLATES[kinds[0]][decision] : [];
  const preview = t => single ? fillTemplate(t, rows[0]) : t.replace(/\[\[(.*?)(?:\|.*?)?\]\]/gs, "$1");  // bulk chips: readable, tokens shown
  const chipText = t => { const body = (preview(t).split("\n\n")[1] || "").replace(/^Sorry for the late reply(\. | — )/, ""); return body.length > 70 ? body.slice(0, 68) + "…" : body; };  // shared apology hidden in chips
  $("#tpls").innerHTML = tpls.map((t, i) => single ? `<button type="button" data-t="${esc(preview(t))}" title="${esc(preview(t))}">${esc(chipText(t))}</button>`
    : `<button type="button" data-bulk-tpl="${i}" aria-pressed="${i === 0}" title="${esc(preview(t))}">${esc(chipText(t))}</button>`).join("") +
    (kinds.length > 1 ? `<span class="muted small">Mixed request types (${kinds.map(k => KIND_LABEL[k]).join(", ")}) — leave the box empty and each person gets the message for their own request type.</span>` : "");
  if (!single && kinds.length === 1) bulkTpl = tpls[0];
  $("#mComment").value = single ? preview(tpls[suggest(rows[0], decision)]) : "";
  $("#mComment").placeholder = single ? "Your message" : "Optional: write your own message instead ({name}, {type}, {dates} are filled in per person). Leave empty to use the selected template.";
  current_tpls = tpls;
  const renderPreview = () => { const v = $("#mComment").value.trim();
    $("#mPreview").hidden = single;
    if (!single) $("#mPreview").innerHTML = "<b>Preview</b>" + rows.slice(0, 3).map(r => `<div><span class="muted">${esc(r.employee)} · ${esc(r.type || "")}</span><br>${esc(messageFor(r, v)).replace(/\n/g, "<br>")}</div>`).join("") + (rows.length > 3 ? `<div class="muted">…and ${rows.length - 3} more</div>` : ""); };
  $("#mComment").oninput = renderPreview; renderPreview();
  $("#mOk").textContent = word;
  $("#mOk").className = "btn " + (decision === "approved" ? "ok" : "bad");
  $("#mNote").textContent = (rows.length > 1 ? `Each reply goes to that employee's own email. ` : "") +
    (rows.length > 1 && missing.length ? `⚠ No email for ${missing.join(", ")} — those will fail; do them one by one. ` : "") + (demo ? "Demo mode — nothing is emailed; decision is saved locally." :
    "Labels the Gmail message Leave/" + done + ". greytHR itself only updates if you also use its Approve/Reject link (or email-approval reply is enabled by your admin).");
  m.returnValue = "";
  current = rows;
  m.showModal();
  $("#mComment").focus();
  m.onclose = async () => {
    if (m.returnValue !== "ok") return;
    try {
      const v = $("#mComment").value.trim(), comments = Object.fromEntries(rows.map(r => [r.id, messageFor(r, v)]));
      const { results } = await api("/api/decide", { ids: rows.map(r => r.id), decision, comment: v, comments, reply: $("#mReply").checked, to: $("#mTo").value.trim() });
      const ok = results.filter(x => x.ok), bad = results.filter(x => !x.ok);
      ok.forEach(x => { const r = all.find(y => y.id === x.id); Object.assign(r, { status: decision, decided_at: new Date().toISOString(), comment: x.comment, unread: false }); selected.delete(x.id); });
      const sentTo = ok.filter(x => x.replied_to);
      if (ok.length) toast(`${done} ${ok.length} request(s)` + (!sentTo.length ? " · no email sent" : ok.length === 1 ? ` · reply ${demo ? "simulated" : "sent"} to ${sentTo[0].replied_to}` : ` · ${sentTo.length} replies ${demo ? "simulated" : "sent"}, each to the employee`));
      bad.forEach(x => toast("Failed: " + x.error, true));
      render();
      ok.forEach(x => document.querySelector(`tr[data-id="${CSS.escape(x.id)}"]`)?.classList.add("flash"));
      if ($("#drawer").classList.contains("on")) openDrawer($("#drawer").dataset.id);
    } catch (e) { toast("Failed: " + e.message, true); }
    rows.forEach(r => busy.delete(r.id));
  };
}

function exportCsv() {
  const cols = ["employee", "emp_id", "employee_email", "type", "from", "to", "days", "status", "decided_by", "reason", "received", "decided_at", "comment"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...sorted(filtered()).map(r => cols.map(c => q(r[c])).join(","))].join("\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `leave-requests-${iso(new Date())}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- events
let qTimer;
$("#q").addEventListener("input", e => { clearTimeout(qTimer); qTimer = setTimeout(() => setF({ q: e.target.value.trim() }), 150); });
$("#type").addEventListener("change", e => setF({ type: e.target.value }));
$("#dFrom").addEventListener("change", e => setF({ from: e.target.value }));
$("#dTo").addEventListener("change", e => setF({ to: e.target.value }));
$("#seg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setF({ status: b.dataset.s }); });
$("#kpis").addEventListener("click", e => { const b = e.target.closest(".kpi"); if (b && b.dataset.s) setF({ status: f.status === b.dataset.s ? "all" : b.dataset.s }); });
// calendar tooltip: one fixed element on top of everything, clamped to the screen, flips above when no room below
function showTip(day) {
  const t = $("#tip"); t.innerHTML = day.querySelector(".tip").innerHTML; t.hidden = false;
  const r = day.getBoundingClientRect(), w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + "px";
  t.style.top = (r.bottom + 8 + h > innerHeight - 8 ? Math.max(8, r.top - h - 8) : r.bottom + 8) + "px";
}
const hideTip = () => { $("#tip").hidden = true; };
$("#heat").addEventListener("mouseover", e => { const d = e.target.closest(".day"); if (d) showTip(d); });
$("#heat").addEventListener("mouseleave", hideTip);
$("#heat").addEventListener("focusin", e => { const d = e.target.closest(".day"); if (d) showTip(d); });
$("#heat").addEventListener("focusout", hideTip);
addEventListener("scroll", hideTip, { passive: true });
const goMonth = m => { if (/^\d{4}-\d{2}$/.test(m)) { calMonth = m; hideTip(); renderHeat(); } };
$("#calPrev").onclick = () => goMonth(addMonth(calMonth, -1));
$("#calNext").onclick = () => goMonth(addMonth(calMonth, 1));
$("#calToday").onclick = () => goMonth(iso(new Date()).slice(0, 7));
$("#calMonth").addEventListener("change", e => goMonth(e.target.value));
$("#calTable").onclick = () => {  // filter the table to the month on screen
  const [y, mo] = calMonth.split("-").map(Number), from = `${calMonth}-01`, to = iso(new Date(y, mo, 0));
  $("#dFrom").value = from; $("#dTo").value = to; setF({ from, to, day: "", status: "all" });
  $(".table-card").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
};
$("#heat").addEventListener("click", e => { const b = e.target.closest(".day"); if (!b) return; const d = b.dataset.day; setF({ day: f.day === d ? "" : d, status: "all" }); const nb = $(`.day[data-day="${d}"]`); if (nb && nb.matches(":hover")) showTip(nb); });
$("#chips").addEventListener("click", e => {
  const k = e.target.dataset.clear; if (!k) return;
  const keys = k === "*" ? ["employee", "day", "week", "type", "from", "to", "q"] : [k];
  keys.forEach(x => { f[x] = ""; ({ type: "#type", from: "#dFrom", to: "#dTo", q: "#q" })[x] && ($(({ type: "#type", from: "#dFrom", to: "#dTo", q: "#q" })[x]).value = ""); });
  setF({});
});
$("#prev").onclick = () => { page--; renderTable(); };
$("#next").onclick = () => { page++; renderTable(); };
$("#refresh").onclick = () => load(true);
$("#export").onclick = exportCsv;
$("#help").onclick = () => $("#keys").showModal();
$("#theme").onclick = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t; localStorage.theme = t; $("#theme").textContent = t === "dark" ? "☾" : "☀";
  Object.values(charts).forEach(c => c.destroy()); charts = {}; render();
};
$$("th[data-k]").forEach(th => th.onclick = () => { sort = { k: th.dataset.k, dir: sort.k === th.dataset.k ? -sort.dir : (th.dataset.k === "employee" || th.dataset.k === "type" ? 1 : -1) }; renderTable(); });
$("#all").onchange = e => { $$("#tbl tbody tr").forEach(tr => { const r = all.find(x => x.id === tr.dataset.id); if (isOpen(r)) e.target.checked ? selected.add(r.id) : selected.delete(r.id); }); renderTable(); };
$("#tbl tbody").addEventListener("click", e => {
  const tr = e.target.closest("tr"); if (!tr) return;
  const id = tr.dataset.id;
  let cb = e.target.type === "checkbox" ? e.target : null;
  if (!cb && e.target.classList.contains("chk")) { cb = e.target.querySelector("input"); if (cb.disabled) return; cb.checked = !cb.checked; }  // whole cell is the target
  if (cb) { cb.checked ? selected.add(id) : selected.delete(id); renderTable(); return; }
  const act = e.target.closest("[data-act]");
  if (act) return askDecision([id], act.dataset.act);
  focus = [...tr.parentNode.children].indexOf(tr); openDrawer(id); renderTable();
});
$("#bulk").addEventListener("click", e => { const b = e.target.closest("[data-bulk]"); if (b) askDecision([...selected], b.dataset.bulk); });
$("#dBody").addEventListener("click", e => { const b = e.target.closest("[data-dact]"); if (b) askDecision([$("#drawer").dataset.id], b.dataset.dact); });
// mark busy the instant Confirm is pressed (the dialog "close" event fires a task later)
$("#mForm").addEventListener("submit", e => { if (e.submitter?.value === "ok") current.forEach(r => busy.add(r.id)); });
$("#tpls").addEventListener("click", e => { const chip = e.target.closest("button"); if (!chip) return;
  if (chip.dataset.t) { $("#mComment").value = chip.dataset.t; $("#mComment").oninput?.(); }
  else if (chip.dataset.bulkTpl) { bulkTpl = current_tpls[+chip.dataset.bulkTpl]; $("#mComment").value = "";
    $$("#tpls [data-bulk-tpl]").forEach(b => b.setAttribute("aria-pressed", b === chip)); $("#mComment").oninput?.(); } });
$("#dClose").onclick = closeDrawer; $("#scrim").onclick = closeDrawer;

document.addEventListener("keydown", e => {
  if (document.querySelector("dialog[open]")) return;
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === "Escape") { if (typing) document.activeElement.blur(); else if ($("#drawer").classList.contains("on")) closeDrawer(); else { selected.clear(); renderTable(); } return; }
  if (typing) return;
  const rows = $$("#tbl tbody tr"), cur = rows[focus]?.dataset.id;
  const k = e.key;
  if (k === "/") { e.preventDefault(); $("#q").focus(); }
  else if (k === "j" || k === "ArrowDown") { focus = Math.min(focus + 1, rows.length - 1); renderTable(); if ($("#drawer").classList.contains("on")) openDrawer($$("#tbl tbody tr")[focus].dataset.id); }
  else if (k === "k" || k === "ArrowUp") { focus = Math.max(focus - 1, 0); renderTable(); if ($("#drawer").classList.contains("on")) openDrawer($$("#tbl tbody tr")[focus].dataset.id); }
  else if (k === "Enter" && cur && !/^(BUTTON|A)$/.test(document.activeElement.tagName)) { e.preventDefault(); openDrawer(cur); }  // focused buttons handle Enter natively; preventDefault stops the key "clicking" the newly focused Close
  else if (k === "a" && cur) askDecision([cur], "approved");
  else if (k === "r" && cur) askDecision([cur], "rejected");
  else if (k === "x" && cur) { const r = all.find(x => x.id === cur); if (isOpen(r)) { selected.has(cur) ? selected.delete(cur) : selected.add(cur); renderTable(); } }
  else if ("12345".includes(k) && k.length === 1) setF({ status: ["all", "pending", "approved", "rejected", "stale"][+k - 1] });
  else if (k === "[" && !$("#calPrev").disabled) $("#calPrev").click();
  else if (k === "]" && !$("#calNext").disabled) $("#calNext").click();
  else if (k === "?") $("#keys").showModal();
  else return;
  if (k.startsWith("Arrow")) e.preventDefault();
});

if (localStorage.theme) { document.documentElement.dataset.theme = localStorage.theme; $("#theme").textContent = localStorage.theme === "dark" ? "☾" : "☀"; }
f.status = "pending";
load(false);
setInterval(() => { if (!document.hidden && !document.querySelector("dialog[open]")) load(true, true); }, 5 * 60e3);  // quiet auto-sync
