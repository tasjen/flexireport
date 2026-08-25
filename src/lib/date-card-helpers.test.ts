import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildIssueGroups,
  buildJqlForDate,
  apportionWorkHours,
  buildSubmission,
  defaultCheckedKeysOf,
  buildSummary,
  favoritesAsIssues,
  FAVORITE_KEY_PREFIX,
  getDateAfter,
  getDateRelation,
  jqlFor,
  toOptionItems,
} from "@/lib/date-card-helpers";
import type { JiraIssue } from "@/type";

function issue(key: string, summary: string, status: string): JiraIssue {
  return {
    id: key,
    key,
    fields: {
      summary,
      updated: "",
      duedate: "",
      status: { name: status },
    },
  };
}

describe("getDateAfter", () => {
  it("returns the next day", () => {
    expect(getDateAfter("2026-07-24")).toBe("2026-07-25");
  });

  it("rolls over month boundaries", () => {
    expect(getDateAfter("2026-01-31")).toBe("2026-02-01");
  });
});

describe("buildSummary", () => {
  it("returns an empty string for no issues", () => {
    expect(buildSummary([])).toBe("");
  });

  it("groups issues into sorted [Status] blocks with sorted bullet lines", () => {
    const summary = buildSummary([
      issue("DR-2", "Fix login", "In Progress"),
      issue("DR-9", "Ship report", "Done"),
      issue("DR-1", "Add tests", "In Progress"),
    ]);
    expect(summary).toBe(
      "[Done]\n• DR-9: Ship report\n\n" +
        "[In Progress]\n• DR-1: Add tests\n• DR-2: Fix login",
    );
  });
});

// Favorites masquerade as issues in `allIssues`, mirroring DateCard's
// favoriteIssues mapping.
function favoriteIssue(text: string): JiraIssue {
  return {
    id: text,
    key: `favorite:${text}`,
    fields: { summary: text, updated: "", duedate: "", status: { name: "" } },
  };
}

const sum = (hours: number[]) => hours.reduce((total, h) => total + h, 0);

describe("apportionWorkHours", () => {
  it("gives a lone row the whole day", () => {
    expect(apportionWorkHours([1])).toEqual([8]);
    expect(apportionWorkHours([40])).toEqual([8]);
  });

  it("splits the day in proportion to task counts", () => {
    expect(apportionWorkHours([3, 1])).toEqual([6, 2]);
    expect(apportionWorkHours([1, 1])).toEqual([4, 4]);
    expect(apportionWorkHours([5, 3, 1])).toEqual([4.5, 2.5, 1]);
  });

  it("hands the rounding leftover to the most shortchanged row", () => {
    // 16/3 half-hours each: three floors of 5 leave one half-hour over, and
    // the highest-ranked row takes it rather than the day summing to 7.5.
    expect(apportionWorkHours([1, 1, 1])).toEqual([3, 2.5, 2.5]);
  });

  it("never drops a row below an hour, however small its share", () => {
    // A row is a project worth reporting, so the one-hour floor wins over the
    // exact proportion — and the hours it takes come off the largest row, so
    // the day still totals 8.
    expect(apportionWorkHours([40, 1])).toEqual([7, 1]);
    expect(apportionWorkHours([1000, 1, 1])).toEqual([6, 1, 1]);
  });

  it("always adds up to a full day, whatever the weights", () => {
    const cases = [
      [1],
      [1, 1],
      [7, 2],
      [1, 1, 1],
      [2, 2, 1],
      [9, 4, 3],
      [100, 1, 1],
      [1, 0, 0],
      [0, 0],
    ];
    for (const weights of cases) {
      const hours = apportionWorkHours(weights);
      expect([weights, sum(hours)]).toEqual([weights, 8]);
      // Every value must land on an option of the portal's hour select.
      for (const value of hours) {
        expect([weights, value * 2]).toEqual([weights, Math.round(value * 2)]);
        expect(value).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("returns nothing for no rows", () => {
    expect(apportionWorkHours([])).toEqual([]);
  });
});

describe("buildSubmission", () => {
  it("degrades to one backend-defaulted entry when nothing is selected", () => {
    expect(
      buildSubmission({
        selectedKeys: [],
        allIssues: [issue("DR-1", "Add tests", "In Progress")],
        createdKeys: new Set(),
        projectMap: {},
        defaultProject: null,
        favorites: [],
      }),
    ).toEqual({
      summaryText: "",
      submitEntries: [{ project: null, summary: "", hours: 8 }],
    });
  });

  it("sends unmapped selected issues as one backend-defaulted entry", () => {
    const { summaryText, submitEntries } = buildSubmission({
      selectedKeys: ["DR-1", "XX-2"],
      allIssues: [
        issue("DR-1", "Add tests", "In Progress"),
        issue("XX-2", "Write docs", "Done"),
        issue("DR-3", "Not selected", "Done"),
      ],
      createdKeys: new Set(),
      projectMap: {},
      defaultProject: null,
      favorites: [],
    });
    expect(summaryText).toBe(
      "[Done]\n• XX-2: Write docs\n\n[In Progress]\n• DR-1: Add tests",
    );
    expect(submitEntries).toEqual([
      { project: null, summary: summaryText, hours: 8 },
    ]);
  });

  it("leads the summary with selected favorites as plain bullets", () => {
    const { summaryText, submitEntries } = buildSubmission({
      selectedKeys: ["favorite:Standup", "XX-2"],
      allIssues: [
        favoriteIssue("Standup"),
        issue("XX-2", "Write docs", "Done"),
      ],
      createdKeys: new Set(),
      projectMap: {},
      defaultProject: null,
      favorites: [{ text: "Standup", project: null }],
    });
    expect(summaryText).toBe("• Standup\n\n[Done]\n• XX-2: Write docs");
    expect(submitEntries).toEqual([
      { project: null, summary: summaryText, hours: 8 },
    ]);
  });

  it("relabels created-group issues to a [Created] block without mutating them", () => {
    const created = issue("DR-1", "Add tests", "In Progress");
    const { summaryText } = buildSubmission({
      selectedKeys: ["DR-1", "XX-2"],
      allIssues: [created, issue("XX-2", "Write docs", "Done")],
      createdKeys: new Set(["DR-1"]),
      projectMap: {},
      defaultProject: null,
      favorites: [],
    });
    expect(summaryText).toBe(
      "[Created]\n• DR-1: Add tests\n\n[Done]\n• XX-2: Write docs",
    );
    expect(created.fields.status.name).toBe("In Progress");
  });

  it("buckets mapped tasks into rows by portal project, largest first", () => {
    const { submitEntries } = buildSubmission({
      selectedKeys: ["DR-1", "DR-2", "OPS-8", "OPS-9", "favorite:Deploy"],
      allIssues: [
        issue("DR-1", "Add tests", "In Progress"),
        issue("DR-2", "Fix login", "Done"),
        issue("OPS-8", "Rotate keys", "In Progress"),
        issue("OPS-9", "Patch server", "Done"),
        favoriteIssue("Deploy"),
      ],
      createdKeys: new Set(),
      projectMap: { DR: "100", OPS: "200" },
      defaultProject: null,
      favorites: [{ text: "Deploy", project: "200" }],
    });
    expect(submitEntries).toEqual([
      {
        project: "200",
        hours: 5,
        summary:
          "• Deploy\n\n[Done]\n• OPS-9: Patch server\n\n" +
          "[In Progress]\n• OPS-8: Rotate keys",
      },
      {
        project: "100",
        hours: 3,
        summary:
          "[Done]\n• DR-2: Fix login\n\n[In Progress]\n• DR-1: Add tests",
      },
    ]);
  });

  it("routes a favorite by its own portal project, not through project_map", () => {
    // "Deploy" carries a project the map has no entry for and its text is not
    // a project key at all: a favorite names its portal project directly.
    const { submitEntries } = buildSubmission({
      selectedKeys: ["DR-1", "favorite:Deploy"],
      allIssues: [
        issue("DR-1", "Add tests", "In Progress"),
        favoriteIssue("Deploy"),
      ],
      createdKeys: new Set(),
      projectMap: { DR: "100" },
      defaultProject: null,
      favorites: [{ text: "Deploy", project: "300" }],
    });
    expect(submitEntries).toEqual([
      {
        project: "100",
        hours: 4,
        summary: "[In Progress]\n• DR-1: Add tests",
      },
      { project: "300", hours: 4, summary: "• Deploy" },
    ]);
  });

  it("treats a favorite left on the portal's blank option as having no project", () => {
    const { submitEntries } = buildSubmission({
      selectedKeys: ["favorite:Standup"],
      allIssues: [favoriteIssue("Standup")],
      createdKeys: new Set(),
      projectMap: {},
      defaultProject: "100",
      favorites: [{ text: "Standup", project: "" }],
    });
    expect(submitEntries).toEqual([
      { project: "100", hours: 8, summary: "• Standup" },
    ]);
  });

  it("puts unmapped tasks in the default project's bucket, joining its mapped bucket", () => {
    const { submitEntries } = buildSubmission({
      selectedKeys: ["DR-1", "XX-5", "favorite:Standup"],
      allIssues: [
        issue("DR-1", "Add tests", "In Progress"),
        issue("XX-5", "Unmapped work", "Done"),
        favoriteIssue("Standup"),
      ],
      createdKeys: new Set(),
      projectMap: { DR: "100" },
      defaultProject: "100",
      favorites: [{ text: "Standup", project: null }],
    });
    expect(submitEntries).toEqual([
      {
        project: "100",
        hours: 8,
        summary:
          "• Standup\n\n[Done]\n• XX-5: Unmapped work\n\n" +
          "[In Progress]\n• DR-1: Add tests",
      },
    ]);
  });

  it("merges unmapped tasks into row 1 when no default project is set", () => {
    const { submitEntries } = buildSubmission({
      selectedKeys: ["DR-1", "XX-5", "favorite:Standup"],
      allIssues: [
        issue("DR-1", "Add tests", "In Progress"),
        issue("XX-5", "Unmapped work", "Done"),
        favoriteIssue("Standup"),
      ],
      createdKeys: new Set(),
      projectMap: { DR: "100" },
      defaultProject: null,
      favorites: [{ text: "Standup", project: null }],
    });
    expect(submitEntries).toEqual([
      {
        project: "100",
        hours: 8,
        summary:
          "• Standup\n\n[Done]\n• XX-5: Unmapped work\n\n" +
          "[In Progress]\n• DR-1: Add tests",
      },
    ]);
  });

  it("counts unmapped tasks toward row 1's share when rows compete", () => {
    const { submitEntries } = buildSubmission({
      selectedKeys: ["A-1", "B-1", "XX-1"],
      allIssues: [
        issue("A-1", "Mapped to row 1", "Done"),
        issue("B-1", "Mapped to row 2", "Done"),
        issue("XX-1", "Unmapped work", "Done"),
      ],
      createdKeys: new Set(),
      projectMap: { A: "1", B: "2" },
      defaultProject: null,
      favorites: [],
    });

    expect(
      submitEntries.map(({ project, hours }) => ({ project, hours })),
    ).toEqual([
      { project: "1", hours: 5.5 },
      { project: "2", hours: 2.5 },
    ]);
  });

  it("merges buckets past the 3 form rows into row 3", () => {
    // 3 mapped buckets + a distinct default-project bucket = 4 buckets.
    const { submitEntries } = buildSubmission({
      selectedKeys: ["A-1", "A-2", "A-3", "B-1", "B-2", "C-1", "XX-1"],
      allIssues: [
        issue("A-1", "a1", "Done"),
        issue("A-2", "a2", "Done"),
        issue("A-3", "a3", "Done"),
        issue("B-1", "b1", "Done"),
        issue("B-2", "b2", "Done"),
        issue("C-1", "c1", "Done"),
        issue("XX-1", "x1", "Done"),
      ],
      createdKeys: new Set(),
      projectMap: { A: "1", B: "2", C: "3" },
      defaultProject: "4",
      favorites: [],
    });
    expect(submitEntries).toEqual([
      {
        project: "1",
        hours: 3.5,
        summary: "[Done]\n• A-1: a1\n• A-2: a2\n• A-3: a3",
      },
      { project: "2", hours: 2.5, summary: "[Done]\n• B-1: b1\n• B-2: b2" },
      { project: "3", hours: 2, summary: "[Done]\n• C-1: c1\n• XX-1: x1" },
    ]);
  });
});

const daysAgo = (dayCount: number) => `${dayCount} days ago`;

describe("getDateRelation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps 0/1/7+ day differences to the given sentinels", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));
    expect(
      getDateRelation("2026-07-24", "en", "today", "yesterday", daysAgo),
    ).toBe("today");
    expect(
      getDateRelation("2026-07-23", "en", "today", "yesterday", daysAgo),
    ).toBe("yesterday");
    expect(
      getDateRelation("2026-07-14", "en", "today", "yesterday", daysAgo),
    ).toBe("10 days ago");
  });

  it("returns null for malformed or future dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));
    expect(
      getDateRelation("not-a-date", "en", "today", "yesterday", daysAgo),
    ).toBeNull();
    expect(
      getDateRelation("2026-07-25", "en", "today", "yesterday", daysAgo),
    ).toBeNull();
  });
});

describe("buildIssueGroups", () => {
  it("keeps base group order and drops empty groups", () => {
    const groups = buildIssueGroups(
      {
        status: [issue("DR-1", "Add tests", "In Progress")],
        created: [],
        sprint: [issue("DR-2", "Fix login", "To Do")],
        favorite: [],
      },
      new Set(["status"]),
    );
    expect(
      groups.map((group) => ({
        id: group.id,
        keys: group.issues.map((i) => i.key),
      })),
    ).toEqual([
      { id: "status", keys: ["DR-1"] },
      { id: "sprint", keys: ["DR-2"] },
    ]);
  });

  it("renders default groups first, base order within each partition", () => {
    const groups = buildIssueGroups(
      {
        status: [issue("DR-1", "Add tests", "In Progress")],
        created: [issue("DR-2", "Fix login", "To Do")],
        sprint: [issue("DR-3", "Ship report", "To Do")],
        favorite: [],
      },
      new Set(["sprint"]),
    );
    expect(groups.map((group) => group.id)).toEqual([
      "sprint",
      "status",
      "created",
    ]);
  });

  it("dedups by key in display order: duplicates land in the first visible group", () => {
    const groups = buildIssueGroups(
      {
        status: [
          issue("DR-1", "Add tests", "In Progress"),
          issue("DR-2", "Fix login", "Done"),
        ],
        created: [],
        sprint: [issue("DR-1", "Add tests", "In Progress")],
        favorite: [],
      },
      new Set(["sprint"]),
    );
    expect(
      groups.map((group) => ({
        id: group.id,
        keys: group.issues.map((i) => i.key),
      })),
    ).toEqual([
      { id: "sprint", keys: ["DR-1"] },
      { id: "status", keys: ["DR-2"] },
    ]);
  });
});

describe("defaultCheckedKeysOf", () => {
  it("checks the post-dedup keys of displayed default groups only", () => {
    const defaultGroupIds = new Set<"sprint">(["sprint"]);
    const groups = buildIssueGroups(
      {
        status: [
          issue("DR-1", "Add tests", "In Progress"),
          issue("DR-2", "Fix login", "Done"),
        ],
        created: [],
        sprint: [issue("DR-1", "Add tests", "In Progress")],
        favorite: [],
      },
      defaultGroupIds,
    );
    expect(defaultCheckedKeysOf(groups, defaultGroupIds)).toEqual(
      new Set(["DR-1"]),
    );
  });
});

describe("buildJqlForDate", () => {
  // Asserted verbatim: these strings are both what Jira runs and what the
  // group tooltips display, so a silent edit to either is a behavior change.
  // The status window is spelled out to the minute on purpose: JQL DURING is
  // inclusive at both ends, so handing it the next day would cover 48 hours
  // and make consecutive cards show each other's transitions.
  it("bounds every query by the date inclusive and the next day exclusive", () => {
    expect(buildJqlForDate("2026-07-20")).toEqual({
      status:
        'status CHANGED BY currentUser() DURING ("2026-07-20 00:00", "2026-07-20 23:59")',
      created:
        'creator = currentUser() AND created >= "2026-07-20" AND created < "2026-07-21"',
      sprint:
        'assignee = currentUser() AND created < "2026-07-21" AND sprint in openSprints() AND statusCategory = "In Progress"',
    });
  });
});

describe("jqlFor", () => {
  const jqlByGroup = buildJqlForDate("2026-07-20");

  it("returns the query each Jira-backed group was built from", () => {
    expect(jqlFor(jqlByGroup, "status")).toBe(jqlByGroup.status);
    expect(jqlFor(jqlByGroup, "created")).toBe(jqlByGroup.created);
    expect(jqlFor(jqlByGroup, "sprint")).toBe(jqlByGroup.sprint);
  });

  it("has nothing to show for favorites, which are local", () => {
    expect(jqlFor(jqlByGroup, "favorite")).toBeUndefined();
  });
});

describe("favoritesAsIssues", () => {
  it("prefixes keys so favorites can never collide with a Jira key", () => {
    const [favorite] = favoritesAsIssues([{ text: "Standup", project: "200" }]);
    expect(favorite?.key).toBe(`${FAVORITE_KEY_PREFIX}Standup`);
    expect(favorite?.fields.summary).toBe("Standup");
  });

  it("leaves the status blank, so a leaked favorite can't form a status block", () => {
    expect(
      favoritesAsIssues([{ text: "Standup", project: null }])[0]?.fields.status
        .name,
    ).toBe("");
  });

  it("keeps insertion order", () => {
    expect(
      favoritesAsIssues([
        { text: "Standup", project: null },
        { text: "Code review", project: null },
      ]).map((asIssue) => asIssue.fields.summary),
    ).toEqual(["Standup", "Code review"]);
  });
});

describe("toOptionItems", () => {
  it("labels Jira issues 'KEY: summary' and sorts them by key", () => {
    expect(
      toOptionItems({
        id: "status",
        issues: [
          issue("DR-9", "Ship report", "Done"),
          issue("DR-1", "Add tests", "In Progress"),
        ],
      }),
    ).toEqual([
      { value: "DR-1", label: "DR-1: Add tests" },
      { value: "DR-9", label: "DR-9: Ship report" },
    ]);
  });

  it("shows favorites as bare text in the order they were added", () => {
    expect(
      toOptionItems({
        id: "favorite",
        issues: favoritesAsIssues([
          { text: "Standup", project: null },
          { text: "Code review", project: null },
        ]),
      }),
    ).toEqual([
      { value: `${FAVORITE_KEY_PREFIX}Standup`, label: "Standup" },
      { value: `${FAVORITE_KEY_PREFIX}Code review`, label: "Code review" },
    ]);
  });
});
