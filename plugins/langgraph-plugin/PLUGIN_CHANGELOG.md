# langgraph-plugin plugin changelog

Version history for the **plugin package** (`.claude-plugin/plugin.json` + the marketplace entry) —
the skills the plugin ships.

Format follows [Keep a Changelog](https://keepachangelog.com/); newest first. Semver on the plugin:
**major** = removed/renamed skill or breaking workflow change, **minor** = new skill / capability /
template, **patch** = doc or fix with no new surface.

## [0.3.0] — 2026-07-02

Both skills now find the RIGHT running server instead of trusting the configured port, the
investigation skill inventories its monitoring sources before digging in, and the runner gains an
opt-in streaming wire capture. Handoff-aware analysis throughout.

### Added
- `follow-langgraph-conversation`: Phase 0 is now **environment discovery** — sweep live listeners
  for LangGraph instances, probe each for the thread to find the instance that OWNS it (a 404 on
  the configured port does not mean the thread is gone), map that instance to its project (host
  process or container), and print a monitoring-source inventory (dev-server API, LangSmith,
  process/container logs, other tracing backends) before investigating.
- `follow-langgraph-conversation`: LangSmith **endpoint resolution** (`LANGSMITH_ENDPOINT` /
  legacy `LANGCHAIN_ENDPOINT`; EU and self-hosted deployments) threaded through every Phase 2
  query; trace availability verified against the thread's time window instead of trusting the
  current tracing flag.
- `follow-langgraph-conversation`: **handoff-aware analysis** — read handoff `additional_kwargs`
  and step-batch tool envelopes from thread values; guidance for node-built final messages (no
  LLM run in LangSmith) and stream-only custom events; new root-cause category
  (handoff/routing decision errors); three new pitfalls (trusting the configured port,
  hardcoding the LangSmith endpoint, trusting the current tracing flag).
- `run-langgraph-conversation`: pre-start **instance sweep** — find already-running LangGraph
  servers on any port and confirm which one serves THIS project (process cwd / container
  inspect / graph-id match) before starting a new one.
- `run-langgraph-conversation`: **Phase 3b (opt-in) streaming wire capture** — a raw SSE run with
  `stream_mode: ["messages-tuple", "updates", "custom"]`, an event-order summary, and the capture
  kept as a golden fixture for stream-consumer tests.
- `run-langgraph-conversation`: handoff-turn surfacing (kwargs + state slots), the
  no-middleware-locally expectation (post-handback turns keep hitting the same agent on the dev
  server), and the identity-sticks-from-turn-1 rule for channel-fronted graphs with
  preserve-initial reducers.

### Changed
- `plugin.json` + `marketplace.json` descriptions and the root README skill bullets refreshed to
  the new capability set.

## [0.2.0] — 2026-06-05

### Changed
- Both skills discover the dev-server port and LangSmith credentials from the project's own
  config (`langgraph.json`, dev script, `docker-compose`, `.env`) instead of assuming defaults.

## [0.1.0] — 2026-06-05

### Added
- Initial release: `run-langgraph-conversation` (execute a single- or multi-turn test
  conversation against the local dev server, capture the `thread_id`) and
  `follow-langgraph-conversation` (investigate a thread end-to-end — dev-server checkpoint
  history + optional LangSmith traces — and produce root-cause analysis).
