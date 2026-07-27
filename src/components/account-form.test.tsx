import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import AccountForm from "@/components/account-form";
import { useTaskParameters } from "@/lib/queries";
import type { Account } from "@/lib/store";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

// The Jira half of the parallel verification is a plugin-http fetch; mock the
// module like queries.test.ts and set a response per test (clearMocks in
// setup.ts resets the Tauri IPC, not vi mocks, so re-arm both each test).
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

async function setJira(init: { status?: number; loginReason?: string } = {}) {
  const { fetch } = await import("@tauri-apps/plugin-http");
  vi.mocked(fetch).mockResolvedValue(
    new Response("{}", {
      status: init.status ?? 200,
      headers: init.loginReason
        ? { "x-seraph-loginreason": init.loginReason }
        : {},
    }),
  );
}

// verify_portal_login is a backend command: "ok" resolves, "fail" rejects with
// a portal error string, and a Promise keeps it in flight (pending-state test).
type PortalBehavior = "ok" | "fail" | Promise<unknown>;

function setup(
  opts: {
    account?: Account;
    portal?: PortalBehavior;
    closeError?: string;
  } = {},
) {
  const portal = opts.portal ?? "ok";
  const saved: Account[] = [];
  const invoked: string[] = [];
  mockTauri(opts.account ? { account: opts.account } : {}, (cmd, args) => {
    invoked.push(cmd);
    if (cmd === "plugin:store|set") {
      const entry = args as { key: string; value: unknown };
      if (entry.key === "account") saved.push(entry.value as Account);
      return undefined;
    }
    if (cmd === "verify_portal_login") {
      if (portal === "fail") return Promise.reject("portal login failed");
      if (portal !== "ok") return portal;
      return undefined;
    }
    if (cmd === "close_browsers" && opts.closeError) {
      return Promise.reject(opts.closeError);
    }
    if (cmd === "get_task_parameters") {
      return { dates: [], leaves: [], projects: [] };
    }
    return undefined;
  });
  return { saved, invoked };
}

// Observes the task_parameters query so an invalidation triggers a refetch we
// can count via the get_task_parameters invoke.
function TaskParamsProbe() {
  useTaskParameters();
  return null;
}

// Fields are addressed by `account-<field name>` testids rather than their
// labels: every label is a lingui message, so label-text queries would break
// on a copy or catalog edit. The field names are the store schema's, which the
// test already asserts on.
const field = (name: keyof Account) => `account-${name}`;

// The dialog opens itself on mount (account is undefined on first render), so
// the fields are present without clicking the trigger.
async function renderForm() {
  await renderWithProviders(<AccountForm />);
  await screen.findByTestId(field("portal_url"));
}

async function fillField(name: keyof Account, value: string) {
  const input = screen.getByTestId(field(name));
  // clear first: with a stored account, TanStack Form reconciles its values
  // into the pristine fields, so typing would otherwise append to them
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

async function fillValidFields(overrides: Partial<Account> = {}) {
  const values: Account = {
    portal_url: "https://portal.example.com",
    portal_credential: "user:pass",
    phone: "0812345678",
    email: "user@example.com",
    api_token: "token",
    ...overrides,
  };
  await fillField("portal_url", values.portal_url);
  await fillField("portal_credential", values.portal_credential);
  await fillField("phone", values.phone);
  await fillField("email", values.email);
  await fillField("api_token", values.api_token);
}

function saveButton() {
  return screen.getByTestId("account-save");
}

async function submit() {
  await waitFor(() => expect(saveButton()).toBeEnabled());
  await userEvent.click(saveButton());
}

it("verifies, saves the normalized account, and closes on success", async () => {
  const { saved, invoked } = setup();
  await setJira();
  await renderForm();
  // trailing slash is stripped by normalizePortalUrl on submit
  await fillValidFields({ portal_url: "https://portal.example.com/" });
  await submit();

  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toEqual({
    portal_url: "https://portal.example.com",
    portal_credential: "user:pass",
    phone: "0812345678",
    email: "user@example.com",
    api_token: "token",
  });
  await waitFor(() =>
    expect(screen.queryByTestId(field("portal_url"))).not.toBeInTheDocument(),
  );
  // fresh install: no previous account cached, so no browser teardown
  expect(invoked).not.toContain("close_browsers");
});

it("lists both failed checks, saves nothing, and offers Save anyway", async () => {
  const { saved } = setup({ portal: "fail" });
  await setJira({ status: 401 });
  await renderForm();
  await fillValidFields();
  await submit();

  // "Portal:"/"Jira:" are VerifyAccountError's own untranslated line prefixes,
  // and "portal login failed" is this test's stubbed backend reason. The Jira
  // failure text itself is a lingui message, so only its presence is asserted.
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/Portal: portal login failed/);
  expect(alert).toHaveTextContent(/Jira:/);
  expect(saved).toEqual([]);
  expect(screen.getByTestId("account-save-anyway")).toBeInTheDocument();
});

it("lists only the check that failed when the other passes", async () => {
  const { saved } = setup({ portal: "fail" });
  await setJira(); // Jira authenticates
  await renderForm();
  await fillValidFields();
  await submit();

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/Portal: portal login failed/);
  expect(alert).not.toHaveTextContent(/Jira:/);
  expect(saved).toEqual([]);
});

it("saves via Save anyway without a passing verification", async () => {
  const { saved } = setup({ portal: "fail" });
  await setJira({ status: 401 });
  await renderForm();
  await fillValidFields();
  await submit();

  await screen.findByRole("alert");
  expect(saved).toEqual([]);
  await userEvent.click(screen.getByTestId("account-save-anyway"));

  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toMatchObject({
    portal_url: "https://portal.example.com",
    email: "user@example.com",
  });
  await waitFor(() =>
    expect(screen.queryByTestId(field("portal_url"))).not.toBeInTheDocument(),
  );
});

it("shows Verifying… and disables Save while the checks are in flight", async () => {
  let resolvePortal!: () => void;
  const portalGate = new Promise<void>((resolve) => {
    resolvePortal = () => resolve();
  });
  const { saved } = setup({ portal: portalGate });
  await setJira();
  await renderForm();
  await fillValidFields();
  await submit();

  // data-pending, not the "Verifying…" label, which is translated copy
  await waitFor(() => expect(saveButton()).toHaveAttribute("data-pending"));
  expect(saveButton()).toBeDisabled();
  expect(saved).toEqual([]);

  resolvePortal();
  await waitFor(() => expect(saved).toHaveLength(1));
});

it("tears down browsers and refreshes task parameters on save with an existing account", async () => {
  const existingAccount: Account = {
    phone: "0899999999",
    email: "old@example.com",
    api_token: "old-token",
    portal_url: "https://old.example.com",
    portal_credential: "old:pass",
  };
  const { saved, invoked } = setup({ account: existingAccount });
  await setJira();
  await renderWithProviders(
    <>
      <AccountForm />
      <TaskParamsProbe />
    </>,
  );
  await screen.findByTestId(field("portal_url"));
  // the probe fetches task parameters once the stored account resolves
  const taskParamCalls = () =>
    invoked.filter((c) => c === "get_task_parameters").length;
  await waitFor(() => expect(taskParamCalls()).toBe(1));

  await fillValidFields();
  await submit();

  await waitFor(() => expect(saved).toHaveLength(1));
  // a previous account was cached, so the member-switch teardown runs...
  expect(invoked).toContain("close_browsers");
  expect(invoked.indexOf("close_browsers")).toBeLessThan(
    invoked.indexOf("plugin:store|set"),
  );
  // ...and invalidating task_parameters refetches through the probe
  await waitFor(() => expect(taskParamCalls()).toBeGreaterThanOrEqual(2));
});

it("does not save a replacement account while an old browser is busy", async () => {
  const existingAccount: Account = {
    phone: "0899999999",
    email: "old@example.com",
    api_token: "old-token",
    portal_url: "https://old.example.com",
    portal_credential: "old:pass",
  };
  const { saved, invoked } = setup({
    account: existingAccount,
    closeError:
      "The headed browser is busy; wait for the current browser action to finish",
  });
  await setJira();
  await renderForm();
  await fillValidFields();

  await submit();
  await waitFor(() => expect(invoked).toContain("close_browsers"));

  expect(saved).toEqual([]);
  expect(invoked).not.toContain("plugin:store|set");
});
