import type { MessageDescriptor } from "@lingui/core";
import { create } from "mutative";

import type { SubmitTaskEntry } from "@/lib/mutations";
import type { Favorite, TaskGroupType } from "@/lib/store";
import { TASK_GROUPS } from "@/lib/task-groups";
import type { JiraIssue } from "@/type";

export type IssueGroup = {
  id: TaskGroupType;
  label: MessageDescriptor;
  // How the group is derived, shown in its TaskSelect tooltip.
  description: MessageDescriptor;
  issues: JiraIssue[];
};

// Prefix that namespaces favorite keys away from real Jira issue keys, so
// dedup/selection state can never collide and buildSubmission can split
// favorites back out of the flat selection.
export const FAVORITE_KEY_PREFIX = "favorite:";

// The Jira-backed task groups. Favorites are local, so they are the one
// TaskGroupType with no query behind them.
export type JqlByGroup = Record<Exclude<TaskGroupType, "favorite">, string>;

// The three Jira queries a date card runs, bounded by <date> inclusive and
// <date+1> exclusive. One source for both the strings handed to
// useJiraTasksQuery and the strings shown in each group's tooltip, so what the
// user is told can't drift from what was asked of Jira.
export function buildJqlForDate(date: string): JqlByGroup {
  const dateAfter = getDateAfter(date);
  return {
    status: `status CHANGED BY currentUser() DURING ("${date}", "${dateAfter}")`,
    created: `creator = currentUser() AND created >= "${date}" AND created < "${dateAfter}"`,
    sprint: `assignee = currentUser() AND created < "${dateAfter}" AND sprint in openSprints() AND statusCategory != Done`,
  };
}

// Total lookup over every TaskGroupType, so the tooltip can ask about any
// group without a cast: favorites simply have no JQL to show.
export function jqlFor(
  jqlByGroup: JqlByGroup,
  id: TaskGroupType,
): string | undefined {
  return id === "favorite" ? undefined : jqlByGroup[id];
}

// Favorites masquerade as issues so the existing dedup/default-checked/
// override machinery applies unchanged. buildSummary never sees them —
// buildSubmission splits them back out into plain leading lines by their
// FAVORITE_KEY_PREFIX.
export function favoritesAsIssues(favorites: Favorite[]): JiraIssue[] {
  return favorites.map((favorite) => ({
    id: favorite.text,
    key: `${FAVORITE_KEY_PREFIX}${favorite.text}`,
    fields: {
      summary: favorite.text,
      status: { name: "" },
      updated: "",
      duedate: "",
    },
  }));
}

// Favorites show their text alone, in the order they were added; Jira issues
// show "KEY: summary" sorted by key.
export function toOptionItems(
  group: Pick<IssueGroup, "id" | "issues">,
): { value: string; label: string }[] {
  if (group.id === "favorite") {
    return group.issues.map((issue) => ({
      value: issue.key,
      label: issue.fields.summary,
    }));
  }
  return group.issues
    .map((issue) => ({
      value: issue.key,
      label: `${issue.key}: ${issue.fields.summary}`,
    }))
    .toSorted((a, b) => a.value.localeCompare(b.value));
}

export function buildIssueGroups(
  issuesById: Record<TaskGroupType, JiraIssue[]>,
  defaultGroupIds: Set<TaskGroupType>,
): IssueGroup[] {
  const ordered = [
    ...TASK_GROUPS.filter((group) => defaultGroupIds.has(group.type)),
    ...TASK_GROUPS.filter((group) => !defaultGroupIds.has(group.type)),
  ];
  // Dedup by key runs in display order, so an issue appearing in more than
  // one query stays in the first group shown on screen.
  const seen = new Set<string>();
  return ordered
    .map(({ type: id, label, description }) => ({
      id,
      label,
      description,
      issues: issuesById[id].filter((issue) => {
        if (seen.has(issue.key)) return false;
        seen.add(issue.key);
        return true;
      }),
    }))
    .filter((group) => group.issues.length > 0);
}

// Membership is post-dedup on purpose: what starts checked always matches
// the groups the user sees on screen.
export function defaultCheckedKeysOf(
  groups: IssueGroup[],
  defaultGroupIds: Set<TaskGroupType>,
): Set<string> {
  return new Set(
    groups
      .filter((group) => defaultGroupIds.has(group.id))
      .flatMap((group) => group.issues.map((issue) => issue.key)),
  );
}

export type SubmissionInput = {
  selectedKeys: string[];
  allIssues: JiraIssue[];
  // Keys of issues displayed under the "created" group, relabeled to a
  // synthetic [Created] status block.
  createdKeys: Set<string>;
  projectMap: Record<string, string>;
  defaultProject: string | null;
  // For each favorite's own portal project; favorites appear in allIssues as
  // issue-shaped objects whose keys carry FAVORITE_KEY_PREFIX, which strips
  // the project off, so the list is what puts it back.
  favorites: Favorite[];
};

function bulletLines(texts: string[]): string {
  return texts.map((text) => `• ${text}`).join("\n");
}

type Bucket = { issues: JiraIssue[]; favoriteTexts: string[] };

function bucketSize(bucket: Bucket): number {
  return bucket.issues.length + bucket.favoriteTexts.length;
}

// A full day on the portal's task form. Its `task_work_hour_N` selects offer
// 0.5-hour steps from 0.5 to 8, and the rows of one report must add up to
// exactly one workday.
export const WORK_HOURS_PER_DAY = 8;
const HALF_HOURS_PER_DAY = WORK_HOURS_PER_DAY * 2;
// A project row is never worth less than an hour, however few tasks landed in
// it. The backend enforces the same floor.
const MIN_HALF_HOURS_PER_ROW = 2;

/**
 * Splits the workday across submission rows in proportion to `weights` — each
 * row's task count — snapped to the portal's 0.5-hour grid.
 *
 * Largest-remainder apportionment: floor every exact share, then hand the
 * leftover half-hours to the rows that rounding shortchanged most. That is
 * what keeps the parts summing to exactly 8; rounding each share on its own
 * does not. No row drops below `MIN_HALF_HOURS_PER_ROW`, so a row worth a
 * single task still reports an hour against its project.
 *
 * Apportioning integer half-hours rather than fractional hours is deliberate:
 * the result is written into a `<select>` and has to match an option value
 * exactly, so float drift is not survivable.
 */
export function apportionWorkHours(weights: number[]): number[] {
  if (!weights.length) return [];
  if (weights.length === 1) return [WORK_HOURS_PER_DAY];
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  // Buckets only exist once something lands in them, so the zero-weight arm is
  // defensive: split the day evenly rather than divide by zero.
  const exact = weights.map((weight) =>
    totalWeight
      ? (HALF_HOURS_PER_DAY * weight) / totalWeight
      : HALF_HOURS_PER_DAY / weights.length,
  );
  const halves = exact.map((share) =>
    Math.max(MIN_HALF_HOURS_PER_ROW, Math.floor(share)),
  );
  // Positive where flooring cost the row, negative where the one-hour floor
  // gave it more than its share — one ordering drives both corrections below.
  const shortfall = exact.map((share, i) => share - (halves[i] ?? 0));
  const byShortfall = halves
    .map((_, i) => i)
    .toSorted((a, b) => (shortfall[b] ?? 0) - (shortfall[a] ?? 0));
  let left = HALF_HOURS_PER_DAY - halves.reduce((sum, half) => sum + half, 0);
  for (let n = 0; left > 0; n++, left--) {
    const row = byShortfall[n % byShortfall.length] ?? 0;
    halves[row] = (halves[row] ?? 0) + 1;
  }
  // Over-allocation only happens when the one-hour floor lifted small rows
  // above their share. Reclaim from the largest row, which is always big
  // enough to give one back, because the two quantities move against each
  // other: a row is only lifted when its exact share is under 2 half-hours,
  // so two lifted rows (at most 4 to reclaim) leave the largest above 12, and
  // one lifted row (at most 2) leaves it at 7 or more.
  for (; left < 0; left++) {
    const largest = halves.indexOf(Math.max(...halves));
    halves[largest] = (halves[largest] ?? 0) - 1;
  }
  return halves.map((half) => half / 2);
}

export function buildSubmission(input: SubmissionInput): {
  summaryText: string;
  submitEntries: SubmitTaskEntry[];
} {
  const selected = new Set(input.selectedKeys);
  const selectedIssues = input.allIssues.filter((issue) =>
    selected.has(issue.key),
  );
  const selectedFavoriteTexts = selectedIssues
    .filter((issue) => issue.key.startsWith(FAVORITE_KEY_PREFIX))
    .map((issue) => issue.fields.summary);
  // Cloned via mutative, not mutated — issues live in the react-query cache.
  const jiraIssues = selectedIssues
    .filter((issue) => !issue.key.startsWith(FAVORITE_KEY_PREFIX))
    .map((issue) =>
      input.createdKeys.has(issue.key)
        ? create(issue, (draft) => {
            draft.fields.status.name = "Created";
          })
        : issue,
    );
  const summaryText = [
    bulletLines(selectedFavoriteTexts),
    buildSummary(jiraIssues),
  ]
    .filter(Boolean)
    .join("\n\n");

  const favoriteProjectByText = new Map(
    input.favorites.map((favorite) => [favorite.text, favorite.project]),
  );
  const buckets = new Map<string, Bucket>();
  const getBucket = (portalProject: string): Bucket => {
    let bucket = buckets.get(portalProject);
    if (!bucket) {
      bucket = { issues: [], favoriteTexts: [] };
      buckets.set(portalProject, bucket);
    }
    return bucket;
  };
  const unmappedIssues: JiraIssue[] = [];
  const unmappedFavoriteTexts: string[] = [];
  for (const issue of jiraIssues) {
    // A Jira issue reaches its portal project through project_map, keyed by
    // the prefix of its issue key.
    const projectKey = issue.key.split("-")[0];
    const portalProject =
      (projectKey ? input.projectMap[projectKey] : undefined) ??
      input.defaultProject;
    if (portalProject) getBucket(portalProject).issues.push(issue);
    else unmappedIssues.push(issue);
  }
  for (const text of selectedFavoriteTexts) {
    // A favorite names its portal project itself, so no mapping step — an
    // untagged one still falls back to the default project. `||`, not `??`:
    // the portal keeps a blank-valued placeholder among its project options,
    // and a favorite left on it means no project, not a project named "".
    const portalProject =
      favoriteProjectByText.get(text) || input.defaultProject;
    if (portalProject) getBucket(portalProject).favoriteTexts.push(text);
    else unmappedFavoriteTexts.push(text);
  }
  // Stable sort by task count (favorites included), so equally-sized buckets
  // keep display order.
  const ranked = [...buckets.entries()].toSorted(
    (a, b) => bucketSize(b[1]) - bucketSize(a[1]),
  );
  // The map editor caps distinct portal projects at 3, but a distinct
  // default-project bucket (or a hand-edited store) can push past that —
  // merge any overflow into the 3rd row.
  const rows = ranked.slice(0, 3);
  const lastRow = rows[rows.length - 1];
  if (lastRow) {
    for (const [, bucket] of ranked.slice(3)) {
      lastRow[1].issues.push(...bucket.issues);
      lastRow[1].favoriteTexts.push(...bucket.favoriteTexts);
    }
  }
  // Row 1 also carries the unmapped tasks in its comment (see below), so they
  // count toward its share of the day — otherwise the row doing the most work
  // is credited with the least of it.
  const hoursByRow = apportionWorkHours(
    rows.map(
      ([, bucket], i) =>
        bucketSize(bucket) +
        (i === 0 ? unmappedIssues.length + unmappedFavoriteTexts.length : 0),
    ),
  );
  // Without a default project, unmapped tasks ride along in row 1's comment,
  // merged into its favorites/status grouping.
  const submitEntries: SubmitTaskEntry[] = rows.length
    ? rows.map(([project, bucket], i) => ({
        project,
        hours: hoursByRow[i] ?? WORK_HOURS_PER_DAY,
        summary: [
          bulletLines(
            i === 0
              ? [...bucket.favoriteTexts, ...unmappedFavoriteTexts]
              : bucket.favoriteTexts,
          ),
          buildSummary(
            i === 0 ? [...bucket.issues, ...unmappedIssues] : bucket.issues,
          ),
        ]
          .filter(Boolean)
          .join("\n\n"),
      }))
    : [{ project: null, hours: WORK_HOURS_PER_DAY, summary: summaryText }];
  return { summaryText, submitEntries };
}

export function buildSummary(issues: JiraIssue[]): string {
  if (!issues.length) return "";
  const byStatus = issues.reduce<Record<string, JiraIssue[]>>((acc, issue) => {
    acc[issue.fields.status.name] = [
      ...(acc[issue.fields.status.name] ?? []),
      issue,
    ];
    return acc;
  }, {});
  return Object.entries(byStatus)
    .toSorted((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([status, statusIssues]) =>
        `[${status}]\n${statusIssues
          .toSorted((a, b) => a.key.localeCompare(b.key))
          .map((issue) => `• ${issue.key}: ${issue.fields.summary}`)
          .join("\n")}`,
    )
    .join("\n\n");
}

// "Today"/"Yesterday", the weekday name within the last week, then "N days
// ago". Diffed at UTC midnight so a DST shift can't skew the day count.
export function getDateRelation(
  date: string,
  locale: string,
  today: string,
  yesterday: string,
  daysAgo: (dayCount: number) => string,
): string | null {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  const dateUtc = Date.UTC(year, month - 1, day);
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((todayUtc - dateUtc) / 86_400_000);
  if (Number.isNaN(diffDays) || diffDays < 0) return null;
  if (diffDays === 0) return today;
  if (diffDays === 1) return yesterday;
  if (diffDays < 7) {
    return new Date(dateUtc).toLocaleDateString(
      locale === "th" ? "th-TH" : "en-US",
      {
        weekday: "long",
        timeZone: "UTC",
      },
    );
  }
  return daysAgo(diffDays);
}

export function getDateAfter(date: string): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + 1);
  const result = d.toISOString().split("T")[0];
  if (!result) throw new Error("Invalid date");
  return result;
}
