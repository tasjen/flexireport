import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import {
  type Account,
  DEFAULT_PREFERENCES,
  type Favorite,
  type Preferences,
  store,
} from "@/lib/store";
import type { JiraIssue, SelectOption } from "@/type";

const JIRA_DOMAIN = "https://living-insider.atlassian.net";

export function accountOptions() {
  return queryOptions({
    // queryFn must not return undefined, so "no account yet" is null
    queryKey: ["account"],
    queryFn: async () => (await store.get<Account>("account")) ?? null,
  });
}

export function useAccount() {
  return useQuery(accountOptions());
}

export function preferencesOptions() {
  return queryOptions({
    queryKey: ["preferences"],
    // Per-field merge, not `??`: preferences persisted before a field was
    // added would otherwise come back missing that field.
    queryFn: async (): Promise<Preferences> => ({
      ...DEFAULT_PREFERENCES,
      ...(await store.get<Partial<Preferences>>("preferences")),
    }),
  });
}

export function usePreferences() {
  return useQuery(preferencesOptions());
}

export function favoritesOptions() {
  return queryOptions({
    // stores saved before the key existed return undefined, hence ?? [];
    // older favorites are plain strings, and the ones written while favorites
    // were tagged with a project key carry `project_key` instead of a portal
    // project. Both normalize to a project-less favorite, so a stale key can
    // never route a submission to a project the user never picked here; the
    // store upgrades on the next save.
    queryKey: ["favorites"],
    queryFn: async (): Promise<Favorite[]> =>
      (
        (await store.get<
          (string | { text: string; project?: string | null })[]
        >("favorites")) ?? []
      ).map((favorite) =>
        typeof favorite === "string"
          ? { text: favorite, project: null }
          : { text: favorite.text, project: favorite.project ?? null },
      ),
  });
}

export function useFavorites() {
  return useQuery(favoritesOptions());
}

export function taskParametersOptions() {
  return queryOptions({
    queryKey: ["task_parameters"],
    staleTime: Infinity,
    queryFn: async () => {
      const result = await invoke<{
        dates: SelectOption[];
        leaves: SelectOption[];
        projects: SelectOption[];
      }>("get_task_parameters");
      return result;
    },
    retry: false,
  });
}

export function useTaskParameters(
  options?: ReturnType<typeof taskParametersOptions>,
) {
  const { data: account } = useAccount();
  return useQuery({
    ...taskParametersOptions(),
    enabled: Boolean(account),
    ...options,
  });
}

/**
 * Checks that the Jira email + API token actually authenticate, via the cheap
 * `/myself` endpoint. Same failure detection as `jiraTasksQueryOptions`: Jira
 * Cloud may fall back to anonymous access instead of rejecting bad
 * credentials, flagging the failure only via the `x-seraph-loginreason`
 * header. Resolves on success, throws with a user-facing message otherwise.
 */
export async function verifyJiraCredentials(
  email: string,
  apiToken: string,
): Promise<void> {
  const res = await tauriFetch(`${JIRA_DOMAIN}/rest/api/3/myself`, {
    method: "GET",
    headers: {
      Authorization: `Basic ${btoa(`${email}:${apiToken}`)}`,
      Accept: "application/json",
    },
  });
  const loginReason = res.headers.get("x-seraph-loginreason");
  if (loginReason && loginReason !== "OK") {
    throw new Error(
      i18n._(
        msg`Jira authentication failed (${loginReason}) — check your Jira email and API token`,
      ),
    );
  }
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? i18n._(
            msg`Jira authentication failed — check your Jira email and API token`,
          )
        : i18n._(msg`Jira request failed (${res.status} ${res.statusText})`),
    );
  }
}

export function jiraTasksQueryOptions(jql: string, account?: Account | null) {
  return queryOptions({
    queryKey: ["jira_tasks", jql],
    staleTime: Infinity,
    queryFn: async () => {
      if (!account) throw new Error(i18n._(msg`No account has been set`));
      const EMAIL = account.email;
      const API_TOKEN = account.api_token;
      const res = await tauriFetch(`${JIRA_DOMAIN}/rest/api/3/search/jql`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${EMAIL}:${API_TOKEN}`)}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jql,
          fields: ["status", "updated", "summary", "duedate"],
          maxResults: 50,
        }),
      });
      // Jira Cloud does not reject bad credentials here — it silently falls
      // back to anonymous access and returns 200 with zero issues, flagging
      // the failure only via this header (verified against this instance).
      // Without the check, a wrong email/API token looks like a day with no
      // issues. Absent header or "OK" means authenticated.
      const loginReason = res.headers.get("x-seraph-loginreason");
      if (loginReason && loginReason !== "OK") {
        throw new Error(
          i18n._(
            msg`Jira authentication failed (${loginReason}) — check your Jira email and API token`,
          ),
        );
      }
      if (!res.ok) {
        // Non-auth failures (e.g. 400 from bad JQL) carry `errorMessages`
        // in the body; fall back to the HTTP status.
        const messages = await res
          .json()
          .then((body: { errorMessages?: string[] }) => body.errorMessages)
          .catch(() => undefined);
        throw new Error(
          messages?.length
            ? `Jira: ${messages.join("\n")}`
            : i18n._(
                msg`Jira request failed (${res.status} ${res.statusText})`,
              ),
        );
      }
      return res.json() as Promise<{ issues: JiraIssue[] }>;
    },
  });
}

export function useJiraTasksQuery(
  jql: string,
  options?: Partial<ReturnType<typeof jiraTasksQueryOptions>>,
) {
  const { data: account } = useAccount();
  return useQuery({
    ...jiraTasksQueryOptions(jql, account),
    enabled: Boolean(account),
    ...options,
  });
}
