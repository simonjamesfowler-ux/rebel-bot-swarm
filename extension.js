// Rebel Bot Swarm - VS Code extension. Shows your Claude Code sessions as a team: status, avatars, messages.
// Local only: no network, no telemetry. It reads only while its panel is open and visible, and stops when closed.
// The status-bar button only opens the panel. Webview: strict CSP, no remote content, pictures only from the
// avatars folder. Writes only when you click a button in the panel (Save, Upload picture, Make an empty brain file,
// Save digest request): to VS Code's storage folder for this extension, or to the folders / file you set.
// Never writes agent files, brains (except a new empty one), the board or Claude Code's files. Updates come from the Marketplace.
"use strict";
const vscode = require("vscode"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const core = require("./core.js");

let panel = null, timer = null, store = "", lastIds = [], lastPriv = new Set(), attach = null;

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
  lastIds = (state.members || []).map(x => x.id).filter(Boolean);
  lastPriv = new Set((state.members || []).filter(x => x.private).map(x => x.id));
  panel.webview.postMessage({ type: "state", state });
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

function show() {
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
    else if (m.type === "digest") {
      const id = String(m.member || ""), file = attach && attach.id === id ? attach.path : "";
      const r = core.digestRequest(m, lastIds, c, file);
      if (r.ok) attach = null;
      panel.webview.postMessage({ type: "digestResult", ...r });
    }
  });
  panel.onDidChangeViewState(() => { if (panel && panel.visible) push(); });
  panel.onDidDispose(() => { clearInterval(timer); timer = null; panel = null; attach = null; });
  restart();
}

function activate(context) {
  store = context.globalStorageUri.fsPath;
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.text = "$(organization) Swarm";
  bar.tooltip = "Rebel Bot Swarm: show your sessions (reads only while open)";
  bar.command = "rebelBotSwarm.show";
  bar.show();
  context.subscriptions.push(bar, vscode.commands.registerCommand("rebelBotSwarm.show", show),
    vscode.commands.registerCommand("rebelBotSwarm.openRequests", openRequests),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!panel || !e.affectsConfiguration("rebelBotSwarm")) return;
      panel.webview.options = { enableScripts: true, localResourceRoots: roots(cfg()) };
      panel.webview.html = html(panel.webview);
      restart();
    }),
    { dispose() { clearInterval(timer); if (panel) panel.dispose(); } });
}

function deactivate() { clearInterval(timer); }

module.exports = { activate, deactivate };
