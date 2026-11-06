# Dispatch Mode Agent Team

A DSH desktop plugin plus an agent preset. It turns the official experimental Agent Teams into a
"clarify the request first, then build" way of working.

## What it gives you

- **The dispatch-mode preset**: the Lead interrogates the request before acting — each round lists every
  open question at once as a question card in the chat (options plus a recommendation); you pick and submit.
  No silent assumptions, and no work before you and the team share the same understanding.
- **12 teammate roles** ordered by workflow stage (call what you need, not all of them): external research, repo
  research, frontier review, plan review, build, integrate, reproduce, logic review, adversarial review,
  visual review, retrospective, docs and terminology.
- **Unified or per-role configuration**: the plugin page sets one model and reasoning effort for every role
  at once, or each role individually; each role also picks its own agent preset (PTC / standard / minimal)
  and its batch-call mode.
- **Narrowed tool surface**: teammates automatically lose the goal and subagent tools and keep only the
  team tools their job needs.
- **Structured reporting**: every teammate must call `report_result` (status / evidence / acceptance /
  unresolved items) and the plugin delivers it to the Lead.
- **Two places to open the team**: the "Agent team" row in the left sidebar, or the "Open workspace"
  button on the session's member panel. Both open the team topology canvas (real hand-offs, live numbers,
  shared tasks, teammate conversations).
- **A /team switch**: off by default, because a team really does spend more model budget. The switch is
  remembered per session, and sessions that had it on are restored after the host restarts.

## What it does not do

- It does not change or replace the official Agent Teams implementation — that stays available as-is;
  this plugin is a usage layer on top of it.
- It adds no model-call path of its own: a teammate's model and effort still go through the official
  `agent/request` override.
