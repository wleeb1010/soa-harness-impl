# @soa-harness/chat-ui

Direct-to-Runner chat UI for SOA-Harness v1.2. React + TypeScript. Zero dependencies beyond React and `@soa-harness/runner` type imports.

## What's in the box

- **`ChatView`** — full chat interface. Textarea input, message list, SSE-streamed assistant replies via §16.6 dispatcher. Auto-scrolls, shows terminal `stop_reason` when not `NaturalStop`.
- **`AuditTailViewer`** — polls `/audit/tail` on an interval, renders rows with `role="feed"`. Hash-chain `this_hash` preview visible for verification.
- **`PermissionPromptOverlay`** — modal overlay surfacing §10.3 / §14.1 `PermissionPrompt` events. Focus-trapped, Escape denies, Allow/Deny buttons carry tool-specific `aria-label`s.
- **`useDispatchStream`** — the SSE consumer primitive. Fires `POST /dispatch` with `Accept: text/event-stream`, parses each frame per §16.6.2, aggregates `ContentBlockDelta.text` into a `text` string, tracks terminal `stop_reason`. Returns `{ start, cancel }` so callers can manually drive lifecycle.

## Scope for v1.2

Direct-to-Runner only — no Gateway (that's M11), no OAuth (also M11). The UI authenticates via a session bearer that the embedding app is responsible for minting via `POST /sessions`. One session per mount.

## Accessibility

Targets WCAG 2.1 AA:

- Message list is `role="log"` + `aria-live="polite"`.
- Chat input has a visible `<label>` + keyboard shortcuts hint (`Enter` sends, `Shift+Enter` newlines).
- Permission prompt is `role="dialog"` + `aria-modal="true"` with focus trap.
- Audit tail polling announces new rows via a visually-hidden `role="status"` region.
- Buttons have explicit `aria-label`s when the visible text doesn't carry full context (Cancel button, Allow/Deny).
- Colors are not hardcoded; data-attributes (`data-role`, `data-testid`) let adopters theme without patching the package.

Adopters SHOULD run axe-core or equivalent against their shell app, since keyboard contrast and reduced-motion responsiveness depend on the wrapping CSS.

## Example

```tsx
import { ChatView, AuditTailViewer } from "@soa-harness/chat-ui";

export function App({ runnerUrl, sessionBearer, sessionId }) {
  return (
    <main>
      <ChatView
        runnerUrl={runnerUrl}
        sessionBearer={sessionBearer}
        sessionId={sessionId}
        model="example-adapter-model-id"
        billingTag="tenant-a/env-prod"
      />
      <AuditTailViewer runnerUrl={runnerUrl} sessionBearer={sessionBearer} />
    </main>
  );
}
```

## Out of scope for v1.2

- Multi-session chat (M9+)
- Tool-use mid-stream UI (requires richer `ContentBlockDelta` handling when `delta.partial_json` fires)
- Dispatch history / replay (requires admin-bearer to `/dispatch/recent` — not in the adopter-auth path)
- Localization beyond `lang="en"`

None of the above change the v1.2 wire contract; they're all additive UI work that can land in a v1.2.x patch or M9+.
