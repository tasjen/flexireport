//! Live-portal compatibility smoke test.
//!
//! Everything else in this crate proves the app is self-consistent. This is
//! the only thing that proves the *real portal* still looks the way the app
//! believes it does — it is what catches markup the fixtures haven't caught up
//! with yet.
//!
//! Gated behind the `live-portal-smoke` cargo feature, so it does not exist in
//! a normal build and cannot slow or break the required CI job:
//!
//! ```text
//! SMOKE_PORTAL_URL=https://portal.example.com \
//! SMOKE_PORTAL_CREDENTIAL=user:pass \
//! SMOKE_PHONE=0812345678 \
//! cargo test --manifest-path src-tauri/Cargo.toml --features live-portal-smoke live_portal
//! ```
//!
//! **Use a dedicated test account.** These tests log in for real.
//!
//! **Nothing here submits a report, and nothing here may ever be made to.**
//! The suite navigates and reads; it never fills the form and never calls
//! `submit_task_form`. A smoke test that files a bogus daily report into a
//! colleague-visible system is worse than no smoke test.
//!
//! Expect this to be flakier than the rest of the suite: it depends on the
//! network, on the portal being up, and on credentials staying valid. Keep it
//! non-required.

use chromiumoxide::{Browser, Page};

use crate::{
    account::PortalAccountConfig, launch_browser, login_to_portal, profile_dir,
    project_options::ProjectOptionsCache, task_parameters::TaskParametersScrape, ChromiumPage,
    ChromiumTaskFormSource, TASK_COMMENT_TEXTAREA_PREFIX, TASK_DATE_SELECT, TASK_FORM_SELECTOR,
    TASK_LEAVE_SELECT, TASK_PROJECT_SELECT_PREFIX,
};

const PORTAL_URL: &str = "SMOKE_PORTAL_URL";
const PORTAL_CREDENTIAL: &str = "SMOKE_PORTAL_CREDENTIAL";
const PHONE: &str = "SMOKE_PHONE";

/// Credentials come from the environment only. They are never read from
/// `store.json` and never committed — enabling the feature without supplying
/// them is a setup mistake, so it fails loudly rather than passing silently.
fn live_config() -> PortalAccountConfig {
    let read = |name: &str| {
        std::env::var(name).unwrap_or_else(|_| {
            panic!("{name} is unset; the live smoke test needs a dedicated test account")
        })
    };
    PortalAccountConfig::from_candidates(read(PHONE), read(PORTAL_URL), read(PORTAL_CREDENTIAL))
        .expect("the smoke-test environment holds an incomplete portal account")
}

/// A real, logged-in headless browser against the real portal.
struct LiveSession {
    browser: Browser,
    page: ChromiumPage,
    config: PortalAccountConfig,
}

impl LiveSession {
    /// Launches and logs in, which is itself the first assertion: a failure
    /// here means the portal rejected our credentials or moved its login form.
    ///
    /// `label` names this test's own profile dir, so tests run in parallel
    /// never contend for one Chromium profile lock.
    async fn login(label: &str) -> Self {
        let config = live_config();
        let user_data_dir = profile_dir(&std::env::temp_dir().join("flexireport-smoke"), label);
        let (browser, page) = launch_browser(&user_data_dir, false, "smoke")
            .await
            .expect("Chromium failed to launch");
        login_to_portal(&page, &config, "smoke")
            .await
            .expect("the live portal rejected our login");
        Self {
            browser,
            page,
            config,
        }
    }

    /// Tears the browser down and asserts the shutdown itself was clean —
    /// cleanup failing against the real portal is worth knowing about.
    async fn close(mut self) {
        // `None` means the process had already exited, which is still a clean
        // teardown; only a real kill error is a failure.
        if let Some(Err(error)) = self.browser.kill().await {
            panic!("could not terminate the smoke-test browser: {error}");
        }
    }
}

async fn is_present(page: &Page, selector: &str) -> bool {
    page.find_elements(selector)
        .await
        .is_ok_and(|found| !found.is_empty())
}

#[tokio::test]
async fn the_live_portal_still_accepts_our_login_and_shuts_down_cleanly() {
    let session = LiveSession::login("login").await;

    // `login_to_portal` only returns once the portal has landed us on
    // `member.php`, so reaching here is the member-page assertion too.
    let landed_on = session
        .page
        .url()
        .await
        .expect("could not read the page URL");
    let expected = format!("{}/member.php", session.config.portal_url());
    session.close().await;

    assert!(
        landed_on
            .as_deref()
            .is_some_and(|url| url.starts_with(&expected)),
        "expected to land on {expected}, got {landed_on:?}"
    );
}

#[tokio::test]
async fn the_live_task_form_still_yields_dates_leaves_and_projects() {
    let session = LiveSession::login("parameters").await;
    let source = ChromiumTaskFormSource {
        page: &session.page,
        base_url: session.config.portal_url(),
    };

    let parameters = TaskParametersScrape::run(&source, &ProjectOptionsCache::new())
        .await
        .expect("could not scrape the live task form");
    session.close().await;

    // Only that each select yielded something — the actual values are the
    // user's own reporting window and project list, which change constantly.
    assert!(
        !parameters.dates.is_empty(),
        "the live portal offered no reportable dates"
    );
    assert!(
        !parameters.leaves.is_empty(),
        "the live portal offered no leave types"
    );
    assert!(
        !parameters.projects.is_empty(),
        "the live portal offered no projects"
    );
}

#[tokio::test]
async fn the_live_task_form_still_has_every_selector_submission_writes_to() {
    let session = LiveSession::login("selectors").await;
    session
        .page
        .goto(format!("{}/task.php", session.config.portal_url()))
        .await
        .expect("could not open the live task form");

    let mut required = vec![
        TASK_FORM_SELECTOR.to_string(),
        TASK_DATE_SELECT.to_string(),
        TASK_LEAVE_SELECT.to_string(),
    ];
    for row in 1..=3 {
        required.push(format!("{TASK_PROJECT_SELECT_PREFIX}{row}"));
        required.push(format!("{TASK_COMMENT_TEXTAREA_PREFIX}{row}"));
    }

    let mut missing = Vec::new();
    for selector in &required {
        if !is_present(&session.page, selector).await {
            missing.push(selector.clone());
        }
    }
    session.close().await;

    // Reading only: this test never sets a value and never submits.
    assert!(
        missing.is_empty(),
        "the live task form no longer has these selectors, so a submission \
         would silently write nothing: {missing:?}"
    );
}
