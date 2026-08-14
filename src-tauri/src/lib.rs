mod account;
mod basic_auth;
mod browser_session;
#[cfg(test)]
mod command_registry;
mod error;
mod lifecycle;
#[cfg(all(test, feature = "live-portal-smoke"))]
mod live_portal;
mod login;
mod navigation;
#[cfg(test)]
mod portal_dom;
mod project_options;
mod submission;
mod task_parameters;

use account::PortalAccountConfig;
use basic_auth::BasicAuthPolicy;
use browser_session::{BrowserHost, BrowserOperation, BrowserSession};
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::fetch::{
    ContinueRequestParams, EnableParams, EventRequestPaused, HeaderEntry, RequestPattern,
    RequestStage,
};
use chromiumoxide::Page;
pub(crate) use error::AppError;
use futures::StreamExt;
use login::{login_script, LoginPortal, PortalLogin, VerifyHost, VerifySession};
use navigation::{wait_for_navigation, UrlExpectation};
use project_options::ProjectOptionsCache;
use serde::Serialize;
use std::{
    ops::Deref,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use submission::{
    SubmissionAutomation, SubmissionPlan, SubmissionPortal, SubmissionPreferences,
    SubmissionWorkflow, TaskEntry,
};
use task_parameters::{TaskFormSource, TaskParameters, TaskParametersScrape};
use tauri::Manager;
use tauri_plugin_store::StoreExt;

// Portal-specific selectors. Update these here if the admin site changes its
// form markup. The portal base URL and Basic-auth credential are NOT compiled
// in: they are user-supplied via the Account form and read from `store.json`
// (`account.portal_url` / `account.portal_credential`) — see `portal_url()`
// and `portal_credential()`.
const LOGIN_INPUT_SELECTOR: &str = "input[type='text']";
const TASK_DATE_SELECT: &str = "select#task_date";
const TASK_LEAVE_SELECT: &str = "select#task_leave";
// The task form has 3 project/comment row pairs, numbered 1-3; append the row
// number to these prefixes to get a row's selectors.
const TASK_PROJECT_SELECT_PREFIX: &str = "select#task_project_id";
const TASK_COMMENT_TEXTAREA_PREFIX: &str = "textarea#task_comment";
const TASK_WORK_HOUR_SELECT_PREFIX: &str = "select#task_work_hour_";
const TASK_FORM_SELECTOR: &str = "form[action='task.php']";

/// Path to one of the app's Chromium profile dirs, under the app's own cache
/// dir (not the shared system temp). Each browser instance gets its own subdir
/// so they never contend for the same profile lock; the set is bounded to the
/// three names below, which is why they can be wiped rather than cleaned up.
fn profile_dir(cache_dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    cache_dir.join("profiles").join(name)
}

/// Which browser instance this is, for log lines and its profile subdir.
fn browser_label(with_head: bool) -> &'static str {
    if with_head {
        "headed"
    } else {
        "headless"
    }
}

/// The throwaway `verify_portal_login` profile, kept apart from the persistent
/// instances so a check never contends with them.
const VERIFY_PROFILE: &str = "verify";

/// The real Chromium boundary behind `BrowserSession`: launches a browser from
/// this instance's own profile dir, logs it into the portal, and terminates it.
struct ChromiumHost {
    app: tauri::AppHandle,
    with_head: bool,
}

/// A Chromium page plus the request pump that scopes the portal's Basic-auth
/// header to that page's configured portal origin.
#[derive(Clone)]
struct ChromiumPage {
    page: Page,
    auth: Arc<Mutex<Option<BasicAuthController>>>,
}

impl ChromiumPage {
    fn new(page: Page) -> Self {
        Self {
            page,
            auth: Arc::new(Mutex::new(None)),
        }
    }

    fn install_basic_auth(&self, controller: BasicAuthController) -> Result<(), AppError> {
        let mut auth = self
            .auth
            .lock()
            .map_err(|_| AppError::from("Portal authentication state is unavailable"))?;
        *auth = Some(controller);
        Ok(())
    }

    fn basic_auth_is_healthy(&self) -> bool {
        self.auth
            .lock()
            .is_ok_and(|auth| auth.as_ref().is_some_and(BasicAuthController::is_healthy))
    }

    fn stop_basic_auth(&self) {
        if let Ok(mut auth) = self.auth.lock() {
            auth.take();
        }
    }
}

impl Deref for ChromiumPage {
    type Target = Page;

    fn deref(&self) -> &Self::Target {
        &self.page
    }
}

/// Owns the page-scoped Fetch event pump. Dropping it aborts the pump before
/// the page/browser is closed, so no request can remain paused by an orphaned
/// interceptor.
struct BasicAuthController {
    task: tokio::task::JoinHandle<()>,
    healthy: Arc<AtomicBool>,
}

impl BasicAuthController {
    async fn start(page: &Page, portal_url: &str, token: &str) -> Result<Self, AppError> {
        let policy = BasicAuthPolicy::new(portal_url, token)?;
        let pattern = policy.url_pattern();

        // Subscribe before enabling Fetch so the first paused request cannot
        // race ahead of the pump.
        let mut requests = page.event_listener::<EventRequestPaused>().await?;
        let pump_page = page.clone();
        let healthy = Arc::new(AtomicBool::new(true));
        let pump_health = Arc::clone(&healthy);
        let task = tokio::spawn(async move {
            while let Some(request) = requests.next().await {
                let mut continuation = ContinueRequestParams::new(request.request_id.clone());
                if let Some(headers) =
                    policy.headers_for(&request.request.url, request.request.headers.inner())
                {
                    continuation.headers = Some(
                        headers
                            .into_iter()
                            .map(|(name, value)| HeaderEntry::new(name, value))
                            .collect(),
                    );
                }
                if let Err(error) = pump_page.execute(continuation).await {
                    log::warn!("portal Basic-auth request pump stopped: {error}");
                    break;
                }
            }
            pump_health.store(false, Ordering::Release);
        });
        let controller = Self { task, healthy };

        let pattern = RequestPattern::builder()
            .url_pattern(pattern)
            .request_stage(RequestStage::Request)
            .build();
        if let Err(error) = page
            .execute(EnableParams::builder().pattern(pattern).build())
            .await
        {
            drop(controller);
            return Err(error.into());
        }
        Ok(controller)
    }

    fn is_healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire) && !self.task.is_finished()
    }
}

impl Drop for BasicAuthController {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// One lazily-launched, logged-in Chromium instance. All reuse and teardown
/// policy lives in [`BrowserSession`](browser_session::BrowserSession).
type BrowserState = BrowserSession<ChromiumHost>;

fn browser_state(app: &tauri::AppHandle, with_head: bool) -> BrowserState {
    BrowserSession::new(ChromiumHost {
        app: app.clone(),
        with_head,
    })
}

struct HeadedBrowserState(BrowserState);
struct HeadlessBrowserState(BrowserState);

/// Lets a `BrowserState` newtype deref to the inner state, so both wrappers
/// share the session interface without duplicating the boilerplate.
macro_rules! impl_browser_state_deref {
    ($wrapper:ty) => {
        impl std::ops::Deref for $wrapper {
            type Target = BrowserState;
            fn deref(&self) -> &Self::Target {
                &self.0
            }
        }
    };
}

impl_browser_state_deref!(HeadedBrowserState);
impl_browser_state_deref!(HeadlessBrowserState);

/// The real Chromium boundary behind `VerifySession`. Always headless and
/// always in its own `profiles/verify` dir, so a check never contends with the
/// headed or headless session's profile lock.
struct ChromiumVerifyHost {
    app: tauri::AppHandle,
}

impl VerifyHost for ChromiumVerifyHost {
    type Browser = Browser;
    type Page = ChromiumPage;

    async fn launch(&self) -> Result<(Browser, ChromiumPage), AppError> {
        let user_data_dir = profile_dir(&self.app.path().app_cache_dir()?, VERIFY_PROFILE);
        launch_browser(&user_data_dir, false, VERIFY_PROFILE).await
    }

    async fn login(
        &self,
        page: &ChromiumPage,
        config: &PortalAccountConfig,
    ) -> Result<(), AppError> {
        login_to_portal(page, config, "verify").await
    }

    async fn kill(&self, browser: &mut Browser) {
        let _ = browser.kill().await;
    }
}

/// Runs `verify_portal_login` checks. Parks the in-flight browser so the
/// `RunEvent::Exit` handler can kill it if the app closes mid-verify
/// (invariant: every browser instance must be terminated on app close).
struct VerifyBrowserState(VerifySession<ChromiumVerifyHost>);

impl std::ops::Deref for VerifyBrowserState {
    type Target = VerifySession<ChromiumVerifyHost>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl ChromiumHost {
    /// This browser's Chromium user-data dir. The subdir is the instance label,
    /// so headed and headless never contend for the same profile lock.
    fn user_data_dir(&self) -> Result<std::path::PathBuf, AppError> {
        Ok(profile_dir(&self.app.path().app_cache_dir()?, self.label()))
    }
}

impl BrowserHost for ChromiumHost {
    type Browser = Browser;
    type Page = ChromiumPage;

    fn label(&self) -> &'static str {
        browser_label(self.with_head)
    }

    /// Launches a fresh Chromium instance and logs into the admin portal.
    async fn launch(&self) -> Result<(Browser, ChromiumPage), AppError> {
        // Read the whole config first: a missing value must fail before we
        // spend the cost of launching a browser.
        let account = portal_account(&self.app)?;

        let (browser, page) =
            launch_browser(&self.user_data_dir()?, self.with_head, self.label()).await?;
        login_to_portal(&page, &account, self.label()).await?;

        // Chromium starts with an initial blank tab in addition to the page we
        // create; close it after login so the headed window doesn't show a
        // stray empty tab. Best-effort: login already succeeded, so a cleanup
        // failure shouldn't fail the launch.
        if let Ok(pages) = browser.pages().await {
            for p in pages {
                if p.target_id() != page.target_id() {
                    let _ = p.close().await;
                }
            }
        }

        Ok((browser, page))
    }

    /// Probes whether the cached page can still be driven over CDP. Issues a
    /// real round-trip into the page's JS context (`Runtime.evaluate`) and
    /// returns false if it errors or times out.
    ///
    /// Do NOT probe with `page.url()`: chromiumoxide answers that from the
    /// handler's locally-cached frame state without contacting Chromium, so it
    /// keeps returning `Ok` even when the renderer/CDP session is dead (e.g.
    /// after the OS suspends the browser during a long idle) — a false positive
    /// that then strands the next real command on a ~30s CDP timeout. A
    /// process-level check (`Browser::try_wait`) is likewise insufficient: on
    /// macOS the process lingers after its last window closes. Probe the live
    /// session, not the cache or the process.
    async fn is_page_alive(&self, page: &ChromiumPage) -> bool {
        page.basic_auth_is_healthy()
            && matches!(
                tokio::time::timeout(std::time::Duration::from_secs(2), page.evaluate("1")).await,
                Ok(Ok(_))
            )
    }

    async fn close(&self, browser: &mut Browser, page: ChromiumPage) {
        page.stop_basic_auth();
        let _ = page.page.clone().close().await;
        let _ = browser.close().await;
        let _ = browser.wait().await;
    }

    async fn kill(&self, browser: &mut Browser) {
        let _ = browser.kill().await;
    }
}

/// Launches a fresh Chromium instance from a clean profile at `user_data_dir`.
/// `label` is used for log lines only. Shared by `BrowserState::launch_and_login`
/// and `verify_portal_login`.
async fn launch_browser(
    user_data_dir: &std::path::Path,
    with_head: bool,
    label: &str,
) -> Result<(Browser, ChromiumPage), AppError> {
    // Start each launch from a clean profile in our own cache dir. Wiping
    // also clears any stale `SingletonLock` a previous unclean shutdown left
    // behind, so a leftover Chromium can't make this launch hand off and exit.
    log::info!("launching {label} browser");
    let _ = std::fs::remove_dir_all(user_data_dir);
    std::fs::create_dir_all(user_data_dir)?;
    let mut config = BrowserConfig::builder()
        .user_data_dir(user_data_dir)
        .incognito()
        .viewport(None);
    if with_head {
        config = config.with_head();
    }
    let (browser, mut handler) = Browser::launch(config.build()?).await?;
    tokio::spawn(async move { while handler.next().await.is_some() {} });
    let page = ChromiumPage::new(browser.new_page("about:blank").await?);
    Ok((browser, page))
}

/// The real `LoginPortal`: a Chromium page with stealth mode enabled. Holds no
/// login policy — the sequence lives in `PortalLogin::execute`.
struct ChromiumLoginPortal<'a> {
    page: &'a ChromiumPage,
    portal_url: &'a str,
}

impl LoginPortal for ChromiumLoginPortal<'_> {
    async fn set_basic_auth(&mut self, token: &str) -> Result<(), AppError> {
        self.page.enable_stealth_mode().await?;
        let controller = BasicAuthController::start(self.page, self.portal_url, token).await?;
        self.page.install_basic_auth(controller)?;
        Ok(())
    }

    async fn goto(&mut self, url: &str) -> Result<(), AppError> {
        self.page.goto(url).await?;
        Ok(())
    }

    async fn submit_phone(&mut self, phone: &str) -> Result<(), AppError> {
        self.page
            .evaluate(login_script(LOGIN_INPUT_SELECTOR, phone)?)
            .await?;
        Ok(())
    }

    async fn wait_for_url(&mut self, expected: &str, timeout: Duration) -> Result<(), AppError> {
        wait_for_url(self.page, expected, timeout.as_millis() as u64).await
    }
}

/// Logs `page` into the admin portal with `config`. Shared by the persistent
/// browser sessions (values from `store.json`) and `verify_portal_login`
/// (candidate values from the Account form), so login can't drift between them.
async fn login_to_portal(
    page: &ChromiumPage,
    config: &PortalAccountConfig,
    label: &str,
) -> Result<(), AppError> {
    PortalLogin::execute(
        config,
        label,
        &mut ChromiumLoginPortal {
            page,
            portal_url: config.portal_url(),
        },
    )
    .await
}

/// Reads and validates the portal account config from `store.json`. Free
/// function (not a `ChromiumHost` method) so commands can read portal config
/// without holding a browser state reference.
fn portal_account(app: &tauri::AppHandle) -> Result<PortalAccountConfig, AppError> {
    let store = app.store("store.json")?;
    PortalAccountConfig::from_store_value(store.get("account").as_ref())
}

/// The user-configured portal base URL, normalized. Validates the whole
/// account, so a command that only needs the URL still reports the first
/// unconfigured field rather than failing later inside login.
fn portal_url(app: &tauri::AppHandle) -> Result<String, AppError> {
    Ok(portal_account(app)?.portal_url().to_string())
}

/// Polls until the page URL starts with `expected`. Prefix match rather than
/// equality, so a redirect that appends query params, a fragment, or a
/// trailing slash still counts as arrival. The first probe is immediate, so
/// an already-reached URL returns without waiting for the polling interval.
async fn wait_for_url(page: &Page, expected: &str, timeout_ms: u64) -> Result<(), AppError> {
    let expectation = UrlExpectation::new(expected);
    wait_for_navigation(
        &expectation,
        std::time::Duration::from_millis(timeout_ms),
        || async { page.url().await.map_err(AppError::from) },
    )
    .await
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
struct SelectOption {
    label: String,
    value: String,
}

async fn get_select_options(page: &Page, selector: &str) -> Result<Vec<SelectOption>, AppError> {
    let elements = page.find_elements(selector).await?;
    let mut options = Vec::with_capacity(elements.len());
    for el in &elements {
        if let Some(value) = el.attribute("value").await? {
            let label = el.inner_text().await?.unwrap_or_default();
            options.push(SelectOption { label, value });
        }
    }
    Ok(options)
}

/// The project `<select>` options, scraped from the portal on first use and
/// held until the browser sessions are torn down. See `ProjectOptionsCache`
/// for why the cache is scoped to a login rather than to the process.
static PROJECT_OPTIONS: ProjectOptionsCache = ProjectOptionsCache::new();

/// The real `TaskFormSource`: a logged-in page plus the portal base URL. Holds
/// the selectors and nothing else — the scrape order and the caching rule live
/// in `TaskParametersScrape`.
struct ChromiumTaskFormSource<'a> {
    page: &'a Page,
    base_url: &'a str,
}

impl TaskFormSource for ChromiumTaskFormSource<'_> {
    async fn goto_task_form(&self) -> Result<(), AppError> {
        self.page
            .goto(format!("{}/task.php", self.base_url))
            .await?;
        Ok(())
    }

    async fn scrape_dates(&self) -> Result<Vec<SelectOption>, AppError> {
        get_select_options(self.page, &format!("{TASK_DATE_SELECT} option")).await
    }

    async fn scrape_leaves(&self) -> Result<Vec<SelectOption>, AppError> {
        get_select_options(self.page, &format!("{TASK_LEAVE_SELECT} option")).await
    }

    async fn scrape_projects(&self) -> Result<Vec<SelectOption>, AppError> {
        get_select_options(self.page, &format!("{TASK_PROJECT_SELECT_PREFIX}1 option")).await
    }

    async fn goto_member_page(&self) -> Result<(), AppError> {
        self.page
            .goto(format!("{}/member.php", self.base_url))
            .await?;
        Ok(())
    }
}

/// Tears down both browser instances so the next command logs in fresh.
/// Called from the frontend after the account changes: both sessions belong
/// to the old login, and a reused headed session would submit tasks as the
/// previous member.
#[tauri::command]
async fn close_browsers(
    headless: tauri::State<'_, HeadlessBrowserState>,
    headed: tauri::State<'_, HeadedBrowserState>,
) -> Result<(), AppError> {
    log::info!("close_browsers: tearing down both browser instances");
    lifecycle::close_persistent_sessions(&headless, &headed, &PROJECT_OPTIONS).await?;
    Ok(())
}

/// Verifies the given portal values by performing a real login in a throwaway
/// headless browser. Takes the *candidate* values as arguments — this never
/// reads `store.json` — so nothing persists unless the frontend decides to
/// save after this succeeds. Pass or fail, the browser is killed before
/// returning; it exists only for the duration of the check.
#[tauri::command]
async fn verify_portal_login(
    state: tauri::State<'_, VerifyBrowserState>,
    portal_url: String,
    portal_credential: String,
    phone: String,
) -> Result<(), AppError> {
    log::info!("verify_portal_login: checking candidate portal values");
    // Candidates run through the same validation and trailing-slash
    // normalization as stored values, so nothing can pass here and then behave
    // differently once the frontend saves it.
    let candidate = PortalAccountConfig::from_candidates(phone, portal_url, portal_credential)?;
    state.verify(&candidate).await
}

#[tauri::command]
async fn get_task_parameters(
    state: tauri::State<'_, HeadlessBrowserState>,
) -> Result<TaskParameters, AppError> {
    let mut operation = state.try_operation()?;
    let base_url = portal_url(&state.host().app)?;
    let page = operation.page().await?;
    let source = ChromiumTaskFormSource {
        page,
        base_url: &base_url,
    };

    let parameters = TaskParametersScrape::run(&source, &PROJECT_OPTIONS).await?;

    log::info!(
        "get_task_parameters: scraped {} dates, {} leaves, {} projects",
        parameters.dates.len(),
        parameters.leaves.len(),
        parameters.projects.len()
    );
    Ok(parameters)
}

#[tauri::command]
async fn open_member_page(state: tauri::State<'_, HeadedBrowserState>) -> Result<(), AppError> {
    let mut operation = state.try_operation()?;
    let base_url = portal_url(&state.host().app)?;
    let page = operation.page().await?;
    page.goto(format!("{base_url}/member.php")).await?;
    page.bring_to_front().await?;
    Ok(())
}

struct ChromiumSubmissionPortal<'a, 'session> {
    browser: &'a mut BrowserOperation<'session, ChromiumHost>,
    base_url: &'a str,
}

/// Sets a `<select>` to `value` and proves it took, naming the field as `what`
/// if it did not.
///
/// Assigning a value no `<option>` carries leaves a `<select>` blank instead
/// of throwing, so the value is read back: that silence is exactly how portal
/// markup that dropped an option would reach a submitted report.
async fn set_select_value(
    page: &Page,
    selector: &str,
    value: &str,
    what: &str,
) -> Result<(), AppError> {
    let selector_js = serde_json::to_string(selector)?;
    let value_js = serde_json::to_string(value)?;
    let applied: String = page
        .evaluate(format!(
            "(() => {{
                const select = document.querySelector({selector_js});
                select.value = {value_js};
                return select.value;
            }})()"
        ))
        .await?
        .into_value()?;
    if applied != value {
        return Err(
            format!("The portal's {what} select rejected {value}: it has no such option").into(),
        );
    }
    Ok(())
}

/// Writes the plan into the task form on `page`, which must already be on it.
/// Free function (not a `ChromiumSubmissionPortal` method) so the DOM contract
/// can be exercised against a fixture page without an `AppHandle`.
async fn fill_task_form(page: &Page, date: &str, plan: &SubmissionPlan) -> Result<(), AppError> {
    // `date` comes from a portal option value, but the dates are re-read every
    // scrape and the page can have moved on since, so it gets the same
    // read-back as the rest.
    set_select_value(page, TASK_DATE_SELECT, date, "date").await?;

    for (i, entry) in plan.rows().iter().enumerate() {
        let row = i + 1;
        if let Some(project) = entry.project() {
            // Project options are cached per login, not per command, so a
            // project the portal has since dropped can still reach this point
            // — and would otherwise submit as a blank select.
            set_select_value(
                page,
                &format!("{TASK_PROJECT_SELECT_PREFIX}{row}"),
                project,
                &format!("row {row} project"),
            )
            .await?;
        }
        let summary_selector_js =
            serde_json::to_string(&format!("{TASK_COMMENT_TEXTAREA_PREFIX}{row}"))?;
        let summary_js = serde_json::to_string(entry.summary())?;
        page.evaluate(format!(
            "document.querySelector({summary_selector_js}).value = {summary_js};"
        ))
        .await?;

        // Every row's hours are written explicitly. The portal pre-selects 8
        // on row 1 and leaves rows 2-3 blank, so a row left alone either
        // double-counts the day or submits no hours at all.
        set_select_value(
            page,
            &format!("{TASK_WORK_HOUR_SELECT_PREFIX}{row}"),
            &entry.hours().as_option_value(),
            &format!("row {row} hours"),
        )
        .await?;
    }

    if let Some(keep) = plan.project_filter() {
        // Every value set on a row select must survive the filter, so the
        // keep list is project_list + default_project + each entry's project.
        let keep_js = serde_json::to_string(keep)?;
        page.evaluate(format!(
            "Array.from(document.querySelectorAll('select')).forEach((e) => {{
                        if (e.id.includes('task_project_id')) {{
                            e.querySelectorAll('option').forEach((o) => {{
                                if (!{keep_js}.includes(o.value) && o.value != '') {{
                                    o.remove();
                                }}
                            }});
                        }}
                    }});"
        ))
        .await?;
    }

    Ok(())
}

/// Submits the task form on `page`. Free function for the same reason as
/// `fill_task_form`.
async fn submit_task_form(page: &Page) -> Result<(), AppError> {
    // The selector contains single quotes, so pass it through
    // `serde_json::to_string` instead of hand-wrapping it in '...'
    // (same technique as the login selector).
    let form_selector_js = serde_json::to_string(TASK_FORM_SELECTOR)?;
    page.evaluate(format!(
        "document.querySelector({form_selector_js}).submit();"
    ))
    .await?;
    Ok(())
}

impl SubmissionPortal for ChromiumSubmissionPortal<'_, '_> {
    async fn prepare(&mut self, date: &str, plan: &SubmissionPlan) -> Result<(), AppError> {
        let page = self.browser.page().await?;
        page.goto(format!("{}/task.php", self.base_url)).await?;
        page.bring_to_front().await?;
        fill_task_form(page, date, plan).await
    }

    async fn submit(&mut self) -> Result<(), AppError> {
        log::info!("submit_task: auto-submitting the task form");
        submit_task_form(self.browser.page().await?).await
    }

    async fn confirm_submission(&mut self) -> Result<(), AppError> {
        // The portal confirms a saved task by navigating to the report page.
        wait_for_url(
            self.browser.page().await?,
            &format!("{}/task_report.php", self.base_url),
            10_000,
        )
        .await
    }

    async fn close(&mut self) {
        log::info!("submit_task: submission confirmed, closing headed browser");
        self.browser.close().await;
    }
}

#[tauri::command]
async fn submit_task(
    state: tauri::State<'_, HeadedBrowserState>,
    date: String,
    entries: Vec<TaskEntry>,
) -> Result<(), AppError> {
    log::info!(
        "submit_task: pre-filling form for date {date} ({} row(s))",
        entries.len().max(1)
    );
    let mut operation = state.try_operation()?;
    let base_url = portal_url(&state.host().app)?;

    let store = state.host().app.store("store.json")?;
    let preferences = store.get("preferences");
    let default_project = preferences.as_ref().and_then(|value| {
        value
            .get("default_project")
            .and_then(|p| p.as_str().map(String::from))
    });
    let project_list = preferences
        .as_ref()
        .and_then(|value| {
            value
                .get("project_list")
                .and_then(|projects| projects.as_array().cloned())
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|project| project.as_str().map(String::from))
        .collect();
    let plan = SubmissionPlan::build(
        entries,
        SubmissionPreferences::new(default_project, project_list),
    )?;
    let automation = SubmissionAutomation::from_preferences(preferences.as_ref());
    let mut portal = ChromiumSubmissionPortal {
        browser: &mut operation,
        base_url: &base_url,
    };

    SubmissionWorkflow::execute(&plan, automation, &date, &mut portal)
        .await
        .map(|_| ())
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    // Logs go to the terminal in dev only — never to disk. Release builds
    // don't register the plugin at all, so log macros become no-ops there.
    if cfg!(debug_assertions) {
        builder = builder.plugin(
            tauri_plugin_log::Builder::new()
                .targets([tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                )])
                .level(log::LevelFilter::Info)
                .build(),
        );
    }
    builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let window = app.get_webview_window("main").expect("no main window");
            // Show before focusing: the window starts hidden until the frontend
            // reveals it (see main.tsx), and focusing a hidden window does
            // nothing — this is the escape hatch if the frontend never loads.
            let _ = window.show();
            let _ = window.set_focus();
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(HeadlessBrowserState(browser_state(app.handle(), false)));
            app.manage(HeadedBrowserState(browser_state(app.handle(), true)));
            app.manage(VerifyBrowserState(VerifySession::new(ChromiumVerifyHost {
                app: app.handle().clone(),
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_task_parameters,
            close_browsers,
            submit_task,
            open_member_page,
            verify_portal_login
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(async {
                    lifecycle::shutdown(
                        &app_handle.state::<HeadlessBrowserState>(),
                        &app_handle.state::<HeadedBrowserState>(),
                        &app_handle.state::<VerifyBrowserState>(),
                    )
                    .await;
                });
            }
        });
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{browser_label, profile_dir, VERIFY_PROFILE};

    #[test]
    fn each_browser_instance_gets_its_own_profile_directory() {
        let cache = Path::new("/tmp/app-cache");

        let dirs = [browser_label(false), browser_label(true), VERIFY_PROFILE]
            .map(|name| profile_dir(cache, name));

        // Bounded to three fixed paths, which is what lets each launch wipe
        // its own dir instead of tracking temporary ones for cleanup.
        assert_eq!(
            dirs,
            [
                Path::new("/tmp/app-cache/profiles/headless").to_path_buf(),
                Path::new("/tmp/app-cache/profiles/headed").to_path_buf(),
                Path::new("/tmp/app-cache/profiles/verify").to_path_buf(),
            ]
        );
    }

    #[test]
    fn headed_and_headless_instances_are_labelled_apart() {
        // The label names the instance in log lines *and* picks its profile
        // subdir, so a collision here would put both browsers in one profile.
        assert_ne!(browser_label(true), browser_label(false));
        assert_ne!(browser_label(true), VERIFY_PROFILE);
        assert_ne!(browser_label(false), VERIFY_PROFILE);
    }
}
