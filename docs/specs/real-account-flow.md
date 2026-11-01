# Spec: Try it, Go live and Monitor

Status: ready for an agent. This is the unbuilt half of the proposed App Flow. The simulated half (Run with Continue, Ready, Handed off, blocked with a fix, every path back to the list) has shipped.

## Problem Statement

An admin can now build a connector, test it on a simulated copy of the app, and hand it off. But nothing in Integration Builder ever touches their real account. When they reach Ready, their only real choice is to give the code or summary to someone else and hope it works.

The landing page promises "Try it" and "Go live", and neither exists. Ready shows Try it as "not available yet". So an admin who isn't a developer has no way to:

- see their own people come through before trusting the connector,
- have the connector run without a developer setting it up,
- find out when a running connector breaks, because a token expired, the app changed, or a sync started failing.

## Solution

Three new steps follow Ready, all read only on the admin's real account.

- **Try it.** The admin pastes a token for their real app. We run the connector once on our server, using the same trusted runtime the checks use, and show the people it found, masked as today. The token is used for that run only and is not kept.
- **Go live.** After a successful Try it, the admin approves the connector. We store the token encrypted, freeze the approved version of the connector, and run it on a schedule. It becomes **Live** on Your connectors.
- **Monitor.** A live connector has a page with its last sync, how many people it found, recent runs, and any alert. The list shows its health at a glance.

Two failure paths close the loop.

- **Token rejected.** If the app rejects the stored token, the connector stops running, the list shows that it needs a new token, and the admin pastes one. We check the new token with a Try it before resuming.
- **Something changed.** If a sync fails for another reason, or the admin changes a decision, the list shows an alert. The approved version keeps running until the admin approves a new one. Changing decisions never silently changes what is live.

## User Stories

1. As an admin, I want a Try it option on Ready, so that I can check the connector against my real account before trusting it.
2. As an admin, I want Try it to ask only for the credential the connector's sign-in method needs, so that I'm not asked for things I don't have.
3. As an admin who isn't a developer, I want plain instructions for where to find that token in the app, using the docs' own words where we have them, so that I can get it without help.
4. As an admin, I want to see that Try it is read only before I paste anything, so that I know it can't change my account.
5. As an admin, I want to see my real people after Try it, masked the same way as the preview, so that I can confirm it reads the right account.
6. As an admin, I want Try it to say how many people it found and whether it read the whole list, so that I know the result is complete.
7. As an admin, I want a clear plain-language message when my token is wrong, so that I know to paste a different one rather than think the connector is broken.
8. As an admin, I want a clear message when my token lacks a permission, naming the permission, so that I can fix it in the app.
9. As an admin, I want a clear message when my app plan doesn't include usage data, so that I know users still work without it.
10. As an admin, I want Try it to forget my token when it finishes unless I go live, so that a test doesn't leave a secret stored.
11. As an admin, I want to try again with a different token without starting over, so that a typo costs me one paste.
12. As an admin, I want Go live to be offered only after a successful Try it with the current decisions, so that nothing goes live untested on my real account.
13. As an admin, I want to see what will happen before I approve, including how often it runs and that it only reads, so that I know what I'm agreeing to.
14. As an admin, I want to choose daily or hourly runs, with daily as the default, so that it fits how fresh I need the data.
15. As an admin, I want the token stored securely and never shown again, so that nobody can read it back from the app.
16. As an admin, I want a live connector to show Live on Your connectors, so that I can tell it apart from ones that are only ready or handed off.
17. As an admin, I want the list to show when each live connector last synced and how many people it found, so that I can check health without opening each one.
18. As an admin, I want a monitor page for a live connector, so that I can see its recent runs and any problem in one place.
19. As an admin, I want the monitor to show the last few runs with when they ran, how long they took and what happened, so that I can spot a pattern.
20. As an admin, I want a Run now button on the monitor page, so that I can refresh right after fixing something.
21. As an admin, I want Run now to be limited to once every few minutes, so that I can't accidentally hammer my app's rate limits.
22. As an admin, I want to see the people from the latest sync, masked, so that I can confirm it is still reading the right account.
23. As an admin, I want to pause a live connector, so that I can stop it without losing its setup.
24. As an admin, I want to resume a paused connector, so that it picks up where it left off.
25. As an admin, I want removing a live connector to stop it and delete its token and its synced people, so that nothing is left behind.
26. As an admin, I want a connector whose token is rejected to stop running and say Needs a new token on the list, so that I notice without checking each one.
27. As an admin, I want to paste a new token from that alert, check it with Try it, and resume, so that fixing it takes one short path.
28. As an admin, I want a connector that keeps failing for other reasons to show an alert with the reason in plain words, so that I know whether to wait or act.
29. As an admin, I want a temporary outage at my app to be retried on the next run without an alert, so that I'm not alarmed by blips.
30. As an admin, I want an alert when several runs in a row fail, so that a real problem doesn't go unnoticed.
31. As an admin, I want changing a decision on a live connector to leave the approved version running, so that I can edit without breaking what works.
32. As an admin, I want the list to show that a live connector has unapproved changes, so that I remember to finish them.
33. As an admin, I want to approve a changed connector with a fresh Try it, so that the new version is checked on my real account before it replaces the old one.
34. As an admin, I want to read the docs again from a failing live connector, so that I can rebuild it when the app's API has changed.
35. As an admin, I want the live version to keep running while I read the docs again and test, until I approve the new one, so that I'm never left with nothing.
36. As a developer, I want Try it and the monitor to show requests made, pages read and the error kind, so that I can diagnose problems quickly.
37. As a developer, I want to know a live connector runs the same manifest and runtime as the code I was handed, so that what I see in the monitor matches what I ship.
38. As an admin, I want connectors whose sign-in needs a person to approve access, such as OAuth with a consent screen, to say a developer is needed for now, so that I'm not stuck at a step that can't work.
39. As an admin, I want the hand-off path to stay available on Ready after a connector goes live, so that my developer can still take the code.
40. As an admin, I want every page in this flow to have a way back to Your connectors, so that I never dead-end.
41. As an admin on a phone, I want Try it, the monitor and the alerts to work at phone width, so that I can check on things away from my desk.
42. As a workspace owner, I want only people in my workspace to see or change our live connectors, so that another company can't touch them.
43. As an admin, I want the people from a sync kept only until the next one replaces them, so that we don't build up copies of personal data.
44. As an admin, I want nothing sent to my real account during Build, Checks, Code or Run, as today, so that only Try it and Go live touch it, and only when I choose.

## Implementation Decisions

**We run the integrations.** The proposed flow says "Approve it and we run it on a schedule", so this is decided. Generation and hand-off stay exactly as they are, and running is added beside them.

**One runtime.** Try it, scheduled runs and Run now all use the existing trusted runtime with no simulator origin, so its real-host protections apply: the allow-listed hosts from the manifest, the public-address check, read-only requests, retries and limits. No new execution path.

**Server side only.** Real runs happen in the app API, never in the browser. A token never reaches the browser after it is pasted, and the vendor's CORS rules don't apply.

**New app API routes**, all behind the existing session and same-origin checks, and scoped to the caller's workspace:

- Try it: takes the connector, its pack, its decisions and the credential fields. Returns a run summary and a masked sample. Stores nothing.
- Go live: takes the same inputs plus the schedule. Re-runs the try. Only if it succeeds, stores the encrypted credential and the approved version, and returns the live summary.
- Live summary: read for one connector, plus the workspace load returns a live summary for every live connector.
- Run now, pause, resume, replace token: replacing a token runs a try first.
- Remove: deleting a connector also stops it and deletes its credential, runs and snapshot.
- A scheduled sync route for the platform's cron, guarded by a secret header, not by a session.

**Schema.** Three tables, added with the existing idempotent migrations:

- `live_connectors`: connector id (also the key), workspace id, the approved manifest and decisions as a frozen copy with its hash, schedule, state, next run time, a lease for the run in progress, and the count of consecutive failures.
- `credentials`: connector id, the ciphertext, nonce and key version. Never selected by a route that returns data to the browser.
- `runs`: id, connector id, started and finished times, outcome, people count, requests, pages, error kind, and a short message. Only the last 30 per connector are kept.

The latest successful sync's people are stored as one snapshot per live connector, replaced on each successful run and deleted with the connector.

**Live state as a state machine**, not scattered flags:

```text
live ──token rejected──▶ needs-token ──new token passes Try it──▶ live
live ──3 failed runs in a row──▶ failing ──a run succeeds──▶ live
live ──pause──▶ paused ──resume──▶ live
any ──remove──▶ (deleted)
```

- A run that fails with `auth` moves the connector to needs-token at once.
- `rate_limited`, `server`, `network` and `timeout` count toward failing.
- `forbidden`, `not_found`, `contract` and `safety` move it to failing at once, because retrying won't help.
- A `plan_gated` usage stream is a partial success, not a failure.

**Approved version vs draft.** The live record keeps its own frozen copy of the manifest and decisions. Editing the connector changes only the draft, as today. The list shows "Live, changes not approved" when the draft's hash differs from the approved hash. Approving runs a Try it on the draft, then replaces the frozen copy.

**List status.** The status the browser saves (draft, ready, handed off) stays as it is. The list adds the server's live state on top: live, needs a new token, failing, paused, or live with changes not approved. The server's state wins over the saved status for display.

**Scheduler.** A platform cron calls the sync route every 15 minutes. The route claims due connectors with a lease (claim where the next run time has passed and there's no live lease, in one update), runs each, records the run, and sets the next run time. Two overlapping calls never run the same connector twice. Hourly and daily are the only schedules. Run now sets the next run time to now and is limited to once every five minutes.

**Secrets.** Credentials are encrypted with AES-256-GCM using a key from the environment, with a key version stored for later rotation. They are never logged, never returned and never put in a URL. The runtime's existing redaction stays in place.

**Sign-in methods.** Bearer token, API key, basic auth and OAuth client credentials are supported. OAuth authorization code says a developer is needed, because it requires a consent redirect.

**Journeys.** The developer journey sees requests, pages, timing and error kinds. The not-a-developer journey sees the same facts in plain words, as Checks and Run do today.

**Injected dependencies.** The app API's dependencies grow from the database alone to the database plus the vendor fetch, the clock and the encryption key. Production passes the real ones, and tests pass the simulated vendor and a fixed clock.

## Testing Decisions

**One seam: the app API over HTTP**, exactly as the account and connector tests do today. Each test starts the app service on PGlite, calls routes with a session cookie, and asserts on responses and on what a later call returns.

The vendor is the existing simulated copy built from the manifest, injected as the app's vendor fetch. It already supports outages, expired and revoked tokens, rate limits and count collapse, so the failure paths need no new fixtures. A fixed, settable clock drives the scheduler.

A good test asserts what a user of the API can observe, never internals:

- A successful Try it returns people and a complete status, and stores nothing. A later live summary shows the connector isn't live.
- A pasted token never appears in any response body or header from any route, including after Go live, the live summary and the workspace load.
- Go live after a failed try is refused.
- After the clock passes the next run time, calling the sync route produces exactly one run, and two overlapping calls still produce one.
- A revoked token in the simulator moves the connector to needs-token. Replacing it with a good token runs a try and returns it to live.
- Three outages in a row move it to failing, and one success returns it to live.
- Changing decisions leaves the approved hash running, and the live summary reports changes not approved.
- Another workspace gets a not-found response for every route on a connector it doesn't own.
- Removing a connector deletes its credential, runs and snapshot. A raw query in the test confirms no rows remain.
- Run now inside the five-minute window is refused.

**Prior art:** the app service tests for session, workspace scoping and HTTP shape, the runtime tests for error kinds against the simulator, and the connector tests for list status. The list status mapping is tested through the existing connector-state tests, because that seam already exists.

## Out of Scope

- Sending synced people anywhere else, such as a webhook, a warehouse or a CSV export. The snapshot exists for Try it and the monitor only.
- Detecting docs changes by re-reading docs on a schedule. A re-read stays a manual action from a failing connector.
- OAuth authorization code with a consent redirect.
- Email or chat notifications. Alerts show in the app only.
- Encryption key rotation tooling. The key version is stored so it can be added later.
- Roles and permissions within a workspace. Workspaces have one owner today.
- Schedules other than hourly and daily, and per-connector rate limits beyond the runtime's own.
- Billing, quotas and per-plan limits on how many connectors can be live.

## Further Notes

- **The biggest open product question:** without a destination for synced people, running on our side gives the admin confidence and monitoring but no data they can use elsewhere. The next spec should pick the first destination.
- **Production prerequisites:**
  - `CREDENTIALS_KEY` and `CRON_SECRET` set in Vercel.
  - A cron entry in the Vercel config.
  - Neon in production, as today.
  - The scheduled route needs a function duration long enough for the slowest sync. The read route already allows 300 seconds.
- **Copy:** every new page follows the Calm design and the house components. Calendly and the other named apps are sample content only.
- **Legal:** storing a customer's vendor token and their people is a new data-handling commitment, and the privacy wording on the landing page should be checked before launch.
