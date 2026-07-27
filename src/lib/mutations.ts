import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import {
  accountOptions,
  favoritesOptions,
  preferencesOptions,
  taskParametersOptions,
  verifyJiraCredentials,
} from "./queries";
import { type Account, type Favorite, type Preferences, store } from "./store";
import { toastError } from "./utils";

// One project/comment row pair of the portal's task form. `project` is a
// portal project option id; null lets the backend fall back to the
// default_project preference (only meaningful on the first row).
export type SubmitTaskEntry = { project: string | null; summary: string };

export function useSubmitTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (arg: { date: string; entries: SubmitTaskEntry[] }) => {
      await invoke("submit_task", arg);
    },
    onSuccess: (_, arg) => {
      queryClient.setQueryData(taskParametersOptions().queryKey, (data) => {
        if (!data) return data;
        return {
          ...data,
          dates: data.dates.filter((e) => e.value !== arg.date),
        };
      });
    },
    onError: toastError,
  });
}

export class VerifyAccountError extends Error {
  failures: { portal?: string; jira?: string };

  constructor(failures: { portal?: string; jira?: string }) {
    super(
      [
        failures.portal && `Portal: ${failures.portal}`,
        failures.jira && `Jira: ${failures.jira}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    this.name = "VerifyAccountError";
    this.failures = failures;
  }
}

/**
 * Runs both credential checks in parallel against the *candidate* account
 * values — nothing is saved here, and nothing reads or writes the query
 * cache. The portal check is a real headless-browser login (backend
 * command); the Jira check is a cheap REST call. Throws VerifyAccountError
 * naming each failed check so the Account form can label the error lines.
 * No onError toast: the form shows the error in the dialog instead.
 */
export function useVerifyAccountMutation() {
  return useMutation({
    mutationFn: async (account: Account) => {
      const [portal, jira] = await Promise.allSettled([
        invoke("verify_portal_login", {
          portalUrl: account.portal_url,
          portalCredential: account.portal_credential,
          phone: account.phone,
        }),
        verifyJiraCredentials(account.email, account.api_token),
      ]);
      const failures: { portal?: string; jira?: string } = {};
      // invoke() rejects with the backend's serialized error string
      if (portal.status === "rejected") failures.portal = String(portal.reason);
      if (jira.status === "rejected") {
        failures.jira =
          jira.reason instanceof Error
            ? jira.reason.message
            : String(jira.reason);
      }
      if (failures.portal || failures.jira) {
        throw new VerifyAccountError(failures);
      }
    },
  });
}

export function useSaveAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (account: Account) => {
      const previous = queryClient.getQueryData(accountOptions().queryKey);
      // Reserve and close both old browser sessions before changing the
      // stored credentials. If either session is busy, the backend rejects
      // without closing either one and this mutation leaves the old account
      // intact, so stored credentials and authenticated sessions cannot drift.
      if (previous) {
        await invoke("close_browsers");
      }
      await store.set("account", account);
      await store.save();
      return account;
    },
    onSuccess: async (account) => {
      queryClient.setQueryData(accountOptions().queryKey, account);
      await queryClient.invalidateQueries(taskParametersOptions());
    },
    onError: toastError,
  });
}

export function useSavePreferencesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (preferences: Preferences) => {
      await store.set("preferences", preferences);
      await store.save();
      return preferences;
    },
    // Update the cache optimistically, not in onSuccess: consumers compute the
    // next preferences from the current ones, so a save that only lands in the
    // cache after store.save() resolves leaves a window where a quick second
    // edit reads stale data and silently reverts the first.
    onMutate: async (preferences) => {
      await queryClient.cancelQueries(preferencesOptions());
      const previous = queryClient.getQueryData(preferencesOptions().queryKey);
      queryClient.setQueryData(preferencesOptions().queryKey, preferences);
      return { previous };
    },
    onError: (error, _preferences, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          preferencesOptions().queryKey,
          context.previous,
        );
      }
      toastError(error);
    },
  });
}

export function useSaveFavoritesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (favorites: Favorite[]) => {
      await store.set("favorites", favorites);
      await store.save();
      return favorites;
    },
    // Optimistic for the same reason as preferences: consumers compute the
    // next array from the current one, so a late cache write would let rapid
    // edits clobber each other.
    onMutate: async (favorites) => {
      await queryClient.cancelQueries(favoritesOptions());
      const previous = queryClient.getQueryData(favoritesOptions().queryKey);
      queryClient.setQueryData(favoritesOptions().queryKey, favorites);
      return { previous };
    },
    onError: (error, _favorites, context) => {
      if (context?.previous) {
        queryClient.setQueryData(favoritesOptions().queryKey, context.previous);
      }
      toastError(error);
    },
  });
}
