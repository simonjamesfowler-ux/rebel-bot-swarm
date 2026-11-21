# Changelog

## 0.4.2
- **Spark opens beside the dashboard.** The new Claude Code chat now opens in the editor group to the RIGHT of the
  dashboard, so the dashboard stays in view. If that group is there already, it is used again (no new split on each
  click). Decide uses the same place when it opens the leader's chat. If the dashboard is not open, or the Claude
  Code command fails, the chat opens in Claude Code's default place.
- **Condense button on each card** (cards with an open chat). It works only when the chat is safe to condense or
  restart: idle, no helper it started still running, nothing waiting, no open board item names the member, board job not still running (the tooltip says
  why when it is off). The card shows the chat's context size; the button is orange and pulses when the chat is large
  (new setting `rebelBotSwarm.condenseTokens`, default 250000) or the board job says done. Click: choose **Condense**
  (`/compact`) or **Restart** (new chat). The member first saves its lessons to its brain: the BRAIN SAVE prompt (new
  setting `rebelBotSwarm.condensePrompt`) goes on the clipboard and the member's chat comes to the front; a
  `CONDENSE <time>.json` request file goes to the requests folder.

## 0.4.1
- **Decide button fixed (request file first, toast, output channel).** A click now writes the `DECIDE <time>.json`
  request file FIRST, then tries to open the leader's chat. Every click shows one VS Code notice: `Decide sent to
  <leader> ...` or the exact error. Errors and each Decide step go to the new output channel **Rebel Bot Swarm**.
  The page shows "sending..." and, if the extension gives no answer in 4 seconds, tells you to reload the window.
- Board items are compared without markdown marks, extra spaces, CR or a trailing full stop.
- If the extension files change on disk after VS Code loaded them (a new install of the same version), the panel
  tells you to run **Developer: Reload Window**.

## 0.4.0
- **Compact summary row:** the summary tiles are one 30 px row that does not wrap (on a narrow panel the row scrolls).
  The shared-slot tile shows a short text (for example "Free · 21 Nov 10:15"); the full text is in its tooltip. Click a
  tile (or press Enter on it) to go to its section. The Network view now fills the height that is left.
- **Waiting for you** counts only the open top-level bullets in the board's "Waiting for" section (sub-lines, struck
  `~~…~~`, `[x]` and DONE items are not counted). Each item has a **Decide ▸** button (left of the item, in one
  column): it puts `DECIDE: <item>` in your leader's OWN chat (new setting `rebelBotSwarm.leaderSessionId`, else the
  newest chat whose tab title starts with the leader name) and always writes a `DECIDE <time>.json` request file. If no
  leader chat is found, it opens a new chat with a decision prompt (new setting `rebelBotSwarm.decidePrompt`).
- Header: Spark, Save team, Restore team and Add team member are one compact button group on the header row.
- New setting `rebelBotSwarm.showUnnamedSessions` (default off): sessions that still have their default title (the
  folder name) and are not on the board get no card.
- **Spark** (big button at the top of the dashboard, command **Rebel Bot Swarm: Spark a new chat**): opens a new
  Claude Code chat with a starter prompt in the chat box (you press Enter to send it). The default prompt makes the
  chat a front desk that hands the task to a matching subagent or writes a request file for your coordinator, then
  tells you that you can close the tab. New setting `rebelBotSwarm.sparkPrompt`. If the Claude Code commands do not
  work, the prompt goes on the clipboard and the Claude Code side bar opens.
- **Open and close:** the **Swarm** status-bar button now opens the dashboard, or closes it when it is in front. New
  command **Rebel Bot Swarm: Toggle dashboard** (keys Ctrl+Alt+S on Windows and Linux). New **Rebel Bot Swarm** icon in the
  activity bar: Open dashboard, Spark and Save team buttons and a 3-line status (working, waiting for you, idle or ready).
- **Team leader:** new settings `rebelBotSwarm.leaderName` (default "Coordinator") and `rebelBotSwarm.leaderRole`, and
  command **Rebel Bot Swarm: Set leader name**. Spark opens the chat as the leader ("Hi, I'm (leader name). What would
  you like to do?"); a custom `sparkPrompt` can use `{leader}` and `{leaderRole}`. The Spark button shows the name.
  The leader card has a violet border, a left bar and a LEAD badge (a violet ring in Network view), also when idle.
- **New users:** a VS Code walkthrough "Start here: Rebel Bot Swarm" (Help > Get Started) and a small **Start here**
  drop-down in the dashboard header with the same four steps and the box for the leader name: open on first run,
  closed after "Got it", open again from the header at any time (the open or closed state is kept). README: "Start
  here" at the top.

## 0.3.1 (not released; part of 0.4.0)
- **Save team...** (button at the top of the panel, command **Rebel Bot Swarm: Save team**): one `.zip` file where
  you choose, with your members file, pictures, panel brains, `rebelBotSwarm.*` settings and a manifest. Optional
  groups, all off by default: Claude Code member brains, agent files, skills (not `synced`) and project memory (with
  a privacy warning). Private members' brains are left out unless you tick "Include private members' brains".
  Never saved: Claude Code settings, credentials, `.env` files, keys, tokens, transcripts.
- **Restore team...** (button and command): from a Save team `.zip` file or folder. Checks file names (no path
  tricks), file types (pictures by their first bytes, text files) and sizes; shows what is new and what it replaces;
  asks first; keeps a dated copy of each replaced file and setting in VS Code's storage folder (`restore backups`).
- A one-time tip when your team is in VS Code's storage folder (it can be deleted when you uninstall).
- README: new section "Keep your team safe".
## 0.3.0
- **Dashboard look:** a strip of summary tiles (working, waiting for you, idle or ready, jobs done today, messages
  today, shared slot), panels with headers, colours from your VS Code theme (light, dark and high contrast), and a
  layout that stacks on narrow panels.
- **Smaller member cards** (half the size), so more members fit. Idle, ready and closed members stay grey.
- **Working window** on the right: who is working now and the current step, recent progress lines, the messages
  between members (briefs from the coordinator, reports back, and messages), and the board's `## Log` lines. Read from
  the helper (subagent) transcripts that Claude Code writes, so it works with any team. Private members show their
  status only.
- **Comms lines:** a glowing line with a moving pulse from sender to receiver for each new hand-over, fading after
  about 15 seconds; recent links stay as faint lines. **Network view** shows the members as nodes on a ring with the
  busiest one in the middle. A static line when your system asks for reduced motion.
- **Edit panel:** Save and Close at the top (and still at the bottom); the avatar choices are in a dropdown with
  thumbnails (keyboard: arrows, Home, End, Escape); **Upload picture...** copies a PNG, JPEG or WebP (max 2 MB) into
  the avatars folder and selects it.
- **Rebel crew avatars:** 12 new original flat geometric faces and bots (pilot, mechanic, CAD engineer, drafter,
  coordinator, admin, researcher, teacher, personal assistant, navigator, helper droid, scout bot).
- **Role instructions** match more agent files: by file name, the `name:` line, the leading name in the `description:`
  line, or an `"agent"` value in the members file.
- **Brain:** the edit panel shows the member's own Markdown notes: Claude Code's subagent memory
  (`memory: user | project | local` in the agent file, file `MEMORY.md`) if there is one, else `<member>.md` in the new
  `rebelBotSwarm.brainsFolder`. **Open** it in VS Code, or make an empty one.
- **Digest:** give a member a text, a link or a file to learn. The panel saves one `DIGEST <time>.json` request (and a
  copy of the file) for your coordinator session. The panel never edits agent files or brains.
- No avatars folder set: your pictures now go to VS Code's storage folder for this extension.

## 0.2.0
- Click a card to edit the member: the name on the panel, the avatar (14 drawn styles or your own pictures), a next
  task and role instructions. The name and avatar are kept in a members file. The task and role instructions are
  saved as one request file ("EDIT MEMBER <time>.json") for your coordinator session. The panel never edits agent files.
- The role instructions box is filled from the member's agent file in `~/.claude/agents/` (read only), if there is one.
- Idle, ready and closed members show as grey cards, so the busy members stand out.
- "Add team member" now always shows. With no requests folder set, requests go to VS Code's storage folder for this
  extension. New command: **Rebel Bot Swarm: Open requests folder**.
- New settings: `rebelBotSwarm.membersFile` (where names and avatars are kept) and `rebelBotSwarm.agentCards`
  (a ready card for each agent file that has no card yet; default off).
- Ready for the VS Code Marketplace: updates now come from the Marketplace.

## 0.1.1
- Members with no open tab now show as "ready" (idle, available through the coordinator) instead of "closed". A member whose background helper (subagent transcript written in the last 2 minutes) is running shows as "working".

## 0.1.0
- First version: team cards with original avatars and status, shared slot, waiting list, message feed, optional own pictures, optional "Add team member" request file.
