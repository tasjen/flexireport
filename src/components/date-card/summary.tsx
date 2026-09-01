import { Trans } from "@lingui/react/macro";
import {
  CircleAlertIcon,
  CopyCheckIcon,
  CopyIcon,
  Loader2Icon,
} from "lucide-react";

import { Button } from "@/components/shared/button";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

type Props = {
  isFetching: boolean;
  // react-query's own error type. The `instanceof` guard below still stands:
  // a queryFn can reject with a non-Error, which the type does not model.
  error: Error | null;
  // The unsplit report text for the current selection. Empty when nothing is
  // selected — which is not the same as nothing being available.
  summaryText: string;
  hasIssues: boolean;
};

export default function DateCardSummary({
  isFetching,
  error,
  summaryText,
  hasIssues,
}: Props) {
  const { isCopied, copy } = useCopyToClipboard();

  if (isFetching) return <Loader2Icon className="animate-spin" />;

  if (error) {
    return (
      <p
        role="alert"
        className="flex items-start gap-2 whitespace-pre-wrap text-red-500"
      >
        <CircleAlertIcon className="mt-1 size-4" />
        {error instanceof Error ? error.message : String(error)}
      </p>
    );
  }

  if (!summaryText) {
    return (
      <p className="relative mt-4 whitespace-pre-wrap text-muted-foreground italic">
        {/* No tasks at all vs. tasks exist but none selected — reachable when
            `default_task_groups` is empty or all groups were unchecked. */}
        {hasIssues ? (
          <Trans>No tasks selected</Trans>
        ) : (
          <Trans>No tasks found</Trans>
        )}
      </p>
    );
  }

  return (
    <p className="relative whitespace-pre-wrap">
      {summaryText}
      <Button
        variant="ghost"
        className={cn("absolute -top-2 right-0", {
          "not-hover:text-muted-foreground": !isCopied,
        })}
        onClick={() => copy(summaryText)}
      >
        {isCopied ? <CopyCheckIcon /> : <CopyIcon />}
      </Button>
    </p>
  );
}
