# Sandbox Detail TUI Design

## Context

The AgentPod TUI currently supports login, sandbox listing, sandbox creation, and dashboard lifecycle actions. The next useful slice is a detail view for a selected sandbox. This keeps the TUI focused on sandbox management before moving into larger chat, terminal, files, or git features.

The management API already exposes the endpoints needed for this slice:

- `GET /api/v2/sandboxes/:id` for fresh sandbox details.
- `GET /api/v2/sandboxes/:id/stats` for container resource usage.
- `GET /api/v2/sandboxes/:id/logs?tail=100` for recent container logs.

## Goals

- Open a sandbox detail view from the dashboard with `Enter` on the selected sandbox.
- Show an overview of the selected sandbox.
- Show resource stats for running sandboxes when available.
- Show recent container logs.
- Keep the slice small, testable, and state-driven.

## Non-Goals

- Embedded terminal access is out of scope.
- AI chat, OpenCode sessions, permissions, and streaming are out of scope.
- File browser and git UI are out of scope.
- Lifecycle actions inside the detail view are out of scope for this slice; dashboard shortcuts remain the primary lifecycle controls.
- Streaming logs are out of scope; this slice uses a refreshable recent-log snapshot.

## User Flow

1. User views the dashboard sandbox list.
2. User moves selection with existing dashboard navigation.
3. User presses `Enter` on a selected sandbox.
4. TUI opens `SandboxDetail` view for that sandbox.
5. Detail view defaults to `Overview` tab.
6. User switches detail tabs to `Stats` or `Logs`.
7. User presses `r` to refresh the active detail tab.
8. User presses `Esc` to return to Dashboard.

## Detail Tabs

### Overview

Overview shows the freshest available sandbox metadata:

- Name.
- Status.
- ID.
- Description if present.
- Git URL if present.
- Flavor ID if present.
- Resource tier ID if present.
- Container ID if present.
- Created and updated timestamps.

Opening the detail view should immediately attempt to load fresh data from `GET /api/v2/sandboxes/:id`. If that request fails, the view should still show the dashboard's selected sandbox snapshot and display the error.

### Stats

Stats shows data from `GET /api/v2/sandboxes/:id/stats`:

- CPU percent.
- Memory usage and limit.
- Memory percent.
- Network receive/transmit.
- Block read/write.

If stats fail to load, show an error in the Stats tab without leaving the detail view. This commonly happens when a sandbox is stopped or the container runtime cannot provide stats.

### Logs

Logs shows recent log text from `GET /api/v2/sandboxes/:id/logs?tail=100`.

The first slice should render plain text logs in a scrollable or clipped pane. Log search, filtering, live streaming, and tail-size controls can come later.

## Keyboard Model

- `Enter` on Dashboard opens detail for the selected sandbox.
- `Esc` in detail returns to Dashboard.
- `Tab` / `Shift+Tab` switches between `Overview`, `Stats`, and `Logs` within detail.
- `1`, `2`, `3` jump directly to `Overview`, `Stats`, and `Logs`.
- `r` refreshes the active detail tab.
- `q` should not quit from detail in this slice; use `Esc` to return to Dashboard, then `q` to quit.

## App State

Add `View::SandboxDetail`.

Add focused detail state to `App`:

- Selected sandbox ID.
- Detail tab enum: `Overview`, `Stats`, `Logs`.
- Fresh sandbox detail snapshot, optional.
- Stats snapshot, optional.
- Logs string, optional.
- Error message, optional.
- Loading flags for detail, stats, and logs.

The detail view should prefer fresh detail data when available and fall back to the dashboard list item if the detail request fails.

## API Client

Extend `apps/tui/src/api/sandboxes.rs` with:

- `get_sandbox(id)`, already present.
- `get_sandbox_stats(id)` returning a new `SandboxStats` type.
- `get_sandbox_logs(id, tail)` returning log text from `{ logs, tail }` response.

Add `SandboxStats` to `apps/tui/src/types.rs` with fields matching the API response:

- `cpu_percent`
- `memory_usage`
- `memory_limit`
- `memory_percent`
- `network_rx`
- `network_tx`
- `block_read`
- `block_write`

Use serde renames to map API camelCase fields where needed.

## Rendering

Create `apps/tui/src/ui/views/sandbox_detail.rs`.

The renderer should use the current TUI visual style:

- Top line or block title: selected sandbox name and status.
- Internal tab row: Overview, Stats, Logs.
- Body area for the active tab.
- Error line when the active tab has an error.
- Help line: `Tab: next tab | Shift+Tab: previous tab | r: refresh | Esc: dashboard`.

The renderer should be simple and text-first. More polished tables, gauges, and log scrolling can be added after behavior is stable.

## Testing Plan

Use TDD for each behavior:

- Dashboard `Enter` opens `View::SandboxDetail` for the selected sandbox.
- `Esc` returns from detail to Dashboard.
- Detail opens with `Overview` tab and loads fresh sandbox detail from API.
- Detail falls back to dashboard snapshot when fresh detail load fails.
- `Tab`, `Shift+Tab`, and number keys switch detail tabs.
- `r` refreshes Overview, Stats, or Logs depending on active tab.
- Stats API parses CPU, memory, network, and block I/O fields.
- Logs API parses `{ logs, tail }` response.
- Stats failure stays in detail and records an error.
- Logs failure stays in detail and records an error.

## Implementation Notes

Keep the first implementation synchronous within key handlers, matching the current TUI app style. Do not introduce background tasks or streaming for this slice. If later responsiveness becomes a problem, move detail loading into the event loop's async result channel as a separate refactor.
