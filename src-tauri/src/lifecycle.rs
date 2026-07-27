//! What gets torn down, and when.
//!
//! The two entry points here are the whole of the app's teardown policy. They
//! are generic over the session hosts so the ordering and the completeness of
//! each teardown can be tested with fakes — `lib.rs` only wires the real
//! Chromium sessions into them.

use crate::{
    browser_session::{BrowserHost, BrowserSession},
    login::{VerifyHost, VerifySession},
    project_options::ProjectOptionsCache,
    AppError,
};

/// Tears down both persistent sessions and drops the cached project list.
///
/// Backs the `close_browsers` command. The frontend calls it after an account
/// change and on the ≥1h-away reset, so **both** halves matter: a surviving
/// session would submit as the previous member, and a surviving project cache
/// would show that member's project list.
pub(crate) async fn close_persistent_sessions<A: BrowserHost, B: BrowserHost>(
    headless: &BrowserSession<A>,
    headed: &BrowserSession<B>,
    projects: &ProjectOptionsCache,
) -> Result<(), AppError> {
    // Reserve both sessions before mutating either one. If either is busy,
    // `?` drops the first reservation and leaves both sessions plus the cache
    // untouched, so the caller can retry after the active command finishes.
    let mut headless_operation = headless.try_operation()?;
    let mut headed_operation = headed.try_operation()?;
    tokio::join!(headless_operation.close(), headed_operation.close());
    projects.clear().await;
    Ok(())
}

/// Terminates every browser the app owns, for `RunEvent::Exit`.
///
/// The project cache is deliberately left alone — the process is ending, and
/// nothing can read it again. The verification browser is *killed* rather than
/// closed: it is throwaway and a check may still be in flight.
///
/// Any new browser instance or long-lived resource must be torn down here too.
pub(crate) async fn shutdown<A: BrowserHost, B: BrowserHost, V: VerifyHost>(
    headless: &BrowserSession<A>,
    headed: &BrowserSession<B>,
    verify: &VerifySession<V>,
) {
    headless.shutdown().await;
    headed.shutdown().await;
    verify.kill_parked().await;
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::{
        account::PortalAccountConfig,
        browser_session::test_support::{fake_session, Event, FakeHost, FakePage},
        browser_session::BrowserSession,
        login::test_support::{verify_session, FakeVerifyHost, VerifyEvent},
        login::VerifySession,
        project_options::ProjectOptionsCache,
        SelectOption,
    };

    use super::{close_persistent_sessions, shutdown};

    fn sessions() -> (BrowserSession<FakeHost>, BrowserSession<FakeHost>) {
        (fake_session("headless"), fake_session("headed"))
    }

    async fn start(session: &BrowserSession<FakeHost>) -> FakePage {
        let mut operation = session.try_operation().unwrap();
        *operation.page().await.unwrap()
    }

    fn projects(label: &str) -> Vec<SelectOption> {
        vec![SelectOption {
            label: label.into(),
            value: "1".into(),
        }]
    }

    fn candidate() -> PortalAccountConfig {
        PortalAccountConfig::from_candidates(
            "0812345678".into(),
            "https://portal.example.com".into(),
            "user:pass".into(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn closing_the_browsers_shuts_down_both_sessions() {
        let (headless, headed) = sessions();
        start(&headless).await;
        start(&headed).await;

        close_persistent_sessions(&headless, &headed, &ProjectOptionsCache::new())
            .await
            .unwrap();

        assert_eq!(
            (headless.host().events(), headed.host().events()),
            (
                vec![Event::Launched(1), Event::ClosedGracefully(1)],
                vec![Event::Launched(1), Event::ClosedGracefully(1)]
            )
        );
    }

    #[tokio::test]
    async fn a_busy_session_prevents_either_browser_or_the_project_cache_from_closing() {
        let (headless, headed) = sessions();
        start(&headless).await;
        start(&headed).await;
        let active = headed.try_operation().unwrap();
        let cache = ProjectOptionsCache::new();
        cache
            .get_or_scrape(|| async { Ok(projects("old account")) })
            .await
            .unwrap();

        let error = close_persistent_sessions(&headless, &headed, &cache)
            .await
            .unwrap_err();

        assert_eq!(
            (
                error.to_string(),
                headless.host().events(),
                headed.host().events(),
                cache
                    .get_or_scrape(|| async { Ok(projects("new account")) })
                    .await
                    .unwrap(),
            ),
            (
                "The headed browser is busy; wait for the current browser action to finish"
                    .to_string(),
                vec![Event::Launched(1)],
                vec![Event::Launched(1)],
                projects("old account"),
            )
        );
        drop(active);
    }

    #[tokio::test]
    async fn closing_the_browsers_drops_the_cached_project_list() {
        let (headless, headed) = sessions();
        let cache = ProjectOptionsCache::new();
        cache
            .get_or_scrape(|| async { Ok(projects("old account")) })
            .await
            .unwrap();

        close_persistent_sessions(&headless, &headed, &cache)
            .await
            .unwrap();
        let after = cache
            .get_or_scrape(|| async { Ok(projects("new account")) })
            .await
            .unwrap();

        assert_eq!(after, projects("new account"));
    }

    #[tokio::test]
    async fn a_new_account_cannot_inherit_the_previous_logins_session() {
        let (headless, headed) = sessions();
        start(&headless).await;
        start(&headed).await;

        close_persistent_sessions(&headless, &headed, &ProjectOptionsCache::new())
            .await
            .unwrap();
        let page = start(&headed).await;

        // A second `Launched` with no `Probed` in between: the old login's
        // session was gone rather than merely stale, so nothing could be
        // submitted as the previous member.
        assert_eq!(
            (page.0, headed.host().events()),
            (
                2,
                vec![
                    Event::Launched(1),
                    Event::ClosedGracefully(1),
                    Event::Launched(2),
                ]
            )
        );
    }

    #[tokio::test]
    async fn closing_the_browsers_with_nothing_open_is_harmless() {
        let (headless, headed) = sessions();

        close_persistent_sessions(&headless, &headed, &ProjectOptionsCache::new())
            .await
            .unwrap();
        close_persistent_sessions(&headless, &headed, &ProjectOptionsCache::new())
            .await
            .unwrap();

        assert_eq!(
            (headless.host().events(), headed.host().events()),
            (vec![], vec![])
        );
    }

    #[tokio::test]
    async fn app_exit_closes_both_persistent_browsers() {
        let (headless, headed) = sessions();
        let verify = verify_session();
        start(&headless).await;
        start(&headed).await;

        shutdown(&headless, &headed, &verify).await;

        assert_eq!(
            (headless.host().events(), headed.host().events()),
            (
                vec![Event::Launched(1), Event::ClosedGracefully(1)],
                vec![Event::Launched(1), Event::ClosedGracefully(1)]
            )
        );
    }

    #[tokio::test(start_paused = true)]
    async fn app_exit_kills_a_verification_that_is_still_in_flight() {
        let (headless, headed) = sessions();
        let verify = verify_session();
        verify.host().login_hangs.set(true);
        let config = candidate();
        let verifying = verify.verify(&config);
        tokio::pin!(verifying);

        let events = tokio::select! {
            _ = &mut verifying => panic!("the hung verification should not finish"),
            events = async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                shutdown(&headless, &headed, &verify).await;
                verify.host().events()
            } => events,
        };

        assert_eq!(
            events,
            vec![VerifyEvent::Launched(1), VerifyEvent::Killed(1)]
        );
    }

    #[tokio::test]
    async fn app_exit_with_nothing_running_is_harmless() {
        let (headless, headed) = sessions();
        let verify: VerifySession<FakeVerifyHost> = verify_session();

        shutdown(&headless, &headed, &verify).await;

        assert_eq!(
            (
                headless.host().events(),
                headed.host().events(),
                verify.host().events()
            ),
            (vec![], vec![], vec![])
        );
    }
}
