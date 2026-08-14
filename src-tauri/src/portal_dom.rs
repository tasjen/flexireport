//! Portal DOM contract tests.
//!
//! These drive a **real Chromium** against a local HTTP fixture serving
//! representative portal markup, so they catch the failures unit tests cannot:
//! a selector that no longer matches, a form field that never gets filled, a
//! value mangled on its way into the DOM.
//!
//! Every test is `#[ignore]`d. The required CI job runs `cargo test`, which
//! must not depend on a Chromium binary being present. Run them with:
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml -- --ignored
//! ```
//!
//! The fixture pages in `src/fixtures/` are **sanitized captures of the real
//! portal**, not markup generated from the selector constants under test — a
//! fixture built from the same constants would pass no matter how wrong they
//! became. Two deviations are marked in the files themselves: the `task_date`
//! options are reconstructed (the portal renders them server-side, so the
//! capture held only the placeholder), and `option_edge_cases.html` is wholly
//! synthetic because the real pages give every `<option>` a `value`.
//!
//! Re-capturing a page is the right way to update these. Sanitize first:
//! member names, phone numbers, session and CSRF tokens, the real hostname,
//! internal URLs, and real project names.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
};

use chromiumoxide::Browser;
use tiny_http::{Header, Response, Server};

use crate::{
    account::PortalAccountConfig, fill_task_form, get_select_options, launch_browser,
    login_to_portal, project_options::ProjectOptionsCache, submit_task_form,
    task_parameters::TaskParametersScrape, wait_for_url, AppError, ChromiumPage,
    ChromiumTaskFormSource, SelectOption, SubmissionPlan, SubmissionPreferences, TaskEntry,
    TASK_DATE_SELECT, TASK_LEAVE_SELECT, TASK_PROJECT_SELECT_PREFIX,
};

const LOGIN_HTML: &str = include_str!("fixtures/login.html");
const MEMBER_HTML: &str = include_str!("fixtures/member.html");
const TASK_HTML: &str = include_str!("fixtures/task.html");
const TASK_REPORT_HTML: &str = include_str!("fixtures/task_report.html");
const OPTION_EDGE_CASES_HTML: &str = include_str!("fixtures/option_edge_cases.html");

/// Where the captured login form posts. The portal handles the credentials
/// there and then redirects to `member.php`, which is what login waits for.
const LOGIN_FORM_ACTION: &str = "/xxx.php";

/// One request the fixture server saw, so tests can assert on what actually
/// went over the wire rather than on what the code intended to send.
#[derive(Debug, Clone)]
struct RecordedRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: String,
}

impl RecordedRequest {
    /// Parses an `application/x-www-form-urlencoded` body into its fields.
    fn form_fields(&self) -> HashMap<String, String> {
        self.body
            .split('&')
            .filter(|pair| !pair.is_empty())
            .filter_map(|pair| pair.split_once('='))
            .map(|(key, value)| (percent_decode(key), percent_decode(value)))
            .collect()
    }
}

/// Minimal `application/x-www-form-urlencoded` decoding: `+` is a space and
/// `%XX` is a byte. Enough for reading back what Chromium submitted.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or_default();
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A local HTTP server standing in for the admin portal. Serves the fixture
/// pages, records every request, and reproduces the portal's post-submit
/// redirect to `task_report.php`.
struct FixtureServer {
    base_url: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    cross_origin_base: Arc<Mutex<Option<String>>>,
    server: Arc<Server>,
    stopping: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl FixtureServer {
    fn start() -> Self {
        let server = Arc::new(Server::http("127.0.0.1:0").expect("fixture server failed to bind"));
        let port = server
            .server_addr()
            .to_ip()
            .expect("fixture server has no IP address")
            .port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let cross_origin_base = Arc::new(Mutex::new(None));
        let stopping = Arc::new(AtomicBool::new(false));

        let worker = {
            let server = Arc::clone(&server);
            let requests = Arc::clone(&requests);
            let cross_origin_base = Arc::clone(&cross_origin_base);
            let stopping = Arc::clone(&stopping);
            std::thread::spawn(move || {
                while let Ok(mut request) = server.recv() {
                    if stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let authorization = request
                        .headers()
                        .iter()
                        .find(|header| header.field.equiv("Authorization"))
                        .map(|header| header.value.as_str().to_string());
                    // The portal serves everything from the base URL, so strip
                    // any query string before routing.
                    let path = request
                        .url()
                        .split('?')
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    requests.lock().unwrap().push(RecordedRequest {
                        method: request.method().as_str().to_string(),
                        path: path.clone(),
                        authorization,
                        body,
                    });

                    let is_post = request.method().as_str() == "POST";
                    let _ = match (path.as_str(), is_post) {
                        // Submitting the login form lands on the member page,
                        // which is the signal `login_to_portal` polls for.
                        (LOGIN_FORM_ACTION, true) => request.respond(redirect("/member.php")),
                        // A saved task redirects to the report page; that
                        // redirect is what `auto_close` waits on.
                        ("/task.php", true) => request.respond(redirect("/task_report.php")),
                        ("/" | "/index.php", _) => request.respond(html(LOGIN_HTML)),
                        ("/member.php", _) => request.respond(html(MEMBER_HTML)),
                        ("/task.php", _) => request.respond(html(TASK_HTML)),
                        ("/task_report.php", _) => request.respond(html(TASK_REPORT_HTML)),
                        ("/cross-origin.html", _) => {
                            let base = cross_origin_base
                                .lock()
                                .unwrap()
                                .clone()
                                .expect("cross-origin fixture target was not configured");
                            request.respond(html(&format!(
                                "<!doctype html><img src=\"{base}/pixel\">"
                            )))
                        }
                        ("/cross-origin-redirect", _) => {
                            let base = cross_origin_base
                                .lock()
                                .unwrap()
                                .clone()
                                .expect("cross-origin fixture target was not configured");
                            request.respond(redirect(&format!("{base}/landing")))
                        }
                        ("/option_edge_cases.html", _) => {
                            request.respond(html(OPTION_EDGE_CASES_HTML))
                        }
                        _ => request.respond(Response::empty(404)),
                    };
                }
            })
        };

        Self {
            base_url: format!("http://127.0.0.1:{port}"),
            requests,
            cross_origin_base,
            server,
            stopping,
            worker: Some(worker),
        }
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }

    fn point_cross_origin_requests_at(&self, other: &FixtureServer) {
        *self.cross_origin_base.lock().unwrap() = Some(other.base_url.clone());
    }

    /// The last request for `path`, or a panic naming what was seen instead —
    /// a missing request usually means a selector stopped matching.
    fn last_request_to(&self, method: &str, path: &str) -> RecordedRequest {
        let requests = self.requests();
        requests
            .iter()
            .rev()
            .find(|request| request.method == method && request.path == path)
            .unwrap_or_else(|| {
                panic!("no {method} {path} request; the fixture server saw: {requests:#?}")
            })
            .clone()
    }
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.server.unblock();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn html(body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_header(Header::from_bytes("Content-Type", "text/html; charset=utf-8").unwrap())
}

fn redirect(location: &str) -> Response<std::io::Empty> {
    Response::empty(302).with_header(Header::from_bytes("Location", location).unwrap())
}

/// A throwaway Chromium for one test, in its own profile dir so parallel tests
/// never contend for a profile lock.
struct TestBrowser {
    browser: Browser,
    page: ChromiumPage,
}

impl TestBrowser {
    async fn launch(label: &str) -> Self {
        let user_data_dir = std::env::temp_dir()
            .join("flexireport-portal-dom")
            .join(format!("{label}-{}", std::process::id()));
        let (browser, page) = launch_browser(&user_data_dir, false, "portal-dom")
            .await
            .expect("Chromium failed to launch — these tests need a real browser");
        Self { browser, page }
    }

    /// Logs into the fixture portal through the production login path.
    async fn login(&self, server: &FixtureServer, phone: &str) -> Result<(), AppError> {
        let config = PortalAccountConfig::from_candidates(
            phone.into(),
            server.base_url.clone(),
            "portal-user:portal-pass".into(),
        )
        .unwrap();
        login_to_portal(&self.page, &config, "portal-dom").await
    }

    async fn goto_task_form(&self, server: &FixtureServer) {
        self.page
            .goto(format!("{}/task.php", server.base_url))
            .await
            .expect("could not open the task form");
    }

    async fn close(mut self) {
        let _ = self.browser.kill().await;
    }
}

/// Builds a plan from `(project, summary, hours)` rows. Hours are spelled out
/// per row rather than derived, since `SubmissionPlan::build` requires them to
/// total a full day and these tests assert on what reaches the portal.
fn plan(entries: Vec<(Option<&str>, &str, f64)>, project_list: Vec<String>) -> SubmissionPlan {
    SubmissionPlan::build(
        entries
            .into_iter()
            .map(|(project, summary, hours)| {
                serde_json::from_value::<TaskEntry>(serde_json::json!({
                    "project": project,
                    "summary": summary,
                    "hours": hours,
                }))
                .unwrap()
            })
            .collect(),
        SubmissionPreferences::new(None, project_list),
    )
    .unwrap()
}

fn labels(options: &[SelectOption]) -> Vec<&str> {
    options.iter().map(|option| option.label.as_str()).collect()
}

fn values(options: &[SelectOption]) -> Vec<&str> {
    options.iter().map(|option| option.value.as_str()).collect()
}

#[tokio::test]
#[ignore = "needs a real Chromium; run with --ignored"]
async fn login_sends_the_basic_auth_header_and_the_configured_phone() {
    let server = FixtureServer::start();
    let browser = TestBrowser::launch("login").await;

    browser
        .login(&server, "0812345678")
        .await
        .expect("login should reach the member page");

    let login_page = server.last_request_to("GET", "/");
    let submitted = server.last_request_to("POST", LOGIN_FORM_ACTION);
    browser.close().await;

    // `user:pass` base64-encoded, exactly as the portal's basic gate expects.
    assert_eq!(
        login_page.authorization.as_deref(),
        Some("Basic cG9ydGFsLXVzZXI6cG9ydGFsLXBhc3M=")
    );
    // The portal names the phone field `tel`, and `login_script` targets it
    // through `input[type='text']` — the form's other inputs are hidden.
    assert_eq!(
        submitted.form_fields().get("tel").map(String::as_str),
        Some("0812345678"),
        "the login form did not submit the configured phone"
    );
}

#[tokio::test]
#[ignore = "needs a real Chromium; run with --ignored"]
async fn basic_auth_is_not_sent_to_a_different_origin() {
    let portal = FixtureServer::start();
    let external = FixtureServer::start();
    portal.point_cross_origin_requests_at(&external);
    let browser = TestBrowser::launch("auth-origin").await;
    browser.login(&portal, "0812345678").await.unwrap();

    browser
        .page
        .goto(format!("{}/cross-origin.html", portal.base_url))
        .await
        .expect("could not load the cross-origin subresource fixture");
    let subresource = external.last_request_to("GET", "/pixel");
    let _ = browser
        .page
        .goto(format!("{}/cross-origin-redirect", portal.base_url))
        .await;
    // The external fixture intentionally returns 404 after recording the
    // redirected request, which Chromium may surface as a navigation error.
    let redirected = external.last_request_to("GET", "/landing");
    browser.close().await;

    assert_eq!(
        (subresource.authorization, redirected.authorization),
        (None, None),
        "the portal credential must never cross an origin boundary"
    );
}

#[tokio::test]
#[ignore = "needs a real Chromium; run with --ignored"]
async fn task_form_selects_are_scraped_in_portal_order() {
    let server = FixtureServer::start();
    let browser = TestBrowser::launch("scrape").await;
    browser.login(&server, "0812345678").await.unwrap();
    browser.goto_task_form(&server).await;

    let dates = get_select_options(&browser.page, &format!("{TASK_DATE_SELECT} option"))
        .await
        .unwrap();
    let leaves = get_select_options(&browser.page, &format!("{TASK_LEAVE_SELECT} option"))
        .await
        .unwrap();
    let projects = get_select_options(
        &browser.page,
        &format!("{TASK_PROJECT_SELECT_PREFIX}1 option"),
    )
    .await
    .unwrap();
    browser.close().await;

    assert_eq!(
        values(&dates),
        ["", "2026-07-23", "2026-07-24", "2026-07-25"],
        "dates must keep portal order, placeholder included"
    );
    // Unicode survives the round-trip through CDP, in both labels and values.
    assert_eq!(
        (labels(&leaves), values(&leaves)),
        (
            vec![
                "ไม่มี",
                "ลาป่วยเต็มวัน",
                "ลากิจเต็มวัน",
                "ลาพักร้อนเต็มวัน",
                "ลาป่วยครึ่งวัน",
                "ลากิจครึ่งวัน",
                "ลาพักร้อนครึ่งวัน",
                "ลาเดือนเกิด",
                "ลา-ไม่จ่าย",
            ],
            vec!["", "1", "2", "3", "4", "5", "6", "7", "8"]
        )
    );
    assert_eq!(
        values(&projects),
        ["", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
        "the empty-valued placeholder is kept, ahead of the selectable projects"
    );
}

#[tokio::test]
#[ignore = "needs a real Chromium; run with --ignored"]
async fn a_parameter_scrape_reads_the_task_form_and_leaves_the_browser_on_the_member_page() {
    let server = FixtureServer::start();
    let browser = TestBrowser::launch("parameters").await;
    browser.login(&server, "0812345678").await.unwrap();

    let source = ChromiumTaskFormSource {
        page: &browser.page,
        base_url: &server.base_url,
    };
    let parameters = TaskParametersScrape::run(&source, &ProjectOptionsCache::new())
        .await
        .unwrap();
    let landed_on = browser.page.url().await.unwrap();
    browser.close().await;

    assert_eq!(
        (
            values(&parameters.dates),
            values(&parameters.leaves).len(),
            values(&parameters.projects),
        ),
        (
            vec!["", "2026-07-23", "2026-07-24", "2026-07-25"],
            9,
            vec!["", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
        )
    );
    assert_eq!(
        landed_on.as_deref(),
        Some(format!("{}/member.php", server.base_url).as_str()),
        "the scrape must leave the browser on the member page"
    );
}

#[tokio::test]
#[ignore = "needs a real Chromium; run with --ignored"]
async fn options_without_a_value_attribute_are_dropped_and_placeholders_are_kept() {
    let server = FixtureServer::start();
    let browser = TestBrowser::launch("option-policy").await;
    browser
        .page
        .goto(format!("{}/option_edge_cases.html", server.base_url))
        .await
        .unwrap();

    let options = get_select_options(
        &browser.page,
        &format!("{TASK_PROJECT_SELECT_PREFIX}1 option"),
    )
    .await
    .unwrap();
    browser.close().await;

    assert_eq!(
        (labels(&options), values(&options)),
        (
            vec!["เลือกโครงการที่ทำ", "โครงการ 1", "Unicode — ค่า"],
            vec!["", "1", "ค่า-ยูนิโค้ด"]
        ),
        "`ไม่มี value attribute` has no value attribute and must be dropped"
    );
}

#[tokio::test]
#[ignore = "needs a real Chromium; run with --ignored"]
async fn the_submitted_form_carries_the_exact_date_project_summary_and_hours() {
    let server = FixtureServer::start();
    let browser = TestBrowser::launch("submit").await;
    browser.login(&server, "0812345678").await.unwrap();
    browser.goto_task_form(&server).await;

    let plan = plan(
        vec![
            (Some("1"), "Website work", 4.0),
            (Some("2"), "App work", 2.5),
            (Some("3"), "Tooling", 1.5),
        ],
        vec![],
    );
    fill_task_form(&browser.page, "2026-07-24", &plan)
        .await
        .unwrap();
    submit_task_form(&browser.page).await.unwrap();
    wait_for_url(
        &browser.page,
        &format!("{}/task_report.php", server.base_url),
        10_000,
    )
    .await
    .expect("the portal's post-submit redirect was not recognized");

    let submitted_request = server.last_request_to("POST", "/task.php");
    let submitted = submitted_request.form_fields();
    browser.close().await;

    assert_eq!(
        submitted_request.authorization.as_deref(),
        Some("Basic cG9ydGFsLXVzZXI6cG9ydGFsLXBhc3M="),
        "same-origin form submissions must retain the portal credential"
    );
    let field = |name: &str| submitted.get(name).cloned().unwrap_or_default();
    assert_eq!(
        (
            field("task_date"),
            field("task_project_id1"),
            field("task_comment1"),
            field("task_project_id2"),
            field("task_comment2"),
            field("task_project_id3"),
            field("task_comment3"),
        ),
        (
            "2026-07-24".into(),
            "1".into(),
            "Website work".into(),
            "2".into(),
            "App work".into(),
            "3".into(),
            "Tooling".into(),
        )
    );
    // Row 1's select ships with 8 pre-selected and rows 2-3 ship blank, so
    // these three values are the whole point: they prove every row was written
    // rather than left to the portal's own defaults, and that a half-hour
    // renders as the portal's own option value rather than "2.50".
    assert_eq!(
        (
            field("task_work_hour_1"),
            field("task_work_hour_2"),
            field("task_work_hour_3"),
        ),
        ("4".into(), "2.5".into(), "1.5".into())
    );
}

#[tokio::test]
#[ignore = "needs a real Chromium; run with --ignored"]
async fn awkward_summary_text_survives_assignment() {
    let server = FixtureServer::start();
    let browser = TestBrowser::launch("escaping").await;
    browser.login(&server, "0812345678").await.unwrap();
    browser.goto_task_form(&server).await;

    // Every character class that has broken a hand-quoted JS literal before.
    let summary = "[Done]\n• IT-1: \"quoted\" & 'single'\n• IT-2: back\\slash </textarea> ครับ";
    let plan = plan(vec![(Some("1"), summary, 8.0)], vec![]);
    fill_task_form(&browser.page, "2026-07-24", &plan)
        .await
        .unwrap();
    submit_task_form(&browser.page).await.unwrap();
    wait_for_url(
        &browser.page,
        &format!("{}/task_report.php", server.base_url),
        10_000,
    )
    .await
    .unwrap();

    let submitted = server.last_request_to("POST", "/task.php").form_fields();
    browser.close().await;

    // Quotes, apostrophes, backslashes, a literal `</textarea>` and Unicode all
    // arrive byte-for-byte. Newlines are the one documented exception: the HTML
    // spec requires a submitting browser to normalize textarea line breaks to
    // CRLF, so the portal stores `\r\n` for every report — ours and any typed
    // by hand in the portal itself.
    assert_eq!(
        submitted.get("task_comment1").map(String::as_str),
        Some(summary.replace('\n', "\r\n").as_str())
    );
}

#[tokio::test]
#[ignore = "needs a real Chromium; run with --ignored"]
async fn project_filtering_keeps_allowed_options_and_removes_the_rest() {
    let server = FixtureServer::start();
    let browser = TestBrowser::launch("filtering").await;
    browser.login(&server, "0812345678").await.unwrap();
    browser.goto_task_form(&server).await;

    // The task form puts a `task_work_hour_N` select beside every project
    // select. The filter walks *every* `<select>` on the page and is guarded
    // only by an id check, so a sloppier guard would strip these too.
    let work_hours_before = get_select_options(&browser.page, "select#task_work_hour_1 option")
        .await
        .unwrap();

    // Row 1 is set to project 2, which is not in `project_list` — it must
    // survive the filter anyway, or the row would submit a blank project.
    let plan = plan(vec![(Some("2"), "App work", 8.0)], vec!["1".into()]);
    fill_task_form(&browser.page, "2026-07-24", &plan)
        .await
        .unwrap();

    let remaining = get_select_options(
        &browser.page,
        &format!("{TASK_PROJECT_SELECT_PREFIX}1 option"),
    )
    .await
    .unwrap();
    let work_hours_after = get_select_options(&browser.page, "select#task_work_hour_1 option")
        .await
        .unwrap();
    browser.close().await;

    assert_eq!(
        values(&remaining),
        ["", "1", "2"],
        "the placeholder, the allowlisted project, and the row's own project must remain"
    );
    assert_eq!(
        values(&work_hours_after),
        values(&work_hours_before),
        "the project filter must leave neighbouring selects untouched"
    );
}

#[tokio::test]
#[ignore = "needs a real Chromium; run with --ignored"]
async fn a_missing_selector_fails_instead_of_silently_submitting_nothing() {
    let server = FixtureServer::start();
    let browser = TestBrowser::launch("missing").await;
    browser.login(&server, "0812345678").await.unwrap();
    // The member page has no task form, standing in for portal markup that
    // renamed or removed the fields.
    browser
        .page
        .goto(format!("{}/member.php", server.base_url))
        .await
        .unwrap();

    let error = fill_task_form(
        &browser.page,
        "2026-07-24",
        &plan(vec![(Some("1"), "x", 8.0)], vec![]),
    )
    .await
    .unwrap_err();
    browser.close().await;

    let message = error.to_string();
    assert!(
        message.contains("null") || message.to_lowercase().contains("cannot"),
        "a vanished selector should fail loudly, got: {message}"
    );
}

#[tokio::test]
#[ignore = "needs a real Chromium; run with --ignored"]
async fn a_project_the_portal_no_longer_offers_fails_instead_of_submitting_blank() {
    let server = FixtureServer::start();
    let browser = TestBrowser::launch("stale_project").await;
    browser.login(&server, "0812345678").await.unwrap();
    browser.goto_task_form(&server).await;

    // Project options are cached per login, so this is the reachable case: the
    // user picks a project from a list scraped an hour ago that the portal has
    // since dropped. Assigning it does not throw, it leaves the select blank.
    browser
        .page
        .evaluate(
            "document
                .querySelectorAll('select#task_project_id1 option')
                .forEach((option) => {
                    if (option.value === '2') option.remove();
                });",
        )
        .await
        .unwrap();

    let error = fill_task_form(
        &browser.page,
        "2026-07-24",
        &plan(vec![(Some("2"), "App work", 8.0)], vec![]),
    )
    .await
    .unwrap_err();
    browser.close().await;

    let message = error.to_string();
    assert!(
        message.contains("rejected 2"),
        "a vanished project option should fail loudly, got: {message}"
    );
}

#[tokio::test]
#[ignore = "needs a real Chromium; run with --ignored"]
async fn hours_the_portal_no_longer_offers_fail_instead_of_submitting_blank() {
    let server = FixtureServer::start();
    let browser = TestBrowser::launch("hours").await;
    browser.login(&server, "0812345678").await.unwrap();
    browser.goto_task_form(&server).await;

    // Stands in for a portal that narrowed its hour options. This is the one
    // failure the other tests cannot reach: assigning a value no `<option>`
    // carries does not throw, it leaves the select blank — so without the
    // read-back the report would submit with no hours at all.
    browser
        .page
        .evaluate(
            "document
                .querySelectorAll('select#task_work_hour_1 option')
                .forEach((option) => {
                    if (option.value === '8') option.remove();
                });",
        )
        .await
        .unwrap();

    let error = fill_task_form(
        &browser.page,
        "2026-07-24",
        &plan(vec![(Some("1"), "Website work", 8.0)], vec![]),
    )
    .await
    .unwrap_err();
    browser.close().await;

    let message = error.to_string();
    assert!(
        message.contains("rejected 8"),
        "a missing hour option should fail loudly, got: {message}"
    );
}
