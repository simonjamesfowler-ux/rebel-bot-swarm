# Changelog

## 0.5.5
- **A helper that is given more work lights up again.** A helper woken with a new message after its report used to
  stay "finished" for good, because its old report was still in its record. Now a report counts only when it is
  the last thing the helper did.

## 0.5.4
- **Decide goes to your leader's own chat.** While the leader's chat is running, Decide opens no tab: it writes
  "DECIDE <time>.json" in the requests folder (item, raised_by, the board line as its id, board, section, time); the
  leader watches that folder, asks you, and sends the answer to whoever raised the item. The item shows "Sent to
  <leader>". The leader marks its running chat with "LEADER WATCH.json" {"sessionId": "..."} in the requests folder.
  With no leader chat running, Decide opens a new chat with the question and says so.
- **Tokens: the model each member used** (for example Opus 5.5) beside the row; hover for the tokens per model and
  the effort level the transcript records.

## 0.5.3
- **Helpers light their card wherever they were started.** A helper (subagent) started from a session in any
  project folder now lights its member's card, not only one started in this window's folders. As in this window's
  own folders, a helper with Claude Code's record stays lit for 15 minutes between writes (long steps), one without
  it for 2 minutes. Other folders are only read for helpers inside that time, so the dashboard stays quick.
- **Helpers are named from Claude Code's own record.** The card is found from the helper's agent type (for example
  `ada-lovelace` lights the card Ada), so the brief no longer has to start "You are ...". That line is still used
  when there is no record.
- **The card says what the helper is doing.** A working card's tooltip shows the helper's task, then its latest step.

## 0.5.2
- **OPEN button.** The leader button reads OPEN and the name on the leader's card (for example OPEN COORDINATOR)
  and follows a rename at once. It always shows the full name: when the row is short of room the other buttons
  become icons (with tooltips), then the row wraps, and only then does the name break onto two lines.
  What it does is unchanged.
- **Botify.** In a member's avatar list, **Create...** makes a cartoon avatar from a photo or screen grab: paste,
  drop or choose a picture, drag the circle onto the face, press Botify, adjust skin, hair, beard, eyes and glasses,
  then Save as new avatar. The picture is read inside the dashboard and never leaves the computer; only the drawing
  is saved (a new BOTIFY file in the avatars folder).
- **Network view.** Nodes never overlap; each team bar is only as wide as the name; lines run under the nodes, end at
  the bar and are routed around every face; names stay readable.
- **Save.** A pop-out closes only once the save has landed, with a "Saved" note; an error keeps it open. Changing a
  setting no longer reloads the page. Save and Close sit at the top of the member pop-out only, always visible.
- **Brain Folder** link in each member pop-out (tooltip: the full path) opens the brain folder, making it first
  with an empty MEMORY.md when needed.
- Team and Role boxes match the theme.
- **Saved settings with no card** are kept and listed at the top of a member's edit box; choose the card each one
  belongs to and press Use for this card (members.json is backed up first).
- **Smaller top buttons.** 32px tall with 12px text; OPEN is the only filled button. When the row is short of room
  the other buttons become icons (tooltips keep the names), then the row wraps.
- **Tokens button.** Opens a small pop-out with each member's token use today and the team total, with a bar each.
  The figures are the `usage` fields Claude Code writes in the transcripts (the member's open chat and its helpers),
  each reply counted once. A member with no transcript today shows "not known". Hover a row for the split.
- The figure boxes under the top row wrap on narrow windows: nothing on the dashboard scrolls sideways (360px and up).
- Updating keeps your data: members, teams, avatars (including Botify ones) and brains live outside the extension's
  install folder, and an upgrade test checks them before each release.

## 0.5.1
- **Smaller cards.** A card now shows only the picture, the name, the status and the role or TEAM LEAD tag. The job,
  the files booked, the shared-slot note and the Condense button moved to the full view (click the card).
- **Add team member shows the new card at once** (as ready). It is kept in the members file (`added`) until your
  board has a row for it. A name whose first word another card already uses is refused, because cards are keyed by it.
- **A colour per team.** Create team asks for a colour (12 colours or your own #rrggbb). Change it later with
  **Team ▾ > Change team colour...** or the command **Rebel Bot Swarm: Change team colour**. Each team card carries a
  stripe in its team colour. Setting `rebelBotSwarm.teams` takes an optional `color`.
- **Delete team** (Team ▾ menu or command): the team goes and its members leave it. No card is deleted; its
  sub-teams become teams of their own.
- **Sub-teams** (one level). Create team asks **Is it part of another team?**; a sub-team shows under its parent
  (dashed header, "part of ..."), can take members from its parent, and shows in the parent team's window. Its
  leader links to the parent's leader in Network view. Setting `teams` takes an optional `parent`.
- Fixed: the hand-over lines of Network view stayed drawn on the cards after switching back to card view. Lines now
  show in Network view only.
- Save team / Restore team keep the new `added` cards, team colours and sub-teams.

## 0.5.0
- **Create team... and Team ▾ buttons** at the top, beside Save team and Restore team. Create team asks for the
  name, lets you tick its members (cards with no team yet; members of other teams are not moved), its leader and its
  scope, then can show the new team in this window. **Team ▾** (shown once a team exists) switches the window between
  the whole swarm and one team. The commands are now **Create team** and **Switch team**.
- **Teams inside the swarm.** New user setting `rebelBotSwarm.teams` (`[{name, leader, scope}]`, max 12) and command
  **Rebel Bot Swarm: Add team**. Each card's edit panel has a **Team** and a **Role** box (roles: Team leader + the new
  setting `rebelBotSwarm.roles`). The dashboard groups the cards: swarm leader first (above all teams), then each team
  with its leader first and its scope line on the header, then No team. Cards show a TEAM LEAD badge or their role.
  Network view: swarm leader in the middle, team leaders on an inner ring, each team's members together, dotted team
  lines in the team colour.
- **One team per window.** New workspace setting `rebelBotSwarm.team` and command **Rebel Bot Swarm: Show one team in
  this window**: that window shows the swarm leader + one team, and **Spark** starts that team's leader.
- **Several windows, one team file.** A member save is refused if another window saved the same member since the card
  was opened. Each window writes members.json through its own temp file.

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
