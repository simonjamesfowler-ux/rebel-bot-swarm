// Rebel Bot Swarm - core reader. Reads Claude Code's local session files and an optional team board. No network.
// READ ONLY: <home>/.claude/sessions/*.json, <home>/.claude/projects/<project>/*.jsonl (tail reads of new bytes only)
// the board file you choose, and (only for the edit panel, or when "agentCards" is on) <home>/.claude/agents/*.md.
// WRITES, only when you click Save in the panel: members.json (name and avatar on the panel, a backup first) and
// request files ("NEW MEMBER <time>.json", "EDIT MEMBER <time>.json") for your coordinator session. The extension
// passes the folders: VS Code's storage folder for this extension, or the folders you set. Never the agent files,
// the board or the session files. Works on Windows, macOS and Linux.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");

const CLAUDE = path.join(os.homedir(), ".claude");
const SESSIONS = path.join(CLAUDE, "sessions");
const PROJECTS = path.join(CLAUDE, "projects");
const AGENTS = path.join(CLAUDE, "agents");
const FIRST_TAIL = 3000000, FEED_DAYS = 3, NAME_MAX = 60, JOB_MAX = 200, TASK_MAX = 300, ROLE_MAX = 6000, PIC_MAX = 5000000;
const STYLES = ["crew", "coord", "cad", "draught", "research", "cabinet", "teacher", "family", "books", "kitchen", "fitter", "postbot", "cleanbot", "tablet"];
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
      const n = fn.slice(0, -3).toLowerCase(), nn = n.replace(/[^a-z0-9]/g, "");
      if (!nn || [...have].some(h => { h = h.replace(/[^a-z0-9]/g, ""); return h && (nn.startsWith(h) || h.startsWith(nn)); })) continue;
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
  applyHelpers(members, (n, j) => member(n, j, null, null, b), dirs, cfg.agentCards ? AGENTS : null);
  const avDir = expandHome(cfg.avatarsFolder), pics = ownPictures(avDir), files = picFiles(avDir), settings = loadSettings(cfg.membersFile), choices = [];
  if (picUri) for (const f of Object.keys(files)) choices.push({ file: f, url: picUri(files[f].p) + "?v=" + files[f].v });
  for (const m of members) {
    const mid = memberId(m.name), st = settings[mid] || {};
    m.id = mid; m.style = ""; m.display = (typeof st.name === "string" && st.name.length > 0 && st.name.length <= NAME_MAX) ? st.name : "";
    const av = typeof st.avatar === "string" ? st.avatar : "";
    m.avatar = (av.startsWith("style:") && STYLES.includes(av.slice(6))) || (av.startsWith("pic:") && files[av.slice(4)]) ? av : "auto";
    if (m.avatar.startsWith("style:")) { m.style = m.avatar.slice(6); continue; }
    if (m.avatar.startsWith("pic:")) { const c = choices.find(x => x.file === m.avatar.slice(4)); m.pic = c ? c.url : ""; continue; }
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
           board: b.found, members, feed: out, pics: choices, styles: STYLES, avatarsSet: !!avDir };
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
function agentFileFor(mid, agentsDir = AGENTS) {
  const norm = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, ""), k = norm(mid);
  let files = [];
  try { files = fs.readdirSync(agentsDir).filter(f => f.endsWith(".md")); } catch (e) { return null; }
  if (!k) return null;
  const hit = files.find(f => norm(f.slice(0, -3)) === k) || files.find(f => { const n = norm(f.slice(0, -3)); return n && (n.startsWith(k) || k.startsWith(n)); });
  return hit ? path.join(agentsDir, hit) : null;
}
function roleBody(mid, agentsDir) {
  const f = agentFileFor(mid, agentsDir);
  if (!f) return { found: false, body: "" };
  try {
    const text = fs.readFileSync(f, "utf8").slice(0, 200000).replace(/\r\n/g, "\n");
    return { found: true, body: text.replace(/^---\n[\s\S]*?\n---\n/, "").trim() };
  } catch (e) { return { found: false, body: "" }; }
}
function roleInfo(mid, agentsDir) {
  const r = roleBody(mid, agentsDir), tooLong = r.body.length > ROLE_MAX;
  return { id: mid, found: r.found, body: tooLong ? "" : r.body, too_long: tooLong, limit: ROLE_MAX };
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
  const settings = loadSettings(mf), entry = {};
  if (name) entry.name = name;
  if (av !== "auto") entry.avatar = av;
  const changed = JSON.stringify(entry) !== JSON.stringify(settings[mid] || {});
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

module.exports = { buildState, newMemberRequest, editMember, roleInfo, expandHome, _resetLimit: () => { lastRequest = 0; } };
