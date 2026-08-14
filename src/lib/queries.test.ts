import { beforeAll, describe, expect, it, vi } from "vitest";

import { activateLocale } from "@/lib/i18n";
import {
  favoritesOptions,
  jiraTasksQueryOptions,
  preferencesOptions,
  verifyJiraCredentials,
} from "@/lib/queries";
import {
  type Account,
  DEFAULT_PREFERENCES,
  type Favorite,
  type Preferences,
} from "@/lib/store";
import { mockTauri } from "@/test/tauri";

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

async function mockJiraResponse(
  body: unknown,
  init: { status?: number; loginReason?: string } = {},
) {
  const { fetch } = await import("@tauri-apps/plugin-http");
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: init.loginReason
        ? { "x-seraph-loginreason": init.loginReason }
        : {},
    }),
  );
}

const account: Account = {
  phone: "0812345678",
  email: "user@example.com",
  api_token: "token",
  portal_url: "https://portal.example.com",
  portal_credential: "user:pass",
};

const runJiraQuery = (acc: Account | null) =>
  (
    jiraTasksQueryOptions("project = DR", acc).queryFn as () => Promise<{
      issues: unknown[];
    }>
  )();

// The queryFns ignore their react-query context argument, so call them bare.
const readPreferences = () =>
  (preferencesOptions().queryFn as () => Promise<Preferences>)();
const readFavorites = () =>
  (favoritesOptions().queryFn as () => Promise<Favorite[]>)();

describe("preferencesOptions", () => {
  it("returns full defaults when no preferences were ever saved", async () => {
    mockTauri({});
    await expect(readPreferences()).resolves.toEqual(DEFAULT_PREFERENCES);
  });

  it("merges stored values over defaults field-by-field, upgrading old stores", async () => {
    // A store saved before project_map/auto_close existed: only some fields.
    mockTauri({
      preferences: { default_project: "42", autofill_summary: false },
    });
    await expect(readPreferences()).resolves.toEqual({
      ...DEFAULT_PREFERENCES,
      default_project: "42",
      autofill_summary: false,
    });
  });
});

describe("favoritesOptions", () => {
  it("returns an empty list when the key predates the store", async () => {
    mockTauri({});
    await expect(readFavorites()).resolves.toEqual([]);
  });

  it("normalizes legacy strings and drops the superseded project_key tag", async () => {
    // A store written across all three shapes: a bare string, a favorite
    // tagged with the old project key (which routed through project_map), and
    // one carrying its own portal project.
    mockTauri({
      favorites: [
        "Standup",
        { text: "Deploy", project_key: "OPS" },
        { text: "Review", project: "200" },
      ],
    });
    await expect(readFavorites()).resolves.toEqual([
      { text: "Standup", project: null },
      { text: "Deploy", project: null },
      { text: "Review", project: "200" },
    ]);
  });
});

describe("jiraTasksQueryOptions auth-failure detection", () => {
  beforeAll(async () => {
    await activateLocale("en");
  });

  it("throws on 200 responses flagged by x-seraph-loginreason", async () => {
    // Jira Cloud falls back to anonymous access for bad credentials: 200
    // with zero issues, failure flagged only via this header.
    await mockJiraResponse(
      { issues: [] },
      { loginReason: "AUTHENTICATED_FAILED" },
    );
    await expect(runJiraQuery(account)).rejects.toThrow(
      "Jira authentication failed (AUTHENTICATED_FAILED)",
    );
  });

  it("resolves when the header is absent or OK", async () => {
    await mockJiraResponse({ issues: [{ key: "DR-1" }] });
    await expect(runJiraQuery(account)).resolves.toEqual({
      issues: [{ key: "DR-1" }],
    });
    await mockJiraResponse({ issues: [] }, { loginReason: "OK" });
    await expect(runJiraQuery(account)).resolves.toEqual({ issues: [] });
  });

  it("surfaces Jira errorMessages on non-auth failures", async () => {
    await mockJiraResponse(
      { errorMessages: ["The JQL query is invalid."] },
      { status: 400 },
    );
    await expect(runJiraQuery(account)).rejects.toThrow(
      "Jira: The JQL query is invalid.",
    );
  });

  it("throws before fetching when no account is set", async () => {
    await expect(runJiraQuery(null)).rejects.toThrow("No account has been set");
  });
});

describe("verifyJiraCredentials", () => {
  beforeAll(async () => {
    await activateLocale("en");
  });

  it("rejects when the login-reason header flags a failure", async () => {
    await mockJiraResponse({}, { loginReason: "AUTHENTICATED_FAILED" });
    await expect(
      verifyJiraCredentials("user@example.com", "bad"),
    ).rejects.toThrow("Jira authentication failed (AUTHENTICATED_FAILED)");
  });

  it("rejects on 401 with a credentials message", async () => {
    await mockJiraResponse({}, { status: 401 });
    await expect(
      verifyJiraCredentials("user@example.com", "bad"),
    ).rejects.toThrow("check your Jira email and API token");
  });

  it("resolves on an authenticated 200", async () => {
    await mockJiraResponse({ accountId: "abc" });
    await expect(
      verifyJiraCredentials("user@example.com", "good"),
    ).resolves.toBeUndefined();
  });
});
