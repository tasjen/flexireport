import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { InfoIcon, MoveRightIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/shared/button";
import { Input } from "@/components/shared/input";
import { Label } from "@/components/shared/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/shared/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/shared/tooltip";
import { useSavePreferencesMutation } from "@/lib/mutations";
import { usePreferences, useTaskParameters } from "@/lib/queries";

// The portal's task form has 3 project/textarea row pairs, so a mapping can
// target at most 3 distinct portal projects.
const MAX_DISTINCT_PROJECTS = 3;

export default function ProjectMapForm() {
  const { t } = useLingui();
  const { data: preferences } = usePreferences();
  const savePreferences = useSavePreferencesMutation();
  const { data } = useTaskParameters();
  const [key, setKey] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [listRef] = useAutoAnimate();

  const projects = data?.projects;
  if (!projects?.length || !preferences) return null;

  const projectMap = preferences.project_map;
  // A project key is a Jira issue-key prefix (e.g. "ABC-123" → "ABC").
  // Normalize to uppercase so lookups can't miss on casing.
  const trimmedKey = key.trim().toUpperCase();
  // Only `null` means "nothing picked yet" — the portal keeps an empty-valued
  // placeholder option, and picking it is a real selection.
  const distinctValues = new Set([
    ...Object.values(projectMap),
    ...(projectId === null ? [] : [projectId]),
  ]);
  const canAdd = Boolean(
    trimmedKey &&
    projectId !== null &&
    !(trimmedKey in projectMap) &&
    distinctValues.size <= MAX_DISTINCT_PROJECTS,
  );

  function projectLabel(value: string) {
    return projects?.find((p) => p.value === value)?.label ?? value;
  }

  function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canAdd || !preferences || projectId === null) return;
    savePreferences.mutate({
      ...preferences,
      project_map: { ...projectMap, [trimmedKey]: projectId },
    });
    setKey("");
    setProjectId(null);
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Label className="flex flex-none items-center gap-1">
        <Trans>Project mapping</Trans>
        <Tooltip>
          <TooltipTrigger
            render={
              <span>
                <InfoIcon size={16} className="inline" />
              </span>
            }
          />
          <TooltipContent>
            <Trans>
              Maps Jira project keys to the portal's projects — an issue's key
              is its Jira key prefix (ABC-123 → ABC); favorites pick their
              portal project themselves. Selected tasks are grouped by portal
              project and each group fills its own project + comment pair in the
              task form, largest group first (max {MAX_DISTINCT_PROJECTS} portal
              projects — the form has {MAX_DISTINCT_PROJECTS} pairs). Unmapped
              tasks fall back to the default project's group, or the first
              comment when no default project is set.
            </Trans>
          </TooltipContent>
        </Tooltip>
      </Label>
      {Object.keys(projectMap).length > 0 && (
        <ul ref={listRef} className="flex w-full flex-col">
          {Object.entries(projectMap).map(([projectKey, portalProject]) => (
            <li key={projectKey} className="flex items-center gap-2 text-sm">
              <span className="font-mono">{projectKey}</span>
              <MoveRightIcon className="size-4 flex-none text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {projectLabel(portalProject)}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => {
                  const { [projectKey]: _removed, ...rest } = projectMap;
                  savePreferences.mutate({ ...preferences, project_map: rest });
                }}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={handleAdd} className="flex w-full items-center gap-2">
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t`Key`}
          className="w-16 flex-none font-mono"
          data-testid="project-map-key"
        />
        <Select
          items={projects}
          value={projectId}
          onValueChange={(val) => setProjectId(val)}
        >
          <SelectTrigger
            className="min-w-0 flex-1"
            data-testid="project-map-project"
          >
            <SelectValue
              className={projectId === null ? undefined : "text-foreground"}
            >
              {(value: string | null) =>
                value === null ? t`Project` : projectLabel(value)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="w-2xs">
            <SelectGroup>
              {projects.map((item) => (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  data-testid={`project-map-option-${item.value}`}
                >
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          type="submit"
          size="icon"
          disabled={!canAdd}
          data-testid="project-map-add"
        >
          <PlusIcon />
        </Button>
      </form>
    </div>
  );
}
