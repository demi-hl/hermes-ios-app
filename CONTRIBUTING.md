# Contributing

Hermes Battlestation is one Next.js codebase shipping two surfaces: a downloadable
**desktop app** (Electron, boots its own bundled standalone server) and a **mobile app**
(Capacitor, reachable over your tailnet). It is a launcher for a [Hermes](https://claude-code.nousresearch.com)
agent already running on your machine — nothing is sent to a third party.

## Architecture

- **One Next.js app**, two delivery targets from the same `app/` tree.
- **Desktop**: `electron/main.cjs` boots the bundled `.next/standalone` server as a child
  process, loads it in a BrowserWindow (gated on `ready-to-show` to avoid a white launch
  flash), and spawns a local `hermes` process.
- **Mobile**: `components/shell/AppShell.tsx` splits on `useMediaQuery("(min-width:1024px)")`
  — desktop -> `ide/IDEShell.tsx` (sidebar + panes), mobile -> swipe pager + `BottomTabBar`.
  PWA manifest at `public/manifest.webmanifest` + `public/sw.js`.

## Panes / API routes

Each pane in `components/panes/*Pane.tsx` is backed by an `app/api/<name>/route.ts`. Panes
poll via `components/usePolling.ts` (tolerates both a `{data,fetchedAt}` envelope and a bare
payload). Panes: Sessions, Cron, Skills, Config, API Keys, Analytics, MCP, OpenRouter,
Fleet, Kanban, Tasks/PRs, Obsidian, Editor, Terminal, Diff.

## Hard rules

- **Config-safe**: the apply-pipeline never edits a Hermes user's config.yaml model block
  directly — it writes its own pipeline file.
- **Secrets stay server-side**: only .env.example (blank template) is tracked. Real config
  lives in .env.local (gitignored) or is written by the in-app Setup screen. The browser
  never receives tokens. Run a secret scan before every commit.
- **No hardcoded identity**: never bake in a username, home path, tailnet hostname, team ID,
  or repo name. Derive at runtime (user from gh api user, home from \$HOME, repo roots from
  config). Everything is env- or Setup-driven and defaults to localhost.
- **Fleet is read-only**: remote node telemetry goes through a read-only SSH allowlist
  (sshReadOnly()) plus an HTTP agent-up probe. The fleet can never open a remote shell.

## Build

\`\`\`bash
npm install
npm run electron:rebuild   # rebuild native addons (node-pty) for Electron
npm run electron:dev       # build + launch the desktop app
npm run dist:linux         # package installers (or dist:mac / dist:win)
\`\`\`

- node scripts/prepare-standalone.cjs bundles the next-server runtime + node-pty + static +
  public into .next/standalone. Required before packaging.
- Verify packaging against the bundled standalone server, not the source dev server.

## Mobile build

Capacitor 8 uses Swift Package Manager (no CocoaPods). Point the native shell at your server
via CAP_SERVER_URL (defaults to http://localhost:9119), set your own Apple DEVELOPMENT_TEAM
and PRODUCT_BUNDLE_IDENTIFIER in ios/App/App.xcodeproj, then npx cap sync ios and build in Xcode.

## Style

TypeScript: nanostores for shared state, useStore in components, thin route roots,
table-driven mapping, interfaces for public props.
