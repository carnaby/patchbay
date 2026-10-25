# Proposal 0002: sound cues on live widgets

|                    |                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | **Implemented.** See "Implementation notes" at the end.                                                                                |
| Area               | `packages/core` (schema, rule evaluation), `apps/web` (playback, widget editor, presentation mode), `apps/server/src/mcp/reference.ts` |
| Effort             | About a day including tests                                                                                                            |
| New infrastructure | None. No server work at runtime, no push, no audio files.                                                                              |

## Goal

A dashboard on a wall screen can **make a short sound when something happens in its live data**: a new order arrives, a
price crosses a threshold. Like a shop bell. Whoever sets it up decides whether and how to use it; the TV's mute button
is the ultimate off switch.

## Non-goals

These are deliberately out, to keep the feature small and the concept clean:

- No notifications outside an open dashboard: no push, e-mail, webhooks or background checks on the server.
- No automation ("when X then do Y").
- No custom uploaded sounds (avoids file storage, size limits and copyright issues).

## User experience

### Setting it up (editor, per widget)

A collapsible **Sound** section in the widget editor:

| Field                  | Values                                                         | Default           |
| ---------------------- | -------------------------------------------------------------- | ----------------- |
| Play when              | _New rows arrive_ · _A condition becomes true_                 | _New rows arrive_ |
| Rows are identified by | a column (e.g. `order_id`); empty = compare row counts         | empty             |
| Condition              | expression in the existing language, e.g. `price > 100000`     | –                 |
| Sound                  | one of the built-in sounds below, each with a ▶ preview button | Bell              |
| Volume                 | 0–100 % slider, with preview                                   | 70 %              |
| At most once every     | seconds (cooldown)                                             | 10 s              |

Previewing plays the sound immediately at the chosen volume. Choosing a sound plays it once as well, so picking by ear
is quick.

### Built-in sounds

Synthesised in the browser with the Web Audio API: no audio files, no licensing, a few lines each, identical on every
device.

| Id      | Character                                | Typical use                                 |
| ------- | ---------------------------------------- | ------------------------------------------- |
| `bell`  | Classic shop-door bell, bright and short | New order, new customer                     |
| `chime` | Two rising tones, friendly               | Something good happened                     |
| `ding`  | Single soft tone                         | Quiet offices, frequent events              |
| `cash`  | "Ka-ching" cash register                 | Sales, payments                             |
| `pop`   | Very short, subtle click                 | High-frequency updates                      |
| `alert` | Three firm beeps                         | A threshold was crossed and needs attention |

### On the screen

- A widget with a sound shows a small speaker icon in its header (muted icon when muted).
- When it plays, the widget gets the same short highlight that agent edits use, so people can see _which_ widget rang.
- **Autoplay rule:** browsers block sound until the page has been clicked once. If a dashboard has sounds and audio is
  still locked, presentation mode shows a single **"Enable sound"** button in its control bar. One click (or OK on the
  TV remote) and it stays enabled for that tab. This is explained in the TV (i) tooltip as well.
- A **mute toggle** for this viewer in the dashboard toolbar and in the presentation control bar, remembered in
  `localStorage`. It affects only the current screen, never other viewers.

### Agents

Agents can set sounds through the normal `updateWidget` operation, e.g.
`{ "op": "updateWidget", "id": "orders", "set": { "sound": { "trigger": { "kind": "newRows", "key": "order_id" }, "sound": "bell" } } }`.
The reference text gets a short section, including the advice to use sounds sparingly.

## Rules of behaviour

1. **Edge-triggered.** A condition plays once when it _becomes_ true, not on every refresh while it stays true. It must
   become false and true again to play again.
2. **Never on load.** The first result after opening a page, reconnecting or refetching only sets the baseline.
3. **New rows by key.** With a key column, a sound plays when a key appears that was not in the previous result. This
   avoids false alarms when rows drop off the front of a rolling window. Without a key, it compares row counts and plays
   only when the count grew.
4. **Cooldown per widget**, plus a global throttle of one sound per 1.5 s across the dashboard, so ten widgets firing
   together make one sound, not a cacophony.
5. **Only where it is displayed.** Sounds play in browsers showing the dashboard, never in the editor's preview panes
   and never on the server.

## Data model

Add an optional field to every data-bound widget (`chart`, `kpi`, `gauge`, `table`):

```ts
sound?: {
  trigger: { kind: 'newRows'; key?: string } | { kind: 'condition'; expr: string };
  sound: 'bell' | 'chime' | 'ding' | 'cash' | 'pop' | 'alert';
  volume: number;       // 0..1, default 0.7
  cooldownSec: number;  // 0..3600, default 10
}
```

Strict schema as everywhere; `expr` is validated with the existing parser. Older dashboards simply have no `sound`.

## Implementation outline

- `packages/core/src/sound.ts`: the schema and a pure `soundDecision(rule, previous, next, state)` that returns
  `play | silent` plus the new state (baseline keys, last condition value, last played time). All rules above live here.
- `apps/web/src/lib/sounds.ts`: one shared `AudioContext`, the six synthesised sounds, `unlockAudio()` for the
  autoplay rule, and the mute preference.
- `apps/web`: call `soundDecision` where dataset results arrive (the SSE `data` handler and query results), the Sound
  section in `WidgetEditor`, the speaker icon in `WidgetFrame`, mute and "Enable sound" in the toolbar and presentation
  controls.
- `apps/server/src/mcp/reference.ts`: document the field.

## Testing

- Core unit tests for `soundDecision`: first result is silent, new key plays, rolling window without new keys is silent,
  count growth without key, condition edge (false→true plays, true→true silent, true→false→true plays again), cooldown.
- Web: a Playwright test with a stubbed `AudioContext` that counts plays while a live dataset changes.
- Manual: listen to all six sounds on a laptop, a phone and a TV browser.

## Risks

- **Annoyance.** Mitigated by defaults (off unless configured), cooldowns, a global throttle, a per-screen mute and
  edge-triggering.
- **Autoplay confusion** ("why is it silent?"). Mitigated by the explicit "Enable sound" button and the TV tooltip.
- **Background tabs.** Browsers may delay timers in hidden tabs; that is acceptable because the feature targets a
  visible wall screen.

## Implementation notes

Where this proposal left a detail open, the implementation decided as follows:

- **Conditions look at the last row**, the newest reading of a live source. Evaluating "any row" would stay true while
  an old reading is still inside a rolling window, so the edge would never re-arm. An empty result counts as false.
- **A trigger inside the cooldown is consumed**, not postponed: the baseline moves on, so a burst never turns into a
  late second sound.
- **One place decides.** Results from SSE and from queries both land in the TanStack Query cache; the web app listens
  there (`apps/web/src/state/sound-cues.ts`) instead of in each handler, so a result is decided exactly once however
  many frames show the widget, and editor panes reading the same data never trigger anything.
- **Baselines** are reset after an SSE reconnect and whenever the widget's rule or its dataset definition changes.
  Results that carry an error (stale copies) are ignored. A rule added while data is already on screen takes the
  current result as its baseline, so the next change can play.
- **Flash without sound.** A widget that fires still flashes when the screen is muted, audio is locked or the global
  throttle swallowed the sound, so people can still see what happened.
- **Turning it off over MCP**: `updateWidget { set: { sound: null } }` removes the rule.
- **Unlocking**: on a dashboard with sounds, the first click or key press anywhere unlocks audio; the "Enable sound"
  button is the explicit fallback for screens nobody touches. Dashboards without sounds never create an
  `AudioContext`.
- The Playwright check (stubbed `AudioContext`, controlled live events, plus real SSE from `demo.signal`) was run
  during development and is not part of CI, like the other browser checks (see architecture §10). The manual
  listening test on a phone and a TV is still open.
