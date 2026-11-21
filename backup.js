// Rebel Bot Swarm - Save team / Restore team. Node built-ins only (fs, path, os, zlib, crypto).
// Save: one .zip that the user chooses. Always: members file, pictures, panel brains, rebelBotSwarm.* settings, manifest.
// Optional groups (off by default): Claude Code member brains, agent files, skills (not "synced"), project memory.
// Never: Claude Code settings, credentials, .env, keys, tokens, transcripts (.jsonl), private members' brains (unless ticked).
// Restore: every entry name and type is checked; nothing is replaced without the user's yes; a dated copy of each
// replaced file is kept first.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), zlib = require("zlib"), crypto = require("crypto");

const FORMAT = 1;
const FILE_MAX = 5000000, TEXT_MAX = 2000000, TOTAL_MAX = 250000000, COUNT_MAX = 5000, ZIP_MAX = 300000000, DEPTH_MAX = 8;
const PIC_EXT = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
const TEXT_EXT = [".md", ".txt", ".json", ".py", ".js", ".mjs", ".cjs", ".ts", ".html", ".htm", ".css", ".xml", ".xsd", ".yaml",
  ".yml", ".csv", ".tsv", ".sh", ".ps1", ".toml", ".ini", ".cfg"];
const BIN_EXT = [".png", ".jpg", ".jpeg", ".webp"];
// never saved and never restored, at any depth
const NEVER = /^(settings(\.local)?\.json|\.?credentials(\..*)?|.*\.env|\.env(\..*)?|.*\.jsonl|.*\.(key|pem|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|(.*[._ -])?(tokens?|secrets?|passwords?|api[._-]?keys?)\.(json|txt|ya?ml|ini|cfg|toml))$/i;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const safePart = s => typeof s === "string" && /^[A-Za-z0-9_][A-Za-z0-9 ._()+,&'=@~-]{0,150}$/.test(s) && !s.includes("..") &&
  !/[. ]$/.test(s) && !RESERVED.test(s);
const slug = x => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const p2 = n => String(n).padStart(2, "0");
function stamp(d) {
  d = d || new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

// ---- groups: zip folder -> where the files live on this computer
const GROUPS = [
  { key: "members", label: "Members file (names and avatars)", optional: false },
  { key: "avatars", label: "Pictures (avatars folder)", optional: false },
  { key: "brains", label: "Panel brains (brains folder)", optional: false },
  { key: "settings", label: "Rebel Bot Swarm settings", optional: false },
  { key: "agentMemory", label: "Claude Code member brains", optional: true, zip: "claude/agent-memory", dir: c => path.join(c, "agent-memory"),
    note: "~/.claude/agent-memory/* (Claude Code's own subagent memory)" },
  { key: "agents", label: "Agent files", optional: true, zip: "claude/agents", dir: c => path.join(c, "agents"),
    note: "~/.claude/agents/*.md (the role of each member)" },
  { key: "skills", label: "Skills", optional: true, zip: "claude/skills", dir: c => path.join(c, "skills"),
    note: "~/.claude/skills/* (not the \"synced\" folder)" },
  { key: "projectMemory", label: "Claude Code project memory", optional: true, zip: "claude/projects", dir: c => path.join(c, "projects"),
    note: "~/.claude/projects/*/memory. WARNING: may hold private notes; keep this file private." }
];
const GROUP = Object.fromEntries(GROUPS.map(g => [g.key, g]));

function isPrivate(name, priv) {
  const s = slug(name);
  if (!s) return false;
  for (const p of priv || []) {
    const sp = slug(p);
    if (sp && (s === sp || s.includes(sp) || s.split("-")[0] === sp.split("-")[0])) return true;
  }
  return false;
}

// ---- file type checks (pictures by their first bytes, text must be UTF-8 without NUL bytes)
const MAGIC = { ".png": b => b.length > 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ".jpg": b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  ".webp": b => b.length > 12 && b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP" };
MAGIC[".jpeg"] = MAGIC[".jpg"];
const isText = b => !b.includes(0) && Buffer.from(b.toString("utf8"), "utf8").equals(b);
function svgOk(b) {
  if (!isText(b)) return false;
  const t = b.toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
  return (t.startsWith("<svg") || t.startsWith("<?xml")) && t.includes("<svg") &&
    !/<script|javascript:|<foreignobject|\son[a-z]+\s*=|<iframe|<embed|<object|xlink:href\s*=\s*["']\s*(?!#)|href\s*=\s*["']\s*(?:https?:|data:|\/\/)/.test(t);
}
/** null = OK, else the reason. kind: "pic" (avatars), "md", "file" (text or png/jpg/webp). */
function typeProblem(name, buf, kind) {
  const ext = path.extname(name).toLowerCase();
  if (NEVER.test(path.basename(name))) return "not allowed (private file type)";
  if (kind === "pic") {
    if (!PIC_EXT.includes(ext)) return "not a picture type";
    if (buf.length > FILE_MAX) return "larger than 5 MB";
    if (ext === ".svg") return svgOk(buf) ? null : "not a plain SVG picture";
    return MAGIC[ext](buf) ? null : "not a real " + ext.slice(1).toUpperCase() + " picture";
  }
  if (kind === "md" && ext !== ".md") return "not a .md file";
  if (BIN_EXT.includes(ext)) return buf.length > FILE_MAX ? "larger than 5 MB" : MAGIC[ext](buf) ? null : "not a real picture";
  if (!TEXT_EXT.includes(ext)) return "file type not saved";
  if (buf.length > TEXT_MAX) return "larger than 2 MB";
  return isText(buf) ? null : "not a text file";
}

// ---- walk a folder (no links, no hidden files, limited depth)
function walk(root, rel, depth, out, skip) {
  if (depth > DEPTH_MAX) return;
  let names = [];
  try { names = fs.readdirSync(path.join(root, rel)).sort(); } catch (e) { return; }
  for (const n of names) {
    const r = rel ? rel + "/" + n : n, p = path.join(root, r);
    if (n.startsWith(".")) continue;
    let st;
    try { st = fs.lstatSync(p); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;
    if (skip && skip(r, st)) continue;
    if (st.isDirectory()) walk(root, r, depth + 1, out, skip);
    else if (st.isFile()) out.push({ rel: r, file: p, size: st.size });
  }
}

/** Lists what Save team would put in the zip. o: {membersFile, avatarsFolder, brainsFolder, claudeDir, privateNames,
 *  privateFiles, settings, include: {agentMemory, agents, skills, projectMemory, privateMembers}} */
function collect(o) {
  const inc = o.include || {}, claude = o.claudeDir || path.join(os.homedir(), ".claude"), priv = inc.privateMembers ? [] : (o.privateNames || []);
  const privFiles = new Set(inc.privateMembers ? [] : (o.privateFiles || []).map(f => path.resolve(f).toLowerCase()));
  const files = [], skipped = [], listed = { agentMemory: [] };
  const add = (group, name, file, kind) => {
    if (privFiles.has(path.resolve(file).toLowerCase())) { skipped.push({ name, why: "private member" }); return; }
    if (NEVER.test(path.basename(file))) { skipped.push({ name, why: "private file type" }); return; }
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { skipped.push({ name, why: e.code || "read error" }); return; }
    const bad = typeProblem(name, buf, kind);
    if (bad) { skipped.push({ name, why: bad }); return; }
    files.push({ group, name, data: buf });
  };
  if (o.membersFile && fs.existsSync(o.membersFile)) add("members", "members.json", o.membersFile, "file");
  if (o.avatarsFolder) {
    const l = []; walk(o.avatarsFolder, "", DEPTH_MAX, l);   // top level only
    for (const f of l) add("avatars", "avatars/" + f.rel, f.file, "pic");
  }
  if (o.brainsFolder) {
    const l = []; walk(o.brainsFolder, "", DEPTH_MAX, l);
    for (const f of l) {
      if (path.extname(f.rel).toLowerCase() !== ".md") continue;
      if (isPrivate(path.basename(f.rel, ".md"), priv)) { skipped.push({ name: "brains/" + f.rel, why: "private member" }); continue; }
      add("brains", "brains/" + f.rel, f.file, "md");
    }
  }
  if (o.settings && Object.keys(o.settings).length) files.push({ group: "settings", name: "swarm-settings.json", data: Buffer.from(JSON.stringify(o.settings, null, 2), "utf8") });
  // agent memory: listed always (names only), saved only when ticked
  const am = GROUP.agentMemory.dir(claude);
  let amNames = [];
  try { amNames = fs.readdirSync(am).filter(n => { try { return fs.lstatSync(path.join(am, n)).isDirectory(); } catch (e) { return false; } }).sort(); } catch (e) { amNames = []; }
  for (const n of amNames) {
    const p = isPrivate(n, o.privateNames || []);
    listed.agentMemory.push({ agent: n, private: p });
    if (!inc.agentMemory) continue;
    if (p && !inc.privateMembers) { skipped.push({ name: "claude/agent-memory/" + n, why: "private member" }); continue; }
    if (!safePart(n)) continue;
    const l = []; walk(path.join(am, n), "", 1, l);
    for (const f of l) add("agentMemory", `claude/agent-memory/${n}/${f.rel}`, f.file, "file");
  }
  if (inc.agents) {
    const l = []; walk(GROUP.agents.dir(claude), "", DEPTH_MAX, l);
    for (const f of l) if (path.extname(f.rel).toLowerCase() === ".md") add("agents", "claude/agents/" + f.rel, f.file, "md");
  }
  if (inc.skills) {
    const l = []; walk(GROUP.skills.dir(claude), "", 1, l, (r, st) => st.isDirectory() && r.toLowerCase() === "synced");
    for (const f of l) if (f.rel.includes("/")) add("skills", "claude/skills/" + f.rel, f.file, "file");
  }
  if (inc.projectMemory) {
    const pd = GROUP.projectMemory.dir(claude);
    let projs = [];
    try { projs = fs.readdirSync(pd).sort(); } catch (e) { projs = []; }
    for (const pr of projs) {
      const md = path.join(pd, pr, "memory");
      try { if (!fs.lstatSync(md).isDirectory()) continue; } catch (e) { continue; }
      const l = []; walk(md, "", DEPTH_MAX - 2, l);
      for (const f of l) add("projectMemory", `claude/projects/${pr}/memory/${f.rel}`, f.file, "file");
    }
  }
  return { files, skipped, listed };
}

// ---- zip writer / reader (deflate, UTF-8 names, no zip64: the limits keep it under 4 GB)
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
           date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function zipWrite(entries, when) {
  const parts = [], central = [], dt = dosTime(when || new Date());
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8"), raw = e.data, def = zlib.deflateRawSync(raw, { level: 9 });
    const store = def.length >= raw.length, body = store ? raw : def, crc = crc32(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(store ? 0 : 8, 8);
    h.writeUInt16LE(dt.time, 10); h.writeUInt16LE(dt.date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt16LE(dt.time, 12); c.writeUInt16LE(dt.date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, name, body); central.push(c, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
/** Reads a zip made by Save team (or any plain zip). Throws on a damaged, encrypted or too-large file. */
function zipRead(buf) {
  if (buf.length > ZIP_MAX) throw new Error("the file is larger than 300 MB");
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(e + 10), cdOff = buf.readUInt32LE(e + 16);
  if (count > COUNT_MAX) throw new Error("too many files in the zip");
  const out = [];
  let p = cdOff, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("damaged zip");
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28);
    const xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString("utf8");
    p += 46 + nl + xl + cl;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error("encrypted zip");
    if (usize > FILE_MAX) { out.push({ name, bad: "larger than 5 MB" }); continue; }
    total += usize;
    if (total > TOTAL_MAX) throw new Error("the zip holds more than 250 MB");
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new Error("damaged zip");
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    if (ds + csize > buf.length) throw new Error("damaged zip");
    const body = buf.slice(ds, ds + csize);
    let data;
    try {
      if (method === 0) data = Buffer.from(body);
      else if (method === 8) data = zlib.inflateRawSync(body, { maxOutputLength: FILE_MAX + 1 });
      else { out.push({ name, bad: "unknown compression" }); continue; }
    } catch (err) { out.push({ name, bad: "damaged entry" }); continue; }
    if (data.length !== usize || crc32(data) !== crc) { out.push({ name, bad: "damaged entry" }); continue; }
    out.push({ name, data });
  }
  return out;
}
/** Reads a Save team folder (same layout as the zip). */
function folderRead(dir) {
  const l = [], out = [];
  walk(dir, "", 0, l);
  if (l.length > COUNT_MAX) throw new Error("too many files in the folder");
  let total = 0;
  for (const f of l) {
    if (f.size > FILE_MAX) { out.push({ name: f.rel, bad: "larger than 5 MB" }); continue; }
    total += f.size;
    if (total > TOTAL_MAX) throw new Error("the folder holds more than 250 MB");
    try { out.push({ name: f.rel, data: fs.readFileSync(f.file) }); } catch (e) { out.push({ name: f.rel, bad: e.code || "read error" }); }
  }
  return out;
}

// ---- Save
function makeManifest(version, files, skipped, listed, include) {
  return { app: "Rebel Bot Swarm", format: FORMAT, version, created: new Date().toISOString(),
    included: Object.fromEntries(GROUPS.map(g => [g.key, g.optional ? !!(include || {})[g.key] : true])),
    privateMembersIncluded: !!(include || {}).privateMembers,
    files: files.map(f => ({ name: f.name, group: f.group, size: f.data.length, sha256: crypto.createHash("sha256").update(f.data).digest("hex") })),
    skipped, claudeMemberBrains: listed.agentMemory };
}
/** Writes the zip (via a temporary file). Returns {ok, msg, count}. */
function saveTeam(target, o, version) {
  const r = collect(o);
  const man = makeManifest(version, r.files, r.skipped, r.listed, o.include);
  const entries = [{ name: "manifest.json", data: Buffer.from(JSON.stringify(man, null, 2), "utf8") }, ...r.files];
  try {
    const tmp = target + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, zipWrite(entries));
    fs.renameSync(tmp, target);
  } catch (e) { return { ok: false, msg: "Not saved: " + (e.code || e.message || "write error") + "." }; }
  return { ok: true, count: r.files.length, skipped: r.skipped.length, msg: `Team saved: ${r.files.length} files` +
    (r.skipped.length ? ` (${r.skipped.length} left out, see manifest.json)` : "") + "." };
}

// ---- Restore
const MEMBER_KEY = /^[a-z0-9][a-z0-9 ._-]{0,59}$/;
function cleanMembers(buf) {
  let d;
  try { d = JSON.parse(buf.toString("utf8")); } catch (e) { return null; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const out = {};
  for (const k of Object.keys(d).slice(0, 500)) {
    const v = d[k];
    if (!MEMBER_KEY.test(k) || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = {};
    if (typeof v.name === "string" && v.name.length <= 60 && !/[\u0000-\u001f]/.test(v.name)) e.name = v.name;
    if (typeof v.avatar === "string" && /^(style:[a-z0-9-]{1,30}|pic:[A-Za-z0-9 _().-]{1,120})$/.test(v.avatar) && !v.avatar.includes("..")) e.avatar = v.avatar;
    if (typeof v.agent === "string" && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}$/.test(v.agent)) e.agent = v.agent;
    // 0.5.0 teams: the member's team and role (checked against the teams/roles settings when the dashboard reads them)
    if (typeof v.team === "string" && v.team && v.team.length <= 40 && !/[\u0000-\u001f]/.test(v.team)) e.team = v.team;
    if (typeof v.role === "string" && v.role && v.role.length <= 40 && !/[\u0000-\u001f]/.test(v.role)) e.role = v.role;
    // 0.5.1 Add team member: the new card {name, job, time}, plain short text only
    const a = v.added, txt = (x, n) => typeof x === "string" && x.length <= n && !/[\u0000-\u001f]/.test(x);
    if (a && typeof a === "object" && !Array.isArray(a) && txt(a.name, 60) && a.name.trim() && txt(a.job || "", 200) && txt(a.time || "", 40))
      e.added = { name: a.name, job: a.job || "", time: a.time || "" };
    if (Object.keys(e).length) out[k] = e;
  }
  return Buffer.from(JSON.stringify(out, null, 2), "utf8");
}
/** schema: package.json contributes.configuration.properties. Returns only known keys with the right type. */
function cleanSettings(buf, schema) {
  let d;
  try { d = JSON.parse(buf.toString("utf8")); } catch (e) { return null; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    const s = schema["rebelBotSwarm." + k];
    if (!s) continue;
    if (s.type === "string" && typeof v === "string" && v.length <= 6000 && (!s.enum || s.enum.includes(v))) out[k] = v;
    else if (s.type === "boolean" && typeof v === "boolean") out[k] = v;
    else if (s.type === "number" && typeof v === "number" && isFinite(v) && (s.minimum === undefined || v >= s.minimum) && (s.maximum === undefined || v <= s.maximum)) out[k] = v;
    else if (s.type === "array" && Array.isArray(v) && v.length <= 200 && v.every(x => typeof x === "string" && x.length <= 100)) out[k] = v;
    else if (k === "teams" && s.type === "array" && Array.isArray(v) && v.length <= 12) {
      // 0.5.0 teams: [{name, leader, scope}], plain short text only
      const ok = x => typeof x === "string" && x.length <= 160 && !/[\u0000-\u001f]/.test(x);
      const list = v.filter(x => x && typeof x === "object" && !Array.isArray(x) && ok(x.name) && x.name.trim())
        .map(x => {   // keys kept in the user's own order, so an unchanged team does not read as changed
          const e = {};
          for (const k of Object.keys(x)) {
            if (k === "name" || ((k === "leader" || k === "scope" || k === "parent") && ok(x[k]) && x[k])) e[k] = x[k];   // parent: 0.5.1 sub-teams
            else if (k === "color" && typeof x.color === "string" && /^#[0-9a-fA-F]{6}$/.test(x.color)) e.color = x.color;   // 0.5.1
          }
          return e; });
      if (list.length === v.length) out[k] = list;
    }
  }
  return out;
}
const under = (root, p) => { const r = path.resolve(root), t = path.resolve(p); return t.startsWith(r + path.sep) && t.length > r.length + 1; };
/** Checks each entry and finds its place. t: {membersFile, avatarsFolder, brainsFolder, claudeDir, schema, current}.
 *  Returns {items: [{group, name, target, status: new|replace|same, data}], settings: {values, changes}|null, bad: [{name, why}], manifest}. */
function planRestore(entries, t) {
  const claude = t.claudeDir || path.join(os.homedir(), ".claude"), items = [], bad = [];
  let manifest = null, settings = null;
  for (const e of entries) {
    const name = e.name;
    if (e.bad) { bad.push({ name, why: e.bad }); continue; }
    const parts = name.split("/");
    if (name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || !parts.every(safePart) || parts.length > DEPTH_MAX + 4) {
      bad.push({ name, why: "unsafe file name" }); continue;
    }
    if (NEVER.test(parts[parts.length - 1])) { bad.push({ name, why: "not allowed (private file type)" }); continue; }
    let group = "", root = "", target = "", kind = "file", data = e.data;
    if (name === "manifest.json") {
      try { manifest = JSON.parse(data.toString("utf8")); } catch (err) { manifest = null; }
      continue;
    } else if (name === "members.json") {
      group = "members"; data = cleanMembers(data);
      if (!data) { bad.push({ name, why: "not a members file" }); continue; }
      target = t.membersFile; root = path.dirname(t.membersFile || "");
    } else if (name === "swarm-settings.json") {
      const v = cleanSettings(data, t.schema || {});
      if (!v) { bad.push({ name, why: "not a settings file" }); continue; }
      const cur = t.current || {}, changes = Object.keys(v).filter(k => JSON.stringify(cur[k]) !== JSON.stringify(v[k]));
      settings = { values: v, changes };
      continue;
    } else if (parts[0] === "avatars" && parts.length === 2) { group = "avatars"; root = t.avatarsFolder; kind = "pic"; }
    else if (parts[0] === "brains" && parts.length === 2) { group = "brains"; root = t.brainsFolder; kind = "md"; }
    else if (parts[0] === "claude" && parts[1] === "agent-memory" && parts.length >= 4) { group = "agentMemory"; root = path.join(claude, "agent-memory"); }
    else if (parts[0] === "claude" && parts[1] === "agents" && parts.length === 3) { group = "agents"; root = path.join(claude, "agents"); kind = "md"; }
    else if (parts[0] === "claude" && parts[1] === "skills" && parts.length >= 4 && parts[2].toLowerCase() !== "synced") { group = "skills"; root = path.join(claude, "skills"); }
    else if (parts[0] === "claude" && parts[1] === "projects" && parts.length >= 5 && parts[3] === "memory") { group = "projectMemory"; root = path.join(claude, "projects"); }
    else { bad.push({ name, why: "not a Save team file" }); continue; }
    if (!root) { bad.push({ name, why: "no folder set for it" }); continue; }
    const why = typeProblem(name, data, kind);
    if (why) { bad.push({ name, why }); continue; }
    if (!target) target = path.join(root, ...parts.slice(group === "avatars" || group === "brains" ? 1 : 2));
    if (group !== "members" && !under(root, target)) { bad.push({ name, why: "unsafe file name" }); continue; }
    let status = "new";
    try {
      const st = fs.lstatSync(target);
      if (!st.isFile()) { bad.push({ name, why: "a folder or link is in the way" }); continue; }
      status = fs.readFileSync(target).equals(data) ? "same" : "replace";
    } catch (err) { status = "new"; }
    items.push({ group, name, target, status, data });
  }
  return { items, settings, bad, manifest };
}
/** Writes the chosen items. A dated copy of each replaced file goes to backupDir first. */
function applyRestore(items, backupDir) {
  let written = 0, kept = 0;
  const failed = [];
  for (const it of items) {
    if (it.status === "same") continue;
    try {
      if (it.status === "replace") {
        const b = path.join(backupDir, ...it.name.split("/"));
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(it.target, b, fs.constants.COPYFILE_EXCL);
        kept++;
      }
      fs.mkdirSync(path.dirname(it.target), { recursive: true });
      const tmp = it.target + ".restore-tmp";
      fs.writeFileSync(tmp, it.data, { flag: "w" });
      fs.renameSync(tmp, it.target);
      written++;
    } catch (e) { failed.push({ name: it.name, why: e.code || "write error" }); }
  }
  return { written, kept, failed };
}

module.exports = { GROUPS, collect, saveTeam, zipWrite, zipRead, folderRead, planRestore, applyRestore, cleanMembers, cleanSettings,
  isPrivate, typeProblem, stamp, crc32 };
