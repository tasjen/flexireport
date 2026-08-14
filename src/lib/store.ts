import { LazyStore } from "@tauri-apps/plugin-store";

// Schema of store.json. The Rust backend reads the same keys
// (src-tauri/src/lib.rs), so field names must stay in sync.
export type Account = {
  phone: string;
  email: string;
  api_token: string;
  // Portal base URL, stored without a trailing slash — the backend joins
  // paths as `format!("{base_url}/task.php")`.
  portal_url: string;
  // HTTP Basic-auth credential in "user:pass" form, encoded verbatim into
  // the Authorization header by the backend.
  portal_credential: string;
};

// A free-form favorite task. Frontend-only: the Rust side never reads this
// key. The text itself is the identity — the favorites dialog rejects
// duplicates, so no generated ids. `project` is a portal project option id
// picked straight from the favorites dialog's select, so a favorite names its
// portal project directly instead of routing through `project_map` the way a
// Jira issue key does; null routes it like an unmapped task (the default
// project's bucket when set, else the first form row). Older stores hold
// plain strings, or objects carrying the superseded `project_key` tag —
// `favoritesOptions` normalizes both to this shape at read time.
export type Favorite = { text: string; project: string | null };

export type TaskGroupType = "status" | "created" | "sprint" | "favorite";

export type Preferences = {
  default_project: string | null;
  project_list: string[];
  // Jira issue-key prefix (e.g. "ABC") → portal project option id. Favorites
  // are not routed through here — they carry their own portal project.
  // Selected tasks are bucketed by mapped portal project and each bucket
  // fills its own project-select/textarea row pair in the task form, largest
  // bucket first. The form has 3 row pairs, so the editor caps this at 3
  // distinct values.
  project_map: Record<string, string>;
  default_task_groups: TaskGroupType[];
  autofill_summary: boolean;
  auto_submit: boolean;
  auto_close: boolean;
};

// Fallback merged under whatever is persisted, so preferences saved before a
// field existed still come back with that field populated.
export const DEFAULT_PREFERENCES: Preferences = {
  default_project: null,
  project_list: [],
  project_map: {},
  default_task_groups: ["status"],
  autofill_summary: true,
  auto_submit: false,
  auto_close: false,
};

export const store = new LazyStore("store.json");
