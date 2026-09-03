import { Trans, useLingui } from "@lingui/react/macro";
import { InfoIcon, SearchIcon } from "lucide-react";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/shared/combobox";
import { Label } from "@/components/shared/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/shared/tooltip";
import type { TaskOptionItem } from "@/lib/date-card-helpers";

type Props = {
  items: TaskOptionItem[];
  value: string[];
  onValueChange: (keys: string[]) => void;
  label?: string;
  // Plain-English gloss of how this group's items are derived, shown in an
  // info tooltip beside the label. Needs `label` to render — the tooltip
  // trigger sits inside it.
  description?: string;
  // The literal JQL the group's issues came from, shown under `description` so
  // the tooltip states what was actually asked of Jira. Omitted by groups that
  // aren't Jira-backed (favorites).
  jql?: string;
  className?: string;
  // render item labels as-is instead of splitting on ": " into
  // "KEY: description" columns (used by the favorites group, whose labels
  // are free text)
  plainLabels?: boolean;
  // Stable identity for tests. `label` is translated copy, so it can't be
  // queried on; the caller passes a locale-independent id instead, and the
  // input and the "(all selected)" marker derive their own from it.
  testId?: string;
};

export default function TaskSelect({
  items,
  value,
  onValueChange,
  label,
  description,
  jql,
  className,
  plainLabels,
  testId,
}: Props) {
  const { t } = useLingui();
  const anchor = useComboboxAnchor();
  const allSelected = items.length > 0 && value.length === items.length;
  return (
    <Combobox
      multiple
      items={items}
      value={value}
      onValueChange={onValueChange}
    >
      <div className={className} ref={anchor} data-testid={testId}>
        {label && (
          <Label className="mb-2 gap-1 px-1 text-nowrap">
            {label}
            {description && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span data-testid={testId && `${testId}-info`}>
                      <InfoIcon size={16} className="inline" />
                    </span>
                  }
                />
                <TooltipContent className="max-w-sm flex-col items-start gap-1.5">
                  <span>{description}</span>
                  {jql && (
                    // The label is `text-nowrap`, but the portaled tooltip is
                    // outside it — a long JQL still needs to wrap itself.
                    <code className="font-mono break-words whitespace-pre-wrap text-background/70">
                      {jql}
                    </code>
                  )}
                </TooltipContent>
              </Tooltip>
            )}
            {allSelected && (
              <span
                className="font-normal text-muted-foreground"
                data-testid={testId && `${testId}-all-selected`}
              >
                <Trans>(all selected)</Trans>
              </span>
            )}
          </Label>
        )}
        <ComboboxInput
          startAddon={<SearchIcon className="pointer-events-none" />}
          placeholder={t`Search tasks`}
          data-testid={testId && `${testId}-input`}
        />
      </div>
      <ComboboxContent anchor={anchor} className="w-xl" side="bottom">
        <ComboboxEmpty>
          <Trans>No tasks found.</Trans>
        </ComboboxEmpty>
        <ComboboxList className="scrollbar-thin scrollbar-thumb-muted-foreground space-y-1">
          {(option: TaskOptionItem) => {
            if (plainLabels) {
              return (
                <ComboboxItem
                  key={option.value}
                  value={option.value}
                  className="flex items-start gap-2"
                >
                  <span className="flex-1">{option.label}</span>
                  {option.hint && (
                    // Same badge the favorites dialog puts beside a favorite,
                    // so the project reads the same in both places.
                    <span className="max-w-40 flex-none truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {option.hint}
                    </span>
                  )}
                </ComboboxItem>
              );
            }
            const splitStr = ": ";
            const splitIndex = option.label.indexOf(splitStr);
            const key = option.label.slice(0, splitIndex);
            const itemDescription = option.label.slice(
              splitIndex + splitStr.length,
            );
            return (
              <ComboboxItem
                key={option.value}
                value={option.value}
                className="flex items-start gap-2"
              >
                <span className="flex-none">{key}</span>
                <span>{itemDescription}</span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
