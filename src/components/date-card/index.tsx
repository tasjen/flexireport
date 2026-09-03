import DateCardHeader from "@/components/date-card/header";
import DateCardSummary from "@/components/date-card/summary";
import TaskSelectGrid from "@/components/date-card/task-select-grid";
import { Card, CardContent, CardFooter } from "@/components/shared/card";
import { Separator } from "@/components/shared/separator";
import { buildSubmission, WORK_HOURS_PER_DAY } from "@/lib/date-card-helpers";
import { useSubmitTaskMutation } from "@/lib/mutations";
import { usePreferences } from "@/lib/queries";
import { DEFAULT_PREFERENCES } from "@/lib/store";
import { useDateCardTasks } from "@/lib/use-date-card-tasks";
import { useTaskSelection } from "@/lib/use-task-selection";

type Props = {
  date: string;
};
export default function DateCard({ date }: Props) {
  const { data: preferences } = usePreferences();
  const defaultGroupIds = new Set(
    preferences?.default_task_groups ?? DEFAULT_PREFERENCES.default_task_groups,
  );

  const {
    jqlByGroup,
    issueGroups,
    allIssues,
    createdKeys,
    favorites,
    favoriteProjectLabels,
    error,
    isFetching,
    refetchAll,
  } = useDateCardTasks(date, defaultGroupIds);

  const {
    selectedKeys,
    selectedKeySet,
    handleSelectionChange,
    reset: resetSelection,
  } = useTaskSelection(issueGroups, defaultGroupIds);

  // `summaryText` is the unsplit preview/copy text; `submitEntries` is the
  // same selection split into up to 3 form rows. The splitting/bucketing
  // semantics live in buildSubmission (date-card-helpers.ts).
  const { summaryText, submitEntries } = buildSubmission({
    selectedKeys,
    allIssues,
    createdKeys,
    projectMap: preferences?.project_map ?? DEFAULT_PREFERENCES.project_map,
    defaultProject:
      preferences?.default_project ?? DEFAULT_PREFERENCES.default_project,
    favorites,
  });

  const autofillSummary =
    preferences?.autofill_summary ?? DEFAULT_PREFERENCES.autofill_summary;

  const { mutate: submitTask, isPending: isSubmitting } =
    useSubmitTaskMutation();

  return (
    // DateList renders one card per date, so the card's own testid is what
    // scopes the inner ones (`submit-task`, `task-group-*`) to a single date.
    <Card as="li" data-testid={`date-card-${date}`}>
      <DateCardHeader
        date={date}
        isFetching={isFetching}
        isSubmitting={isSubmitting}
        // Submitting mid-fetch would ship whatever the summary happened to be
        // — but only autofill has a summary to get wrong.
        submitDisabled={isSubmitting || (autofillSummary && isFetching)}
        onRefresh={() => {
          refetchAll();
          // Refetched issues should come back on their group defaults, not
          // carrying overrides recorded against the previous result set.
          resetSelection();
        }}
        onSubmit={() =>
          submitTask({
            date,
            // Without autofill there is no text to split by project, so send
            // one empty row and let the backend fall back to the default
            // project — the pre-mapping behavior. One row means the whole day.
            entries: autofillSummary
              ? submitEntries
              : [
                  {
                    project: null,
                    summary: "",
                    hours: WORK_HOURS_PER_DAY,
                  },
                ],
          })
        }
      />
      <Separator />
      <CardContent className="space-y-4">
        <DateCardSummary
          isFetching={isFetching}
          error={error}
          summaryText={summaryText}
          hasIssues={allIssues.length > 0}
        />
      </CardContent>
      <CardFooter>
        <TaskSelectGrid
          groups={issueGroups}
          jqlByGroup={jqlByGroup}
          favoriteProjectLabels={favoriteProjectLabels}
          selectedKeySet={selectedKeySet}
          onSelectionChange={handleSelectionChange}
        />
      </CardFooter>
    </Card>
  );
}
