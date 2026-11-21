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
    .filter(w => !/^\(?nothing\)?$/i.test(w));
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
  for (const [sid, d] of Object.entries(teamLive)) if (!used.has(sid)) members.push(member(d.name || sid.slice(0, 8), b.found ? "(not on the board)" : "", d, sid, b));
  const settings = loadSettings(cfg.membersFile), idx = agentIndex(cfg.agentsDir === undefined ? AGENTS : cfg.agentsDir);
  const wantedOf = n => { const s = settings[memberId(n)]; return s && typeof s.agent === "string" ? s.agent : ""; };
  if (cfg.agentCards) addAgentCards(members, (n, j) => member(n, j, null, null, b), idx, wantedOf);
  for (const m of members) if (m.status === "closed") m.status = "ready";
  const avDir = expandHome(cfg.avatarsFolder), pics = ownPictures(avDir), files = picFiles(avDir), choices = [];
  if (picUri) for (const f of Object.keys(files)) choices.push({ file: f, url: picUri(files[f].p) + "?v=" + files[f].v });
  lastMembers.clear();
  for (const m of members) {
    const mid = memberId(m.name), st = settings[mid] || {};
    m.id = mid; m.style = ""; m.display = (typeof st.name === "string" && st.name.length > 0 && st.name.length <= NAME_MAX) ? st.name : "";
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
  const privSids = new Set(members.filter(m => m.sid && m.private).map(m => m.sid));
  const titleNames = {};
  for (const sid of new Set([...titles.keys(), ...Object.keys(names)])) titleNames[sid] = names[sid] || titles.get(sid) || sid.slice(0, 8);
  for (const m of members) if (m.sid) titleNames[m.sid] = m.name;
  const byName = n => { const f = firstWord(n); return members.find(m => m.name === n || m.display === n) || members.find(m => f && firstWord(m.name) === f) || null; };
  const msgs = [];   // {ts, from, to, text, kind, fromId?, toId?}
  // helpers (subagents): who works now, their steps, the brief from the coordinator and the hand-back
  const working = [], steps = [], helperIds = {};
  for (const { p, st, parent } of helperFiles(dirs)) {
    const h = helperInfo(p, st);
    if (!h) continue;
    const a = h.agentType && !h.builtIn ? idx.find(x => x.keys.includes(slug(h.agentType))) : null;
    const m = (a && members.find(x => matchAgent(x.name, idx, wantedOf(x.name)) === a)) || (h.you && byName(h.you)) || null;
    const who = m ? (m.display || m.name) : (h.you || (a ? a.name : h.agentType ? "helper (" + h.agentType + ")" : "helper"));
    const pm = members.find(x => x.sid === parent) || null, boss = pm ? (pm.display || pm.name) : (titleNames[parent] || "coordinator");
    const hide = (m && m.private) || isPriv(who) || isPriv(h.task) || isPriv(h.you) || isPriv(h.agentType);
    const age = Date.now() - st.mtimeMs, running = !h.finished && age < (h.hasMeta ? RUN_SECS : HELPER_SECS) * 1000;
    const last = h.steps[h.steps.length - 1];
    helperIds[path.basename(p, ".jsonl").replace(/^agent-/, "")] = { who, id: m ? m.id : "", hide };
    if (running) {
      working.push({ who, id: m ? m.id : "", task: hide ? "(private)" : h.task, step: hide ? "" : (last ? last.text : "starting"),
                     time: last ? fmt(new Date(last.ts)) : fmt(new Date(st.mtimeMs)), ts: last ? last.ts : new Date(st.mtimeMs).toISOString() });
      if (m && (m.status === "ready" || m.status === "idle")) {
        m.status = "working"; m.since = fmt(new Date(st.mtimeMs)); m.extra = hide ? "helper running" : (last ? last.text : "helper running");
      }
    }
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
  const log = b.log.slice(-40).reverse().map(l => ({ date: l.date, who: l.who, text: isPriv(l.who) || isPriv(l.text) ? "(private)" : l.text }));
  const now = new Date();
  return { updated: `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`, now: now.getTime(), holder: b.holder, waiting: b.waiting,
           board: b.found, members, feed: out, links: links.slice(0, 80), working: working.sort(desc), steps: steps.sort(desc).slice(0, 40), log,
           pics: choices, styles: STYLES, avatarsSet: !!avDir };
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
  fs.writeFileSync(file + ".tmp", JSON.stringify(settings, null, 2), "utf8");
  fs.renameSync(file + ".tmp", file);
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
  if (typeof old.agent === "string" && old.agent) entry.agent = old.agent;   // the agent-file link stays
  if (name) entry.name = name;
  if (av !== "auto") entry.avatar = av;
  const canon = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
  const changed = canon(entry) !== canon(old);
  const sendReq = !!task || (!!role && role !== roleBody(mid, opts.agentsDir).body);
  if (!changed && !sendReq) return { ok: false, msg: "Nothing to save: change the name, avatar, task or role instructions first." };
  if (Date.now() - lastRequest < 5000) return { ok: false, msg: "Not saved: wait 5 seconds between requests." };
  const done = [], t = stamp();
  try {
    if (changed) { if (Object.keys(entry).length) settings[mid] = entry; else delete settings[mid]; writeMembers(settings, mf); done.push("Name and avatar saved"); }
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

// ADD TEAM MEMBER: one file "NEW MEMBER <yyyy-mm-dd HHMMSS>.json" in the requests folder.
// The file name uses the time only; JSON.stringify escapes the typed text.
function clean(t, limit) {
  if (typeof t !== "string") return null;
  t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return t && t.length <= limit ? t : null;
}
function newMemberRequest(data, requestsFolder) {
  const dir = expandHome(requestsFolder);
  if (!dir) return { ok: false, msg: "Not saved: no requests folder." };
  const name = clean(data && data.name, NAME_MAX), job = clean(data && data.job, JOB_MAX);
  if (!name || !job) return { ok: false, msg: `Not saved: type a name (max ${NAME_MAX}) and the job (max ${JOB_MAX} characters).` };
  if (Date.now() - lastRequest < 5000) return { ok: false, msg: "Not saved: wait 5 seconds between requests." };
  const t = stamp();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `NEW MEMBER ${t.file}.json`), JSON.stringify({ name, job, time: t.iso, from: "Rebel Bot Swarm" }, null, 2),
      { encoding: "utf8", flag: "wx" });
  } catch (e) {
    return { ok: false, msg: e.code === "EEXIST" ? "Not saved: wait a second and try again." : "Not saved: " + (e.code || "write error") + "." };
  }
  lastRequest = Date.now();
  return { ok: true, msg: "Request saved for your coordinator" };
}

module.exports = { buildState, newMemberRequest, editMember, roleInfo, brainInfo, brainFor, createBrain, savePicture, digestRequest,
  matchAgent, agentIndex, expandHome, _resetLimit: () => { lastRequest = 0; } };
