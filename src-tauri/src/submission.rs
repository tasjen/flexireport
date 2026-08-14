/// One project/comment row pair sent by the frontend, which has already
/// bucketed selected tasks through the `project_map` preference and
/// apportioned the day's hours across the rows.
///
/// The wire shape only — `SubmissionPlan::build` is what turns it into a
/// validated `PlannedRow`.
#[derive(serde::Deserialize, Debug)]
pub(crate) struct TaskEntry {
    project: Option<String>,
    summary: String,
    hours: f64,
}

/// Hours for one row, held as integer half-hours because the portal's
/// `task_work_hour_N` select only offers 0.5-hour steps and the value written
/// into it has to match an option string exactly. Constructing one is proof
/// the number lands on the grid and is a legal amount for a single row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WorkHours(u8);

/// A full workday in half-hours. The portal's hour select tops out at 8, and a
/// report's rows must add up to exactly one day.
pub(crate) const HALF_HOURS_PER_DAY: u8 = 16;

/// The least a project row can be worth. A row is a project the user spent
/// part of the day on; anything under an hour is noise on a timesheet, so the
/// frontend's apportionment floors rows here and this rejects the rest.
const MIN_HALF_HOURS_PER_ROW: u8 = 2;

impl WorkHours {
    fn from_hours(hours: f64) -> Result<Self, crate::AppError> {
        let half_hours = hours * 2.0;
        if !half_hours.is_finite() || (half_hours - half_hours.round()).abs() > 1e-6 {
            return Err(format!("Work hours must be a multiple of 0.5, got {hours}").into());
        }
        let half_hours = half_hours.round();
        if !(f64::from(MIN_HALF_HOURS_PER_ROW)..=f64::from(HALF_HOURS_PER_DAY))
            .contains(&half_hours)
        {
            return Err(format!(
                "Work hours must be between {} and {}, got {hours}",
                f64::from(MIN_HALF_HOURS_PER_ROW) / 2.0,
                f64::from(HALF_HOURS_PER_DAY) / 2.0
            )
            .into());
        }
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Ok(Self(half_hours as u8))
    }

    fn half_hours(self) -> u8 {
        self.0
    }

    /// Formats as the portal's option value: whole hours carry no decimal part
    /// (`"8"`), halves carry exactly one (`"7.5"`). A plain float format would
    /// render `"8.0"`, which matches no option and would silently leave the
    /// select blank.
    pub(crate) fn as_option_value(self) -> String {
        if self.0.is_multiple_of(2) {
            (self.0 / 2).to_string()
        } else {
            format!("{}.5", self.0 / 2)
        }
    }
}

/// A row after the form's constraints have been applied: project defaulting
/// done, hours validated onto the portal's grid.
#[derive(Debug)]
pub(crate) struct PlannedRow {
    project: Option<String>,
    summary: String,
    hours: WorkHours,
}

impl PlannedRow {
    pub(crate) fn project(&self) -> Option<&str> {
        self.project.as_deref()
    }

    pub(crate) fn summary(&self) -> &str {
        &self.summary
    }

    pub(crate) fn hours(&self) -> WorkHours {
        self.hours
    }
}

pub(crate) struct SubmissionPreferences {
    default_project: Option<String>,
    project_list: Vec<String>,
}

impl SubmissionPreferences {
    pub(crate) fn new(default_project: Option<String>, project_list: Vec<String>) -> Self {
        Self {
            default_project,
            project_list,
        }
    }
}

#[derive(Debug)]
pub(crate) struct SubmissionPlan {
    rows: Vec<PlannedRow>,
    project_filter: Option<Vec<String>>,
}

/// Project/comment row pairs on the portal task form. More than this cannot be
/// submitted, and the frontend's `buildSubmission` already merges overflow into
/// the last row.
pub(crate) const MAX_ROWS: usize = 3;

impl SubmissionPlan {
    /// Applies the backend's form constraints before Chromium is touched: at
    /// least one row, at most `MAX_ROWS`, row-one defaulting, and hours that
    /// sit on the portal's 0.5-hour grid, clear `MIN_HALF_HOURS_PER_ROW`, and
    /// add up to exactly one workday.
    ///
    /// Too many rows is a caller contract violation, not user error, so it
    /// fails loudly. Silently dropping the extras would ship a report missing
    /// part of the day's work with no signal that anything was lost. Hours are
    /// checked the same way: the portal rejects a day that does not total 8,
    /// and finding that out from a filled form is worse than finding it out
    /// here.
    pub(crate) fn build(
        mut entries: Vec<TaskEntry>,
        preferences: SubmissionPreferences,
    ) -> Result<Self, crate::AppError> {
        if entries.len() > MAX_ROWS {
            return Err(format!(
                "Cannot submit {} rows: the portal task form has only {MAX_ROWS}",
                entries.len()
            )
            .into());
        }
        let SubmissionPreferences {
            default_project,
            mut project_list,
        } = preferences;
        if entries.is_empty() {
            entries.push(TaskEntry {
                project: None,
                summary: String::new(),
                // The only row there is, so it owns the whole day.
                hours: f64::from(HALF_HOURS_PER_DAY) / 2.0,
            });
        }
        let project_filter = if project_list.is_empty() {
            None
        } else {
            project_list.extend(default_project.iter().cloned());
            project_list.extend(
                entries
                    .iter()
                    .filter_map(|entry| entry.project.as_ref())
                    .cloned(),
            );
            Some(project_list)
        };
        if let Some(first) = entries.first_mut() {
            first.project = first.project.take().or(default_project);
        }
        let rows = entries
            .into_iter()
            .map(|entry| {
                Ok(PlannedRow {
                    project: entry.project,
                    summary: entry.summary,
                    hours: WorkHours::from_hours(entry.hours)?,
                })
            })
            .collect::<Result<Vec<_>, crate::AppError>>()?;
        // Widened to `u16` so the sum cannot wrap if `MAX_ROWS` ever grows: a
        // wrapped total could land back on 16 and pass this very check.
        let half_hours: u16 = rows
            .iter()
            .map(|row| u16::from(row.hours.half_hours()))
            .sum();
        if half_hours != u16::from(HALF_HOURS_PER_DAY) {
            let total = f64::from(half_hours) / 2.0;
            return Err(format!(
                "Cannot submit {total} hours: the report's rows must add up to {}",
                f64::from(HALF_HOURS_PER_DAY) / 2.0
            )
            .into());
        }
        Ok(Self {
            rows,
            project_filter,
        })
    }

    pub(crate) fn rows(&self) -> &[PlannedRow] {
        &self.rows
    }

    pub(crate) fn project_filter(&self) -> Option<&[String]> {
        self.project_filter.as_deref()
    }
}

/// Backend automation flags read from the persisted preferences object.
pub(crate) struct SubmissionAutomation {
    auto_submit: bool,
    auto_close: bool,
}

impl SubmissionAutomation {
    pub(crate) fn new(auto_submit: bool, auto_close: bool) -> Self {
        Self {
            auto_submit,
            auto_close,
        }
    }

    pub(crate) fn from_preferences(preferences: Option<&serde_json::Value>) -> Self {
        let auto_submit = preferences
            .and_then(|value| value.get("auto_submit"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let auto_close = preferences
            .and_then(|value| value.get("auto_close"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        Self::new(auto_submit, auto_close)
    }
}

/// Observable completion state of the submission workflow.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SubmissionOutcome {
    Prepared,
    Submitted,
    SubmittedAndClosed,
}

/// Boundary between submission policy and the real portal page/browser.
#[allow(async_fn_in_trait)]
pub(crate) trait SubmissionPortal {
    async fn prepare(&mut self, date: &str, plan: &SubmissionPlan) -> Result<(), crate::AppError>;
    async fn submit(&mut self) -> Result<(), crate::AppError>;
    async fn confirm_submission(&mut self) -> Result<(), crate::AppError>;
    async fn close(&mut self);
}

/// Prepares every submission, then conditionally submits and closes according
/// to the stored automation policy.
pub(crate) struct SubmissionWorkflow;

impl SubmissionWorkflow {
    pub(crate) async fn execute<P: SubmissionPortal>(
        plan: &SubmissionPlan,
        automation: SubmissionAutomation,
        date: &str,
        portal: &mut P,
    ) -> Result<SubmissionOutcome, crate::AppError> {
        portal.prepare(date, plan).await?;
        if !automation.auto_submit {
            return Ok(SubmissionOutcome::Prepared);
        }
        portal.submit().await?;
        if !automation.auto_close {
            return Ok(SubmissionOutcome::Submitted);
        }
        portal.confirm_submission().await.map_err(|error| {
            log::warn!("auto-close skipped, submission not confirmed: {error}");
            crate::AppError::from(format!(
                "{error}\nThe portal didn't confirm the submission; leaving the browser open"
            ))
        })?;
        portal.close().await;
        Ok(SubmissionOutcome::SubmittedAndClosed)
    }
}

#[cfg(test)]
mod tests {
    use crate::AppError;

    use super::{
        SubmissionAutomation, SubmissionOutcome, SubmissionPlan, SubmissionPortal,
        SubmissionPreferences, SubmissionWorkflow, TaskEntry, WorkHours, HALF_HOURS_PER_DAY,
    };

    #[derive(Debug, Default, PartialEq, Eq)]
    enum PortalState {
        #[default]
        Empty,
        Prepared,
        Submitted,
        Confirmed,
        Closed,
        ClosedWithoutConfirmation,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum FailurePoint {
        Prepare,
        Submit,
        Confirm,
    }

    #[derive(Default)]
    struct FakePortal {
        state: PortalState,
        failure: Option<FailurePoint>,
    }

    impl FakePortal {
        fn failing_at(failure: FailurePoint) -> Self {
            Self {
                failure: Some(failure),
                ..Self::default()
            }
        }
    }

    impl SubmissionPortal for FakePortal {
        async fn prepare(&mut self, _date: &str, _plan: &SubmissionPlan) -> Result<(), AppError> {
            if self.failure == Some(FailurePoint::Prepare) {
                return Err("prepare failed".into());
            }
            self.state = PortalState::Prepared;
            Ok(())
        }

        async fn submit(&mut self) -> Result<(), AppError> {
            if self.failure == Some(FailurePoint::Submit) {
                return Err("submit failed".into());
            }
            self.state = PortalState::Submitted;
            Ok(())
        }

        async fn confirm_submission(&mut self) -> Result<(), AppError> {
            if self.failure == Some(FailurePoint::Confirm) {
                return Err("confirmation failed".into());
            }
            self.state = PortalState::Confirmed;
            Ok(())
        }

        async fn close(&mut self) {
            self.state = if self.state == PortalState::Confirmed {
                PortalState::Closed
            } else {
                PortalState::ClosedWithoutConfirmation
            };
        }
    }

    fn one_row_plan() -> SubmissionPlan {
        SubmissionPlan::build(
            vec![TaskEntry {
                project: Some("entry-project".into()),
                summary: "Finished the report".into(),
                hours: 8.0,
            }],
            SubmissionPreferences::new(None, vec![]),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn auto_submit_disabled_leaves_the_prepared_form_open() {
        let mut portal = FakePortal::default();

        let outcome = SubmissionWorkflow::execute(
            &one_row_plan(),
            SubmissionAutomation::new(false, true),
            "2026-07-25",
            &mut portal,
        )
        .await
        .unwrap();

        assert_eq!(
            (outcome, portal.state),
            (SubmissionOutcome::Prepared, PortalState::Prepared)
        );
    }

    #[tokio::test]
    async fn auto_submit_enabled_submits_the_prepared_form_and_leaves_it_open() {
        let mut portal = FakePortal::default();

        let outcome = SubmissionWorkflow::execute(
            &one_row_plan(),
            SubmissionAutomation::new(true, false),
            "2026-07-25",
            &mut portal,
        )
        .await
        .unwrap();

        assert_eq!(
            (outcome, portal.state),
            (SubmissionOutcome::Submitted, PortalState::Submitted)
        );
    }

    #[tokio::test]
    async fn auto_close_waits_for_confirmation_before_closing_the_browser() {
        let mut portal = FakePortal::default();

        let outcome = SubmissionWorkflow::execute(
            &one_row_plan(),
            SubmissionAutomation::new(true, true),
            "2026-07-25",
            &mut portal,
        )
        .await
        .unwrap();

        assert_eq!(
            (outcome, portal.state),
            (SubmissionOutcome::SubmittedAndClosed, PortalState::Closed)
        );
    }

    #[tokio::test]
    async fn preparation_failure_prevents_submission() {
        let mut portal = FakePortal::failing_at(FailurePoint::Prepare);

        let error = SubmissionWorkflow::execute(
            &one_row_plan(),
            SubmissionAutomation::new(true, true),
            "2026-07-25",
            &mut portal,
        )
        .await
        .unwrap_err();

        assert_eq!(
            (error.to_string(), portal.state),
            ("prepare failed".into(), PortalState::Empty)
        );
    }

    #[tokio::test]
    async fn submission_failure_leaves_the_prepared_form_open() {
        let mut portal = FakePortal::failing_at(FailurePoint::Submit);

        let error = SubmissionWorkflow::execute(
            &one_row_plan(),
            SubmissionAutomation::new(true, true),
            "2026-07-25",
            &mut portal,
        )
        .await
        .unwrap_err();

        assert_eq!(
            (error.to_string(), portal.state),
            ("submit failed".into(), PortalState::Prepared)
        );
    }

    #[tokio::test]
    async fn unconfirmed_submission_returns_context_and_leaves_the_browser_open() {
        let mut portal = FakePortal::failing_at(FailurePoint::Confirm);

        let error = SubmissionWorkflow::execute(
            &one_row_plan(),
            SubmissionAutomation::new(true, true),
            "2026-07-25",
            &mut portal,
        )
        .await
        .unwrap_err();

        assert_eq!(
            (error.to_string(), portal.state),
            (
                "confirmation failed\nThe portal didn't confirm the submission; leaving the browser open"
                    .into(),
                PortalState::Submitted,
            )
        );
    }

    #[tokio::test]
    async fn missing_automation_preferences_default_to_manual_submission() {
        let mut portal = FakePortal::default();

        let outcome = SubmissionWorkflow::execute(
            &one_row_plan(),
            SubmissionAutomation::from_preferences(None),
            "2026-07-25",
            &mut portal,
        )
        .await
        .unwrap();

        assert_eq!(
            (outcome, portal.state),
            (SubmissionOutcome::Prepared, PortalState::Prepared)
        );
    }

    #[tokio::test]
    async fn stored_automation_preferences_enable_submit_and_close() {
        let preferences = serde_json::json!({
            "auto_submit": true,
            "auto_close": true,
        });
        let mut portal = FakePortal::default();

        let outcome = SubmissionWorkflow::execute(
            &one_row_plan(),
            SubmissionAutomation::from_preferences(Some(&preferences)),
            "2026-07-25",
            &mut portal,
        )
        .await
        .unwrap();

        assert_eq!(
            (outcome, portal.state),
            (SubmissionOutcome::SubmittedAndClosed, PortalState::Closed)
        );
    }

    #[test]
    fn missing_first_row_project_uses_the_configured_default() {
        let plan = SubmissionPlan::build(
            vec![TaskEntry {
                project: None,
                summary: "Finished the report".into(),
                hours: 8.0,
            }],
            SubmissionPreferences::new(Some("portal-project".into()), vec![]),
        )
        .unwrap();

        let row = &plan.rows()[0];
        assert_eq!(
            (row.project.as_deref(), row.summary.as_str()),
            (Some("portal-project"), "Finished the report")
        );
    }

    #[test]
    fn explicit_first_row_project_overrides_the_configured_default() {
        let plan = SubmissionPlan::build(
            vec![TaskEntry {
                project: Some("entry-project".into()),
                summary: "Finished the report".into(),
                hours: 8.0,
            }],
            SubmissionPreferences::new(Some("default-project".into()), vec![]),
        )
        .unwrap();

        assert_eq!(plan.rows()[0].project.as_deref(), Some("entry-project"));
    }

    #[test]
    fn valid_rows_keep_their_order_and_only_row_one_uses_the_default() {
        let plan = SubmissionPlan::build(
            vec![
                TaskEntry {
                    project: None,
                    summary: "First".into(),
                    hours: 4.0,
                },
                TaskEntry {
                    project: None,
                    summary: "Second".into(),
                    hours: 2.5,
                },
                TaskEntry {
                    project: Some("third-project".into()),
                    summary: "Third".into(),
                    hours: 1.5,
                },
            ],
            SubmissionPreferences::new(Some("default-project".into()), vec![]),
        )
        .unwrap();

        let rows = plan
            .rows()
            .iter()
            .map(|row| (row.project.as_deref(), row.summary.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            rows,
            [
                (Some("default-project"), "First"),
                (None, "Second"),
                (Some("third-project"), "Third"),
            ]
        );
    }

    /// Rows carrying an even-as-possible split of the day, so a test about
    /// something other than hours still satisfies the full-day rule.
    fn rows(summaries: &[&str]) -> Vec<TaskEntry> {
        let count = u8::try_from(summaries.len()).unwrap_or(u8::MAX);
        summaries
            .iter()
            .enumerate()
            .map(|(i, summary)| TaskEntry {
                project: None,
                summary: (*summary).into(),
                hours: f64::from(
                    HALF_HOURS_PER_DAY / count
                        + u8::from(u8::try_from(i).unwrap_or(u8::MAX) < HALF_HOURS_PER_DAY % count),
                ) / 2.0,
            })
            .collect()
    }

    #[test]
    fn more_rows_than_the_portal_form_holds_are_rejected_rather_than_dropped() {
        let error = SubmissionPlan::build(
            rows(&["First", "Second", "Third", "Fourth"]),
            SubmissionPreferences::new(None, vec![]),
        )
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "Cannot submit 4 rows: the portal task form has only 3"
        );
    }

    #[test]
    fn a_full_three_row_submission_is_accepted() {
        let plan = SubmissionPlan::build(
            rows(&["First", "Second", "Third"]),
            SubmissionPreferences::new(None, vec![]),
        )
        .unwrap();

        assert_eq!(
            plan.rows()
                .iter()
                .map(|row| row.summary.as_str())
                .collect::<Vec<_>>(),
            ["First", "Second", "Third"]
        );
    }

    #[test]
    fn each_row_keeps_the_hours_it_was_given() {
        let plan = SubmissionPlan::build(
            rows(&["First", "Second", "Third"]),
            SubmissionPreferences::new(None, vec![]),
        )
        .unwrap();

        assert_eq!(
            plan.rows()
                .iter()
                .map(|row| row.hours().as_option_value())
                .collect::<Vec<_>>(),
            ["3", "2.5", "2.5"]
        );
    }

    #[test]
    fn hours_off_the_portals_half_hour_grid_are_rejected() {
        let mut entries = rows(&["First"]);
        entries[0].hours = 2.75;

        let error =
            SubmissionPlan::build(entries, SubmissionPreferences::new(None, vec![])).unwrap_err();

        assert_eq!(
            error.to_string(),
            "Work hours must be a multiple of 0.5, got 2.75"
        );
    }

    #[test]
    fn hours_outside_a_single_rows_range_are_rejected() {
        // 0.5 is on the grid and the select offers it, but a project row worth
        // less than an hour is not something to report.
        for hours in [0.0, -1.0, 0.5, 8.5] {
            let mut entries = rows(&["First"]);
            entries[0].hours = hours;

            let error = SubmissionPlan::build(entries, SubmissionPreferences::new(None, vec![]))
                .unwrap_err();

            assert_eq!(
                error.to_string(),
                format!("Work hours must be between 1 and 8, got {hours}")
            );
        }
    }

    #[test]
    fn rows_that_do_not_add_up_to_a_full_day_are_rejected() {
        // On-grid and in range individually, but 2.5 + 2.5 is not a workday —
        // the portal rejects the submission, so catch it before Chromium does.
        let mut entries = rows(&["First", "Second"]);
        entries[0].hours = 2.5;
        entries[1].hours = 2.5;

        let error =
            SubmissionPlan::build(entries, SubmissionPreferences::new(None, vec![])).unwrap_err();

        assert_eq!(
            error.to_string(),
            "Cannot submit 5 hours: the report's rows must add up to 8"
        );
    }

    #[test]
    fn hours_render_as_the_portals_own_option_values() {
        let rendered = [2_u8, 5, 15, 16]
            .map(|half_hours| WorkHours(half_hours).as_option_value())
            .to_vec();

        // Never "1.0" or "8.0" — the select has no such option, and assigning
        // one silently leaves the field blank.
        assert_eq!(rendered, ["1", "2.5", "7.5", "8"]);
    }

    #[test]
    fn empty_input_produces_one_blank_full_day_row() {
        let plan = SubmissionPlan::build(
            vec![],
            SubmissionPreferences::new(Some("default-project".into()), vec![]),
        )
        .unwrap();

        assert_eq!(
            plan.rows()[0].hours(),
            WorkHours(HALF_HOURS_PER_DAY),
            "the only row must own the whole day"
        );
        let row = &plan.rows()[0];
        assert_eq!(
            (row.project.as_deref(), row.summary.as_str()),
            (Some("default-project"), "")
        );
    }

    #[test]
    fn empty_project_list_disables_filtering() {
        let plan = SubmissionPlan::build(
            vec![TaskEntry {
                project: Some("entry-project".into()),
                summary: "Finished the report".into(),
                hours: 8.0,
            }],
            SubmissionPreferences::new(Some("default-project".into()), vec![]),
        )
        .unwrap();

        assert_eq!(plan.project_filter(), None);
    }

    #[test]
    fn configured_projects_define_the_filter() {
        let plan = SubmissionPlan::build(
            vec![TaskEntry {
                project: None,
                summary: "Finished the report".into(),
                hours: 8.0,
            }],
            SubmissionPreferences::new(None, vec!["first-project".into(), "second-project".into()]),
        )
        .unwrap();

        assert_eq!(
            plan.project_filter(),
            Some(["first-project".into(), "second-project".into()].as_slice())
        );
    }

    #[test]
    fn configured_default_project_survives_filtering() {
        let plan = SubmissionPlan::build(
            vec![TaskEntry {
                project: Some("entry-project".into()),
                summary: "Finished the report".into(),
                hours: 8.0,
            }],
            SubmissionPreferences::new(
                Some("default-project".into()),
                vec!["listed-project".into()],
            ),
        )
        .unwrap();

        assert!(plan
            .project_filter()
            .is_some_and(|projects| projects.iter().any(|project| project == "default-project")));
    }

    #[test]
    fn submitted_entry_projects_survive_filtering() {
        let plan = SubmissionPlan::build(
            vec![
                TaskEntry {
                    project: Some("first-entry-project".into()),
                    summary: "First".into(),
                    hours: 4.0,
                },
                TaskEntry {
                    project: Some("second-entry-project".into()),
                    summary: "Second".into(),
                    hours: 4.0,
                },
            ],
            SubmissionPreferences::new(
                Some("default-project".into()),
                vec!["listed-project".into()],
            ),
        )
        .unwrap();

        assert_eq!(
            plan.project_filter(),
            Some(
                [
                    "listed-project".into(),
                    "default-project".into(),
                    "first-entry-project".into(),
                    "second-entry-project".into(),
                ]
                .as_slice()
            )
        );
    }
}
