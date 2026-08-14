import { useLingui } from "@lingui/react/macro";

import TaskSelect from "@/components/task-select";
import {
  type IssueGroup,
  jqlFor,
  type JqlByGroup,
  toOptionItems,
} from "@/lib/date-card-helpers";
import { cn } from "@/lib/utils";

// Past this many groups the single row gets too cramped to read, so they wrap
// into two columns instead.
const TWO_COLUMN_THRESHOLD = 3;

type Props = {
  groups: IssueGroup[];
  jqlByGroup: JqlByGroup;
  selectedKeySet: Set<string>;
  onSelectionChange: (groupKeys: string[], selected: string[]) => void;
};

export default function TaskSelectGrid({
  groups,
  jqlByGroup,
  selectedKeySet,
  onSelectionChange,
}: Props) {
  const { i18n } = useLingui();

  return (
    <div
      className={cn("flex flex-col gap-2 min-[864px]:flex-row", {
        "min-[864px]:grid min-[864px]:grid-cols-2":
          groups.length > TWO_COLUMN_THRESHOLD,
      })}
    >
      {groups.map((group) => {
        // Kept alongside the items so the change handler can scope its toggles
        // to this group's issues.
        const keys = group.issues.map((issue) => issue.key);
        return (
          <TaskSelect
            key={group.id}
            className="min-w-0 flex-1"
            testId={`task-group-${group.id}`}
            label={i18n._(group.label)}
            description={i18n._(group.description)}
            jql={jqlFor(jqlByGroup, group.id)}
            items={toOptionItems(group)}
            plainLabels={group.id === "favorite"}
            value={keys.filter((key) => selectedKeySet.has(key))}
            onValueChange={(selected) => onSelectionChange(keys, selected)}
          />
        );
      })}
    </div>
  );
}
