// Rebel Bot Swarm - core reader. Reads Claude Code's local session files and an optional team board. No network.
// READ ONLY: <home>/.claude/sessions/*.json, <home>/.claude/projects/<project>/*.jsonl (tail reads of new bytes only)
// and the board file you choose. ONE OPTIONAL WRITE: "Add team member" saves one request file in the requests
// folder you choose (off when that setting is empty). Works on Windows, macOS and Linux.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");

const CLAUDE = path.join(os.homedir(), ".claude");
const SESSIONS = path.join(CLAUDE, "sessions");
const PROJECTS = path.join(CLAUDE, "projects");
const FIRST_TAIL = 3000000, FEED_DAYS = 3, NAME_MAX = 60, JOB_MAX = 200, PIC_MAX = 5000000;
const PIC_TYPES = [".png", ".jpg", ".jpeg", ".svg"];
const FOLD = process.platform === "win32" || process.platform === "darwin";   // case-insensitive file systems
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = n => String(n).padStart(2, "0");
const fmt = d => `${p2(d.getDate())} ${MON[d.getMonth()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
const normDir = p => { let r = path.resolve(String(p || "")).replace(/[\\/]+$/, ""); return FOLD ? r.toLowerCase() : r; };

const offsets = new Map(), feed = new Map(), titles = new Map();

function expandHome(p) {
  p = String(p || "").trim();
  return p === "~" ? os.homedir() : p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(2)) : p;
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function liveSessions() {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(SESSIONS); } catch (e) { return out; }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(SESSIONS, n), "utf8")); } catch (e) { continue; }
    if (!d || !d.sessionId || !pidAlive(d.pid || 0)) continue;
    out[d.sessionId] = d;
  }
  return out;
}

// Board (optional, Markdown): "## Sessions" (or "## Members") table | name | job |, "## Files being edited" table
// | file | session | since |, a "## ... slot" table with a "Holder" row, and "## Waiting ..." bullet list.
function board(file) {
  const empty = { sessions: [], files: [], holder: "", waiting: [], found: false };
  if (!file) return empty;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return empty; }
  const parts = [];
  for (const chunk of ("\n" + text).split(/\r?\n## /).slice(1)) {
    const nl = chunk.indexOf("\n");
    parts.push([(nl < 0 ? chunk : chunk.slice(0, nl)).trim().toLowerCase(), nl < 0 ? "" : chunk.slice(nl + 1)]);
  }
  const section = test => (parts.find(([t]) => test(t)) || ["", ""])[1];
  const table = sec => {
    const rows = [];
    for (const line of sec.split(/\r?\n/)) {
      if (line.startsWith("|") && !/^\|\s*-/.test(line)) rows.push(line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
    }
    return rows.slice(1);
  };
  let holder = "";
  for (const c of table(section(t => t.includes("slot")))) if (c.length > 1 && c[0].toLowerCase().startsWith("holder")) holder = c[1];
  if (/^\(?(free|none|empty|-)?\)?$/i.test(holder.trim())) holder = "";
  const waiting = section(t => t.startsWith("waiting")).split(/\r?\n/).filter(l => l.startsWith("- ")).map(l => l.slice(2).trim())
    .filter(w => !/^\(?nothing\)?$/i.test(w));
  return { sessions: table(section(t => t === "sessions" || t === "members")).filter(c => c.length >= 2),
           files: table(section(t => t.startsWith("files being edited"))).filter(c => c.length >= 3), holder, waiting, found: true };
}

function titleOf(file) {
  const key = Buffer.from('"customTitle":"');
  let fd;
  try {
    fd = fs.openSync(file, "r");
    let end = fs.fstatSync(fd).size;
    while (end > 0) {
      const start = Math.max(0, end - (1 << 20)), len = end - start + Math.min(key.length + 400, fs.fstatSync(fd).size - end);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const i = buf.lastIndexOf(key);
      if (i >= 0) { const j = buf.indexOf(0x22, i + key.length); if (j > 0) return buf.slice(i + key.length, j).toString("utf8"); }
      end = start;
    }
  } catch (e) { /* no title */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return "";
}

// Claude Code keeps each project's transcripts in <home>/.claude/projects/<folder path with non-letters as "-">
function projectDirs(scope, folders) {
  let names = [];
  try { names = fs.readdirSync(PROJECTS); } catch (e) { return []; }
  if (scope === "all") return names.map(n => path.join(PROJECTS, n));
  const want = new Set(folders.map(f => path.resolve(f).replace(/[\\/]+$/, "").replace(/[^A-Za-z0-9]/g, "-").toLowerCase()));
  return names.filter(n => want.has(n.toLowerCase())).map(n => path.join(PROJECTS, n));
}

function scanFeed(dirs) {
  const cutoff = Date.now() - FEED_DAYS * 86400000;
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const fn of names) {
      if (!fn.endsWith(".jsonl")) continue;
      const file = path.join(dir, fn);
      let st;
      try { st = fs.statSync(file); } catch (e) { continue; }
      if (st.mtimeMs < cutoff) continue;
      const sid = fn.slice(0, -6);
      let start = offsets.get(file);
      if (start === undefined) { start = Math.max(0, st.size - FIRST_TAIL); titles.set(sid, titleOf(file)); }
      if (st.size <= start) { offsets.set(file, st.size); continue; }
      const buf = Buffer.alloc(st.size - start);
      try { const fd = fs.openSync(file, "r"); try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); } }
      catch (e) { continue; }
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl < 0) continue;
      offsets.set(file, start + lastNl + 1);
      for (const line of buf.slice(0, lastNl).toString("utf8").split("\n")) {
        if (!line.includes('"name":"SendMessage"')) continue;
        let e;
        try { e = JSON.parse(line); } catch (x) { continue; }
        if (e.type !== "assistant" || !e.timestamp) continue;
        for (const item of ((e.message || {}).content || [])) {
          if (item && item.type === "tool_use" && item.name === "SendMessage") {
            const inp = item.input || {}, msg = String(inp.message || "").trim();
            if (msg) feed.set(item.id || e.uuid, { dir, ts: e.timestamp, from_sid: sid, to_raw: String(inp.to || ""), first: msg.split(/\r?\n/)[0].slice(0, 220) });
          }
        }
      }
    }
  }
}

function member(name, job, d, sid, b) {
  let st = "closed", since = "", extra = "";
  if (d) {
    st = { busy: "working", idle: "idle", waiting: "waiting for you" }[d.status] || d.status || "idle";
    since = d.statusUpdatedAt ? fmt(new Date(d.statusUpdatedAt)) : "";
    extra = d.waitingFor || "";
  }
  const first = name.split(" - ")[0].split(" (")[0].toLowerCase();
  const files = b.files.filter(c => first && c[1].toLowerCase().includes(first)).map(c => c[0]);
  const hm = /^\s*\*\*(.+?)\*\*/.exec(b.holder) || /^\s*([A-Za-z][A-Za-z0-9 \-]+)/.exec(b.holder);
  const holder = hm ? hm[1].toLowerCase() : "";
  return { name, status: st, since, extra, job, files, slot: !!(first && holder.startsWith(first)), sid: sid || "",
           colour: "#" + crypto.createHash("md5").update(first).digest("hex").slice(0, 6), pic: "" };
}

function ownPictures(dir) {
  const out = {};
  if (!dir) return out;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const fn of names) {
    const ext = path.extname(fn).toLowerCase(), p = path.join(dir, fn);
    if (!PIC_TYPES.includes(ext)) continue;
    try { const st = fs.lstatSync(p); if (st.isFile() && st.size <= PIC_MAX) out[path.basename(fn, path.extname(fn)).trim().toLowerCase()] = { p, v: Math.floor(st.mtimeMs) }; }
    catch (e) { continue; }
  }
  return out;
}

const HELPER_SECS = 120;
// Running helpers: <project>/<session>/subagents/*.jsonl written in the last 2 minutes; first 4000 bytes only ("You are <Name>").
function helperNames(PROJS) {
  const out = {}, now = Date.now();
  for (const PROJ of [].concat(PROJS)) {
  let sess = [];
  try { sess = fs.readdirSync(PROJ); } catch (e) { continue; }
  for (const s of sess) {
    const sub = path.join(PROJ, s, "subagents");
    let files = [];
    try { files = fs.readdirSync(sub); } catch (e) { continue; }
    for (const fn of files) {
      if (!fn.endsWith(".jsonl")) continue;
      const p = path.join(sub, fn);
      try {
        const mt = fs.statSync(p).mtimeMs;
        if (now - mt > HELPER_SECS * 1000) continue;
        const fd = fs.openSync(p, "r"), buf = Buffer.alloc(4000);
        let n = 0;
        try { n = fs.readSync(fd, buf, 0, 4000, 0); } finally { fs.closeSync(fd); }
        const m = /"content":"You are ([A-Z][\w'-]*)/.exec(buf.slice(0, n).toString("utf8"));
        if (m) out[m[1].toLowerCase()] = Math.max(out[m[1].toLowerCase()] || 0, mt);
      } catch (e) { continue; }
    }
  }
  }
  return out;
}
const firstWord = n => (String(n).split(" - ")[0].split(" (")[0].trim().split(/\s+/)[0] || "").toLowerCase();
function applyHelpers(members, mk, PROJ, agentsDir) {
  const have = new Set(members.map(m => firstWord(m.name)));
  if (agentsDir && mk) {
    let names = [];
    try { names = fs.readdirSync(agentsDir); } catch (e) { names = []; }
    for (const fn of names) {
      if (!fn.endsWith(".md")) continue;
      const n = fn.slice(0, -3).toLowerCase();
      if (have.has(n)) continue;
      let head = "";
      try { const fd = fs.openSync(path.join(agentsDir, fn), "r"), b = Buffer.alloc(1500); try { head = b.slice(0, fs.readSync(fd, b, 0, 1500, 0)).toString("utf8"); } finally { fs.closeSync(fd); } } catch (e) { continue; }
      const d = /^description:\s*(.+)$/m.exec(head);
      members.push(mk(n[0].toUpperCase() + n.slice(1), d ? d[1].trim().slice(0, 200) : ""));
    }
  }
  const run = helperNames(PROJ);
  for (const m of members) {
    if (m.status === "closed") m.status = "ready";
    const f = firstWord(m.name);
    if (run[f] && (m.status === "ready" || m.status === "idle")) { m.status = "working"; m.since = fmt(new Date(run[f])); m.extra = "helper running"; }
  }
}

/** cfg: {boardFile, privateMembers[], scope: "workspace"|"all", workspaceFolders[], avatarsFolder, requestsFolder}
 *  picUri(path) -> link the webview may load (only inside avatarsFolder). */
function buildState(cfg, picUri) {
  cfg = cfg || {};
  const scope = cfg.scope === "all" ? "all" : "workspace", folders = cfg.workspaceFolders || [];
  const live = liveSessions(), b = board(expandHome(cfg.boardFile));
  const want = new Set(folders.map(normDir)), teamLive = {};
  for (const [sid, d] of Object.entries(live)) if (scope === "all" || want.has(normDir(d.cwd))) teamLive[sid] = d;
  const sockets = {}, names = {};
  for (const [sid, d] of Object.entries(live)) { if (d.messagingSocketPath) sockets[d.messagingSocketPath] = d.name || ""; names[sid] = d.name || ""; }
  const dirs = projectDirs(scope, folders), inScope = new Set(dirs);
  scanFeed(dirs);
  const rows = [];
  for (const cells of b.sessions) {
    const label = cells[0].replace(/\*/g, ""), key = label.split(" (")[0].trim();
    if (!key) continue;
    const match = Object.keys(teamLive).find(sid => { const n = teamLive[sid].name; return n && (n === key || label.includes(n)); });
    rows.push([key, cells[1], match, !!match && teamLive[match].name !== key]);
  }
  const keep = new Set(rows.filter(r => r[2] && r[3]).map(r => r[2]));
  const members = [], used = new Set();
  for (const [key, job, match, renamed] of rows) {
    if (match && keep.has(match) && !renamed) continue;
    members.push(member(key, job, teamLive[match], match, b));
    if (match) used.add(match);
  }
  for (const [sid, d] of Object.entries(teamLive)) if (!used.has(sid)) members.push(member(d.name || sid.slice(0, 8), b.found ? "(not on the board)" : "", d, sid, b));
  applyHelpers(members, null, dirs, null);
  const pics = ownPictures(expandHome(cfg.avatarsFolder));
  for (const m of members) {
    const n = m.name.trim().toLowerCase(), keys = [n, n.split(" - ")[0].split(" (")[0].trim(), n.split(/\s+/)[0]];
    const hit = keys.map(k => k && pics[k]).find(Boolean);
    if (hit && picUri) m.pic = picUri(hit.p) + "?v=" + hit.v;
  }
  const priv = (cfg.privateMembers || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const isPriv = n => priv.some(p => String(n).toLowerCase().includes(p));
  const privSids = new Set(members.filter(m => m.sid && isPriv(m.name)).map(m => m.sid));
  const titleNames = {};
  for (const sid of new Set([...titles.keys(), ...Object.keys(names)])) titleNames[sid] = names[sid] || titles.get(sid) || sid.slice(0, 8);
  for (const m of members) if (m.sid) titleNames[m.sid] = m.name;
  const out = [];
  for (const f of [...feed.values()].filter(x => inScope.has(x.dir)).sort((a, c) => (a.ts < c.ts ? 1 : a.ts > c.ts ? -1 : 0)).slice(0, 120)) {
    const raw = f.to_raw.replace("uds:", "");
    let toName = sockets[raw] || raw;
    for (const m of members) if (m.sid && live[m.sid] && live[m.sid].name === toName) toName = m.name;
    const frm = titleNames[f.from_sid] || f.from_sid.slice(0, 8);
    const hide = privSids.has(f.from_sid) || isPriv(toName) || isPriv(frm);
    const d = new Date(f.ts);
    out.push({ time: isNaN(d) ? f.ts : fmt(d), from: frm, to: toName, text: hide ? "(private)" : f.first });
  }
  const now = new Date();
  return { updated: `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`, holder: b.holder, waiting: b.waiting,
           board: b.found, requests: !!expandHome(cfg.requestsFolder), members, feed: out };
}

// ADD TEAM MEMBER (optional): one file "NEW MEMBER <yyyy-mm-dd HHMMSS>.json" in the requests folder.
// The file name uses the time only; JSON.stringify escapes the typed text.
let lastRequest = 0;
function clean(t, limit) {
  if (typeof t !== "string") return null;
  t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return t && t.length <= limit ? t : null;
}
function newMemberRequest(data, requestsFolder) {
  const dir = expandHome(requestsFolder);
  if (!dir) return { ok: false, msg: "Not saved: set a requests folder in the settings first." };
  const name = clean(data && data.name, NAME_MAX), job = clean(data && data.job, JOB_MAX);
  if (!name || !job) return { ok: false, msg: `Not saved: type a name (max ${NAME_MAX}) and the job (max ${JOB_MAX} characters).` };
  if (Date.now() - lastRequest < 5000) return { ok: false, msg: "Not saved: wait 5 seconds between requests." };
  const d = new Date(), day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `NEW MEMBER ${day} ${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.json`),
      JSON.stringify({ name, job, time: `${day}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` }, null, 2),
      { encoding: "utf8", flag: "wx" });
  } catch (e) {
    return { ok: false, msg: e.code === "EEXIST" ? "Not saved: wait a second and try again." : "Not saved: " + (e.code || "write error") + "." };
  }
  lastRequest = Date.now();
  return { ok: true, msg: "Request saved for your coordinator" };
}

module.exports = { buildState, newMemberRequest, expandHome };
