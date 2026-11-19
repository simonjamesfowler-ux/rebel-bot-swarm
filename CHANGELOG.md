# Changelog

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
