import { i18n } from "@lingui/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import DateCard from "@/components/date-card";
import type { SubmitTaskEntry } from "@/lib/mutations";
import type { Account, Favorite, Preferences } from "@/lib/store";
import { TASK_GROUPS } from "@/lib/task-groups";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";
import type { JiraIssue } from "@/type";

// The three per-date Jira queries all go through the same plugin-http fetch;
// dispatch by JQL substring (each query's clause is unique). The exact
// end-to-end signal is the captured submit_task payload, since the combobox
// popups are portaled/closed — group labels stay visible regardless.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

function issue(key: string, summary: string, status: string): JiraIssue {
  return {
    id: key,
    key,
    fields: { summary, updated: "", duedate: "", status: { name: status } },
  };
}

const STATUS_ISSUES = [
  issue("DR-1", "Fix login bug", "In Progress"),
  issue("DR-3", "Deploy", "Done"),
];
const CREATED_ISSUES = [issue("DR-2", "New ticket", "To Do")];
const SPRINT_ISSUES = [issue("DR-4", "Refactor module", "In Progress")];
// STATUS_ISSUES formatted by buildSummary (statuses then keys sorted).
const STATUS_SUMMARY =
  "[Done]\n• DR-3: Deploy\n\n[In Progress]\n• DR-1: Fix login bug";

const ACCOUNT: Account = {
  phone: "0812345678",
  email: "user@example.com",
  api_token: "token",
  portal_url: "https://portal.example.com",
  portal_credential: "user:pass",
};

function whichQuery(jql: string): "status" | "created" | "sprint" | "unknown" {
  if (jql.includes("CHANGED BY")) return "status";
  if (jql.includes("creator =")) return "created";
  if (jql.includes("openSprints")) return "sprint";
  return "unknown";
}

// queries.ts always sends a JSON string body; narrow it (not String(), which
// would stringify a non-string BodyInit to "[object Object]").
function whichQueryOf(init?: RequestInit) {
  const body = typeof init?.body === "string" ? init.body : "{}";
  return whichQuery((JSON.parse(body) as { jql: string }).jql);
}

type JiraSets = {
  status?: JiraIssue[];
  created?: JiraIssue[];
  sprint?: JiraIssue[];
  // which query should fail with a 400 + errorMessages
  error?: "status" | "created" | "sprint";
};

async function setJira(sets: JiraSets) {
  const { fetch } = await import("@tauri-apps/plugin-http");
  vi.mocked(fetch).mockImplementation((_url, init) => {
    const which = whichQueryOf(init);
    if (sets.error === which) {
      return Promise.resolve(
        new Response(JSON.stringify({ errorMessages: ["Bad JQL"] }), {
          status: 400,
        }),
      );
    }
    const issues =
      which === "status"
        ? (sets.status ?? [])
        : which === "created"
          ? (sets.created ?? [])
          : (sets.sprint ?? []);
    return Promise.resolve(
      new Response(JSON.stringify({ issues }), { status: 200 }),
    );
  });
}

type SubmitCall = { date: string; entries: SubmitTaskEntry[] };

function setup(
  opts: { preferences?: Partial<Preferences>; favorites?: Favorite[] } = {},
) {
  const submitCalls: SubmitCall[] = [];
  mockTauri(
    {
      account: ACCOUNT,
      preferences: opts.preferences ?? {},
      favorites: opts.favorites ?? [],
    },
    (cmd, args) => {
      if (cmd === "submit_task") {
        submitCalls.push(args as SubmitCall);
      }
      return undefined;
    },
  );
  return submitCalls;
}

const DATE = "2026-07-20";

async function renderCard(date = DATE) {
  await renderWithProviders(<DateCard date={date} />);
}

// Groups, the submit button and the "(all selected)" marker are addressed by
// data-testid: their visible labels are lingui messages, so querying them by
// text would break on a copy or catalog edit. Jira issue text and error text
// are data, not copy, so those stay asserted by text.
//
// Every inner testid is scoped through the card's own, since DateList renders
// one card per date and they would otherwise collide across cards.
function card(date = DATE) {
  return within(screen.getByTestId(`date-card-${date}`));
}

function playButton() {
  return card().getByTestId("submit-task");
}

it("renders a group per non-empty source and drops empty groups", async () => {
  setup();
  await setJira({
    status: STATUS_ISSUES,
    created: CREATED_ISSUES,
    sprint: SPRINT_ISSUES,
  });
  await renderCard();

  expect(await card().findByTestId("task-group-status")).toBeInTheDocument();
  expect(card().getByTestId("task-group-created")).toBeInTheDocument();
  expect(card().getByTestId("task-group-sprint")).toBeInTheDocument();
  // no favorites configured, so the favorites group is dropped
  expect(card().queryByTestId("task-group-favorite")).not.toBeInTheDocument();
});

it("explains each group in a tooltip, with the JQL it actually ran", async () => {
  setup({ favorites: [{ text: "Standup", project: null }] });
  await setJira({
    status: STATUS_ISSUES,
    created: CREATED_ISSUES,
    sprint: SPRINT_ISSUES,
  });
  await renderCard();

  // The JQL is data, not copy, so it is asserted verbatim — this is what
  // catches a tooltip drifting from the query the group was built from. The
  // tooltip is portaled outside the card, hence the unscoped screen queries
  // (and base-ui's popup carries no role to query it by).
  await userEvent.hover(await card().findByTestId("task-group-status-info"));
  expect(
    await screen.findByText(
      `status CHANGED BY currentUser() DURING ("${DATE} 00:00", "${DATE} 23:59")`,
    ),
  ).toBeInTheDocument();
  await userEvent.unhover(card().getByTestId("task-group-status-info"));

  // Favorites aren't Jira-backed, so their tooltip carries no JQL. The
  // description is read back through TASK_GROUPS rather than hardcoded, so it
  // stays a copy-independent signal that the tooltip opened at all.
  await userEvent.hover(card().getByTestId("task-group-favorite-info"));
  const favoriteGroup = TASK_GROUPS.find((group) => group.type === "favorite")!;
  expect(
    await screen.findByText(i18n._(favoriteGroup.description)),
  ).toBeInTheDocument();
  expect(screen.queryByText(/currentUser\(\)/)).not.toBeInTheDocument();
});

it("default-checks only the status group and submits its issues", async () => {
  const submitCalls = setup();
  await setJira({
    status: STATUS_ISSUES,
    created: CREATED_ISSUES,
    sprint: SPRINT_ISSUES,
  });
  await renderCard();

  await card().findByTestId("task-group-status");
  await waitFor(() => expect(playButton()).toBeEnabled());
  // only the status group is fully checked by default
  expect(
    card().getByTestId("task-group-status-all-selected"),
  ).toBeInTheDocument();
  expect(
    card().queryByTestId("task-group-created-all-selected"),
  ).not.toBeInTheDocument();

  await userEvent.click(playButton());
  await waitFor(() => expect(submitCalls).toHaveLength(1));
  expect(submitCalls[0]).toEqual({
    date: DATE,
    entries: [{ project: null, summary: STATUS_SUMMARY, hours: 8 }],
  });
});

it("submits one empty row when autofill_summary is off", async () => {
  const submitCalls = setup({ preferences: { autofill_summary: false } });
  await setJira({
    status: STATUS_ISSUES,
    created: CREATED_ISSUES,
    sprint: SPRINT_ISSUES,
  });
  await renderCard();

  await card().findByTestId("task-group-status");
  await waitFor(() => expect(playButton()).toBeEnabled());
  await userEvent.click(playButton());

  await waitFor(() => expect(submitCalls).toHaveLength(1));
  expect(submitCalls[0]).toEqual({
    date: DATE,
    entries: [{ project: null, summary: "", hours: 8 }],
  });
});

it("routes the submission through project_map", async () => {
  const submitCalls = setup({ preferences: { project_map: { DR: "10" } } });
  await setJira({
    status: STATUS_ISSUES,
    created: CREATED_ISSUES,
    sprint: SPRINT_ISSUES,
  });
  await renderCard();

  await card().findByTestId("task-group-status");
  await waitFor(() => expect(playButton()).toBeEnabled());
  await userEvent.click(playButton());

  await waitFor(() => expect(submitCalls).toHaveLength(1));
  expect(submitCalls[0]!.entries).toEqual([
    { project: "10", summary: STATUS_SUMMARY, hours: 8 },
  ]);
});

it("renders favorites and leads the summary with favorite bullets", async () => {
  const submitCalls = setup({
    preferences: { default_task_groups: ["status", "favorite"] },
    favorites: [{ text: "Standup", project: null }],
  });
  await setJira({
    status: STATUS_ISSUES,
    created: CREATED_ISSUES,
    sprint: SPRINT_ISSUES,
  });
  await renderCard();

  expect(await card().findByTestId("task-group-favorite")).toBeInTheDocument();
  await waitFor(() => expect(playButton()).toBeEnabled());
  await userEvent.click(playButton());

  await waitFor(() => expect(submitCalls).toHaveLength(1));
  expect(submitCalls[0]!.entries).toEqual([
    { project: null, summary: `• Standup\n\n${STATUS_SUMMARY}`, hours: 8 },
  ]);
});

it("surfaces a failed Jira query in the card", async () => {
  setup();
  await setJira({ status: STATUS_ISSUES, error: "created" });
  await renderCard();

  // the Jira error text is data, not copy — assert it inside the alert region
  expect(await card().findByRole("alert")).toHaveTextContent(/Bad JQL/);
});

it("shows a spinner and disables submit while a query is in flight", async () => {
  setup();
  let resolveSprint!: (r: Response) => void;
  const sprintGate = new Promise<Response>((resolve) => {
    resolveSprint = resolve;
  });
  const { fetch } = await import("@tauri-apps/plugin-http");
  vi.mocked(fetch).mockImplementation((_url, init) => {
    const which = whichQueryOf(init);
    if (which === "sprint") return sprintGate;
    const issues = which === "status" ? STATUS_ISSUES : [];
    return Promise.resolve(
      new Response(JSON.stringify({ issues }), { status: 200 }),
    );
  });
  await renderCard();

  // isFetching gates the submit button and shows the content spinner
  await waitFor(() => expect(playButton()).toBeDisabled());
  expect(document.querySelector(".animate-spin")).toBeTruthy();

  resolveSprint(
    new Response(JSON.stringify({ issues: SPRINT_ISSUES }), { status: 200 }),
  );
  await waitFor(() => expect(playButton()).toBeEnabled());
});

it("toggling a created issue on adds it as [Created] to the submission", async () => {
  const submitCalls = setup();
  await setJira({ status: STATUS_ISSUES, created: CREATED_ISSUES, sprint: [] });
  await renderCard();

  await card().findByTestId("task-group-created");
  await waitFor(() => expect(playButton()).toBeEnabled());

  // open the created group's combobox and check DR-2
  await userEvent.click(card().getByTestId("task-group-created-input"));
  const option = await screen.findByRole("option", {
    name: /DR-2.*New ticket/,
  });
  await userEvent.click(option);
  await userEvent.keyboard("{Escape}");

  await userEvent.click(playButton());
  await waitFor(() => expect(submitCalls).toHaveLength(1));
  expect(submitCalls[0]!.entries).toEqual([
    {
      project: null,
      summary: `[Created]\n• DR-2: New ticket\n\n${STATUS_SUMMARY}`,
      hours: 8,
    },
  ]);
});
