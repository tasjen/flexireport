# CLAUDE.md

Repository guidance.

## Product

**FlexiReport** is a Tauri 2 desktop app that automates daily work-report submissions to the LivingInsider admin portal (`portal.example.com/team`). It pulls each day's completed work from Jira and pre-fills the portal task form through browser automation; the user only clicks submit.

- The portal has no public API. The Rust backend drives a real Chromium instance with [chromiumoxide](https://github.com/mattsse/chromiumoxide).
- Jira has a REST API and is queried directly from the frontend.

## Stack

- **Backend:** Rust + Tauri 2, `chromiumoxide` (CDP browser automation), `tokio`.
- **Frontend:** React 19, TypeScript 7, Vite 8.
- **State/data:** `@tanstack/react-query` (server state and persisted-store front), `@tauri-apps/plugin-store` (secrets + preferences in `store.json`), `mutative` (immutable nested updates of cached objects).
- **HTTP:** `@tauri-apps/plugin-http` (frontend Jira calls; required to bypass browser CORS).
- **UI:** Tailwind CSS v4, shadcn-style components on `@base-ui/react`, `lucide-react`, `@formkit/auto-animate`.
- **Tooling:** Oxc — oxlint (lint, type-aware via `oxlint-tsgolint`) and oxfmt (format), lefthook (pre-commit), pnpm.

## Commands

```bash
pnpm start      # tauri dev — run the full desktop app (use this to test)
pnpm dev        # vite only (frontend, no Tauri backend — rarely useful here)
pnpm build      # tsc + vite build (typecheck + bundle frontend)
pnpm package    # tauri build — produce distributable bundles
cargo check --manifest-path src-tauri/Cargo.toml   # typecheck Rust backend only
pnpm lint:fix   # oxlint --type-aware --fix (also runs on pre-commit)
pnpm fmt        # oxfmt: format in place (also runs on pre-commit; fmt:check to verify)
pnpm test       # vitest run — frontend unit + component tests
pnpm test:watch # vitest watch mode
cargo test --manifest-path src-tauri/Cargo.toml    # Rust unit tests
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored   # portal DOM + leftover-browser tests (needs Chromium)
cargo test --manifest-path src-tauri/Cargo.toml --features live-portal-smoke live_portal -- --test-threads=1  # live portal (needs credentials)
pnpm e2e        # WebdriverIO smoke suite — fails on macOS (see Testing)
```

Unit tests cover extracted pure logic; UI behavior is still verified with `pnpm start` and exercising the app.

## Testing

- **Frontend:** Vitest 4 + jsdom + React Testing Library. [vitest.config.ts](vitest.config.ts) `mergeConfig`s [vite.config.ts](vite.config.ts), so the `@` alias, lingui macro transform, and react-compiler preset apply in tests. Tests are colocated `*.test.ts(x)` under `src/`; `globals` is off — import `describe`/`it`/`expect` from `"vitest"` explicitly (keeps `tsc -b` and type-aware oxlint working without tsconfig `types` churn).
- **Tauri mocking:** [src/test/tauri.ts](src/test/tauri.ts) `mockTauri(data, onInvoke?)` answers plugin-store IPC from in-memory data and delegates other commands; [src/test/setup.ts](src/test/setup.ts) runs RTL `cleanup()` + `clearMocks()` after each test. Importing `store.ts` in tests is safe: `LazyStore` does no IPC until first use.
- **Query elements by `data-testid`, not by role, label, or text.** Add a stable `data-testid` to the component and select with `getByTestId`/`findByTestId`. Visible copy goes through lingui and changes with translation, and roles come from `@base-ui/react` internals — both make text/role queries break on changes that are not regressions. Suffix generated ids with the underlying value (`project-map-option-${item.value}`) so a test names the exact option it clicks. Assert on fixture data the test itself supplied rather than on translated copy.
- **Don't render components whose value comes from an uncached `use(promise)`** (e.g. `Version`): the promise recreates every render and never settles under RTL.
- **Rust:** `#[cfg(test)]` unit tests colocated in the module under test — `submission.rs` (planning + workflow), `browser_session.rs` (reuse, recovery, teardown), `login.rs` (login sequence + verification lifecycle), `navigation.rs` (URL matching + polling), `account.rs` (stored and candidate portal config), `task_parameters.rs` (scrape order + what is cached), `lifecycle.rs` (teardown completeness), `error.rs` (the command error contract), `project_options.rs` (cache scope), and `leftover_browsers.rs` (which processes get force-killed). Reusable fakes live in each module's `#[cfg(test)] pub(crate) mod test_support`, so `lifecycle.rs` drives teardown through the same `FakeHost`/`FakeVerifyHost` their own tests use. `lib.rs` is the Chromium wiring layer and holds almost no tests — only what has to be asked of the real system: that the profile dirs stay distinct, and that the process table reports argument vectors. Chromium itself stays untested: policy lives behind seams (`SubmissionPortal`, `BrowserHost`, `LoginPortal`, `VerifyHost`, `TaskFormSource`, `ProcessTable`, the `current_url` closure, the `scrape` closure) that tests drive with fakes, while `lib.rs` holds the one real implementation of each. Async tests use `#[tokio::test]`, with `start_paused = true` where timing is asserted. Fakes record an ordered event log and assert on that, not on call counts — it catches ordering bugs (killing a stale browser *before* relaunching) that counters miss.
- **Portal DOM contract:** [src-tauri/src/portal_dom.rs](src-tauri/src/portal_dom.rs) drives a **real Chromium** against a local `tiny_http` fixture server serving the pages in [src-tauri/src/fixtures/](src-tauri/src/fixtures/). It is the only thing that catches a selector that stopped matching, and it asserts on the **submitted form body** the server received, never on generated JS.
  - `#[cfg(test)] mod portal_dom` — no production code, and `tiny_http` is a dev-dependency.
  - Every test is `#[ignore]`d, so the required `cargo test` never needs a Chromium binary. Run with `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored`; `--test-threads=1` if profile dirs collide.
  - The fixture pages are **sanitized captures of the real portal**, deliberately not generated from the selector constants under test — a fixture built from the same constants passes no matter how wrong they get. Update them by re-capturing, and sanitize member names, phone numbers, session/CSRF tokens, the real hostname, internal URLs, and real project names before committing.
  - Two marked deviations: `task_date` options are reconstructed (the portal renders selectable days server-side, so a capture holds only the placeholder), and `option_edge_cases.html` is wholly synthetic because every real `<option>` carries a `value`.
  - Pinned option policy: an `<option>` with **no `value` attribute is dropped**; an empty-valued placeholder (`value=""`) is **kept**.
  - The real task form puts a `task_work_hour_N` select beside every project select, and the project filter walks *every* `<select>` guarded only by an id check — a test asserts those neighbours come through untouched. Another asserts the submitted body carries the apportioned hours, and two more remove an `<option>` at runtime — one hours, one project — to prove a value the portal no longer offers fails loudly instead of submitting blank.
  - Pinned portal fact: the HTML spec makes a submitting browser normalize textarea line breaks to **CRLF**, so every report reaches the portal with `\r\n`, not the `\n` the summary was built with.
- **Live portal smoke:** [src-tauri/src/live_portal.rs](src-tauri/src/live_portal.rs) logs into the **real** portal and checks that login, the task form, its selectors, and the three selects all still work. It is the only thing that catches portal markup the sanitized fixtures haven't caught up with.
  - Behind the `live-portal-smoke` cargo feature, so it does not compile in the required CI job. Credentials come from `SMOKE_PORTAL_URL` / `_PORTAL_CREDENTIAL` / `_PHONE` — never `store.json`, never committed. Missing env fails loudly rather than passing vacuously.
  - **It never submits a report, and must never be made to.** It navigates and reads only; it never fills the form or calls `submit_task_form`. Filing a bogus report into a colleague-visible system is worse than having no smoke test.
  - Use a dedicated test account. Run it with `cargo test --manifest-path src-tauri/Cargo.toml --features live-portal-smoke live_portal -- --test-threads=1`, or manually via the non-required [live-portal-smoke.yml](.github/workflows/live-portal-smoke.yml) workflow, which needs the `SMOKE_PORTAL_URL`, `SMOKE_PORTAL_CREDENTIAL` and `SMOKE_PHONE` repo secrets and reports a notice instead of failing when they are absent.
  - Expect flakiness: network, portal uptime and credential validity all affect it. Keep it manual and non-required.
- **E2E:** WebdriverIO + tauri-driver smoke suite in [e2e/](e2e/), Linux/Windows only (no macOS tauri-driver), run by the separate non-required [e2e.yml](.github/workflows/e2e.yml) workflow on `main` pushes and manual dispatch. `e2e/tsconfig.json` is deliberately not referenced from the root tsconfig so pre-push `tsc -b` ignores it.

## Architecture

### Browser instances

The backend manages **two separate browser instances**, distinguished by newtype wrappers registered as Tauri managed state:

| State | Setting | Purpose |
|---|---|---|
| **`HeadlessBrowserState`** | `with_head: false` | Hidden; `get_task_parameters` scrapes form `<select>` options (dates, leaves, projects). |
| **`HeadedBrowserState`** | `with_head: true` | Visible; `submit_task` pre-fills the form for the user to submit. |

Both wrap `BrowserState`, an alias for `BrowserSession<ChromiumHost>`. The split keeps reuse/teardown policy testable without a real browser:

- **`BrowserSession<H>`** ([src-tauri/src/browser_session.rs](src-tauri/src/browser_session.rs)) holds an operation mutex plus `Mutex<Option<(H::Browser, H::Page)>>` and owns *all* the policy: fail-fast command exclusivity, lazy launch, liveness probing, stale replacement, and the bounded graceful close. An ordinary command holds one `BrowserOperation` for its full Chromium workflow; a second command for the same headed/headless instance immediately returns `BrowserBusy`, while commands for the other instance remain independent.
- **`BrowserHost`** is the system boundary — `launch` (launch + login), `is_page_alive`, `close`, `kill`, `label`. `ChromiumHost` in [src-tauri/src/lib.rs](src-tauri/src/lib.rs) is the only real implementation; it owns the `AppHandle` and `with_head`, so commands needing the handle go through `state.host().app`.

Put new policy in the session and new Chromium calls in the host. Policy added to `ChromiumHost` becomes untestable.

Each instance:

- Lazily launches through `BrowserOperation::page()` and reuses the browser.
- Uses a fixed Chromium user-data dir under the app cache: `app_cache_dir()/profiles/{headed,headless}`. Separate subdirs prevent profile-lock contention.
- Wipes its dir before each launch. Using the app cache instead of shared system temp avoids macOS “access data from other apps” prompts; wiping removes stale `SingletonLock` files after unclean shutdowns, preventing leftover Chromium from making a new launch hand off and exit. Wiping only clears the *lock* — the leftover process itself is killed by the startup reap (see Lifecycle and cleanup).

**Every path that gives up a session removes it from the state before shutting it down.** A failed launch, a dead page, and a hung close all leave the state empty rather than holding a pair the next caller might reuse. The inner lock is held across the launch, so replacement cannot race teardown.

**Project options are cached per login, not per process.** `ProjectOptionsCache` ([src-tauri/src/project_options.rs](src-tauri/src/project_options.rs)) scrapes the project `<select>` once and shares it; `close_browsers` clears it. That covers both moments the login identity can change — before a replacement account is saved and during the ≥1h-away reset — so a different member or portal never inherits the previous one's project list. The lock is held across the scrape, so concurrent first readers share one scrape; a failed scrape caches nothing and is retryable. Any new teardown path must clear it too.

Before reuse, `BrowserOperation::page()` calls the host's `is_page_alive()`, which requires both a healthy Basic-auth request pump and a real JS-context round-trip: `page.evaluate("1")` with a 2s timeout.

- **Do not use `page.url()` as the probe.** chromiumoxide serves it from cached frame state without contacting Chromium, so it remains `Ok` after session death (for example, OS suspension during a long idle). This false positive strands the next real command on a ~30s CDP timeout.
- **Do not rely on `Browser::try_wait()`.** On macOS, the process can linger after its last window closes.
- Probe the live session, not cached state or the process. On failure, force-kill the stale instance with `browser.kill()`, then launch and log in again.

### Login flow: `BrowserOperation::page`

On an instance's first `BrowserOperation::page()`:

1. Read `phone`, `portal_url`, and `portal_credential` from the `account` key in `store.json` through `PortalAccountConfig::from_store_value` ([src-tauri/src/account.rs](src-tauri/src/account.rs)). All three are validated together, so if any is missing the launch fails before spending Chromium startup. Holding a `PortalAccountConfig` is proof login can be attempted — keep reading config through it rather than pulling fields out of the store ad hoc.
2. Launch Chromium, headed or headless.
3. Run `PortalLogin::execute` ([src-tauri/src/login.rs](src-tauri/src/login.rs)), which drives the `LoginPortal` boundary in a fixed order: enable stealth mode and start exact-origin request interception that adds the Basic-auth `Authorization` header from `portal_credential` only to the configured portal origin (the admin site's HTTP basic gate) → navigate to `portal_url` → fill and submit the login input with the phone → poll `wait_for_url` until the current URL reaches `<portal_url>/member.php`, confirming login (`LOGIN_TIMEOUT`, 5s).

The sequence is policy and lives in `PortalLogin`; `ChromiumLoginPortal` in `lib.rs` is the only real `LoginPortal`. Both the persistent sessions (stored values) and `verify_portal_login` (candidate values) go through it, so login cannot drift between them. Only a *timeout* gets the "Wrong phone number, portal URL, or portal credential" explanation appended — CDP and navigation failures propagate unchanged.

`login_script` builds the fill-and-submit JS. Both the selector and the phone go through `serde_json::to_string`; see the escaping rule under Conventions.

`wait_for_url` matches the expected URL exactly, or extended at a `?`, `#`, or `/` boundary — so a redirect that appends query parameters, a fragment, or a trailing slash counts as arrival, while a differently-named sibling route (`/member.php-old`) does not. It succeeds immediately when the page already has the target URL. The rule lives in `UrlExpectation::matches` ([src-tauri/src/navigation.rs](src-tauri/src/navigation.rs)) and is shared by login and post-submit confirmation.

### Lifecycle and cleanup

**Terminate all browser instances on app close.**

Both teardown paths live in [src-tauri/src/lifecycle.rs](src-tauri/src/lifecycle.rs), generic over the session hosts so their ordering and completeness are testable with fakes:

- `close_persistent_sessions(headless, headed, projects)` backs the `close_browsers` command. It reserves both sessions before changing either; if one is busy, it immediately errors and leaves both sessions and the project cache untouched. Once reserved, it closes both sessions **and** clears the project cache, since a surviving cache would show the previous member's project list.
- `shutdown(headless, headed, verify)` backs `RunEvent::Exit`. It deliberately leaves the project cache alone (the process is ending) and *kills* the verification browser rather than closing it. **Add any new browser instance or long-lived resource here.**

- `run()` handles `RunEvent::Exit` by calling `lifecycle::shutdown`, which closes both managed states and then kills an in-flight `verify_portal_login` browser.
- `BrowserOperation::close()` attempts graceful shutdown through the host: stop request interception → close page → close browser → `wait()`. The session bounds it with `GRACEFUL_CLOSE_TIMEOUT` (3s), then falls back to `kill()`. If the user already closed the window, the connection is gone; graceful close cannot finish and `wait()` would otherwise block forever. Repeated closes and closing an empty session are both no-ops.
- Do **not** delete user-data dirs on close. The fixed app-cache paths are bounded to three and wiped on next launch, also reclaiming force-quit leftovers.
- The `close_browsers` command closes **both** instances. The frontend calls it:
  - before persisting an account change, forcing login with the new phone; otherwise a reused headed session could submit as the previous member. A busy error aborts the save, so new stored credentials can never coexist with the old authenticated sessions;
  - when focus returns after ≥1h unfocused via `useResetWhenAway` (see Frontend).
- When adding browser instances or long-lived resources, also tear them down in the `Exit` handler.

#### Reaping what a killed process leaked

Every path above needs the process to be alive to run. `SIGKILL` skips all of them — including chromiumoxide's `kill_on_drop` — and that is the *normal* case in development: `tauri dev` rebuilds on each Rust change by `SIGKILL`ing its dev child, and because `cargo run` `exec`s the binary in place, the process it kills **is** the app. The Chromium it owned is reparented to init and survives, so every hot reload used to leave another browser tree behind; a force-quit does the same to a release build.

Only the *successor* process can clean that up. [src-tauri/src/leftover_browsers.rs](src-tauri/src/leftover_browsers.rs) `reap` kills every process still holding one of this app's profile dirs, and `setup()` calls it once at startup.

- It matches the **whole argv entry** `--user-data-dir=<dir>`, never the path anywhere in the command line. Chromium puts that entry on the browser process *and* every helper, so the strict rule still finds the full tree — while a substring search would also match `--disk-cache-dir=<dir>/cache` and a sibling profile like `<dir>-old`. Nothing is lost by being strict: `chrome_crashpad_handler` is the one process that looks like an exception and isn't, because it names the browser *installation's* shared crash database rather than our profile, is already `ppid` 1 by design, and exits on its own once its browser dies. Matching it would mean reaching into the user's Chrome.
- The paths are the identity. They sit under the app cache dir, which Tauri keys by bundle identifier, so a dev build (`…flexireport.dev/profiles/headed`) and a release build (`…flexireport/profiles/headed`) can never reap each other.
- **Browser processes are killed before helpers**, across all three profiles — a helper outliving its browser is an orphan with no marker left to find it by, while a browser outliving a helper just draws a crash tab in a window nobody is looking at. `reap` returns the pids it *actually* killed, since a leftover can exit on its own between the snapshot and the kill.
- **Its position in `setup()` is load-bearing.** It must stay ahead of the first browser launch, since a browser *this* run started would match too. And it relies on running after plugin setup: Tauri initializes plugins in `build()` and calls the `setup` closure later, so `tauri-plugin-single-instance` has already exited a duplicate process and the reap cannot take out a live sibling instance's browsers.
- `ProcessTable` is the system boundary; `SystemProcesses` in `lib.rs` is the only real implementation (`sysinfo`, `system` feature only). It reads the table in-process rather than shelling out to `ps`/`wmic`, which would flash a console window on Windows. Policy stays in `leftover_browsers`.
- Fakes can only prove the matching rule. Two tests cover the boundary itself: one asserts the real process table reports argument vectors at all (without them the reap silently matches nothing), and an `#[ignore]`d `real_chromium` test launches a real browser and asserts `reap` finds and kills it — that is what catches chromiumoxide switching to a `--user-data-dir <path>` pair or canonicalizing the path, either of which would leave the exact-entry match finding nothing while every fake-backed test stayed green.

### Startup visibility: anti-flash handshake

The main window starts hidden via `"visible": false` in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json). `ShowWindowOnMount` in [src/main.tsx](src/main.tsx) reveals it with `show()` + `setFocus()` on mount; this requires `core:window:allow-show` in capabilities.

- Keep `ShowWindowOnMount` the **outermost** component. Parent effects run after child effects, letting the theme class apply before visibility.
- Register `tauri-plugin-window-state` with `StateFlags::all() & !StateFlags::VISIBLE`. Default flags restore the prior session's visibility during window creation, intermittently showing the window before the frontend is ready, depending on saved state.
- In the single-instance callback, call `show()` before `set_focus()`. If the frontend fails to load and leaves the window hidden, relaunching the app must reveal it instead of focusing an invisible window.

Breaking either backend safeguard restores the flash or makes the app look dead.

### Tauri commands: frontend ↔ backend

Define these in [src-tauri/src/lib.rs](src-tauri/src/lib.rs) and register them in `invoke_handler`. [command_registry.rs](src-tauri/src/command_registry.rs) parses the real `generate_handler!` list and the frontend's `invoke("…")` call sites and fails if either side names something the other doesn't — renaming one half is otherwise a runtime-only "command not found".

- **`get_task_parameters() -> TaskParameters`:** Headless scrape of form `<select>` options. Returns `{ dates, leaves, projects }`, each `Vec<SelectOption {label, value}>`.
  - Order lives in `TaskParametersScrape::run` ([src-tauri/src/task_parameters.rs](src-tauri/src/task_parameters.rs)): open `task.php` → dates → leaves → projects → back to `member.php`. `ChromiumTaskFormSource` in `lib.rs` is the only real `TaskFormSource` and owns the selectors.
  - **Dates and leaves are re-read every call; only projects are cached.** The portal's selectable days move as its reporting window advances, so caching them would hand the user a stale date list.
  - Returning to `member.php` is deliberate — the next command, and the headed window if the user looks at it, should start from the portal's home rather than a half-filled form. A scrape failure skips that return and leaves the browser on the form.
- **`submit_task(date, entries)`:** Headed; navigates the form and sets the date select.
  - `entries` contains up to 3 `{ project, summary, hours }` rows built by `DateCard` from `project_map` (Jira issues) and each favorite's own `project`, largest bucket first.
  - Row *n* sets `task_project_id{n}`, fills `task_comment{n}`, and sets `task_work_hour_{n}`.
  - A `null` row-1 project falls back to `default_project`, read from the `preferences` key in `store.json`.
  - Every row's project options are filtered to `project_list` + `default_project` + entry projects.
  - **More than 3 entries is an error, not a truncation.** The form has 3 row pairs and `buildSubmission` already merges overflow into row 3, so a longer list means a caller bug; `SubmissionPlan::build` rejects it rather than silently shipping a report missing part of the day's work.
  - **Every row's hours are written explicitly, and they must total 8.** The portal pre-selects `8` on row 1 and leaves rows 2-3 blank, so a row left alone either double-counts the day or submits nothing. `SubmissionPlan::build` rejects hours off the 0.5 grid, outside `1..=8`, or not summing to a full day — a caller bug, like too many rows.
  - **Every `<select>` is written through `set_select_value`, which reads the value back.** Assigning a value no `<option>` carries leaves a `<select>` blank rather than throwing, so date, project and hours all verify the assignment and fail loudly instead. All three are reachable: the portal can narrow its hour list, dates move as the reporting window advances, and `project_options` is cached **per login**, so a project the portal has since dropped can still be picked from a stale list. Route any new `<select>` through it rather than assigning directly.
  - **Clicks submit only when `auto_submit` is on**; otherwise the user does. See the submission workflow below.
- **`close_browsers()`:** Atomically reserves and tears down both instances, then clears the cached project options. If either instance is busy, it immediately errors without changing either session or the cache. Called before replacing an existing account and by the ≥1h-away reset in `use-reset-when-away.ts`.
- **`verify_portal_login(portal_url, portal_credential, phone)`:** Logs into the portal with a throwaway headless browser and its own `profiles/verify` dir. Uses the passed *candidate* values and **never** reads `store.json`; they go through `PortalAccountConfig::from_candidates`, which shares validation and trailing-slash normalization with the stored path so a value cannot verify one way and behave another once saved. The Account form calls it before saving. `VerifySession` ([src-tauri/src/login.rs](src-tauri/src/login.rs)) kills the browser after the check, pass or fail.
  - It holds **two** locks. `running` serializes checks, which share one profile dir. `parked` holds the in-flight browser for the `Exit` handler. They must stay separate: with one lock, exit would block waiting for the very check it is trying to abort. Login runs on the `Page`, which is independent of the parked `Browser`.

Keep portal selectors synchronized with portal markup:

- `select#task_date`
- `select#task_leave`
- Three project/comment/hours triples: `select#task_project_id1..3` / `textarea#task_comment1..3` / `select#task_work_hour_1..3` (`lib.rs` prefix constants + row number)

### Submission workflow

`submit_task` splits into three seams so the rules are testable without Chromium ([src-tauri/src/submission.rs](src-tauri/src/submission.rs)):

- `SubmissionPlan::build(entries, preferences)` — the deterministic row/project rules above, plus hour validation. Fallible: >3 rows, off-grid hours, rows under 1h or over 8h, and rows not totalling 8 are all rejected. It turns wire `TaskEntry`s into validated `PlannedRow`s; holding a `PlannedRow` is proof its `WorkHours` lands on an option the portal offers, and `WorkHours::as_option_value` is what renders it (`"8"`, never `"8.0"`).
- `SubmissionAutomation::from_preferences` — reads `auto_submit`/`auto_close`, both defaulting to `false` when the key or field is absent.
- `SubmissionWorkflow::execute(plan, automation, date, portal)` — prepare, then conditionally submit and close, against the `SubmissionPortal` trait. `ChromiumSubmissionPortal` in `lib.rs` is the only real implementation.

Order is load-bearing: prepare always runs; `auto_close` can never close anything unless `auto_submit` also submitted; and closing waits for positive confirmation first.

**Post-submit confirmation is `<portal_url>/task_report.php`**, not `/member.php`. The portal redirects there once a task is saved, so it is the signal `auto_close` waits on (10s bound). `/member.php` is the *login* confirmation only — do not conflate the two. If confirmation times out the browser stays open and the command errors, so the user never loses an unconfirmed submission.

### Frontend

- [src/App.tsx](src/App.tsx): Sidebar containing `OpenMemberPageButton`, `RefreshDateListButton`, `FavoritesForm`, `PreferencesForm`, and `AccountForm`; renders `DateList` after an account exists; mounts `useResetWhenAway`.
- [src/lib/use-reset-when-away.ts](src/lib/use-reset-when-away.ts): `useResetWhenAway` calls `close_browsers` when focus returns after ≥1h unfocused, waits for teardown, then reloads the webview. Preserve this order: reload alone does not reset backend `BrowserState`s; after teardown, the next command launches and logs in fresh. A busy browser leaves both sessions and the project cache untouched, so teardown retries briefly and then bails with an error toast; it must never turn expected contention into a whole-process relaunch.
- [src/lib/use-update-check.ts](src/lib/use-update-check.ts): `useUpdateCheck` runs at launch in production only. If the updater finds a newer release, it shows a persistent toast whose action downloads, installs, and relaunches.
- [src/lib/store.ts](src/lib/store.ts): `LazyStore`, `Account`/`Preferences`/`TaskGroupType`, and `DEFAULT_PREFERENCES`. There is no client state library; react-query reads account and preferences through `useAccount`/`usePreferences` in `queries.ts`.
- [src/lib/task-groups.ts](src/lib/task-groups.ts): `TASK_GROUPS`, the four groups—three Jira-backed, then local favorites—shared by `DateCard` and the preferences form. Each carries a `description`: the plain-English gloss of how the group is derived, shown in its `TaskSelect` tooltip and threaded through `IssueGroup`.
- [src/components/account-form.tsx](src/components/account-form.tsx): Secrets dialog for portal URL, portal credential, phone, Jira email, and Jira API token; inputs strip all spaces.
  - On save, `useVerifyAccountMutation` verifies candidate portal values via `verify_portal_login` and Jira via `/rest/api/3/myself`, in parallel.
  - On failure, an error box lists each failed check; “Save anyway” skips verification for offline/portal-down cases.
  - Only then call `close_browsers` for an existing account, write `store.json`, update the account cache, and invalidate `task_parameters`. A busy teardown aborts before persistence and leaves the old account active.
  - Open automatically until portal fields are configured, covering fresh installs and stores predating those fields.
- [src/components/preferences-form.tsx](src/components/preferences-form.tsx): Dialog containing `DefaultProjectSelect`, `ProjectListSelect`, `ProjectMapForm`, `DefaultTaskGroupsSelect`, and `ThemeToggle`.
- [src/components/project-map-form.tsx](src/components/project-map-form.tsx): Add/delete editor for `project_map` (project key → portal project); normalizes keys to uppercase, rejects duplicates, and caps the map at 3 distinct portal projects because the form has 3 row pairs. “Project key” means a Jira issue-key prefix; favorites do not route through the map — they carry their own portal project.
- [src/components/favorites-form.tsx](src/components/favorites-form.tsx): Star-icon sidebar dialog for `favorites`; supports add and delete only and saves immediately through `useSaveFavoritesMutation`. Add rejects duplicate/blank text. A project select beside the text input names the favorite's portal project directly, defaulting to the first scraped project the way `DefaultProjectSelect` does; it is hidden when `get_task_parameters` has no projects yet, so a favorite is still addable without one (`project: null`).
- [src/components/date-list.tsx](src/components/date-list.tsx): Runs `useTaskParameters`; renders one `DateCard` per non-empty date, 5 at a time, with “Load more.”
- [src/components/date-card/](src/components/date-card/): The per-date card and the three components only it uses, behind an `index.tsx` so consumers keep importing `@/components/date-card`.
- [src/components/date-card/index.tsx](src/components/date-card/index.tsx): Per-date card. Composition only — it reads preferences, calls `useDateCardTasks` + `useTaskSelection`, runs `buildSubmission`, and hands the result to three presentational children. Put new data rules in the hooks or `date-card-helpers.ts`, new markup in the children; rules added back into the card become untestable except through a full render.
  - The submit (`Play`) button calls `useSubmitTaskMutation` with `submitEntries` from `buildSubmission`. Submit is disabled mid-fetch only when `autofill_summary` is on, since that is the only case where a summary can be shipped half-built.
- [src/lib/use-date-card-tasks.ts](src/lib/use-date-card-tasks.ts): `useDateCardTasks(date, defaultGroupIds)` — the card's whole data side. Runs the three Jira queries (`refetchOnMount: "always"`, since `staleTime` is `Infinity` and cards unmount as the list pages) plus `useFavorites`, and returns `{ jqlByGroup, issueGroups, allIssues, createdKeys, favorites, error, isFetching, refetchAll }`.
  - Groups in `default_task_groups` render first and start checked. Dedup by issue key follows display order: duplicates land in the first visible group, and defaults follow the *displayed* group.
  - Favorites become `favorite:`-prefixed issue-shaped objects (`favoritesAsIssues`), reusing dedup, default-checked, and override logic unchanged.
- [src/lib/use-task-selection.ts](src/lib/use-task-selection.ts): `useTaskSelection(issueGroups, defaultGroupIds)` — stores user toggles as per-issue `overrides` over the group defaults rather than as a flat selected-set, recording only actually changed issues. That is what lets issues from a later refetch, or after a `default_task_groups` change, still pick up the right default. `reset()` backs the refresh button. Semantics pinned by `use-task-selection.test.ts`.
- [src/components/date-card/task-select-grid.tsx](src/components/date-card/task-select-grid.tsx): Renders one `TaskSelect` per group and owns the group→option mapping (`toOptionItems`: favorites plain and insertion-ordered, Jira issues `"KEY: summary"` sorted by key). Each `TaskSelect` shows an info tooltip: the group's `description` plus, for the Jira-backed three, the literal JQL that produced it — read from the same `jqlByGroup` the queries ran, so displayed and executed JQL cannot drift; favorites have no entry (`jqlFor` returns `undefined`) and so show no JQL.
- [src/components/date-card/summary.tsx](src/components/date-card/summary.tsx): The preview pane — spinner, then Jira error, then "no tasks found"/"no tasks selected", then the summary with its copy button. Selected favorites lead `summaryText` as plain bullets, before status-grouped Jira issues.
- [src/components/date-card/header.tsx](src/components/date-card/header.tsx): Title, date relation (derived here via `getDateRelation`), refresh and submit buttons. Refresh refetches *and* resets the selection, so refetched issues come back on their group defaults.
- [src/lib/date-card-helpers.ts](src/lib/date-card-helpers.ts): Pure, unit-tested date-card logic — `buildSubmission` (summary text + submit-row bucketing, spec pinned by `date-card-helpers.test.ts`), `buildSummary`, `buildIssueGroups`, `defaultCheckedKeysOf`, `buildJqlForDate`/`jqlFor`, `favoritesAsIssues`, `toOptionItems`, `apportionWorkHours`, `getDateRelation`, `getDateAfter`, `WORK_HOURS_PER_DAY`, and `FAVORITE_KEY_PREFIX`.
  - `buildSubmission` splits the selection into at most 3 rows by portal project:
    - Jira issues resolve through `project_map`, keyed by the part of `issue.key` before `-`. Favorites skip the map: each carries its own portal project.
    - Bucket mapped tasks by portal project; favorites count toward bucket size. Order largest first, with each row's favorites leading its comment as plain bullets.
    - If `default_project` exists, put unmapped tasks in that bucket, joining its mapped bucket if present. Otherwise put them in row 1's summary and merge issues into its status grouping.
    - Merge overflow past 3 buckets into row 3. Overflow can come from a distinct default-project bucket joining 3 mapped buckets or a hand-edited store.
    - With no bucket, send one `{ project: null }` entry for backend defaulting. The card does the same when `autofill_summary` is off, because there is no text to split.
    - Give each row its share of the day through `apportionWorkHours`, weighting rows by task count — including, for row 1, the unmapped tasks folded into its comment, or the row doing the most work is credited with the least of it.
  - `apportionWorkHours` is **largest-remainder apportionment over integer half-hours**, not per-row rounding. Floor each exact share, then hand the leftover half-hours to the rows rounding shortchanged most; that is what makes the parts total exactly 8, which the portal requires and `SubmissionPlan::build` enforces. Two rules it must keep: **no row drops below 1h** — a project worth reporting is worth an hour, and the shortfall comes off the largest row so the day still totals 8 — and arithmetic stays in integer half-hours, since the result has to match a `<select>` option string exactly. The floor is `MIN_HALF_HOURS_PER_ROW`, duplicated in `submission.rs` so the backend rejects what the frontend would never build. Task count is the only weight available — the Jira query fetches no `timetracking`/`worklog` fields.
- [src/lib/queries.ts](src/lib/queries.ts): React-query options/hooks. `taskParametersOptions` wraps `get_task_parameters`; `jiraTasksQueryOptions` calls Jira REST directly; `preferencesOptions` merges stored values over `DEFAULT_PREFERENCES` field-by-field; `favoritesOptions`/`useFavorites` read `favorites` (`?? []` supports stores predating the key) and normalize both legacy shapes — plain strings and objects tagged with the superseded `project_key` — to a project-less favorite.
- [src/lib/mutations.ts](src/lib/mutations.ts): `useSubmitTaskMutation` invokes `submit_task` and optimistically removes the submitted date. Also defines `useSaveAccountMutation`, `useSavePreferencesMutation`, and `useSaveFavoritesMutation`. The latter two optimistically update cache in `onMutate`; consumers derive the next preferences/favorites from current values, preventing late cache writes from letting rapid edits clobber each other.

### Store schema and semantics

The Tauri store plugin persists three `store.json` keys:

```ts
account:     { phone, email, api_token, portal_url, portal_credential }
preferences: { default_project, project_list, project_map, default_task_groups, autofill_summary, auto_submit, auto_close }
favorites:   { text, project }[]
```

- **Account:**
  - `phone` authenticates to the admin portal.
  - `portal_url` is the portal base URL without a trailing slash. Rust re-trims defensively through `normalize_portal_url`, which also normalizes pre-save candidates in `verify_portal_login` so a value can't verify one way and behave another once saved. **Normalization runs before the non-empty check** — a URL of nothing but slashes is non-empty yet trims away to nothing, and an empty base URL sends login to `""` and then times out blaming the phone number.
  - `portal_credential` is `user:pass` for the portal's HTTP basic gate. Passed through **verbatim** — never trimmed or split on `:`, since any byte may be part of the password.
  - Rust reads all three portal fields, together, via `PortalAccountConfig`. All are required and validated up front; empty strings and wrongly typed values count as unconfigured, and the field order in `from_store_value` decides which message a half-configured store reports.
  - `email` + `api_token` authenticate to Jira.
- **Preferences:**
  - Rust reads `default_project`/`project_list` and `auto_submit`/`auto_close` (both default `false`) in `submit_task`.
  - Frontend-only `default_task_groups` controls initially checked date-card groups; default: `["status"]`.
  - Frontend-only `autofill_summary` controls whether submit sends the built summary or an empty string; default: `true`. When `true`, Jira fetching also disables submit.
  - Frontend-only `project_map` maps Jira issue-key prefix → portal project option id; default: `{}`; at most 3 distinct values. `DateCard` uses it to split submission into per-project rows. It covers Jira issues only — favorites carry their own `project`.
  - **`autofill_summary` → `auto_submit` → `auto_close` is a cascade, not just a disabled chain.** A parent turning off **saves its children as `false`**, it does not merely gray them out — see [autofill-summary-toggle.tsx](src/components/autofill-summary-toggle.tsx) and [auto-submit-toggle.tsx](src/components/auto-submit-toggle.tsx). Two things depend on it:
    - Re-enabling a parent leaves its children off until explicitly re-armed, so the app never auto-submits on the strength of a preference the user disarmed long ago.
    - Stored values stay internally consistent (`auto_close` implies `auto_submit` implies `autofill_summary`), which is why `SubmissionAutomation::from_preferences` reads both flags raw instead of re-deriving the chain. The Rust workflow ordering is the second line of defense, not the first.

    Pinned by [preference-toggles.test.tsx](src/components/preference-toggles.test.tsx). Any new dependent toggle must disarm on its parent's save, not just render disabled.
- **Favorites:** Frontend-only, unlike `preferences`; Rust never reads it. Favorites are insertion-ordered free-form tasks whose `text` is identity. Optional `project` holds a portal project option id picked in the favorites dialog — **a favorite names its portal project directly and is never routed through `project_map`**, which stays a Jira-issue-key mechanism. `null` means none, and routes the favorite like an unmapped task (the default project's bucket when set, else row 1). The portal's blank-valued placeholder option is a project the user can pick and is stored as `""`, so `buildSubmission` resolves a favorite's project with `||`, not `??` — a blank means no project, not a project named `""`. Two legacy shapes exist on disk — plain strings, and objects carrying the superseded `project_key` tag — and `favoritesOptions` normalizes both to `{ text, project: null }` on read, so a stale key can never silently route a submission; the store upgrades on the next save.
- **Synchronization:** Frontend `LazyStore` and backend `app.store("store.json")` read the **same file**. Keep field names synchronized between [src/lib/store.ts](src/lib/store.ts) and Rust. For every new `Preferences` field, add a `DEFAULT_PREFERENCES` default; `preferencesOptions`' per-field merge upgrades older stores.

### Jira integration

[src/lib/queries.ts](src/lib/queries.ts) `jiraTasksQueryOptions` POSTs to `https://living-insider.atlassian.net/rest/api/3/search/jql` using `@tauri-apps/plugin-http` `fetch`, not browser `fetch`; this bypasses CORS and uses the capability-allowlisted host. Authentication is Basic `base64(email:api_token)`.

`useDateCardTasks` runs three JQL queries per date, built by `buildJqlForDate` in [src/lib/date-card-helpers.ts](src/lib/date-card-helpers.ts) and bounded by `<date>` inclusive and `<date+1>` exclusive. Edit them there, not at the query call sites — the same strings are what the group tooltips display:

- status: `status CHANGED BY currentUser() DURING ("<date>", "<date+1>")`
- created: `creator = currentUser() AND created >= "<date>" AND created < "<date+1>"`
- sprint: `assignee = currentUser() AND created < "<date+1>" AND sprint in openSprints() AND statusCategory = "In Progress"`

Jira Cloud can return 200 with zero issues for bad credentials due to anonymous fallback. Detect authentication failure through the `x-seraph-loginreason` header.

`buildSubmission` in [src/lib/date-card-helpers.ts](src/lib/date-card-helpers.ts) formats selected issues, grouped by `fields.status.name`, as `[Status]\n• KEY: summary` blocks for the report comment. After dedup, it relabels issues displayed in “created” to synthetic status “Created” before grouping, placing them in their own `[Created]` block sorted alphabetically among status blocks. It uses `mutative` `create`; the originals remain in react-query cache (see immutability below).

## CI/CD and releases

### CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on PRs and `main` pushes with two parallel required jobs:

- `frontend`: oxlint + oxfmt check + `pnpm test` + `pnpm build` on Ubuntu.
- `rust`: `cargo check` + `cargo test` on macOS, avoiding Linux-only Tauri system dependencies.

The E2E smoke suite runs separately in [e2e.yml](.github/workflows/e2e.yml) (non-required; `main` pushes + manual dispatch) — a full Linux Tauri debug build is too slow to gate PRs.

Each job uses `dorny/paths-filter` and `if:`-guards toolchain/setup/check steps based on relevant paths. Irrelevant changes still complete required checks without running the work. Preserve these constraints:

- `permissions:` **must** grant `pull-requests: read`; on PR events, the filter reads changed files from the API, which the explicit permissions block otherwise denies.
- Exclude generated directories by keeping them untracked, **not** with a leading-`!` line. paths-filter matches when **any** pattern matches, so a negation line matches nearly everything and defeats the filter.
- The `frontend` filter must cover `src-tauri` JSON (`tauri.conf*.json`, `capabilities/*.json`) and TOML (`Cargo.toml`) because oxfmt formats them. Keep the filter synchronized with `ignorePatterns` in `.oxfmtrc.json`/`.oxlintrc.json`; excluding all `src-tauri` would allow config formatting violations onto `main`.
- Do not add `fetch-depth: 0`; paths-filter deepens the shallow clone itself.

### Releases

[.github/workflows/release.yml](.github/workflows/release.yml):

- After `CI` succeeds for a `main` push, the workflow compares the tested commit's version with its first parent. A version increase creates `vX.Y.Z` on that exact commit and continues into the release jobs; an ordinary push stops after the prepare job.
- Tags pushed with `GITHUB_TOKEN` do not trigger a second workflow, so automatic tagging and building deliberately live in the same workflow run. A manually pushed `vX.Y.Z` tag still enters the same guard and build jobs.
- The tag build produces macOS Apple Silicon (`app` + dmg; `app` supplies the `.app.tar.gz` updater artifact) and Windows NSIS through `tauri-apps/tauri-action`.
- It uploads installers, updater artifacts, and `latest.json` to a **draft** GitHub Release.
- A guard job fails unless the tag matches the synchronized versions in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `Cargo.lock`.

Release checklist:

1. Run `pnpm bump <X.Y.Z|major|minor|patch>` ([scripts/bump-version.mjs](scripts/bump-version.mjs)). It updates `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `Cargo.lock` through `cargo metadata`, then creates `release/vX.Y.Z`, commits, pushes, and opens the prefilled PR page. Requires clean, up-to-date `main`.
2. Merge the bump PR. After the resulting `main` CI run succeeds, the release workflow verifies the four versions, creates the tag idempotently, and starts the build. `pnpm bump --tag` remains a manual fallback, not a normal release step.
3. When the draft appears, first verify `.dmg`, `.app.tar.gz` + `.sig`, `-setup.exe` + `.sig`, and `latest.json` with both `darwin-aarch64` and `windows-x86_64`. A missing platform means a bundling regression. Then write notes and **Publish**. Publication makes `releases/latest/download/latest.json` live; installed apps see the update at next launch.

Additional release rules:

- **Updater:** `tauri-plugin-updater` checks GitHub Releases at launch through `use-update-check.ts`; no-op in dev. Sign updater artifacts with the key in the `TAURI_SIGNING_PRIVATE_KEY`(+`_PASSWORD`) repo secrets; the public key is in `tauri.conf.json`. **Losing the private key prevents shipped apps from verifying future updates; users must reinstall manually.**
- **[install.sh](install.sh):** macOS repo-root install one-liner using `curl | bash` from `raw.githubusercontent.com/.../main/install.sh`. curl sets no quarantine attribute, so unsigned builds installed this way avoid Gatekeeper's “damaged” dialog. Keep its `.app.tar.gz` asset suffix synchronized with release uploads.
- **Branch protection:** Manually configure GitHub so `main` requires `frontend` and `rust`.

## Conventions and constraints

- **Path alias:** `@/` → `src/`, configured in `tsconfig.json` and `vite.config.ts`. Both forms are used; match nearby imports.
- **Permissions:** Allowlist frontend HTTP and window APIs in [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json). Edit it for every new external Jira host or window API.
- **react-query defaults:** [src/main.tsx](src/main.tsx) sets `staleTime: Infinity` and disables refetch on focus. Refresh only through explicit buttons or cache invalidation, except the ≥1h-away reset, which reloads the webview.
- **Never mutate react-query cache objects.**
  - Derived arrays from `filter`/`flatMap`/`map` are new; their elements still reference `query.data`. In-place writes mutate cache, and `staleTime: Infinity` makes the original unrecoverable until manual refetch.
  - Keep render-phase code, including `useMemo`, pure.
  - For nested updates, use `mutative`'s `create(obj, draft => { ... })` to derive a structurally shared copy without touching cache; see the `[Created]` relabel in `date-card-helpers.ts`.
  - `mutative` does **not** auto-freeze output. Accidental mutation does not throw; it silently corrupts cache.
- **`relaunch()` races `tauri-plugin-single-instance`.** Restart starts the new process before the old exits. If its single-instance check reaches the shutting-down old process, it defers to that dying instance and the app quits. `useResetWhenAway` deliberately retries and bails instead of relaunching when `close_browsers` rejects. Verify this combination before using `relaunch()` as recovery elsewhere.
- **Every value interpolated into `evaluate(...)` goes through `serde_json::to_string`.** That covers summaries, projects, dates, the login phone, and the selectors themselves (several contain single quotes, so hand-wrapping them in `'...'` breaks the JS). No exceptions: the phone is user-supplied and validated only as non-empty, so a raw apostrophe would break the script and a crafted value would inject into the portal page. When adding a new `evaluate` call, escape the literal even if the value looks trusted — Rust enforces no phone or date format, and the trust boundary should not be load-bearing.
- **Command errors are plain strings.** `AppError` ([src-tauri/src/error.rs](src-tauri/src/error.rs)) serializes as its `Display` text because the frontend renders `String(reason)` directly — serializing as a struct would put `[object Object]` in the Account dialog. Keep the wrapping variants `#[error(transparent)]` so `?` never replaces a specific cause with a vaguer one; add context by prefixing the original message, as login and submit confirmation do.
- **Hardcoded values:** `lib.rs` contains only login/form selectors. They are portal-specific; update them when portal markup changes. Portal base URL and Basic-auth credentials are **not** compiled in: users supply `account.portal_url` / `account.portal_credential` through the Account form in `store.json`; Rust reads them per use with `portal_url()` / `portal_credential()`.
- **Formatting:** oxfmt enforces sorted Tailwind classes (`sortTailwindcss`, reading the v4 stylesheet `src/App.css`) and sorted imports (`sortImports`); the pre-commit hook auto-fixes staged files. Linting needs `--type-aware` (wired into `pnpm lint`) or `typescript/no-floating-promises` silently stops running.
- **UI copy stays second person.** Address the user as "you"/"your" (Thai: `คุณ`), never first person ("I"/"me"/"my", Thai: `ฉัน`). Source strings live in `msg`/`t` macro calls under `src/`; `.po` `msgid`s regenerate from them via `pnpm extract`, so fix the source string first, then re-run `pnpm extract --clean` and fill in the resulting blank `msgstr`s per locale.
- **Never switch git branches without asking.** Do not `git checkout`/`git switch` to another branch, create a new branch, or pull `main` mid-session unless the user has explicitly approved it first — even when a merged PR makes moving to a fresh branch seem like the obvious next step. The user coordinates branch state outside the session; unannounced switches cause divergence and merge conflicts.
