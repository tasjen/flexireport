import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { TaskGroupType } from "@/lib/store";

// The task groups shown on each date card, in base priority order: three
// Jira-queried groups plus the user's saved favorites (local, free-form).
// Shared between DateCard (grouping/ordering) and the preferences form
// (default-selected checkboxes) so ids and labels stay in sync.
//
// `description` is the plain-English gloss of how the group is derived, shown
// in each TaskSelect's tooltip. For the Jira-backed groups the tooltip also
// shows the literal JQL DateCard ran, so the gloss stays a summary rather than
// a restatement of the query.
export const TASK_GROUPS: {
  type: TaskGroupType;
  label: MessageDescriptor;
  description: MessageDescriptor;
}[] = [
  {
    type: "status",
    label: msg`Status updated by you`,
    description: msg`Issues whose status you changed on this date.`,
  },
  {
    type: "created",
    label: msg`Created today by you`,
    description: msg`Issues you created on this date.`,
  },
  {
    type: "sprint",
    label: msg`Assigned to you in progress`,
    description: msg`Issues assigned to you in an open sprint that are in progress, created on or before this date.`,
  },
  {
    type: "favorite",
    label: msg`Favorites`,
    description: msg`Recurring tasks you saved yourself. Local to this app — no Jira query involved.`,
  },
];
