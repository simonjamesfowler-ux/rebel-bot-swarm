// Rebel Bot Swarm - core reader. Reads Claude Code's local session files and an optional team board. No network.
// READ ONLY: <home>/.claude/sessions/*.json, <home>/.claude/projects/<project>/*.jsonl (tail reads of new bytes only)
// the board file you choose, <home>/.claude/agents/*.md (first bytes and the role text), and the helper (subagent)
// transcripts <project>/<session>/subagents/agent-*.jsonl + .meta.json (first and last bytes) for the working window.
// WRITES, only when you click Save in the panel: members.json (name and avatar on the panel, a backup first) and
// request files ("NEW MEMBER <time>.json", "EDIT MEMBER <time>.json") for your coordinator session. The extension
// passes the folders: VS Code's storage folder for this extension, or the folders you set. "Upload picture" copies one
// picture you choose into the avatars folder (new file name, never over a file). Never the agent files,
// the board or the session files. Works on Windows, macOS and Linux.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");

const CLAUDE = path.join(os.homedir(), ".claude");
const SESSIONS = path.join(CLAUDE, "sessions");
const PROJECTS = path.join(CLAUDE, "projects");
const AGENTS = path.join(CLAUDE, "agents");
const FIRST_TAIL = 3000000, FEED_DAYS = 3, NAME_MAX = 60, JOB_MAX = 200, TASK_MAX = 300, ROLE_MAX = 6000, PIC_MAX = 5000000;
const STYLES = ["crew", "coord", "cad", "draught", "research", "cabinet", "teacher", "family", "books", "kitchen", "fitter", "postbot", "cleanbot", "tablet",
  "rc-pilot", "rc-mechanic", "rc-engineer", "rc-drafter", "rc-commander", "rc-admin", "rc-researcher", "rc-teacher", "rc-assistant", "rc-navigator", "rc-droid", "rc-scout"];   // rc- = Rebel crew
const PIC_TYPES = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
const UPLOAD_TYPES = [".png", ".jpg", ".jpeg", ".webp"], UPLOAD_MAX = 2000000;
const FOLD = process.platform === "win32" || process.platform === "darwin";   // case-insensitive file systems
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = n => String(n).padStart(2, "0");
const fmt = d => `${p2(d.getDate())} ${MON[d.getMonth()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
const normDir = p => { let r = path.resolve(String(p || "")).replace(/[\\/]+$/, ""); return FOLD ? r.toLowerCase() : r; };

const offsets = new Map(), feed = new Map(), titles = new Map(), lastMembers = new Map();

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
  const empty = { sessions: [], files: [], holder: "", waiting: [], log: [], found: false };
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
    .filter(w => w && !/^\(?nothing\)?$/i.test(w) && !/^~~/.test(w) && !/^\[x\]/i.test(w) && !/^(done|closed)\b/i.test(w));
  // only top-level "- " bullets count: indented sub-lines, struck (~~), ticked ([x]) and DONE items are not open
  // "## Log": "- 21 Nov 14:05 Name: text" (the time is optional); newest lines last
  const log = [];
  for (const l of section(t => t === "log" || t.startsWith("log ")).split(/\r?\n/)) {
    const m = /^- +(\d{1,2} [A-Za-z]{3}(?: \d{4})?)(?:,? (\d{1,2}:\d{2}))? +([^:]{1,48}?): +(.+)$/.exec(l.trim());
    if (m) log.push({ date: m[1] + (m[2] ? " " + m[2] : ""), who: m[3].trim(), text: m[4].slice(0, 300) });
    else if (l.startsWith("- ")) log.push({ date: "", who: "", text: l.slice(2).trim().slice(0, 300) });
  }
  return { log, sessions: table(section(t => t === "sessions" || t === "members")).filter(c => c.length >= 2),
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

// ---- agent files <home>/.claude/agents/*.md (first 2000 bytes). A member matches its agent file by (1) "agent" in the
// members file, (2) the file name or its "name:" line, (3) the leading name of its "description:" line
// ("Ada Lovelace, the ..."). Keys are slugs: "Mary-Ann Smith - Drawings" -> "mary-ann-smith" and "mary-ann".
const slug = x => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const agentCache = new Map();
function readPart(p, start, len) {
  const fd = fs.openSync(p, "r");
  try { const b = Buffer.alloc(len); return b.slice(0, fs.readSync(fd, b, 0, len, start)).toString("utf8"); } finally { fs.closeSync(fd); }
}
function agentIndex(dir) {
  if (!dir) return [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".md")).sort(); } catch (e) { return []; }
  const out = [];
  for (const fn of names) {
    const p = path.join(dir, fn);
    let st;
    try { st = fs.lstatSync(p); if (!st.isFile()) continue; } catch (e) { continue; }
    const c = agentCache.get(p);
    if (c && c.m === st.mtimeMs) { out.push(c.a); continue; }
    let head = "";
    try { head = readPart(p, 0, 2000); } catch (e) { continue; }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head), f = fm ? fm[1] : "";
    const field = k => ((new RegExp("^" + k + ":[ \\t]*(.+)$", "m").exec(f) || [])[1] || "").trim().replace(/^["']|["']$/g, "");
    const base = fn.slice(0, -3), nm = field("name"), desc = field("description");
    const lead = (/^([A-Z0-9][\w'-]*(?: [A-Z0-9][\w'-]*){0,3})(?:,| -| \(| is )/.exec(desc) || [])[1] || "";
    const a = { file: p, base, name: nm || base, lead, desc: desc.slice(0, JOB_MAX), memory: field("memory").toLowerCase(),
                keys: [...new Set([slug(base), slug(nm), slug(lead)].filter(Boolean))] };
    agentCache.set(p, { m: st.mtimeMs, a });
    out.push(a);
  }
  return out;
}
function memberKeys(name) {
  const head = String(name).split(" - ")[0].split(" (")[0].trim();
  return [...new Set([slug(head), slug(head.split(/\s+/)[0])].filter(Boolean))];
}
const squeeze = k => k.replace(/-/g, "");
const MATCH_TESTS = [
  (m, k) => m === k,
  (m, k) => m.startsWith(k + "-") || k.startsWith(m + "-"),
  (m, k) => squeeze(m) === squeeze(k),
  (m, k) => { const a = squeeze(m), b = squeeze(k); return Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)); }];
/** The agent file for a member name (or null). wanted = the "agent" value from the members file, if any. */
function matchAgent(name, idx, wanted) {
  if (!idx || !idx.length) return null;
  if (wanted) { const w = slug(String(wanted).replace(/\.md$/i, "")); const a = idx.find(x => x.keys.includes(w)); if (a) return a; }
  const mk = memberKeys(name);
  for (const t of MATCH_TESTS) for (const m of mk) { const a = idx.find(x => x.keys.some(k => t(m, k))); if (a) return a; }
  return null;
}

// ---- working window: helper (subagent) transcripts <project>/<session>/subagents/agent-*.jsonl and their .meta.json
// ({agentType, description, finished}). Read: the first 6000 bytes (the brief) and the last 256 KB (steps, hand-back).
const HELPER_SECS = 120, RUN_SECS = 900, ACT_HOURS = 24, ACT_FILES = 60, ACT_TAIL = 262144, STEP_MAX = 160, LINE_MAX = 220;
const actCache = new Map();
const oneLine = (t, n) => { const l = String(t || "").split(/\r?\n/).map(x => x.trim()).find(Boolean) || ""; return l.length > n ? l.slice(0, n - 1) + "…" : l; };
function jsonString(raw) {
  raw = raw.slice(0, 3000).replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
  try { return JSON.parse('"' + raw + '"'); } catch (e) { return ""; }
}
function stepText(item) {
  const i = item.input || {};
  if (typeof i.description === "string" && i.description.trim()) return i.description.trim();
  const f = [i.file_path, i.path, i.notebook_path, i.pattern, i.url, i.query].find(x => typeof x === "string" && x);
  return item.name + (f ? " " + (/[\\/]/.test(f) && !/^https?:/.test(f) ? path.basename(f) : f) : "");
}
function helperInfo(p, st) {
  const c = actCache.get(p);
  if (c && c.m === st.mtimeMs && c.s === st.size) return c.i;
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(p.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch (e) { meta = null; }
  let head = "", tail = "";
  try { head = readPart(p, 0, 6000); tail = st.size > 6000 ? readPart(p, Math.max(0, st.size - ACT_TAIL), Math.min(ACT_TAIL, st.size)) : head; }
  catch (e) { return null; }
  const bm = /"content":"((?:[^"\\]|\\.)*)/.exec(head), brief = bm ? jsonString(bm[1]) : "";
  const tm = /"timestamp":"([^"]+)"/.exec(head), you = (/\bYou are ([A-Z][\w'-]*(?: [A-Z][\w'-]*)?)/.exec(brief) || [])[1] || "";
  const steps = [];
  let handback = null, lastText = null, lastTs = "";
  const lines = tail.split("\n");
  if (st.size > ACT_TAIL) lines.shift();
  for (const line of lines) {
    if (!line.includes('"type":"assistant"')) continue;
    let e;
    try { e = JSON.parse(line); } catch (x) { continue; }
    if (e.type !== "assistant" || !e.timestamp) continue;
    lastTs = e.timestamp;
    for (const item of ((e.message || {}).content || [])) {
      if (!item) continue;
      if (item.type === "tool_use" && item.name === "SubagentHandback") handback = { ts: e.timestamp, text: String((item.input || {}).message || "") };
      else if (item.type === "tool_use") steps.push({ ts: e.timestamp, text: oneLine(stepText(item), STEP_MAX) });
      else if (item.type === "text" && String(item.text || "").trim()) lastText = { ts: e.timestamp, text: item.text };
    }
  }
  const m = meta && typeof meta === "object" ? meta : {};
  const hb = handback || (m.finished === true && lastText) || null;
  const i = { agentType: typeof m.agentType === "string" ? m.agentType : "", builtIn: m.isBuiltIn === true, hasMeta: !!meta,
              task: typeof m.description === "string" ? oneLine(m.description, LINE_MAX) : "", finished: m.finished === true || !!handback,
              you, brief: oneLine(brief, LINE_MAX), briefTs: tm ? tm[1] : "", steps: steps.slice(-6), lastTs,
              handback: hb ? { ts: hb.ts, text: oneLine(hb.text, LINE_MAX) } : null };
  actCache.set(p, { m: st.mtimeMs, s: st.size, i });
  return i;
}
function helperFiles(dirs) {
  const out = [], cutoff = Date.now() - ACT_HOURS * 3600000;
  for (const dir of dirs) {
    let sess = [];
    try { sess = fs.readdirSync(dir); } catch (e) { continue; }
    for (const s of sess) {
      const sub = path.join(dir, s, "subagents");
      let files = [];
      try { files = fs.readdirSync(sub); } catch (e) { continue; }
      for (const fn of files) {
        if (!fn.endsWith(".jsonl")) continue;
        const p = path.join(sub, fn);
        try { const st = fs.statSync(p); if (st.isFile() && st.mtimeMs >= cutoff) out.push({ p, st, parent: s }); } catch (e) { continue; }
      }
    }
  }
  return out.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, ACT_FILES);
}
/** 0.5.3: helpers started from a session in ANY other project folder (~/.claude/projects/*), so a card lights
 *  wherever the coordinator's session was started. Stat only; a file is kept (and later read) only when it was
 *  written inside the window: RUN_SECS when Claude Code wrote a .meta.json beside it (seen in the folder listing, no
 *  extra read), else HELPER_SECS. skip = the project folders helperFiles already reads. */
function runningElsewhere(skip) {
  const out = [], now = Date.now();
  let names = [];
  try { names = fs.readdirSync(PROJECTS); } catch (e) { return out; }
  for (const n of names) {
    const dir = path.join(PROJECTS, n);
    if (skip.has(dir)) continue;
    let sess = [];
    try { sess = fs.readdirSync(dir); } catch (e) { continue; }
    for (const s of sess) {
      if (s.endsWith(".jsonl")) continue;
      const sub = path.join(dir, s, "subagents");
      let files = [];
      try { files = fs.readdirSync(sub); } catch (e) { continue; }
      for (const fn of files) {
        if (!fn.endsWith(".jsonl")) continue;
        const p = path.join(sub, fn), secs = files.includes(fn.replace(/\.jsonl$/, ".meta.json")) ? RUN_SECS : HELPER_SECS;
        try { const st = fs.statSync(p); if (st.isFile() && st.mtimeMs >= now - secs * 1000) out.push({ p, st, parent: s, elsewhere: true }); } catch (e) { continue; }
      }
    }
  }
  return out;
}
/** The card for a helper's agentType when no agent file matched: the card id equal to the type ("gold-2"), else the
 *  type's first part ("babu-frik" -> "babu", "gold-leader" -> "gold"). */
function cardForType(members, type) {
  const t = String(type || "").trim().toLowerCase();
  if (!t) return null;
  const head = t.split(/[-_\s]+/)[0];
  return members.find(m => memberId(m.name) === t) || (head ? members.find(m => firstWord(m.name) === head) : null) || null;
}
const firstWord = n => (String(n).split(" - ")[0].split(" (")[0].trim().split(/\s+/)[0] || "").toLowerCase();
function addAgentCards(members, mk, idx, wantedOf) {
  for (const a of idx) {
    if (members.some(m => matchAgent(m.name, idx, wantedOf(m.name)) === a)) continue;
    const n = a.base.toLowerCase();
    members.push(mk(n[0].toUpperCase() + n.slice(1), a.desc));
  }
}

/** cfg: {boardFile, privateMembers[], scope: "workspace"|"all", workspaceFolders[], avatarsFolder, membersFile, agentCards}
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
  // a session that still has its default title (the folder slug, e.g. "my-project" or "my-project-e4") and is not on
  // the board is hidden unless showUnnamedSessions is on
  const slugs = new Set([...folders, ...Object.values(teamLive).map(d => d.cwd || "")].map(p => path.basename(String(p || "")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean));
  const unnamed = d => { const n = String(d.name || "").trim().toLowerCase(); if (!n) return true; const base = n.replace(/-[0-9a-z]{1,8}$/, ""); return slugs.has(n) || slugs.has(base); };
  for (const [sid, d] of Object.entries(teamLive)) if (!used.has(sid) && (cfg.showUnnamedSessions || !unnamed(d))) members.push(member(d.name || sid.slice(0, 8), b.found ? "(not on the board)" : "", d, sid, b));
  const settings = loadSettings(cfg.membersFile), idx = agentIndex(cfg.agentsDir === undefined ? AGENTS : cfg.agentsDir);
  const wantedOf = n => { const s = settings[memberId(n)]; return s && typeof s.agent === "string" ? s.agent : ""; };
  if (cfg.agentCards) addAgentCards(members, (n, j) => member(n, j, null, null, b), idx, wantedOf);
  // 0.5.1: a card made with Add team member (members.json "added") shows at once, until the board has a row for it
  for (const [k, s] of Object.entries(settings)) {
    const a = s.added;
    if (!a || typeof a !== "object" || typeof a.name !== "string" || !a.name.trim() || memberId(a.name) !== k) continue;
    if (members.some(m => memberId(m.name) === k)) continue;
    const m = member(a.name.trim().slice(0, NAME_MAX), typeof a.job === "string" ? a.job.slice(0, JOB_MAX) : "", null, null, b);
    m.extra = "new: waiting for your coordinator to set it up"; m.added = true;
    members.push(m);
  }
  // the team leader (setting leaderName): the card with that name or edit-panel name, else the row whose job says
  // coordinator or leader, else a new ready card
  const lname = String(cfg.leaderName || "").trim().slice(0, NAME_MAX), lid = lname ? memberId(lname) : "";
  let leader = null;
  if (lid) {
    const shown = m => { const s = settings[memberId(m.name)]; return s && typeof s.name === "string" ? s.name.trim().toLowerCase() : ""; };
    leader = members.find(m => memberId(m.name) === lid || shown(m) === lname.toLowerCase())
      || members.find(m => /coordinat|\bleader\b|\blead\b/i.test(m.job || "")) || null;
    if (!leader) { leader = member(lname, String(cfg.leaderRole || "the team leader and coordinator").slice(0, JOB_MAX), null, null, b); members.unshift(leader); }
  }
  for (const m of members) { m.leader = m === leader; if (m.status === "closed") m.status = "ready"; }
  const teamDefs = teamList(cfg.teams), roleDefs = roleList(cfg.roles);
  const avDir = expandHome(cfg.avatarsFolder), pics = ownPictures(avDir), files = picFiles(avDir), choices = [];
  if (picUri) for (const f of Object.keys(files)) choices.push({ file: f, url: picUri(files[f].p) + "?v=" + files[f].v });
  lastMembers.clear();
  for (const m of members) {
    const mid = memberId(m.name), st = settings[mid] || {};
    m.id = mid; m.style = ""; m.display = (typeof st.name === "string" && st.name.length > 0 && st.name.length <= NAME_MAX) ? st.name : "";
    const tm = typeof st.team === "string" ? teamDefs.find(t => t.name.toLowerCase() === st.team.toLowerCase()) : null;
    m.team = tm ? tm.name : ""; m.role = typeof st.role === "string" && roleDefs.includes(st.role) ? st.role : ""; m.teamLead = false;
    m.rev = memberRev(settings[mid]);
    const ag = matchAgent(m.name, idx, wantedOf(m.name));
    m.agent = ag ? ag.base : "";
    lastMembers.set(mid, { name: m.name, wanted: wantedOf(m.name) });
    const av = typeof st.avatar === "string" ? st.avatar : "";
    m.avatar = (av.startsWith("style:") && STYLES.includes(av.slice(6))) || (av.startsWith("pic:") && files[av.slice(4)]) ? av : "auto";
    if (m.avatar.startsWith("style:")) { m.style = m.avatar.slice(6); continue; }
    if (m.avatar.startsWith("pic:")) { const c = choices.find(x => x.file === m.avatar.slice(4)); m.pic = c ? c.url : ""; continue; }
    const n = m.name.trim().toLowerCase(), keys = [n, n.split(" - ")[0].split(" (")[0].trim(), n.split(/\s+/)[0]];
    const hit = keys.map(k => k && pics[k]).find(Boolean);
    if (hit && picUri) m.pic = picUri(hit.p) + "?v=" + hit.v;
  }
  const priv = (cfg.privateMembers || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const isPriv = n => priv.some(p => String(n || "").toLowerCase().includes(p));
  for (const m of members) m.private = isPriv(m.name) || isPriv(m.display);
  const teams = teamGroups(members, teamDefs);
  const privSids = new Set(members.filter(m => m.sid && m.private).map(m => m.sid));
  const titleNames = {};
  for (const sid of new Set([...titles.keys(), ...Object.keys(names)])) titleNames[sid] = names[sid] || titles.get(sid) || sid.slice(0, 8);
  for (const m of members) if (m.sid) titleNames[m.sid] = m.name;
  const byName = n => { const f = firstWord(n); return members.find(m => m.name === n || m.display === n) || members.find(m => f && firstWord(m.name) === f) || null; };
  const msgs = [];   // {ts, from, to, text, kind, fromId?, toId?}
  // helpers (subagents): who works now, their steps, the brief from the coordinator and the hand-back
  const working = [], steps = [], helperIds = {}, busyParents = new Set();
  const tokHelpers = [];   // 0.5.1 token use: each helper transcript and the card it belongs to ("" = no card)
  for (const { p, st, parent, elsewhere } of [...helperFiles(dirs), ...runningElsewhere(inScope)]) {
    const h = helperInfo(p, st);
    if (!h) continue;
    const a = h.agentType && !h.builtIn ? idx.find(x => x.keys.includes(slug(h.agentType))) : null;
    const m = (a && members.find(x => matchAgent(x.name, idx, wantedOf(x.name)) === a))
      || (h.agentType && !h.builtIn ? cardForType(members, h.agentType) : null) || (h.you && byName(h.you)) || null;
    const who = m ? (m.display || m.name) : (h.you || (a ? a.name : h.agentType ? "helper (" + h.agentType + ")" : "helper"));
    const pm = members.find(x => x.sid === parent) || null, boss = pm ? (pm.display || pm.name) : (titleNames[parent] || "coordinator");
    const hide = (m && m.private) || isPriv(who) || isPriv(h.task) || isPriv(h.you) || isPriv(h.agentType);
    const age = Date.now() - st.mtimeMs, running = !h.finished && age < (h.hasMeta ? RUN_SECS : HELPER_SECS) * 1000;
    const last = h.steps[h.steps.length - 1];
    helperIds[path.basename(p, ".jsonl").replace(/^agent-/, "")] = { who, id: m ? m.id : "", hide };
    if (!elsewhere) tokHelpers.push({ p, id: m ? m.id : "" });
    if (running) {
      busyParents.add(parent);
      working.push({ who, id: m ? m.id : "", task: hide ? "(private)" : h.task, step: hide ? "" : (last ? last.text : "starting"),
                     time: last ? fmt(new Date(last.ts)) : fmt(new Date(st.mtimeMs)), ts: last ? last.ts : new Date(st.mtimeMs).toISOString() });
      if (m && (m.status === "ready" || m.status === "idle")) {
        // 0.5.3: the task from .meta.json (description) first, then the latest step
        m.status = "working"; m.since = fmt(new Date(st.mtimeMs));
        m.extra = hide ? "helper running" : (h.task ? oneLine(h.task + (last ? " · " + last.text : ""), LINE_MAX) : (last ? last.text : "helper running"));
      }
    }
    if (elsewhere) continue;   // 0.5.3: a helper from another project lights its card and the working list only
    if (!hide) for (const s of h.steps) steps.push({ ts: s.ts, time: fmt(new Date(s.ts)), who, text: s.text });
    if (h.briefTs) msgs.push({ ts: h.briefTs, from: boss, to: who, text: hide ? "(private)" : (h.task ? h.task + ": " : "") + h.brief, kind: "brief", fromId: pm ? pm.id : "", toId: m ? m.id : "" });
    if (h.handback) msgs.push({ ts: h.handback.ts, from: who, to: boss, text: hide ? "(private)" : h.handback.text, kind: "report", fromId: m ? m.id : "", toId: pm ? pm.id : "" });
  }
  for (const f of [...feed.values()].filter(x => inScope.has(x.dir))) {
    const raw = f.to_raw.replace("uds:", "");
    let toName = sockets[raw] || (helperIds[raw] ? helperIds[raw].who : raw);
    for (const m of members) if (m.sid && live[m.sid] && live[m.sid].name === toName) toName = m.name;
    const frm = titleNames[f.from_sid] || f.from_sid.slice(0, 8);
    const hide = privSids.has(f.from_sid) || isPriv(toName) || isPriv(frm) || (helperIds[raw] && helperIds[raw].hide);
    msgs.push({ ts: f.ts, from: frm, to: toName, text: hide ? "(private)" : f.first, kind: "message", ...(helperIds[raw] ? { toId: helperIds[raw].id } : {}) });
  }
  const desc = (a, c) => (a.ts < c.ts ? 1 : a.ts > c.ts ? -1 : 0);
  const out = [], links = [];
  for (const x of msgs.sort(desc).slice(0, 150)) {
    const d = new Date(x.ts);
    const fm = x.fromId !== undefined ? members.find(m => m.id && m.id === x.fromId) : byName(x.from);
    const tm = x.toId !== undefined ? members.find(m => m.id && m.id === x.toId) : byName(x.to);
    out.push({ time: isNaN(d) ? x.ts : fmt(d), ts: x.ts, from: x.from, to: x.to, text: x.text, kind: x.kind });
    if (fm && tm && fm !== tm && !isNaN(d)) links.push({ from: fm.id, to: tm.id, ts: d.getTime(), kind: x.kind });
  }
  condenseInfo(members, dirs, b.waiting, cfg.condenseTokens, busyParents);
  // 0.5.1 saved settings whose key matches no card: kept in members.json and listed, never dropped
  const cardIds = new Set(members.map(m => m.id)), orphans = Object.entries(settings).filter(([k]) => !cardIds.has(k)).map(([k, v]) => ({ key: k,
    name: typeof v.name === "string" ? v.name : (v.added && typeof v.added.name === "string" ? v.added.name : ""), team: typeof v.team === "string" ? v.team : "",
    role: typeof v.role === "string" ? v.role : "", avatar: typeof v.avatar === "string" ? v.avatar : "" }));
  lastTok = { dirs, helpers: tokHelpers, members: members.map(m => ({ id: m.id, name: m.display || m.name, sid: m.sid || "", team: m.team || "", private: !!m.private })) };
  const log = b.log.slice(-40).reverse().map(l => ({ date: l.date, who: l.who, text: isPriv(l.who) || isPriv(l.text) ? "(private)" : l.text }));
  const now = new Date();
  // a team window (setting team): the swarm leader + that team's cards; the board, feed and log stay swarm-wide
  // a parent team's window also shows its sub-teams
  const vt = viewTeam(teams, cfg.team), subs = vt ? teams.filter(t => t.parent === vt.name) : [];
  const keepIds = vt ? new Set([...vt.ids, ...subs.flatMap(t => t.ids), ...members.filter(m => m.leader).map(m => m.id)]) : null;
  const shownMembers = keepIds ? members.filter(m => keepIds.has(m.id)) : members;
  const shownTeams = vt ? [vt, ...subs] : teams;
  const shownLinks = keepIds ? links.filter(l => keepIds.has(l.from) && keepIds.has(l.to)) : links;
  const shownWorking = keepIds ? working.filter(w => w.id && keepIds.has(w.id)) : working;
  return { updated: `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`, now: now.getTime(), holder: b.holder, waiting: b.waiting,
           view: vt ? vt.name : "", viewMissing: !vt && !!String(cfg.team || "").trim() ? String(cfg.team).trim() : "",
           board: b.found, members: shownMembers, feed: out, links: shownLinks.slice(0, 80), working: shownWorking.sort(desc), steps: steps.sort(desc).slice(0, 40), log,
           orphans, pics: choices, styles: STYLES, avatarsSet: !!avDir, leaderName: lname, teams: shownTeams, allTeams: teams.map(t => t.name), teamParents: Object.fromEntries(teams.filter(t => t.parent).map(t => [t.name, t.parent])), roles: roleDefs };
}

// ---- edit panel: name and avatar (members.json), task and role instructions (a request file for the coordinator)
const memberId = name => { const w = String(name).trim().toLowerCase().split(" - ")[0].split(" (")[0].split(/\s+/); return w[0] || ""; };
const stamp = () => { const d = new Date(), day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return { file: `${day} ${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`, iso: `${day}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` }; };
function loadSettings(file) {
  if (!file) return {};
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8")), out = {};
    if (d && typeof d === "object" && !Array.isArray(d)) for (const k of Object.keys(d)) if (d[k] && typeof d[k] === "object") out[k] = d[k];
    return out;
  } catch (e) { return {}; }
}
// exact file names in the avatars folder: { "Coordinator.png": { p, v } }
function picFiles(dir) {
  const out = {};
  if (!dir) return out;
  let names = [];
  try { names = fs.readdirSync(dir).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1); } catch (e) { return out; }
  for (const fn of names) {
    if (!PIC_TYPES.includes(path.extname(fn).toLowerCase())) continue;
    const p = path.join(dir, fn);
    try { const st = fs.lstatSync(p); if (st.isFile() && st.size <= PIC_MAX) out[fn] = { p, v: Math.floor(st.mtimeMs) }; } catch (e) { continue; }
  }
  return out;
}
const squash = (t, limit) => {
  if (typeof t !== "string") return null;
  t = t.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length <= limit ? t : null;
};
const multiline = (t, limit) => {
  if (typeof t !== "string") return null;
  t = t.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return t.length <= limit ? t : null;
};
function agentOf(mid, agentsDir) {
  const lm = lastMembers.get(mid);
  return matchAgent(lm ? lm.name : mid, agentIndex(agentsDir || AGENTS), lm ? lm.wanted : "");
}
function roleBody(mid, agentsDir) {
  const a = agentOf(mid, agentsDir);
  if (!a) return { found: false, body: "", agent: "" };
  try {
    const text = fs.readFileSync(a.file, "utf8").slice(0, 200000).replace(/\r\n/g, "\n");
    return { found: true, body: text.replace(/^---\n[\s\S]*?\n---\n/, "").trim(), agent: path.basename(a.file) };
  } catch (e) { return { found: false, body: "", agent: "" }; }
}
function roleInfo(mid, agentsDir) {
  const r = roleBody(mid, agentsDir), tooLong = r.body.length > ROLE_MAX;
  return { id: mid, found: r.found, agent: r.agent, body: tooLong ? "" : r.body, too_long: tooLong, limit: ROLE_MAX };
}

// ---- brain: the member's own Markdown notes. First choice: Claude Code's own subagent memory (agent file
// "memory: user | project | local" -> ~/.claude/agent-memory/<agent name>/MEMORY.md, <project>/.claude/agent-memory/
// <agent name>/MEMORY.md, <project>/.claude/agent-memory-local/<agent name>/MEMORY.md). Else <brainsFolder>/<member>.md.
const BRAIN_SHOW = 25000, BRAIN_LINES = 200;
const safeAgentName = n => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(n) && !n.includes("..") ? n : "";
function brainFor(mid, opts) {
  opts = opts || {};
  const lm = lastMembers.get(mid), a = agentOf(mid, opts.agentsDir), folders = opts.workspaceFolders || [];
  const an = a ? safeAgentName(a.name) || safeAgentName(a.base) : "";
  if (an) {
    const scopes = { user: [path.join(opts.claudeDir || CLAUDE, "agent-memory", an)],
                     project: folders.map(f => path.join(f, ".claude", "agent-memory", an)),
                     local: folders.map(f => path.join(f, ".claude", "agent-memory-local", an)) };
    const order = [a.memory, "user", "project", "local"].filter((x, i, l) => scopes[x] && l.indexOf(x) === i);
    for (const s of order) for (const d of scopes[s]) {
      const f = path.join(d, "MEMORY.md");
      try { if (fs.statSync(f).isFile()) return { file: f, kind: "native", scope: s, exists: true }; } catch (e) { /* next */ }
    }
    if (scopes[a.memory] && scopes[a.memory].length) return { file: path.join(scopes[a.memory][0], "MEMORY.md"), kind: "native", scope: a.memory, exists: false };
  }
  const dir = expandHome(opts.brainsFolder), key = memberKeys(lm ? lm.name : mid)[0] || slug(mid);
  if (!dir || !key) return null;
  const f = path.join(dir, key + ".md");
  let exists = false;
  try { exists = fs.statSync(f).isFile(); } catch (e) { exists = false; }
  return { file: f, kind: "panel", scope: "", exists };
}
function brainInfo(mid, opts, hidden) {
  const b = brainFor(mid, opts);
  if (!b) return { id: mid, found: false, file: "", kind: "", text: "" };
  let text = "";
  if (b.exists && !hidden) {
    try {
      text = fs.readFileSync(b.file, "utf8").slice(0, BRAIN_SHOW).replace(/\r\n/g, "\n").split("\n").slice(0, BRAIN_LINES).join("\n");
    } catch (e) { text = ""; }
  }
  return { id: mid, found: true, file: b.file, kind: b.kind, scope: b.scope, exists: b.exists, private: !!hidden, text };
}
/** 0.5.1 "Open brain folder" (Simon, 21 Nov): the folder of the member's brain. When it is not there yet it is made,
 * with an empty MEMORY.md (or the panel's brain file), never over a file. Returns { ok, dir, made, msg }. */
function brainFolder(mid, opts) {
  const b = brainFor(mid, opts);
  if (!b || !b.file) return { ok: false, msg: "No brain place for this member." };
  const dir = path.dirname(b.file);
  let made = false;
  try {
    if (!fs.existsSync(b.file)) {
      fs.mkdirSync(dir, { recursive: true });
      const lm = lastMembers.get(mid);
      fs.writeFileSync(b.file, b.kind === "panel" ? `# ${lm ? lm.name : mid}: brain

` : "", { encoding: "utf8", flag: "wx" });
      made = true;
    }
  } catch (e) { if (e.code !== "EEXIST") return { ok: false, msg: "Not made: " + (e.code || "write error") + "." }; }
  return { ok: true, dir, made, msg: made ? "Brain folder made (empty " + path.basename(b.file) + ") and opened." : "Brain folder opened." };
}
/** Makes an EMPTY brain file in the brains folder (never in Claude Code's own memory folders, never over a file). */
function createBrain(mid, opts) {
  const b = brainFor(mid, opts);
  if (!b || b.kind !== "panel") return { ok: false, msg: "Not made: this member's brain is kept by Claude Code." };
  if (b.exists) return { ok: false, msg: "The brain file is there already." };
  const lm = lastMembers.get(mid);
  try {
    fs.mkdirSync(path.dirname(b.file), { recursive: true });
    fs.writeFileSync(b.file, `# ${lm ? lm.name : mid}: brain\n\n`, { encoding: "utf8", flag: "wx" });
  } catch (e) { return { ok: false, msg: "Not made: " + (e.code || "write error") + "." }; }
  return { ok: true, msg: "Empty brain file made." };
}

// ---- safe file names for copied files: letters, digits, space, _ and - only; never over a file
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
function safeName(src, fallback) {
  let base = path.basename(String(src || ""), path.extname(String(src || ""))).normalize("NFKD")
    .replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  if (!base) base = fallback;
  if (RESERVED.test(base)) base += " file";
  return base;
}
function freeName(dir, base, ext) {
  let fn = base + ext, n = 1;
  while (fs.existsSync(path.join(dir, fn))) fn = `${base} (${++n})${ext}`;
  return fn;
}
const MAGIC = { ".png": b => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
                ".jpg": b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
                ".webp": b => b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP" };
/** 0.5.1 Botify: saves the cartoon avatar the dashboard drew (an SVG made by the page itself) as a NEW file in the
 * avatars folder ("BOTIFY <name>.svg", never over a file). Only plain drawing is accepted: no script, no event
 * attributes, no links or embedded files, max 200 KB. The photo it was made from never leaves the page. */
const BOT_MAX = 200000;
function saveBotify(svg, name, avatarsFolder) {
  const dir = expandHome(avatarsFolder);
  if (!dir) return { ok: false, msg: "Not saved: no avatars folder." };
  const t = String(svg || "");
  if (!t || t.length > BOT_MAX) return { ok: false, msg: "Not saved: the drawing is empty or too large." };
  if (!/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(t) || !/<\/svg>\s*$/.test(t)) return { ok: false, msg: "Not saved: not an avatar drawing." };
  if (/<script|<foreignObject|<image|<iframe|<use|\son[a-z]+\s*=|href\s*=|javascript:|data:|@import|url\((?!#)/i.test(t)) return { ok: false, msg: "Not saved: the drawing holds something other than shapes." };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fn = freeName(dir, safeName("BOTIFY " + String(name || "member") + ".svg", "BOTIFY avatar"), ".svg");
    fs.writeFileSync(path.join(dir, fn), t, { encoding: "utf8", flag: "wx" });
    return { ok: true, file: fn, msg: "Avatar made: " + fn + ". Click Save to keep it for this member." };
  } catch (e) { return { ok: false, msg: "Not saved: " + (e.code || "write error") + "." }; }
}
/** Upload picture: copies one PNG, JPEG or WebP (max 2 MB, checked by its first bytes) into the avatars folder. */
function savePicture(src, avatarsFolder) {
  const dir = expandHome(avatarsFolder);
  if (!dir) return { ok: false, msg: "Not added: no avatars folder." };
  let ext = path.extname(String(src || "")).toLowerCase();
  if (ext === ".jpeg") ext = ".jpg";
  if (!UPLOAD_TYPES.includes(ext)) return { ok: false, msg: "Not added: use a .png, .jpg or .webp picture." };
  let buf;
  try {
    const st = fs.statSync(src);
    if (!st.isFile()) return { ok: false, msg: "Not added: not a file." };
    if (st.size > UPLOAD_MAX) return { ok: false, msg: "Not added: the picture is larger than 2 MB." };
    buf = fs.readFileSync(src);
  } catch (e) { return { ok: false, msg: "Not added: " + (e.code || "read error") + "." }; }
  if (!MAGIC[ext](buf)) return { ok: false, msg: "Not added: the file is not a real " + ext.slice(1).toUpperCase() + " picture." };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fn = freeName(dir, safeName(src, "picture"), ext);
    fs.writeFileSync(path.join(dir, fn), buf, { flag: "wx" });
    return { ok: true, file: fn, msg: "Picture added: " + fn + ". Click Save to keep it for this member." };
  } catch (e) { return { ok: false, msg: "Not added: " + (e.code || "write error") + "." }; }
}

// ---- digest: "learn this" for a member. One request file "DIGEST <time>.json" (+ an attached file copied into
// "<requests>/digest files/") for the coordinator. The panel never writes the agent file or the brain.
const SOURCE_MAX = 20000, NOTE_MAX = 300, ATTACH_MAX = 10000000;
function digestRequest(data, known, opts, attachPath) {
  opts = opts || {};
  const d = data && typeof data === "object" ? data : {}, mid = d.member, reqDir = expandHome(opts.requestsFolder);
  if (!reqDir) return { ok: false, msg: "Not saved: no requests folder." };
  if (typeof mid !== "string" || !known.includes(mid)) return { ok: false, msg: "Not saved: unknown member." };
  const source = multiline(d.source === undefined ? "" : d.source, SOURCE_MAX), note = squash(d.note === undefined ? "" : d.note, NOTE_MAX);
  if (source === null) return { ok: false, msg: `Not saved: the text or link is longer than ${SOURCE_MAX} characters.` };
  if (note === null) return { ok: false, msg: `Not saved: the note must be one line of at most ${NOTE_MAX} characters.` };
  if (!source && !attachPath) return { ok: false, msg: "Not saved: paste a text or a link, or attach a file." };
  if (Date.now() - lastRequest < 5000) return { ok: false, msg: "Not saved: wait 5 seconds between requests." };
  const t = stamp(), lm = lastMembers.get(mid), a = agentOf(mid, opts.agentsDir), b = brainFor(mid, opts);
  let attachment = "";
  try {
    fs.mkdirSync(reqDir, { recursive: true });
    if (attachPath) {
      const st = fs.statSync(attachPath);
      if (!st.isFile()) return { ok: false, msg: "Not saved: the attachment is not a file." };
      if (st.size > ATTACH_MAX) return { ok: false, msg: "Not saved: the attachment is larger than 10 MB." };
      const adir = path.join(reqDir, "digest files"), ext = path.extname(attachPath).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
      fs.mkdirSync(adir, { recursive: true });
      const fn = freeName(adir, `${t.file} ${safeName(attachPath, "file")}`, ext);
      fs.copyFileSync(attachPath, path.join(adir, fn), fs.constants.COPYFILE_EXCL);
      attachment = "digest files/" + fn;
    }
    fs.writeFileSync(path.join(reqDir, `DIGEST ${t.file}.json`),
      JSON.stringify({ type: "digest", member: mid, name: lm ? lm.name : mid, agent_file: a ? path.basename(a.file) : "",
                       brain_file: b ? b.file : "", source, attachment, note, time: t.iso, from: "Rebel Bot Swarm" }, null, 2),
      { encoding: "utf8", flag: "wx" });
  } catch (e) { return { ok: false, msg: e.code === "EEXIST" ? "Not saved: wait a second and try again." : "Not saved: " + (e.code || "write error") + "." }; }
  lastRequest = Date.now();
  return { ok: true, msg: "Digest request saved for your coordinator" + (attachment ? " (with the file)" : "") };
}
/** 0.5.1 gives the saved settings of a key that matches no card to the card the user chose. members.json is backed up
 * first (writeMembers); the card keeps anything the saved settings do not set; the old key is removed. */
function moveSettings(from, to, known, opts) {
  const mf = opts && opts.membersFile;
  if (!mf) return { ok: false, msg: "Not moved: no members file." };
  if (typeof to !== "string" || !known.includes(to)) return { ok: false, msg: "Not moved: choose a card." };
  if (typeof from !== "string" || known.includes(from)) return { ok: false, msg: "Not moved: those settings already belong to a card." };
  let settings;
  try { settings = JSON.parse(fs.readFileSync(mf, "utf8")); } catch (e) { return { ok: false, msg: "Not moved: members file unreadable." }; }
  const src = settings[from];
  if (!src || typeof src !== "object") return { ok: false, msg: "Not moved: those settings are not there any more." };
  const merged = { ...(settings[to] && typeof settings[to] === "object" ? settings[to] : {}), ...src };
  delete merged.added;   // an Add-member note belongs to its old name only
  settings[to] = merged; delete settings[from];
  try { writeMembers(settings, mf); } catch (e) { return { ok: false, msg: "Not moved: " + (e.code || "write error") + "." }; }
  return { ok: true, msg: `Saved settings "${from}" now belong to this card (members.json backed up first).` };
}
function writeMembers(settings, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const bdir = path.join(path.dirname(file), "members backups");
    fs.mkdirSync(bdir, { recursive: true });
    const t = stamp().file;
    let b = path.join(bdir, `members BACKUP ${t}.json`), n = 1;
    while (fs.existsSync(b)) b = path.join(bdir, `members BACKUP ${t} (${++n}).json`);
    fs.copyFileSync(file, b, fs.constants.COPYFILE_EXCL);
  }
  const tmp = `${file}.${process.pid}.tmp`;   // own temp name per window: two windows never share it
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
let lastRequest = 0;
/** data: {member, name, avatar, task, role_instructions}; known: member ids the panel shows now.
 *  opts: {membersFile, requestsFolder, avatarsFolder, agentsDir}. The extension always passes a membersFile and a requestsFolder. */
function editMember(data, known, opts) {
  opts = opts || {};
  const mf = opts.membersFile, reqDir = expandHome(opts.requestsFolder), avDir = expandHome(opts.avatarsFolder);
  const d = data && typeof data === "object" ? data : {}, mid = d.member;
  if (!mf || !reqDir) return { ok: false, msg: "Not saved: no storage folder." };
  if (typeof mid !== "string" || !known.includes(mid)) return { ok: false, msg: "Not saved: unknown member." };
  const name = squash(d.name === undefined ? "" : d.name, NAME_MAX), task = squash(d.task === undefined ? "" : d.task, TASK_MAX);
  const role = multiline(d.role_instructions === undefined ? "" : d.role_instructions, ROLE_MAX);
  if (name === null) return { ok: false, msg: `Not saved: the name is longer than ${NAME_MAX} characters.` };
  if (task === null) return { ok: false, msg: `Not saved: the task must be one line of at most ${TASK_MAX} characters.` };
  if (role === null) return { ok: false, msg: `Not saved: the role instructions are longer than ${ROLE_MAX} characters.` };
  const av = d.avatar === undefined ? "auto" : d.avatar;
  const picOk = typeof av === "string" && av.startsWith("pic:") && !!picFiles(avDir)[av.slice(4)];
  if (!(av === "auto" || (typeof av === "string" && av.startsWith("style:") && STYLES.includes(av.slice(6))) || picOk)) return { ok: false, msg: "Not saved: unknown avatar." };
  const settings = loadSettings(mf), entry = {}, old = settings[mid] || {};
  // shared file, several windows: refuse a save based on an older copy of this member (another window saved since)
  if (typeof d.rev === "string" && d.rev && d.rev !== memberRev(settings[mid]))
    return { ok: false, msg: "Not saved: this member was changed in another window. Close and open the card again, then save." };
  if (typeof old.agent === "string" && old.agent) entry.agent = old.agent;   // the agent-file link stays
  if (old.added && typeof old.added === "object") entry.added = old.added;   // an Add team member card stays
  const team = d.team === undefined ? (typeof old.team === "string" ? old.team : "") : String(d.team || "");
  const rl = d.role === undefined ? (typeof old.role === "string" ? old.role : "") : String(d.role || "");
  if (team && !teamList(opts.teams).some(t => t.name === team)) return { ok: false, msg: "Not saved: unknown team." };
  if (rl && !roleList(opts.roles).includes(rl)) return { ok: false, msg: "Not saved: unknown role." };
  if (team) entry.team = team;
  if (rl) entry.role = rl;
  if (name) entry.name = name;
  if (av !== "auto") entry.avatar = av;
  const canon = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
  const changed = canon(entry) !== canon(old);
  const sendReq = !!task || (!!role && role !== roleBody(mid, opts.agentsDir).body);
  if (!changed && !sendReq) return { ok: false, msg: "Nothing to save: change the name, avatar, team, role, task or role instructions first." };
  if (Date.now() - lastRequest < 5000) return { ok: false, msg: "Not saved: wait 5 seconds between requests." };
  const done = [], t = stamp();
  try {
    if (changed) { if (Object.keys(entry).length) settings[mid] = entry; else delete settings[mid]; writeMembers(settings, mf); done.push("Name, avatar, team and role saved"); }
    if (sendReq) {
      fs.mkdirSync(reqDir, { recursive: true });
      fs.writeFileSync(path.join(reqDir, `EDIT MEMBER ${t.file}.json`),
        JSON.stringify({ member: mid, name, task, role_instructions: role, time: t.iso, from: "Rebel Bot Swarm" }, null, 2), { encoding: "utf8", flag: "wx" });
      done.push("Request saved for your coordinator");
    }
  } catch (e) { return { ok: false, msg: e.code === "EEXIST" ? "Not saved: wait a second and try again." : "Not saved: " + (e.code || "write error") + "." }; }
  lastRequest = Date.now();
  return { ok: true, msg: done.join(". ") };
}

/** Create team: put members with NO team yet into a team (one write, one backup). A member already in a team is left as it is.
 *  ids: member ids; opts: {membersFile, teams}. Returns {ok, msg, joined: [ids]}. */
function joinTeam(ids, team, opts) {
  opts = opts || {};
  const mf = opts.membersFile;
  if (!mf) return { ok: false, msg: "Not saved: no storage folder.", joined: [] };
  if (!teamList(opts.teams).some(t => t.name === team)) return { ok: false, msg: "Not saved: unknown team.", joined: [] };
  const want = [...new Set((Array.isArray(ids) ? ids : []).filter(x => typeof x === "string" && x))];
  if (!want.length) return { ok: true, msg: "No members chosen.", joined: [] };
  const settings = loadSettings(mf), joined = [];
  for (const mid of want) {
    const old = settings[mid] && typeof settings[mid] === "object" ? settings[mid] : {};
    if (typeof old.team === "string" && old.team && !(opts.from && old.team === opts.from)) continue;   // keep other teams exactly as they are (a sub-team may take from its parent: opts.from)
    settings[mid] = { ...old, team };
    joined.push(mid);
  }
  if (!joined.length) return { ok: true, msg: "Those members are in a team already: nothing changed.", joined };
  try { writeMembers(settings, mf); }
  catch (e) { return { ok: false, msg: "Not saved: " + (e.code || "write error") + ".", joined: [] }; }
  return { ok: true, msg: `${joined.length} member${joined.length === 1 ? "" : "s"} added to ${team}.`, joined };
}

// ADD TEAM MEMBER: one file "NEW MEMBER <yyyy-mm-dd HHMMSS>.json" in the requests folder.
// The file name uses the time only; JSON.stringify escapes the typed text.
function clean(t, limit) {
  if (typeof t !== "string") return null;
  t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return t && t.length <= limit ? t : null;
}
/** opts (0.5.1): {membersFile, known: ids of the cards shown now}. With a membersFile the new card is saved there too
 *  (members.json "added": {name, job, time}), so it shows on the dashboard at once. */
function newMemberRequest(data, requestsFolder, opts) {
  opts = opts || {};
  const dir = expandHome(requestsFolder);
  if (!dir) return { ok: false, msg: "Not saved: no requests folder." };
  const name = clean(data && data.name, NAME_MAX), job = clean(data && data.job, JOB_MAX);
  if (!name || !job) return { ok: false, msg: `Not saved: type a name (max ${NAME_MAX}) and the job (max ${JOB_MAX} characters).` };
  const id = memberId(name);
  if (!id || !MEMBER_ID.test(id)) return { ok: false, msg: "Not saved: start the name with a letter or a number, and use only letters, numbers, dots and dashes in its first word." };
  // a card is keyed by the first word of its name: a second card with the same first word cannot show on its own
  if ((opts.known || []).includes(id)) return { ok: false, msg: `Not saved: a card whose name starts with "${id}" is there already. Start the name with another word.` };
  if (Date.now() - lastRequest < 5000) return { ok: false, msg: "Not saved: wait 5 seconds between requests." };
  const t = stamp();
  if (opts.membersFile) {
    try {
      const settings = loadSettings(opts.membersFile), old = settings[id] || {};
      settings[id] = { ...old, added: { name, job, time: t.iso } };
      writeMembers(settings, opts.membersFile);
    } catch (e) { return { ok: false, msg: "Not saved: " + (e.code || "write error") + "." }; }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `NEW MEMBER ${t.file}.json`), JSON.stringify({ name, job, time: t.iso, from: "Rebel Bot Swarm" }, null, 2),
      { encoding: "utf8", flag: "wx" });
  } catch (e) {
    return { ok: false, msg: e.code === "EEXIST" ? "Not saved: wait a second and try again." : "Not saved: " + (e.code || "write error") + "." };
  }
  lastRequest = Date.now();
  return { ok: true, id, msg: opts.membersFile ? "Card added. Request saved for your coordinator" : "Request saved for your coordinator" };
}

/** Delete team (0.5.1): clear "team" from every member of that team (one write, one backup). Cards are kept.
 *  The teams setting itself is changed by the extension. Returns {ok, msg, left: [ids]}. */
function leaveTeam(team, opts) {
  opts = opts || {};
  const mf = opts.membersFile, n = String(team || "").trim().toLowerCase();
  if (!mf) return { ok: false, msg: "Not saved: no storage folder.", left: [] };
  if (!n) return { ok: false, msg: "Not saved: no team named.", left: [] };
  const settings = loadSettings(mf), left = [];
  for (const [mid, v] of Object.entries(settings)) {
    if (typeof v.team !== "string" || v.team.trim().toLowerCase() !== n) continue;
    const e = { ...v }; delete e.team;
    if (Object.keys(e).length) settings[mid] = e; else delete settings[mid];
    left.push(mid);
  }
  if (!left.length) return { ok: true, msg: "No member was in that team.", left };
  try { writeMembers(settings, mf); }
  catch (e) { return { ok: false, msg: "Not saved: " + (e.code || "write error") + ".", left: [] }; }
  return { ok: true, msg: `${left.length} member${left.length === 1 ? "" : "s"} left the team and kept their cards.`, left };
}

// ---- Teams (subgroups): setting teams = [{ name, leader, scope }], roles = extra role names. A member joins a team
// and gets a role in the edit panel (members.json "team", "role"). The swarm leader stays above all teams.
const MEMBER_ID = /^[a-z0-9][a-z0-9._-]{0,59}$/;   // the same keys Save team / Restore team keep
const TEAM_LEAD = "Team leader", TEAM_MAX = 12, HEX = /^#[0-9a-fA-F]{6}$/;
// 0.5.1 team colours: a team's own "color" (#rrggbb), else this list by its place in the teams setting
const TEAM_COLOURS = [["Red", "#e11d48"], ["Blue", "#2563eb"], ["Green", "#16a34a"], ["Amber", "#d97706"], ["Violet", "#7c3aed"], ["Cyan", "#0891b2"],
  ["Pink", "#db2777"], ["Lime", "#65a30d"], ["Orange", "#ea580c"], ["Indigo", "#4f46e5"], ["Teal", "#0d9488"], ["Purple", "#9333ea"]];
function teamList(v) {
  const out = [], seen = new Set();
  for (const t of Array.isArray(v) ? v : []) {
    const o = typeof t === "string" ? { name: t } : t && typeof t === "object" ? t : null;
    const name = o && typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (!name || seen.has(name.toLowerCase()) || out.length >= TEAM_MAX) continue;
    seen.add(name.toLowerCase());
    out.push({ name, leader: typeof o.leader === "string" ? o.leader.trim().slice(0, NAME_MAX) : "",
               scope: typeof o.scope === "string" ? o.scope.replace(/\s+/g, " ").trim().slice(0, 160) : "",
               color: typeof o.color === "string" && HEX.test(o.color.trim()) ? o.color.trim().toLowerCase() : "",
               parent: typeof o.parent === "string" ? o.parent.replace(/\s+/g, " ").trim().slice(0, 40) : "" });
  }
  // 0.5.1 sub-teams, one level: "parent" must name another team that has no parent itself, else it is ignored
  const top = new Map(out.map(t => [t.name.toLowerCase(), t]));
  const raw = new Map(out.map(t => [t.name, t.parent]));
  for (const t of out) {
    const p = t.parent ? top.get(t.parent.toLowerCase()) : null;
    t.parent = p && p !== t && !raw.get(p.name) ? p.name : "";
  }
  return out;
}
function roleList(v) {
  const out = [TEAM_LEAD];
  for (const r of Array.isArray(v) ? v : ["Member", "Specialist", "Helper"]) {
    const t = typeof r === "string" ? r.replace(/\s+/g, " ").trim().slice(0, 30) : "";
    if (t && !out.some(x => x.toLowerCase() === t.toLowerCase()) && out.length < 20) out.push(t);
  }
  return out;
}
/** Name keys of a card: name, edit-panel name and their short forms ("Ann Lee" of "Ann Lee - CAD"). */
const nameKeys = m => [m.name, m.display].filter(Boolean).flatMap(n => { const l = String(n).trim().toLowerCase(); return [l, l.split(" - ")[0].split(" (")[0].trim()]; });
/** Team leader = the card named in the team's "leader" setting (it joins the team), else the first team card with the
 * role Team leader. The swarm leader is never in a team. Returns [{ name, scope, leaderId, ids }] in setting order. */
function teamGroups(members, defs) {
  for (const m of members) if (m.leader) { m.team = ""; m.teamLead = false; }
  const out = [];
  for (const [k, t] of defs.entries()) {
    const want = t.leader.toLowerCase();
    let lead = want ? members.find(m => !m.leader && nameKeys(m).includes(want)) : null;
    if (lead && lead.team && lead.team !== t.name) lead = null;   // a card leads only its own team
    if (lead) lead.team = t.name;
    if (!lead) lead = members.find(m => m.team === t.name && m.role === TEAM_LEAD) || null;
    if (lead) { lead.teamLead = true; if (!lead.role) lead.role = TEAM_LEAD; }
    const ids = members.filter(m => m.team === t.name && m !== lead).map(m => m.id);
    out.push({ name: t.name, scope: t.scope, leader: t.leader, parent: t.parent, color: t.color || TEAM_COLOURS[k % TEAM_COLOURS.length][1], leaderName: lead ? (lead.display || lead.name) : t.leader,
               leaderId: lead ? lead.id : "", ids: lead ? [lead.id, ...ids] : ids });
  }
  // each sub-team straight after its parent team (colours were given by place in the setting, above)
  const tops = out.filter(t => !t.parent);
  return tops.flatMap(t => [t, ...out.filter(x => x.parent === t.name)]);
}
/** The team a window shows (workspace setting team), or null = the whole swarm. */
function viewTeam(teams, name) {
  const n = String(name || "").trim().toLowerCase();
  return n ? teams.find(t => t.name.toLowerCase() === n) || null : null;
}
/** A short version stamp of one member's saved settings: the page sends it back on Save, so a save made in another
 * window in the meantime is not overwritten (members.json is shared by all windows). */
const memberRev = o => crypto.createHash("md5").update(JSON.stringify(o && typeof o === "object" ? Object.keys(o).sort().map(k => [k, o[k]]) : [])).digest("hex").slice(0, 10);

// ---- Condense / Restart: a member's chat may be condensed (/compact) or restarted only when it is safe.
const CTX_TAIL = 600000, ctxCache = new Map();   // file -> { size, mtime, tokens }
/** Context size of a chat now: input + cache tokens of the last main-chain assistant reply (0 = not known). */
function contextTokens(sid, dirs) {
  if (!/^[0-9a-f-]{36}$/i.test(String(sid || ""))) return 0;
  for (const dir of dirs) {
    const file = path.join(dir, sid + ".jsonl");
    let st;
    try { st = fs.statSync(file); } catch (e) { continue; }
    const c = ctxCache.get(file);
    if (c && c.size === st.size && c.mtime === st.mtimeMs) return c.tokens;
    let tokens = 0, fd;
    try {
      const len = Math.min(st.size, CTX_TAIL), buf = Buffer.alloc(len);
      fd = fs.openSync(file, "r"); fs.readSync(fd, buf, 0, len, st.size - len);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (!ln.includes('"usage"') || !ln.includes('"assistant"')) continue;
        let e; try { e = JSON.parse(ln); } catch (x) { continue; }
        if (e.type !== "assistant" || e.isSidechain) continue;
        const u = (e.message || {}).usage;
        if (!u) continue;
        tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        break;
      }
    } catch (e) { tokens = 0; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (x) { /* closed */ } }
    ctxCache.set(file, { size: st.size, mtime: st.mtimeMs, tokens });
    return tokens;
  }
  return 0;
}
const STOP = new Set(["the", "and", "for", "new", "our", "your", "team", "all", "one", "two", "this", "that", "with", "from", "main", "chat", "task", "job", "app"]);
const JOB_OPEN = /\b(in progress|working on|doing|wip|started|running|busy)\b/i, JOB_DONE = /\b(done|finished|complete[d]?|handed back)\b/i;
/** Sets m.ctx (tokens), m.canCondense, m.condenseWhy (why not, or why now) and m.condenseNow (suggest it) on each card.
 * Safe = an open chat, no helper it started still running, status idle (no helper running, not waiting for you), no open board item names the member,
 * and the board job does not say it is still running. Suggest = safe and (context >= limit or the job says done). */
function condenseInfo(members, dirs, waiting, limit, busyParents) {
  const lim = Number(limit) > 0 ? Number(limit) : 250000;
  for (const m of members) {
    m.ctx = m.sid ? contextTokens(m.sid, dirs) : 0;
    // the member's short name ("Ann Lee" of "Ann Lee - CAD") or its first word, if that word is a real name
    const keys = [m.display, m.name].filter(Boolean).flatMap(n => { const s = String(n).split(" - ")[0].split(" (")[0].toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const f = s.split(" ")[0] || ""; return [s, f.length >= 3 && !STOP.has(f) ? f : ""]; }).filter(Boolean);
    const named = (waiting || []).some(w => { const t = " " + String(w).toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
      return keys.some(k => t.includes(" " + k + " ")); });
    const why = !m.sid ? "no open chat" : busyParents && busyParents.has(m.sid) ? "a helper it started is still running" : m.status !== "idle" ? `not idle (${m.status})` : m.extra ? "waiting: " + m.extra
      : named ? "an open board item names this member" : JOB_OPEN.test(m.job || "") && !JOB_DONE.test(m.job || "") ? "the board job is still running" : "";
    m.canCondense = !why;
    const big = m.ctx >= lim;
    m.condenseNow = m.canCondense && (big || JOB_DONE.test(m.job || ""));
    m.condenseWhy = why ? "Not safe now: " + why + "." : big ? `Chat is large (${Math.round(m.ctx / 1000)}k, limit ${Math.round(lim / 1000)}k): condense or restart to save tokens.`
      : m.condenseNow ? "Job done: condense or restart to save tokens." : "Safe to condense or restart.";
  }
}
/** Condense/Restart request for the leader (CONDENSE <time>.json): type, mode, member, session, context tokens. */
function condenseRequest(m, mode, requestsFolder) {
  const dir = expandHome(requestsFolder);
  if (!dir || !m) return { ok: false, msg: "Not saved: no requests folder or member." };
  const t = stamp(), body = JSON.stringify({ type: "condense", mode: mode === "restart" ? "restart" : "compact", member: m.display || m.name,
    session: m.sid || "", contextTokens: m.ctx || 0, time: t.iso, from: "Condense" }, null, 2);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, msg: "Not saved: " + ((e && e.message) || e.code || "folder error") }; }
  for (let n = 1; n <= 20; n++) {
    const file = `CONDENSE ${t.file}${n > 1 ? " " + n : ""}.json`;
    try { fs.writeFileSync(path.join(dir, file), body, { encoding: "utf8", flag: "wx" }); return { ok: true, file }; }
    catch (e) { if (!e || e.code !== "EEXIST") return { ok: false, msg: "Not saved: " + ((e && e.message) || e.code || "write error") }; }
  }
  return { ok: false, msg: "Not saved: 20 requests in one second." };
}

/** Decide: one request file for the leader, who watches the requests folder and asks the question in its own chat. */
function decideRequest(item, requestsFolder) {
  const dir = expandHome(requestsFolder), it = String(item || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  if (!dir || !it) return { ok: false, msg: "Not saved: no requests folder or item." };
  const t = stamp(), body = JSON.stringify({ type: "decide", item: it, time: t.iso, from: "Decide" }, null, 2);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, msg: "Not saved: " + ((e && e.message) || e.code || "folder error") }; }
  // Names have 1-second steps: a 2nd click in the same second gets " 2", " 3"... (never overwrites a file).
  for (let n = 1; n <= 20; n++) {
    const file = `DECIDE ${t.file}${n > 1 ? " " + n : ""}.json`;
    try { fs.writeFileSync(path.join(dir, file), body, { encoding: "utf8", flag: "wx" }); return { ok: true, file }; }
    catch (e) { if (!e || e.code !== "EEXIST") return { ok: false, msg: "Not saved: " + ((e && e.message) || e.code || "write error") }; }
  }
  return { ok: false, msg: "Not saved: 20 requests in one second." };
}

/** Text for comparing board items: no CR, markdown marks, list bullets or extra spaces; NFC; no trailing full stop. */
function normItem(s) {
  return String(s == null ? "" : s).normalize("NFC").replace(/\r/g, "").replace(/^\s*[-*+]\s+/, "").replace(/[*_`]/g, "")
    .replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "").toLowerCase();
}
/** Index of the clicked item in the board's open items now: the same index first, else the same text anywhere; -1 = gone. */
function findWaiting(waiting, k, item) {
  const list = Array.isArray(waiting) ? waiting : [], want = normItem(item), i = Number(k);
  if (!want) return -1;
  if (Number.isInteger(i) && i >= 0 && i < list.length && normItem(list[i]) === want) return i;
  return list.findIndex(w => normItem(w) === want);
}

/** Title in the last 2 MB of a transcript (Claude Code writes customTitle again often), "" if none. */
function tailTitle(file) {
  const key = Buffer.from('"customTitle":"');
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, len = Math.min(size, 2 << 20), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const i = buf.lastIndexOf(key);
    if (i >= 0) { const j = buf.indexOf(0x22, i + key.length); if (j > 0) return buf.slice(i + key.length, j).toString("utf8"); }
  } catch (e) { /* no title */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return "";
}

/** The leader's chat: the newest transcript in <home>/.claude/projects/* whose tab title starts with the leader name.
 * Looks at the 300 newest transcripts only. Returns { id, title, file } or null. */
function findLeaderSession(leader, projectsDir) {
  const want = String(leader || "").trim().toLowerCase();
  if (!want) return null;
  const root = projectsDir || PROJECTS, all = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (e) { return null; }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, d)); } catch (e) { continue; }
    for (const fn of names) {
      if (!/^[0-9a-f-]{36}\.jsonl$/i.test(fn)) continue;
      const file = path.join(root, d, fn);
      try { all.push({ file, id: fn.slice(0, 36), t: fs.statSync(file).mtimeMs }); } catch (e) { /* gone */ }
    }
  }
  all.sort((a, b) => b.t - a.t);
  for (const f of all.slice(0, 300)) {
    const title = tailTitle(f.file);
    if (title && title.toLowerCase().startsWith(want)) return { id: f.id, title, file: f.file };
  }
  return null;
}

// ---- 0.5.1 token use today: read from the "usage" field Claude Code writes on each assistant reply in the transcripts.
// Each reply can be written as several lines with the same message id, so each id is counted once. Nothing is estimated.
let lastTok = null;
const tokCache = new Map();   // file -> { since, off, ids:Set, s:{input,output,cacheWrite,cacheRead} }
const TOK_STEP = 4 * 1048576;
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** The byte offset where today's lines start (transcripts are written in time order): steps back 4 MB at a time. */
function todayOffset(fd, size, since) {
  let pos = size;
  while (pos > 0) {
    const start = Math.max(0, pos - TOK_STEP), len = Math.min(65536, size - start), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const txt = buf.toString("utf8"), nl = start ? txt.indexOf("\n") : -1;
    const m = /"timestamp":"([^"]+)"/.exec(txt.slice(nl + 1));
    if (m && Date.parse(m[1]) < since) return start;
    pos = start;
  }
  return 0;
}
/** Today's token use in one transcript, read from where the last call stopped. null = no such file. */
function fileTokens(p, since) {
  let st;
  try { st = fs.statSync(p); } catch (e) { return null; }
  let c = tokCache.get(p);
  if (!c || c.since !== since || st.size < c.off) c = { since, off: -1, ids: new Set(), s: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } };
  tokCache.set(p, c);
  if (st.mtimeMs < since) { c.off = st.size; return c; }   // not written today
  let fd;
  try {
    fd = fs.openSync(p, "r");
    if (c.off < 0) c.off = todayOffset(fd, st.size, since);
    let rest = "";
    while (c.off < st.size) {
      const len = Math.min(TOK_STEP, st.size - c.off), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, c.off);
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl < 0) { if (len < TOK_STEP) break; rest += buf.toString("utf8"); c.off += len; continue; }   // a line still being written: next time
      const lines = (rest + buf.slice(0, lastNl).toString("utf8")).split("\n");
      rest = "";
      c.off += lastNl + 1;
      for (const ln of lines) {
        if (!ln.includes('"usage"') || !ln.includes('"assistant"')) continue;
        let e; try { e = JSON.parse(ln); } catch (x) { continue; }
        if (e.type !== "assistant" || !e.message || !e.message.usage || !(Date.parse(e.timestamp) >= since)) continue;
        const id = e.message.id || e.requestId || e.uuid;
        if (!id || c.ids.has(id)) continue;
        c.ids.add(id);
        const u = e.message.usage;
        c.s.input += u.input_tokens || 0; c.s.output += u.output_tokens || 0;
        c.s.cacheWrite += u.cache_creation_input_tokens || 0; c.s.cacheRead += u.cache_read_input_tokens || 0;
      }
    }
  } catch (e) { /* unreadable now: keep what was counted */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (x) { /* closed */ } }
  return c;
}
/** Token use since midnight per card: its open chat (main transcript) plus its helpers' transcripts. known = false when
 * no transcript of that card was found (no open chat, no helper today). other = helpers that match no card. */
function tokenUse() {
  const since = midnight(), zero = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, chats: 0 });
  const add = (r, c) => { if (!c) return; for (const k of ["input", "output", "cacheWrite", "cacheRead"]) r[k] += c.s[k]; r.chats++; };
  if (!lastTok) return { since: new Date(since).toISOString(), rows: [], other: zero(), total: zero(), ready: false };
  const rows = lastTok.members.map(m => ({ id: m.id, name: m.name, team: m.team, ...zero(), known: false }));
  const byId = new Map(rows.map(r => [r.id, r])), other = zero();
  for (const m of lastTok.members) {
    if (!/^[0-9a-f-]{36}$/i.test(m.sid)) continue;
    for (const dir of lastTok.dirs) { const c = fileTokens(path.join(dir, m.sid + ".jsonl"), since); if (c) { const r = byId.get(m.id); add(r, c); r.known = true; break; } }
  }
  for (const h of lastTok.helpers) {
    const c = fileTokens(h.p, since), r = h.id && byId.get(h.id);
    if (r) { add(r, c); if (c) r.known = true; } else add(other, c);
  }
  const total = zero();
  for (const r of [...rows, other]) { r.total = r.input + r.output + r.cacheWrite + r.cacheRead; for (const k of ["input", "output", "cacheWrite", "cacheRead", "chats"]) total[k] += r[k]; }
  total.total = total.input + total.output + total.cacheWrite + total.cacheRead;
  return { since: new Date(since).toISOString(), rows, other, total, ready: true };
}

module.exports = { buildState, newMemberRequest, tokenUse, saveBotify, brainFolder, moveSettings, editMember, roleInfo, brainInfo, brainFor, createBrain, savePicture, digestRequest,
  matchAgent, agentIndex, expandHome, decideRequest, findWaiting, condenseRequest, contextTokens, condenseInfo, teamList, roleList, joinTeam, leaveTeam, teamGroups, TEAM_COLOURS, normItem, findLeaderSession, _resetLimit: () => { lastRequest = 0; } };
