# PR 2068: Galaxy back and forward (K2)

Hand test finding K2: a click on a node makes it the new root, and the only way
out is "All graph". This note fixes the concept before the code. K9 belongs to
it: a click on empty canvas no longer leaves the scope, so Back is the way to
undo a step.

## What an entry is

One entry is the complete question the Galaxy workspace answers at that moment:

| Field | Meaning |
|---|---|
| `scope` | The root identity: node id, qualified name and display name, or a file or folder path. Missing means "All graph". |
| `depth` | Loaded layers (hops). |
| `direction` | `both`, `inbound` or `outbound`. |
| `edgeTypes` | The traced relationship types, or all. |
| `trail` | The open path target (`path` to node id) or `calls` (call order), if one is shown. |
| `mode` | `galaxy` or `hierarchy`. |

The entry holds identities and parameters only, never loaded nodes, edges,
layouts or camera positions. Going back re-runs the scope; the bounded scope
cache (four results) and the neighbourhood cache make that fast in practice,
and nothing grows with the session.

"All graph" is an entry like any other, so Back after "All graph" returns to
the scope that was open before.

## Rules

1. **Bounded.** At most 25 entries. A push beyond that drops the oldest entry.
2. **Consecutive duplicates merge.** An entry equal to the current one (same
   key over all fields) is not pushed. Revisiting the same root later is a new
   entry, because it is a new step.
3. **Browser semantics.** Back and Forward move a cursor. A new navigation after
   going back drops the forward branch.
4. **No browser history per step.** There is no `pushState` per step: a long
   session would leave thousands of browser entries, and the browser Back button
   would no longer leave the page. The address bar keeps its current role.
5. **Recent roots.** Besides the linear history a list of the last 8 distinct
   roots (newest first) allows a direct jump. A jump is a new navigation: it
   restores that root with its last depth, direction and edge types and drops the
   forward branch. The list is independent of the cursor, so going back does not
   shorten it.
6. **Keyboard.** Alt+Left is Back, Alt+Right is Forward, not while typing in a
   field or the editor, and not while another surface takes the keys
   (`escapeTaken`). The page prevents the browser default for these keys.
7. **Escape.** Escape first clears an open path, then leaves the scope ("All
   graph"), which is itself a history entry.
8. **Per project.** A project switch starts a fresh history. A project that
   arrives after the first render (from the address bar) keeps "All graph" as
   the first entry.
9. **Cancel is Back.** The minus button while a layer loads (K8) moves the
   cursor back to the previous depth instead of pushing it again, so Forward
   retries the cancelled layer.
10. **Empty canvas.** A click on empty canvas inside a scope clears only the
    path highlight (K9). That is a step of its own, so Back brings the path
    back.

## Where it lives

- `graph-ui/src/graph/navigation-history.ts`: the generic, pure model
  (`push`, `back`, `forward`, `recent`) over any entry with a key function. K27
  (Architecture back and forward) is meant to reuse this module rather than
  write a second one.
- `graph-ui/src/galaxy/scope-history.ts`: the Galaxy entry, its key and the
  tooltips that name a target ("Back to JSONBAgg · 2 layers").
- `GalaxyPanel.tsx`: derives the current entry from its state, pushes it when it
  changes, restores an entry on Back, Forward or a recent jump, and shows the
  Back and Forward buttons with disabled states and the Recent list in the
  scoped toolbar.

## Not in scope

- No breadcrumb of the whole chain. The tooltips name the Back and Forward
  targets, and the Recent list names the roots; a breadcrumb would cost the one
  toolbar row that K3 asks for.
- No persistence across reloads. A reload starts with an empty history, the same
  as a new browser tab.
