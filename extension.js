// Rebel Bot Swarm - VS Code extension. Shows your Claude Code sessions as a team: status, avatars, messages.
// Local only: no network, no telemetry. It reads only while its panel is open and visible, and stops when closed.
// The status-bar button opens or closes the panel. The activity-bar view reads the counts only while it is visible. Webview: strict CSP, no remote content, pictures only from the
// avatars folder. Writes only when you click a button in the panel (Save, Upload picture, Make an empty brain file,
// Save digest request, Save team, Restore team): to VS Code's storage folder for this extension, or to the folders / file you set.
// Save team writes one .zip where you choose; Restore team asks before it writes and keeps a dated copy of each replaced file.
// Never writes agent files, brains (except a new empty one), the board or Claude Code's files, except when you tick and
// confirm those groups in Restore team. Updates come from the Marketplace.
"use strict";
const vscode = require("vscode"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const core = require("./core.js"), backup = require("./backup.js");

let panel = null, timer = null, store = "", lastWaiting = [], lastIds = [], lastPriv = new Set(), lastPrivNames = [], attach = null, ext = null, gstate = null;
let out = null, loadedStamp = "";

/** One line to the "Rebel Bot Swarm" output channel (errors and Decide steps). */
function log(msg) {
  try { if (!out) out = vscode.window.createOutputChannel("Rebel Bot Swarm"); out.appendLine(`[${new Date().toISOString()}] ${msg}`); } catch (e) { /* no channel */ }
}
/** Size + time of the installed code files: if they change after activation, the window runs old code until a reload. */
function codeStamp() {
  try { return ["extension.js", "core.js", path.join("media", "swarm.html")].map(f => { const s = fs.statSync(path.join(__dirname, f)); return s.size + ":" + s.mtimeMs; }).join("|"); }
  catch (e) { return ""; }
}

/** The team leader name (setting leaderName), max 40 characters; empty = "Coordinator". */
function leaderName() {
  return String(vscode.workspace.getConfiguration("rebelBotSwarm").get("leaderName", "") || "").replace(/\s+/g, " ").trim().slice(0, 40) || "Coordinator";
}

function cfg() {
  const c = vscode.workspace.getConfiguration("rebelBotSwarm");
  const membersFile = core.expandHome(c.get("membersFile", "")), requestsFolder = core.expandHome(c.get("requestsFolder", ""));
  const avatarsFolder = core.expandHome(c.get("avatarsFolder", "")), brainsFolder = core.expandHome(c.get("brainsFolder", ""));
  return {
    boardFile: c.get("boardFile", ""), privateMembers: c.get("privateMembers", []), scope: c.get("scope", "workspace"),
    avatarsFolder: avatarsFolder || (store && path.join(store, "avatars")), agentCards: c.get("agentCards", false) === true,
    brainsFolder: brainsFolder || (store && path.join(store, "brains")),
    membersFile: membersFile || (store && path.join(store, "members.json")),
    requestsFolder: requestsFolder || (store && path.join(store, "requests")), requestsSet: !!requestsFolder,
    leaderName: leaderName(), leaderRole: String(c.get("leaderRole", "") || "").trim().slice(0, 120) || "the team leader and coordinator",
    showUnnamedSessions: c.get("showUnnamedSessions", false) === true,
    refresh: Math.min(60, Math.max(2, Number(c.get("refreshSeconds", 5)) || 5)),
    workspaceFolders: (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath) };
}

function roots(c) {
  const a = core.expandHome(c.avatarsFolder);
  return a ? [vscode.Uri.file(a)] : [];   // the webview may load pictures from the avatars folder only
}

function html(webview) {
  const nonce = crypto.randomBytes(16).toString("base64");
  const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return fs.readFileSync(path.join(__dirname, "media", "swarm.html"), "utf8")
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace("<script>", `<script nonce="${nonce}">`);
}

function push() {
  if (!panel || !panel.visible) return;
  const c = cfg();
  let state;
  try { state = core.buildState(c, p => panel.webview.asWebviewUri(vscode.Uri.file(p)).toString()); }
  catch (e) { state = { updated: "", holder: "", waiting: [], members: [], feed: [], error: String((e && e.message) || e) }; }
  state.requestsSet = c.requestsSet;
  state.welcome = !!gstate && !gstate.get(WELCOME_KEY);
  state.startOpen = startOpen(); state.leaderName = c.leaderName;
  lastIds = (state.members || []).map(x => x.id).filter(Boolean);
  lastWaiting = Array.isArray(state.waiting) ? state.waiting.slice() : [];
  lastPriv = new Set((state.members || []).filter(x => x.private).map(x => x.id));
  lastPrivNames = (state.members || []).filter(x => x.private).map(x => x.name).filter(Boolean);
  panel.webview.postMessage({ type: "state", state });
  lastCounts = counts(state); lastCountsAt = Date.now(); sidePush();
}

// ---- status counts (same rules as the dashboard tiles) and the small side view in the activity bar
let lastCounts = null, lastCountsAt = 0, side = null, sideTimer = null;
function counts(s) {
  const m = (s && s.members) || [], n = l => m.filter(x => l.includes(x.status)).length;
  return { working: n(["working"]), waiting: ((s && s.waiting) || []).length,   // open board items only (same as the dashboard tile)
 idle: n(["idle", "ready", "closed"]),
           error: (s && s.error) || "" };
}
function sidePush() {
  if (!side || !side.visible) return;
  if (!(panel && panel.visible) && Date.now() - lastCountsAt > 1500) {   // the dashboard is not reading: read once for the counts
    try { lastCounts = counts(core.buildState(cfg(), () => "")); } catch (e) { lastCounts = { working: 0, waiting: 0, idle: 0, error: String((e && e.message) || e) }; }
    lastCountsAt = Date.now();
  }
  side.webview.postMessage({ type: "counts", counts: lastCounts, open: !!panel, leader: leaderName() });
}
function sideRestart() {
  clearInterval(sideTimer);
  sideTimer = side && side.visible ? setInterval(sidePush, cfg().refresh * 1000) : null;
}
function sideHtml(webview) {
  const nonce = crypto.randomBytes(16).toString("base64");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:6px 4px}
button{display:block;width:100%;margin:0 0 6px;padding:5px 8px;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;font:inherit;cursor:pointer;
color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
button.main{color:var(--vscode-button-foreground);background:var(--vscode-button-background);font-weight:600}
button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
ul{list-style:none;padding:0;margin:10px 0 0}li{margin:3px 0}b{display:inline-block;min-width:1.6em}.e{color:var(--vscode-errorForeground)}</style></head><body>
<button id="open" class="main" type="button">Open dashboard</button><button id="spark" type="button">&#9889; Spark</button><button id="save" type="button">Save team...</button>
<ul aria-live="polite"><li><b id="w">-</b> working</li><li><b id="q">-</b> waiting for you</li><li><b id="i">-</b> idle or ready</li></ul><div class="e" id="e"></div>
<script nonce="${nonce}">const vs=acquireVsCodeApi(),$=id=>document.getElementById(id);
$("open").onclick=()=>vs.postMessage({type:"toggle"});$("spark").onclick=()=>vs.postMessage({type:"spark"});$("save").onclick=()=>vs.postMessage({type:"saveTeam"});
window.addEventListener("message",e=>{const d=e.data||{};if(d.type!=="counts")return;const c=d.counts||{};$("w").textContent=c.working??"-";$("q").textContent=c.waiting??"-";
$("i").textContent=c.idle??"-";$("e").textContent=c.error||"";$("open").textContent=d.open?"Close dashboard":"Open dashboard";$("spark").textContent="⚡ Spark "+(d.leader||"Coordinator")});vs.postMessage({type:"ready"});</script></body></html>`;
}
const sideProvider = {
  resolveWebviewView(view) {
    side = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = sideHtml(view.webview);
    view.webview.onDidReceiveMessage(m => {
      if (!m || typeof m !== "object") return;
      if (m.type === "ready") sidePush();
      else if (m.type === "toggle") toggle();
      else if (m.type === "spark") spark();
      else if (m.type === "saveTeam") saveTeam();
    });
    view.onDidChangeVisibility(() => { sideRestart(); sidePush(); });
    view.onDidDispose(() => { clearInterval(sideTimer); sideTimer = null; side = null; });
    sideRestart();
  }
};
/** Status bar button and command: open the dashboard if it is closed, bring it to the front if it is behind
 *  another tab, close it if it is in front. */
function toggle() {
  if (panel && panel.visible) panel.dispose();
  else if (panel) panel.reveal();
  else show();
  sidePush();
}

function restart() {
  clearInterval(timer);
  timer = panel ? setInterval(push, cfg().refresh * 1000) : null;
}

function openRequests() {
  const dir = cfg().requestsFolder;
  if (!dir) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* shown below */ }
  vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path.join(dir, ".")));
}

async function uploadPic(id) {
  if (!panel || !lastIds.includes(id)) return;
  const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Use this picture",
    filters: { "Pictures (PNG, JPEG, WebP; max 2 MB)": ["png", "jpg", "jpeg", "webp"] } });
  if (!panel) return;
  if (!pick || !pick.length) { panel.webview.postMessage({ type: "uploadResult", ok: false, member: id, msg: "No picture chosen." }); return; }
  const r = core.savePicture(pick[0].fsPath, cfg().avatarsFolder);
  push();   // the new picture is in the choices before it is selected
  panel.webview.postMessage({ type: "uploadResult", member: id, ...r });
}

async function attachFile(id) {
  if (!panel || !lastIds.includes(id)) return;
  const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Attach to the digest request" });
  if (!panel) return;
  if (!pick || !pick.length) { attach = null; panel.webview.postMessage({ type: "attachResult", id, name: "" }); return; }
  let size = 0;
  try { size = fs.statSync(pick[0].fsPath).size; } catch (e) { size = -1; }
  if (size < 0 || size > 10000000) { attach = null; panel.webview.postMessage({ type: "attachResult", id, name: "", msg: "Not attached: max 10 MB." }); return; }
  attach = { id, path: pick[0].fsPath };
  panel.webview.postMessage({ type: "attachResult", id, name: path.basename(pick[0].fsPath) + " (copied when you save)" });
}

// ---- Save team / Restore team (backup.js). Writes only to the file or folders the user confirms.
function schema() { return (ext && ext.packageJSON.contributes.configuration.properties) || {}; }
function userSettings() {
  const c = vscode.workspace.getConfiguration("rebelBotSwarm"), out = {};
  for (const k of Object.keys(schema())) {
    const short = k.replace(/^rebelBotSwarm\./, ""), v = c.inspect(short);
    if (v && v.globalValue !== undefined) out[short] = v.globalValue;
  }
  return out;
}
function privateInfo(c) {
  const files = [];
  for (const id of lastPriv) { const b = core.brainFor(id, c); if (b) files.push(b.file); }
  return { names: [...(c.privateMembers || []), ...lastPrivNames].map(String), files };
}

async function saveTeam() {
  const opt = backup.GROUPS.filter(g => g.optional).map(g => ({ label: g.label, description: g.note, key: g.key, picked: false }));
  opt.push({ label: "Include private members' brains", description: "off = private members' brains are never saved", key: "privateMembers", picked: false });
  const pick = await vscode.window.showQuickPick(opt, { canPickMany: true, ignoreFocusOut: true,
    title: "Save team: always saved = members file, pictures, panel brains, settings. Tick extras (all off by default), then OK." });
  if (!pick) return;
  const include = Object.fromEntries(pick.map(p => [p.key, true]));
  if (include.projectMemory) {
    const ok = await vscode.window.showWarningMessage("Claude Code project memory may hold private notes. Keep this file private.", { modal: true }, "Include it");
    if (ok !== "Include it") return;
  }
  const day = backup.stamp().slice(0, 10);
  const where = await vscode.window.showSaveDialog({ saveLabel: "Save team",
    defaultUri: vscode.Uri.file(require("os").homedir() + path.sep + `Rebel Bot Swarm team ${day}.zip`), filters: { "Zip file": ["zip"] } });
  if (!where) return;
  let target = where.fsPath;
  if (!/\.zip$/i.test(target)) target += ".zip";
  const c = cfg(), pr = privateInfo(c);
  const r = backup.saveTeam(target, { membersFile: c.membersFile, avatarsFolder: c.avatarsFolder, brainsFolder: c.brainsFolder,
    privateNames: pr.names, privateFiles: pr.files, settings: userSettings(), include }, ext ? ext.packageJSON.version : "");
  if (!r.ok) { vscode.window.showErrorMessage(r.msg); return; }
  const b = await vscode.window.showInformationMessage(r.msg + (include.projectMemory ? " Keep this file private." : ""), "Show file");
  if (b === "Show file") vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(target));
}

async function restoreTeam() {
  const from = await vscode.window.showQuickPick([{ label: "From a .zip file", k: "zip" }, { label: "From a folder", k: "dir" }],
    { title: "Restore team: where is your saved team?" });
  if (!from) return;
  const pick = await vscode.window.showOpenDialog(from.k === "zip"
    ? { canSelectMany: false, openLabel: "Restore from this file", filters: { "Zip file": ["zip"] } }
    : { canSelectMany: false, canSelectFiles: false, canSelectFolders: true, openLabel: "Restore from this folder" });
  if (!pick || !pick.length) return;
  let entries;
  try {
    if (from.k === "zip") {
      const st = fs.statSync(pick[0].fsPath);
      if (st.size > 300000000) throw new Error("the file is larger than 300 MB");
      entries = backup.zipRead(fs.readFileSync(pick[0].fsPath));
    } else entries = backup.folderRead(pick[0].fsPath);
  } catch (e) { vscode.window.showErrorMessage("Not restored: " + ((e && e.message) || e) + "."); return; }
  const c = cfg(), cur = userSettings();
  const plan = backup.planRestore(entries, { membersFile: c.membersFile, avatarsFolder: c.avatarsFolder, brainsFolder: c.brainsFolder,
    schema: schema(), current: cur });
  if (!plan.manifest || plan.manifest.app !== "Rebel Bot Swarm") {
    const go = await vscode.window.showWarningMessage("This is not a Save team file (no Rebel Bot Swarm manifest). Check it anyway?", { modal: true }, "Check it");
    if (go !== "Check it") return;
  }
  const items = [];
  for (const g of backup.GROUPS) {
    if (g.key === "settings") {
      if (plan.settings && plan.settings.changes.length) items.push({ label: g.label, key: g.key, picked: true,
        description: `${plan.settings.changes.length} change(s)`, detail: plan.settings.changes.join(", ") });
      continue;
    }
    const l = plan.items.filter(i => i.group === g.key), nw = l.filter(i => i.status === "new"), rp = l.filter(i => i.status === "replace");
    if (!nw.length && !rp.length) continue;
    items.push({ label: g.label, key: g.key, picked: !g.optional,
      description: `${nw.length} new, ${rp.length} replace (dated copy kept), ${l.length - nw.length - rp.length} the same`,
      detail: (g.note ? g.note + ". " : "") + (rp.length ? "Replaces: " + rp.slice(0, 6).map(i => i.name.split("/").pop()).join(", ") + (rp.length > 6 ? " ..." : "") : "Adds new files only.") });
  }
  const badNote = plan.bad.length ? ` ${plan.bad.length} file(s) left out: ` + plan.bad.slice(0, 4).map(b => `${b.name} (${b.why})`).join("; ") + (plan.bad.length > 4 ? " ..." : "") : "";
  if (!items.length) { vscode.window.showInformationMessage("Nothing to restore: your team is the same as the saved one." + badNote); return; }
  const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, ignoreFocusOut: true,
    title: "Restore team: tick what to restore. Files go to the folders set now." });
  if (!chosen || !chosen.length) return;
  const keys = new Set(chosen.map(i => i.key)), todo = plan.items.filter(i => keys.has(i.group) && i.status !== "same");
  const nNew = todo.filter(i => i.status === "new").length, nRep = todo.length - nNew;
  const backupDir = path.join(store, "restore backups", backup.stamp());
  const sets = keys.has("settings") && plan.settings ? plan.settings.changes : [];
  const ok = await vscode.window.showWarningMessage(`Restore ${nNew} new file(s), replace ${nRep} file(s) and change ${sets.length} setting(s)?`,
    { modal: true, detail: (nRep || sets.length ? `A dated copy of each replaced file and setting is kept first in:\n${backupDir}` : "No file is replaced.") + badNote }, "Restore");
  if (ok !== "Restore") return;
  const r = backup.applyRestore(todo, backupDir);
  if (sets.length) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, "settings BEFORE RESTORE.json"), JSON.stringify(cur, null, 2), { encoding: "utf8", flag: "wx" });
      const conf = vscode.workspace.getConfiguration("rebelBotSwarm");
      for (const k of sets) await conf.update(k, plan.settings.values[k], vscode.ConfigurationTarget.Global);
    } catch (e) { r.failed.push({ name: "settings", why: e.code || "write error" }); }
  }
  push();
  const msg = `Team restored: ${r.written} file(s) written, ${r.kept} dated cop${r.kept === 1 ? "y" : "ies"} kept, ${sets.length} setting(s) changed.` +
    (r.failed.length ? ` Not written: ${r.failed.map(f => f.name + " (" + f.why + ")").join(", ")}.` : "");
  const b = await (r.failed.length ? vscode.window.showWarningMessage(msg, ...(r.kept || sets.length ? ["Open backup folder"] : []))
    : vscode.window.showInformationMessage(msg, ...(r.kept || sets.length ? ["Open backup folder"] : [])));
  if (b === "Open backup folder") vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path.join(backupDir, ".")));
}

// ---- Spark: a new Claude Code chat with the team starter prompt. The Claude Code commands used here are not a
// documented API, so each way is tried in turn: (1) command claude-vscode.primaryEditor.open(sessionId, prompt),
// (2) the link <scheme>://anthropic.claude-code/open?prompt=..., (3) the prompt on the clipboard + the Claude Code side bar.
// In ways 1 and 2 Claude Code puts the prompt in the chat box (it is not sent): the user presses Enter.
const WELCOME_KEY = "rebelBotSwarm.welcomeDismissed", START_KEY = "rebelBotSwarm.startOpen", CLAUDE_EXT = "anthropic.claude-code";
/** Start here popover: open on first run, then as the user left it. */
function startOpen() {
  if (!gstate) return false;
  const v = gstate.get(START_KEY);
  return typeof v === "boolean" ? v : !gstate.get(WELCOME_KEY);
}
/** Save the leader name to the user setting (from the Start here box or the command). */
async function saveLeader(name) {
  const v = String(name || "").replace(/\s+/g, " ").trim();
  if (!v || v.length > 40) return { ok: false, msg: "Type a name (max 40 characters)." };
  try { await vscode.workspace.getConfiguration("rebelBotSwarm").update("leaderName", v, vscode.ConfigurationTarget.Global); }
  catch (e) { return { ok: false, msg: "Not saved: " + String((e && e.message) || e) }; }
  sidePush();
  return { ok: true, msg: "Saved: your leader is " + v };
}
async function setLeader() {
  const v = await vscode.window.showInputBox({ title: "Rebel Bot Swarm: team leader", prompt: "Name your team leader. Spark opens a new chat as this leader.",
    value: leaderName(), validateInput: s => (!s.trim() ? "Type a name" : s.trim().length > 40 ? "Max 40 characters" : undefined) });
  if (v === undefined) return;
  const r = await saveLeader(v);
  (r.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)("Rebel Bot Swarm: " + r.msg);
}
function sparkPrompt() {
  const c = cfg(), conf = vscode.workspace.getConfiguration("rebelBotSwarm");
  let t = String(conf.get("sparkPrompt", "") || "").trim();
  if (!t) t = (schema()["rebelBotSwarm.sparkPrompt"] || {}).default || "";
  const board = core.expandHome(c.boardFile || "");
  return t.split("{leaderRole}").join(c.leaderRole).split("{leader}").join(c.leaderName)
    .split("{requestsFolder}").join(c.requestsFolder || "the requests folder")
    .split("{agentsFolder}").join(path.join(require("os").homedir(), ".claude", "agents"))
    .split("{board}").join(board ? `The team board is ${board}: read it first to see who is busy and what is waiting. ` : "")
    .slice(0, 6000);
}
/** Decide: the prompt for one open board item (setting decidePrompt; {leader} {leaderRole} {item} {board} {requestsFolder}). */
function decidePrompt(item) {
  const c = cfg(), conf = vscode.workspace.getConfiguration("rebelBotSwarm");
  let t = String(conf.get("decidePrompt", "") || "").trim();
  if (!t) t = (schema()["rebelBotSwarm.decidePrompt"] || {}).default || "";
  const board = core.expandHome(c.boardFile || ""), it = String(item || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  return t.split("{leaderRole}").join(c.leaderRole).split("{leader}").join(c.leaderName)
    .split("{requestsFolder}").join(c.requestsFolder || "the requests folder")
    .split("{board}").join(board || "the team board").split("{item}").join(it).slice(0, 6000);
}
/** Decide button: only an item that is on the board now (the page cannot send its own text).
 * Order: 1. check the item, 2. write the request file, 3. try to open the leader's chat. Every click ends in one toast
 * and one decideResult message to the page; errors also go to the "Rebel Bot Swarm" output channel. */
async function decide(k, item) {
  const lead = leaderName(), reply = r => { try { if (panel) panel.webview.postMessage({ type: "decideResult", k, ...r }); } catch (e) { /* page gone */ } return r; };
  const fail = msg => { log("Decide ERROR: " + msg); vscode.window.showErrorMessage(msg); return reply({ ok: false, msg }); };
  try {
    log(`Decide click: k=${k} item=${JSON.stringify(item)}`);
    const i = core.findWaiting(lastWaiting, k, item);
    if (i < 0) return fail(`Decide: this item is not on the board now (${lastWaiting.length} open items). The board has changed: try again.`);
    const it = lastWaiting[i];
    // 1. The request file FIRST: the leader watches the requests folder and asks the question in its own chat.
    const folder = cfg().requestsFolder, req = core.decideRequest(it, folder);
    if (!req.ok) return fail(`Decide: request file not saved in ${folder || "(no requests folder)"}: ${req.msg}`);
    log(`Decide request file saved: ${path.join(core.expandHome(folder), req.file)}`);
    // 2. The leader's own chat (setting leaderSessionId, else the newest chat whose tab title starts with the leader name).
    let sid = "", how = "";
    try { sid = leaderSession(); } catch (e) { log("Decide: leader chat search failed: " + ((e && e.stack) || e)); }
    try {
      if (sid) how = await decideInLeader(sid, it);
      else how = (await spark(decidePrompt(it), null, true)) === "clipboard" ? "clipboard" : "new";
    } catch (e) { log("Decide: chat open failed: " + ((e && e.stack) || e)); how = ""; }
    const tail = how === "leader" ? `The prompt is in ${lead}'s chat box: press Enter to send it.`
      : how === "new" ? `No chat for ${lead} was found, so a new chat is open with the decision prompt: press Enter to send it.`
      : how === "clipboard" ? "The decision prompt is on the clipboard: paste it into a Claude Code chat."
      : `${lead}'s chat could not be opened: ${lead} will see the request file.`;
    const msg = `Decide sent to ${lead} (request file ${req.file}). ${tail}`;
    log(msg);
    vscode.window.showInformationMessage(msg);
    return reply({ ok: true, msg, file: req.file, how });
  } catch (e) {
    log("Decide ERROR (exception): " + ((e && e.stack) || e));
    return fail("Decide: error: " + String((e && e.message) || e));
  }
}
function leaderSession() {
  const set = String(vscode.workspace.getConfiguration("rebelBotSwarm").get("leaderSessionId", "") || "").trim();
  if (/^[0-9a-f-]{36}$/i.test(set)) return set;
  const f = core.findLeaderSession(leaderName());
  return f ? f.id : "";
}
/** Put the short DECIDE prompt in the leader's own chat. Returns "leader" or "file" (not opened). No toast: decide() shows it. */
async function decideInLeader(sid, item) {
  const it = String(item || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  const prompt = `DECIDE: ${it} — ask me this as one multiple-choice question.`;
  if (!vscode.extensions.getExtension(CLAUDE_EXT)) { log("Decide: Claude Code extension not found"); return "file"; }
  try { await vscode.commands.executeCommand("claude-vscode.primaryEditor.open", sid, prompt); return "leader"; }
  catch (e) { log("Decide: claude-vscode.primaryEditor.open failed: " + ((e && e.message) || e)); }
  try {
    const uri = vscode.Uri.parse(`${vscode.env.uriScheme || "vscode"}://${CLAUDE_EXT}/open?session=${encodeURIComponent(sid)}&prompt=${encodeURIComponent(prompt)}`);
    if (await vscode.env.openExternal(uri)) return "leader";
    log("Decide: the open link was refused");
  } catch (e) { log("Decide: open link failed: " + ((e && e.message) || e)); }
  return "file";
}
async function spark(given, doneMsg, quiet) {
  const prompt = typeof given === "string" && given ? given : sparkPrompt();
  try { fs.mkdirSync(cfg().requestsFolder, { recursive: true }); } catch (e) { /* the chat can still make it */ }
  const done = doneMsg || `Spark: a new Claude Code chat for ${leaderName()} is open with the starter prompt in the chat box. Press Enter to send it.`;
  // The tab is not renamed after the leader: claude-vscode.renameSessionTab (Claude Code 2.1.329) takes no arguments,
  // asks the user in an input box, and cannot rename a tab until its session has started (after the first message).
  if (vscode.extensions.getExtension(CLAUDE_EXT)) {
    try {
      await vscode.commands.executeCommand("claude-vscode.primaryEditor.open", undefined, prompt);
      if (!quiet) vscode.window.showInformationMessage(done); return "command";
    } catch (e) { /* next way */ }
    try {
      const uri = vscode.Uri.parse(`${vscode.env.uriScheme || "vscode"}://${CLAUDE_EXT}/open?prompt=${encodeURIComponent(prompt)}`);
      if (await vscode.env.openExternal(uri)) { if (!quiet) vscode.window.showInformationMessage(done); return "link"; }
    } catch (e) { /* next way */ }
  }
  await vscode.env.clipboard.writeText(prompt);
  let side = false;
  if (vscode.extensions.getExtension(CLAUDE_EXT)) {
    try { await vscode.commands.executeCommand("claude-vscode.sidebar.open"); side = true; } catch (e) { side = false; }
  }
  if (!quiet) vscode.window.showInformationMessage(side ? "Spark: the starter prompt is on the clipboard. Paste it into the Claude Code chat to start."
    : "Spark: the starter prompt is on the clipboard. Install or open Claude Code, then paste it into a new chat to start.");
  return "clipboard";
}

const TIP_KEY = "rebelBotSwarm.storageTipDismissed";
async function storageTip(context) {
  const c = vscode.workspace.getConfiguration("rebelBotSwarm");
  if (context.globalState.get(TIP_KEY) || (c.get("avatarsFolder", "") && c.get("membersFile", ""))) return;
  const b = await vscode.window.showInformationMessage(
    "Your team is stored in VS Code's storage. Use Save team, or set rebelBotSwarm.avatarsFolder/membersFile to your own folder.",
    "Save team...", "Open settings");
  await context.globalState.update(TIP_KEY, true);   // shown once: not again after it is closed
  if (b === "Save team...") saveTeam();
  else if (b === "Open settings") vscode.commands.executeCommand("workbench.action.openSettings", "rebelBotSwarm");
}

/** A new install of the same version does not reload the running code: the page would be new and the code old. */
function staleCheck() {
  if (!loadedStamp || codeStamp() === loadedStamp) return false;
  const msg = "Rebel Bot Swarm was updated on disk, but this window still runs the old code. Run 'Developer: Reload Window'.";
  log(msg);
  vscode.window.showWarningMessage(msg, "Reload Window").then(b => { if (b) vscode.commands.executeCommand("workbench.action.reloadWindow"); });
  return true;
}
function show() {
  staleCheck();
  if (panel) { panel.reveal(); return; }
  panel = vscode.window.createWebviewPanel("rebelBotSwarm", "Rebel Bot Swarm", vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: roots(cfg()) });
  panel.iconPath = vscode.Uri.file(path.join(__dirname, "media", "icon.png"));
  panel.webview.html = html(panel.webview);
  panel.webview.onDidReceiveMessage(m => {
    if (!m || typeof m !== "object" || !panel) return;
    const c = cfg();
    if (m.type === "ready") push();
    else if (m.type === "newMember") panel.webview.postMessage({ type: "newMemberResult", ...core.newMemberRequest(m, c.requestsFolder) });
    else if (m.type === "getRole") {
      const id = String(m.id || "");
      if (lastIds.includes(id)) panel.webview.postMessage({ type: "role", ...core.roleInfo(id) });
    } else if (m.type === "editMember") {
      panel.webview.postMessage({ type: "editResult", ...core.editMember(m, lastIds, c) });
      push();
    } else if (m.type === "openRequests") openRequests();
    else if (m.type === "getBrain") {
      const id = String(m.id || "");
      if (lastIds.includes(id)) panel.webview.postMessage({ type: "brain", ...core.brainInfo(id, c, lastPriv.has(id)) });
    } else if (m.type === "openBrain") {
      const id = String(m.id || ""), b = lastIds.includes(id) ? core.brainFor(id, c) : null;
      if (b && b.exists) vscode.window.showTextDocument(vscode.Uri.file(b.file), { preview: false, viewColumn: vscode.ViewColumn.Beside });
    } else if (m.type === "createBrain") {
      const id = String(m.id || "");
      if (!lastIds.includes(id)) return;
      panel.webview.postMessage({ type: "brainResult", ...core.createBrain(id, c) });
      panel.webview.postMessage({ type: "brain", ...core.brainInfo(id, c, lastPriv.has(id)) });
    } else if (m.type === "uploadPic") uploadPic(String(m.member || ""));
    else if (m.type === "attachDigest") attachFile(String(m.id || ""));
    else if (m.type === "saveTeam") saveTeam();
    else if (m.type === "spark") spark();
    else if (m.type === "decide") decide(m.k, String(m.item || "")).catch(e => log("Decide ERROR (outer): " + ((e && e.stack) || e)));
    else if (m.type === "dismissWelcome") { if (gstate) { gstate.update(WELCOME_KEY, true); gstate.update(START_KEY, false); } }
    else if (m.type === "startOpen") { if (gstate) gstate.update(START_KEY, !!m.open); }
    else if (m.type === "setLeader") saveLeader(m.name).then(r => { if (panel) panel.webview.postMessage({ type: "leaderResult", ...r }); });
    else if (m.type === "restoreTeam") restoreTeam();
    else if (m.type === "digest") {
      const id = String(m.member || ""), file = attach && attach.id === id ? attach.path : "";
      const r = core.digestRequest(m, lastIds, c, file);
      if (r.ok) attach = null;
      panel.webview.postMessage({ type: "digestResult", ...r });
    }
  });
  panel.onDidChangeViewState(() => { if (panel && panel.visible) push(); });
  panel.onDidDispose(() => { clearInterval(timer); timer = null; panel = null; attach = null; sidePush(); });
  restart();
}

function activate(context) {
  store = context.globalStorageUri.fsPath;
  loadedStamp = codeStamp();
  gstate = context.globalState;
  ext = context.extension || vscode.extensions.getExtension("simonjamesfowler-ux.rebel-bot-swarm") || null;
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.text = "$(organization) Swarm";
  bar.tooltip = "Rebel Bot Swarm: open or close the dashboard (it reads only while open)";
  bar.command = "rebelBotSwarm.toggle";
  bar.show();
  context.subscriptions.push(bar, vscode.commands.registerCommand("rebelBotSwarm.show", show),
    vscode.commands.registerCommand("rebelBotSwarm.toggle", toggle),
    vscode.window.registerWebviewViewProvider("rebelBotSwarm.side", sideProvider),
    vscode.commands.registerCommand("rebelBotSwarm.openRequests", openRequests),
    vscode.commands.registerCommand("rebelBotSwarm.saveTeam", saveTeam),
    vscode.commands.registerCommand("rebelBotSwarm.spark", spark),
    vscode.commands.registerCommand("rebelBotSwarm.setLeader", setLeader),
    vscode.commands.registerCommand("rebelBotSwarm.restoreTeam", restoreTeam),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration("rebelBotSwarm")) return;
      sidePush();
      if (!panel) return;
      panel.webview.options = { enableScripts: true, localResourceRoots: roots(cfg()) };
      panel.webview.html = html(panel.webview);
      restart();
    }),
    { dispose() { clearInterval(timer); clearInterval(sideTimer); if (panel) panel.dispose(); } });
  storageTip(context).catch(() => { /* tip only */ });
}

function deactivate() { clearInterval(timer); clearInterval(sideTimer); }

module.exports = { activate, deactivate };
