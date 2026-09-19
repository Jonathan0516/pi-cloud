# @earendil-works/pi-cloud-web (private, experimental)

A browser presentation for the cloud gateway. It is the `mini` TUI's client half with a DOM instead of a terminal: sessions are listed and created over the gateway's REST routes, and the attached session runs over the WebSocket, folded by the same `reduceLaneSnapshot` the TUI uses. The page holds no agent state of its own.

```text
browser ──REST (Bearer key)──▶ gateway /v1/sessions
        ──WebSocket (pi-cloud.v1 + bearer.<key>)──▶ gateway /v1/ws ──TCP──▶ node ──▶ worker
```

## Build and serve

```bash
node packages/cloud-web/build.mjs                 # → packages/cloud-web/dist (app.js, index.html, styles.css)
node packages/cloud-web/build.mjs --watch
PI_GATEWAY_WEB_DIR=packages/cloud-web/dist ... tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts
```

The gateway serves `dist/` at `/` when `PI_GATEWAY_WEB_DIR` is set, so the page and the API share an origin and no CORS is involved. Any static host works too; the login form takes the gateway URL.

esbuild bundles `src/app.ts` for the browser with the repository's `tsconfig.json` paths. The one Node import reachable from the mini presentation code (`node:crypto` in `mini/tui/session.ts`) is aliased to `src/shims/node-crypto.ts`; any other Node-only import is a build error. `test/build.test.ts` asserts the bundle carries no `node:` specifier.

## What the page does

- **Login**: gateway URL and API key. The key lives in the tab's `sessionStorage` and is sent only to that gateway, as a `Bearer` header for REST and as the `bearer.<key>` WebSocket subprotocol.
- **Sessions**: the tenant's sessions with running/idle state and owning node, newest first; "New" creates one (REST) and attaches to it.
- **Transcript**: user and assistant messages, thinking folded, tool calls with arguments and results folded under them (open/closed state survives re-renders), the streaming message at the tail with a cursor, running tools marked. `src/view-model.ts` is the pure projection and is unit tested.
- **Composer**: Enter sends (`prompt`, or `followUp` while a run is active), Shift+Enter is a newline; buttons for Steer, Follow-up, Abort.
- **Status bar**: model, thinking level, message and token counts, cost, queue length, operation state, last result.

Model selection and login flows (`models.*`) are not wired yet; the initial model comes from the node's `PI_DEFAULT_MODEL`.

## Type checking

`src/app.ts` needs the DOM library, which the repository's root program excludes, so this package has its own `tsconfig.json` (`npm run check` here, and the root `npm run check` runs it too). Everything else in `src/` is checked by the root program as usual.
