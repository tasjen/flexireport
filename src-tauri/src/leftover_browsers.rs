//! Killing Chromium instances an earlier run left behind.
//!
//! Every browser this app launches is terminated in-process: `BrowserSession`
//! closes or kills it, `lifecycle::shutdown` catches the rest on
//! `RunEvent::Exit`, and chromiumoxide's `kill_on_drop` covers a dropped
//! handle. All of that needs *this* process to still be running. It isn't
//! after a `SIGKILL`, a panic, or a force quit — and in development that is
//! the normal case, not the exception: `tauri dev` rebuilds on each Rust
//! change by `SIGKILL`ing its dev child, and because `cargo run` `exec`s the
//! binary in place, the process it kills **is** the app. Nothing on macOS or
//! Windows ties a child's lifetime to its parent's, so the Chromium left
//! behind runs forever — one more tree per hot reload.
//!
//! Wiping the profile dir on launch does not help: Chromium holds its profile
//! open and simply recreates what it needs. Only the *successor* process can
//! clean up, which is why this runs at startup rather than at exit.
//!
//! Each instance's profile dir is fixed and unique to this app, and Chromium
//! carries it in `--user-data-dir=…` on the browser process *and* every helper
//! it spawns. That makes the argument an exact ownership marker: matching it
//! finds every process from a previous run of this instance, and can never
//! match the user's own browser or another tool's automated one.

use std::{ffi::OsString, path::Path};

/// The process table [`reap`] reads and kills through. Split out so the
/// matching rule — the part that decides what gets a `SIGKILL` — is testable
/// without spawning processes. `SystemProcesses` in `lib.rs` is the only real
/// implementation.
pub(crate) trait ProcessTable {
    /// Every running process as `(pid, argv)`.
    fn command_lines(&self) -> Vec<(u32, Vec<OsString>)>;

    /// Force-kills `pid`. Returns whether it was still alive to be killed.
    fn kill(&self, pid: u32) -> bool;
}

/// The `--user-data-dir` argument Chromium is launched with, as one argv entry.
///
/// Matching this whole entry, rather than searching the command line for the
/// path, is what keeps the rule safe: `--disk-cache-dir=<dir>/cache` and a
/// sibling profile like `<dir>-old` both contain the path as a substring.
///
/// Nothing is lost by being strict — every process that references a profile
/// dir at all references it through this argument. `chrome_crashpad_handler`
/// in particular does **not**: it points at the browser installation's own
/// shared crash database, is already `ppid` 1 by design, and exits on its own
/// once the browser it monitors is gone. Matching it would mean reaching into
/// the user's Chrome rather than ours.
fn profile_argument(user_data_dir: &Path) -> OsString {
    let mut arg = OsString::from("--user-data-dir=");
    arg.push(user_data_dir.as_os_str());
    arg
}

/// Whether these arguments belong to a renderer/GPU/utility child rather than
/// the browser process. Chromium tags every child with `--type=…`.
fn is_helper(argv: &[OsString]) -> bool {
    argv.iter()
        .any(|arg| arg.as_encoded_bytes().starts_with(b"--type="))
}

/// Kills every process still running out of one of `profile_dirs`, returning
/// the pids actually killed.
///
/// Call before launching into any of those dirs — the rule cannot tell a
/// browser this run started from one a previous run stranded.
///
/// Browser processes are killed before their helpers, across every profile: a
/// helper outliving its browser is an orphan we would have to find again,
/// while a browser outliving a helper just draws a crash tab in a window
/// nobody is looking at.
pub(crate) fn reap<T: ProcessTable>(table: &T, profile_dirs: &[impl AsRef<Path>]) -> Vec<u32> {
    let markers: Vec<OsString> = profile_dirs
        .iter()
        .map(|dir| profile_argument(dir.as_ref()))
        .collect();

    let mut owned: Vec<(u32, bool)> = table
        .command_lines()
        .into_iter()
        .filter(|(_, argv)| argv.iter().any(|arg| markers.contains(arg)))
        .map(|(pid, argv)| (pid, is_helper(&argv)))
        .collect();
    owned.sort_by_key(|&(pid, is_helper)| (is_helper, pid));

    owned
        .into_iter()
        .filter(|&(pid, _)| table.kill(pid))
        .map(|(pid, _)| pid)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, ffi::OsString};

    use super::{reap, ProcessTable};

    const HEADLESS: &str = "/cache/com.example.app/profiles/headless";
    const HEADED: &str = "/cache/com.example.app/profiles/headed";
    const VERIFY: &str = "/cache/com.example.app/profiles/verify";

    /// A scripted process table recording what got killed, in order.
    #[derive(Default)]
    struct FakeTable {
        processes: Vec<(u32, Vec<OsString>)>,
        dead: RefCell<Vec<u32>>,
        killed: RefCell<Vec<u32>>,
    }

    impl FakeTable {
        fn with(processes: &[(u32, &[&str])]) -> Self {
            Self {
                processes: processes
                    .iter()
                    .map(|(pid, argv)| (*pid, argv.iter().map(OsString::from).collect()))
                    .collect(),
                ..Default::default()
            }
        }

        /// Marks `pid` as having exited between the snapshot and the kill.
        fn already_gone(self, pid: u32) -> Self {
            self.dead.borrow_mut().push(pid);
            self
        }
    }

    impl ProcessTable for FakeTable {
        fn command_lines(&self) -> Vec<(u32, Vec<OsString>)> {
            self.processes.clone()
        }

        fn kill(&self, pid: u32) -> bool {
            self.killed.borrow_mut().push(pid);
            !self.dead.borrow().contains(&pid)
        }
    }

    fn all_profiles() -> [&'static str; 3] {
        [HEADLESS, HEADED, VERIFY]
    }

    fn browser(pid: u32, profile: &str) -> (u32, Vec<OsString>) {
        (
            pid,
            vec![
                OsString::from("/chrome"),
                OsString::from(format!("--user-data-dir={profile}")),
            ],
        )
    }

    fn helper(pid: u32, kind: &str, profile: &str) -> (u32, Vec<OsString>) {
        (
            pid,
            vec![
                OsString::from("/chrome"),
                OsString::from(format!("--type={kind}")),
                OsString::from(format!("--user-data-dir={profile}")),
            ],
        )
    }

    impl FromIterator<(u32, Vec<OsString>)> for FakeTable {
        fn from_iter<I: IntoIterator<Item = (u32, Vec<OsString>)>>(processes: I) -> Self {
            Self {
                processes: processes.into_iter().collect(),
                ..Default::default()
            }
        }
    }

    #[test]
    fn kills_every_process_running_out_of_the_profile() {
        let table: FakeTable = [browser(10, HEADLESS), helper(11, "renderer", HEADLESS)]
            .into_iter()
            .collect();

        assert_eq!(reap(&table, &[HEADLESS]), vec![10, 11]);
    }

    #[test]
    fn every_profile_dir_is_reaped_not_only_the_first() {
        // Startup reaps all three at once, so a stranded headed browser dies
        // even in a session that only ever launches the headless one.
        let table: FakeTable = [
            browser(10, HEADLESS),
            browser(11, HEADED),
            browser(12, VERIFY),
        ]
        .into_iter()
        .collect();

        assert_eq!(reap(&table, &all_profiles()), vec![10, 11, 12]);
    }

    #[test]
    fn kills_the_browser_process_before_its_helpers() {
        // A helper outliving its browser is an orphan with no marker left to
        // find it by, so every browser must die first — including across
        // profiles, since one reap covers all of them.
        let table: FakeTable = [
            helper(11, "renderer", HEADLESS),
            helper(12, "gpu-process", HEADED),
            browser(98, HEADED),
            browser(99, HEADLESS),
        ]
        .into_iter()
        .collect();

        reap(&table, &all_profiles());

        assert_eq!(*table.killed.borrow(), vec![98, 99, 11, 12]);
    }

    #[test]
    fn leaves_every_other_process_alone() {
        // The exact-argument match is the only thing standing between this and
        // killing the user's own browser, so pin the near misses: a sibling
        // path this one is a prefix of, a different flag that happens to
        // contain the path, the shared crash handler that names a Chrome
        // installation's own database, and an unrelated program.
        let table = FakeTable::with(&[
            (
                20,
                &[
                    "/chrome",
                    "--user-data-dir=/cache/com.example.app/profiles/headless-old",
                ],
            ),
            (
                21,
                &[
                    "/chrome",
                    "--disk-cache-dir=/cache/com.example.app/profiles/headless/c",
                ],
            ),
            (
                22,
                &[
                    "/chrome_crashpad_handler",
                    "--database=/Users/someone/Library/Application Support/Google/Chrome/Crashpad",
                ],
            ),
            (23, &["/chrome"]),
            (24, &["/some/other/program", "--user-data-dir=/elsewhere"]),
        ]);

        assert!(reap(&table, &all_profiles()).is_empty());
        assert!(table.killed.borrow().is_empty());
    }

    #[test]
    fn a_dev_build_never_reaps_the_release_builds_browser() {
        // The two bundle identifiers are prefix-related, so their cache dirs
        // are the pair most likely to collide if the match ever loosens.
        const DEV_HEADED: &str = "/cache/com.example.app.dev/profiles/headed";
        let table: FakeTable = [browser(30, HEADED), browser(31, DEV_HEADED)]
            .into_iter()
            .collect();

        assert_eq!(reap(&table, &[DEV_HEADED]), vec![31]);
        assert_eq!(reap(&table, &[HEADED]), vec![30]);
    }

    #[test]
    fn reports_only_the_processes_it_actually_killed() {
        // Nothing holds the table still: a leftover can exit on its own between
        // the snapshot and the kill, and that is not a reaped process.
        let table = FakeTable::with(&[
            (
                10,
                &[
                    "/chrome",
                    "--user-data-dir=/cache/com.example.app/profiles/headless",
                ],
            ),
            (
                11,
                &[
                    "/chrome",
                    "--type=renderer",
                    "--user-data-dir=/cache/com.example.app/profiles/headless",
                ],
            ),
        ])
        .already_gone(11);

        assert_eq!(reap(&table, &all_profiles()), vec![10]);
    }

    #[test]
    fn a_clean_previous_run_leaves_nothing_to_reap() {
        let table = FakeTable::default();

        assert!(reap(&table, &all_profiles()).is_empty());
    }
}

/// Drives the reap against a **real** Chromium, the way `portal_dom` drives
/// the portal selectors against a real one.
///
/// Every test above runs on a fake process table, which can only prove the
/// matching rule — never that a real browser's arguments look the way the rule
/// expects. That is the assumption most likely to rot: chromiumoxide renders
/// the profile dir as a single `--user-data-dir=<path>` argv entry, and a
/// switch to a separate `--user-data-dir <path>` pair, or to a canonicalized
/// path, would leave the reap matching nothing while every fake-backed test
/// stayed green.
///
/// `#[ignore]`d, so the required `cargo test` never needs a Chromium binary.
/// Run with `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored`.
#[cfg(test)]
mod real_chromium {
    use std::time::{Duration, Instant};

    use chromiumoxide::browser::{Browser, BrowserConfig};
    use futures::StreamExt;

    use super::reap;
    use crate::{ProcessTable, SystemProcesses};

    /// A profile dir of this test's own, shaped like the app's
    /// (`…/profiles/<name>`) so the match sees a realistic path.
    fn profile_dir() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("flexireport-reap-{}", std::process::id()))
            .join("profiles")
            .join("headed")
    }

    fn is_running(pid: u32) -> bool {
        SystemProcesses::scan()
            .command_lines()
            .iter()
            .any(|(running, _)| *running == pid)
    }

    #[tokio::test]
    #[ignore]
    async fn a_real_browser_is_recognised_by_its_profile_dir_and_killed() {
        let dir = profile_dir();
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let (mut browser, mut handler) = Browser::launch(
            BrowserConfig::builder()
                .user_data_dir(&dir)
                .build()
                .unwrap(),
        )
        .await
        .unwrap();
        let drain = tokio::spawn(async move { while handler.next().await.is_some() {} });
        let pid = browser
            .get_mut_child()
            .and_then(|child| child.as_mut_inner().id())
            .expect("the launched browser should have a pid");
        assert!(
            is_running(pid),
            "the browser should be running before the reap"
        );

        // Exactly what a fresh app start does to a browser the previous run
        // leaked — the browser here is alive and unreferenced by any session.
        let reaped = reap(&SystemProcesses::scan(), &[&dir]);

        let deadline = Instant::now() + Duration::from_secs(5);
        while is_running(pid) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let survived = is_running(pid);

        drain.abort();
        let _ = std::fs::remove_dir_all(dir.parent().and_then(|p| p.parent()).unwrap());
        assert_eq!(
            (reaped.contains(&pid), survived),
            (true, false),
            "reaped {reaped:?}; browser pid {pid} still running: {survived}"
        );
    }
}
