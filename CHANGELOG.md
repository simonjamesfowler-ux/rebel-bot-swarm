# Changelog

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
