// Rebel Bot Swarm - VS Code extension. Shows your Claude Code sessions as a team: status, avatars, messages.
// Local only: no network, no telemetry. It reads only while its panel is open and visible, and stops when closed.
// The status-bar button only opens the panel. Webview: strict CSP, no remote content, pictures only from the
// avatars folder you set.
"use strict";
const vscode = require("vscode"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const core = require("./core.js");

let panel = null, timer = null;

function cfg() {
  const c = vscode.workspace.getConfiguration("rebelBotSwarm");
  return {
    boardFile: c.get("boardFile", ""), privateMembers: c.get("privateMembers", []), scope: c.get("scope", "workspace"),
    avatarsFolder: c.get("avatarsFolder", ""), requestsFolder: c.get("requestsFolder", ""),
    refresh: Math.min(60, Math.max(2, Number(c.get("refreshSeconds", 5)) || 5)),
    workspaceFolders: (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath) };
}

function roots(c) {
  const a = core.expandHome(c.avatarsFolder);
  return a ? [vscode.Uri.file(a)] : [];
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
  let state;
  try { state = core.buildState(cfg(), p => panel.webview.asWebviewUri(vscode.Uri.file(p)).toString()); }
  catch (e) { state = { updated: "", holder: "", waiting: [], members: [], feed: [], error: String((e && e.message) || e) }; }
  panel.webview.postMessage({ type: "state", state });
}

function restart() {
  clearInterval(timer);
  timer = panel ? setInterval(push, cfg().refresh * 1000) : null;
}

function show() {
  if (panel) { panel.reveal(); return; }
  panel = vscode.window.createWebviewPanel("rebelBotSwarm", "Rebel Bot Swarm", vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: roots(cfg()) });
  panel.iconPath = vscode.Uri.file(path.join(__dirname, "media", "icon.png"));
  panel.webview.html = html(panel.webview);
  panel.webview.onDidReceiveMessage(m => {
    if (!m || typeof m !== "object") return;
    if (m.type === "ready") push();
    else if (m.type === "newMember") panel.webview.postMessage({ type: "newMemberResult", ...core.newMemberRequest(m, cfg().requestsFolder) });
  });
  panel.onDidChangeViewState(() => { if (panel && panel.visible) push(); });
  panel.onDidDispose(() => { clearInterval(timer); timer = null; panel = null; });
  restart();
}

function activate(context) {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.text = "$(organization) Swarm";
  bar.tooltip = "Rebel Bot Swarm: show your sessions (reads only while open)";
  bar.command = "rebelBotSwarm.show";
  bar.show();
  context.subscriptions.push(bar, vscode.commands.registerCommand("rebelBotSwarm.show", show),
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
