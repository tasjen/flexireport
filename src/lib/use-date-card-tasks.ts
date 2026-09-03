import {
  buildIssueGroups,
  buildJqlForDate,
  favoriteProjectLabels,
  favoritesAsIssues,
  type IssueGroup,
  type JqlByGroup,
} from "@/lib/date-card-helpers";
import {
  useFavorites,
  useJiraTasksQuery,
  useTaskParameters,
} from "@/lib/queries";
import type { Favorite, TaskGroupType } from "@/lib/store";
import type { JiraIssue } from "@/type";

export type DateCardTasks = {
  // The strings the three queries below actually ran, for the group tooltips.
  jqlByGroup: JqlByGroup;
  issueGroups: IssueGroup[];
  // Flat union of every grouped issue, for selection/summary bookkeeping.
  allIssues: JiraIssue[];
  // Keys displayed under the "created" group, which buildSubmission relabels
  // to a synthetic [Created] status block. Post-dedup, so an issue shown under
  // an earlier group is not relabeled.
  createdKeys: Set<string>;
  favorites: Favorite[];
  // Favorite text -> portal project label, for the favorites group's option
  // hints. Empty until the headless scrape has run, so a favorite shows its
  // text alone rather than a raw option id.
  favoriteProjectLabels: Map<string, string>;
  // First error across the three queries; one failing query fails the card.
  error: Error | null;
  isFetching: boolean;
  refetchAll: () => void;
};

/**
 * Everything a date card shows, gathered from the three per-date Jira queries
 * plus the local favorites, and grouped by the source that surfaced each
 * issue.
 *
 * Each set is queried separately rather than as one union so its issues can be
 * grouped by source and defaulted per the user's `default_task_groups`
 * preference. Ordering and dedup semantics live in `buildIssueGroups`.
 */
export function useDateCardTasks(
  date: string,
  defaultGroupIds: Set<TaskGroupType>,
): DateCardTasks {
  const jqlByGroup = buildJqlForDate(date);

  // Cards are mounted and unmounted as the list pages in, and a card coming
  // back should re-ask Jira rather than show what was true when it was last
  // open — staleTime is Infinity, so nothing else would refetch it.
  const queryOptions = { refetchOnMount: "always" } as const;
  const statusQuery = useJiraTasksQuery(jqlByGroup.status, queryOptions);
  const createdQuery = useJiraTasksQuery(jqlByGroup.created, queryOptions);
  const sprintQuery = useJiraTasksQuery(jqlByGroup.sprint, queryOptions);

  const { data: favorites } = useFavorites();
  const { data: taskParameters } = useTaskParameters();

  const issueGroups = buildIssueGroups(
    {
      status: statusQuery.data?.issues ?? [],
      created: createdQuery.data?.issues ?? [],
      sprint: sprintQuery.data?.issues ?? [],
      favorite: favoritesAsIssues(favorites ?? []),
    },
    defaultGroupIds,
  );

  return {
    jqlByGroup,
    issueGroups,
    allIssues: issueGroups.flatMap((group) => group.issues),
    createdKeys: new Set(
      issueGroups
        .find((group) => group.id === "created")
        ?.issues.map((issue) => issue.key) ?? [],
    ),
    favorites: favorites ?? [],
    favoriteProjectLabels: favoriteProjectLabels(
      favorites ?? [],
      taskParameters?.projects ?? [],
    ),
    error: statusQuery.error ?? createdQuery.error ?? sprintQuery.error,
    isFetching:
      statusQuery.isFetching ||
      createdQuery.isFetching ||
      sprintQuery.isFetching,
    refetchAll: () => {
      void statusQuery.refetch();
      void createdQuery.refetch();
      void sprintQuery.refetch();
    },
  };
}
