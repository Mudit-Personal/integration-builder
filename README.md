# AI-Generated Integration Builder

Point it at any SaaS API's docs. It drafts a read-only connector for users and usage, and proves it against simulated faults before handing over the code.

The AI writes a **declarative manifest**, not code. A trusted runtime executes the manifest. Auth, pagination, retries, logging and secret handling live in the runtime, so a bad generation cannot add behavior. TypeScript is generated from the manifest.

## Run it

Needs Node 24 and a signed-in `claude` CLI for live reads.

```bash
npm install
```

```bash
npm run demo:read
```

```bash
npm run demo:dev
```

Open http://localhost:4320.

## Layout

| Path | Owns |
|---|---|
| `src/manifest.ts` | The manifest schema, the core data shape |
| `src/runtime.ts` | The trusted executor and its safety limits |
| `src/verify.ts` | Deterministic checks against the source |
| `src/ingest.ts`, `src/spec.ts` | Reading and normalizing docs |
| `src/generate.ts`, `src/llm.ts` | Model call and repair loop |
| `src/mock-core.ts`, `src/mock.ts`, `src/mock-virtual.ts` | Fake vendor, and its HTTP and browser transports |
| `src/scenario-table.ts`, `src/scenarios.ts` | Fault scenarios, runnable on either transport |
| `src/connector-source.ts` | TypeScript bundle from a manifest |
| `web/`, `scripts/build-packs.ts` | Hosted site, see below |
| `src/pack-build.ts` | `AppPack` shape and assembly, shared by the corpus build and live reads |
| `src/read-service.ts`, `server/read.ts`, `scripts/read-dev.ts` | Live read endpoint, its Vercel entry and its local server |
| `scripts/read-batch.ts`, `corpus/top50.json`, `corpus/top50-report.json` | Resumable batch read of the top 50 apps, its list and its outcomes |
| `corpus/` | Real vendor specs, saved docs text and generated manifests |
| `docs/decisions.tsv` | Decision trail |

## Check it

```bash
npm test
```

```bash
npm run typecheck
```

```bash
node scripts/mutation-check.ts
```

The mutation check breaks safety code on purpose and confirms the tests notice.

## Batch read

```bash
node --no-warnings scripts/read-batch.ts
```

It reads every app in `corpus/top50.json` with the signed-in `claude` CLI and skips apps already in `corpus/top50-report.json`. A manifest is saved only when no finding blocks it and no sandbox scenario fails. `--only=a,b` limits the run, and `--retry=unreadable,timeout` rereads apps with those outcomes from their next URL.

These mocks are built from vendor docs. They do not prove the real API behaves the same.

## Hosted version

`web/` is a static site that walks the five steps (Source, Read docs, Decisions, Checks, Code). 11 apps come with saved reads and cost nothing. Any other docs link goes to one server function, `api/read.mjs`, which runs the same `ingest`, `generateManifest` and verification as the local tool and returns an `AppPack`. Checks and Code then run in the visitor's browser. The vendor in Checks is simulated from the manifest and the real API is not called.

The landing page lists the visitor's connectors. `web/src/connectors.ts` autosaves each one to `localStorage` and owns the draft and ready rules. Each live read is stored under its own key, so a full browser loses that read and not the list.

```bash
npm run demo:dev
```

```bash
npm run demo:read
```

`demo:read` serves `/api/read` on port 4321 for the dev and preview servers. It uses `ANTHROPIC_API_KEY` when set, otherwise the signed-in `claude` CLI. The access code is `DEMO_ACCESS_CODE`, or `local` if unset.

```bash
npm run demo:build
```

`demo:build` rebuilds `web/public/packs/` from `corpus/` with no model calls, bundles `server/read.ts` to `api/read.mjs`, and builds the site.

### Deploy to Vercel

1. Run `npm run demo:build` and commit `api/read.mjs`. Vercel looks for functions before the build runs, so the file must be in the repo. The build then replaces it.
2. Import the repo in Vercel. `vercel.json` sets the build command, the output directory and a 300 second function limit, the Hobby maximum.
3. Set both environment variables, then deploy.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Pays for live reads. Without it the function answers 503 |
| `DEMO_ACCESS_CODE` | Visitors enter this to start a live read. Without it the function answers 503 |

Node is pinned to 24.x, because the build runs TypeScript directly.

Each live read is one or two calls to `claude-opus-5-5` at $4 and $20 per million input and output tokens. Estimated cost: $0.30 to $0.50 for one attempt, about $1 when a repair runs. This is an estimate from one measured read of about 52,000 input tokens, not a measured Opus bill, and large specs cost more. Set a monthly spend limit in the Anthropic Console before you share the link, because the access code is the only gate.

## Limits

- Local live reads go through the `claude` CLI. The hosted read uses the Messages API.
- There are no accounts and no scheduler.
- JavaScript-rendered docs fall back to paste. Pasted text is limited to 2 MB on the hosted read.
- `shortcut:` comments in the code mark known limits and when to upgrade them.
