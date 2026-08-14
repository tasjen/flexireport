import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, StarIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/shared/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/shared/dialog";
import { Input } from "@/components/shared/input";
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
import { useSaveFavoritesMutation } from "@/lib/mutations";
import { useFavorites, useTaskParameters } from "@/lib/queries";

export default function FavoritesForm() {
  const { t } = useLingui();
  const { data: favorites } = useFavorites();
  const saveFavorites = useSaveFavoritesMutation();
  const { data: taskParameters } = useTaskParameters();
  const [text, setText] = useState("");
  // `null` is "untouched", not "no project": the select shows the first portal
  // project until the user picks another, the same default DefaultProjectSelect
  // uses. It only stays null when the portal list is empty.
  const [project, setProject] = useState<string | null>(null);
  const [listRef] = useAutoAnimate();

  // The trimmed text is the favorite's identity, so adding is disabled for
  // an empty result or an exact duplicate of an existing favorite. The
  // project is optional and not part of the identity.
  const trimmed = text.trim();
  const canAdd = Boolean(
    trimmed && favorites && !favorites.some((f) => f.text === trimmed),
  );
  // Empty until the headless scrape has run (no account yet, or it failed):
  // favorites stay addable without a project rather than blocking on it.
  const projects = taskParameters?.projects ?? [];
  const firstProject = projects[0];
  const selectedProject = project ?? firstProject?.value ?? null;

  function projectLabel(value: string) {
    return projects.find((p) => p.value === value)?.label ?? value;
  }

  function handleAdd(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canAdd || !favorites) return;
    saveFavorites.mutate([
      ...favorites,
      { text: trimmed, project: selectedProject },
    ]);
    setText("");
    setProject(null);
  }

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button size="icon-xl" variant="ghost" data-testid="favorites-open">
            <StarIcon className="size-6" />
          </Button>
        }
      />
      <DialogContent initialFocus={false} className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <StarIcon />
            <Trans>Favorites</Trans>
          </DialogTitle>
        </DialogHeader>
        {favorites?.length ? (
          <ul ref={listRef} className="flex flex-col gap-1">
            {favorites.map((favorite) => (
              <li key={favorite.text} className="flex items-center gap-2">
                <span className="flex-1 break-all">{favorite.text}</span>
                {favorite.project && (
                  <span className="max-w-40 flex-none truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {projectLabel(favorite.project)}
                  </span>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  data-testid="favorite-delete"
                  onClick={() => {
                    saveFavorites.mutate(
                      favorites.filter((f) => f.text !== favorite.text),
                    );
                  }}
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground italic">
            <Trans>No favorites yet</Trans>
          </p>
        )}
        <form onSubmit={handleAdd} className="flex items-center gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t`Add a favorite task`}
            data-testid="favorite-text"
          />
          {projects.length > 0 && (
            <Select
              items={projects}
              value={selectedProject}
              onValueChange={(val: string | null) => {
                setProject(val ?? firstProject?.value ?? null);
              }}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SelectTrigger
                      className="w-40 flex-none"
                      data-testid="favorite-project"
                    >
                      <SelectValue />
                    </SelectTrigger>
                  }
                />
                <TooltipContent className="max-w-sm">
                  <Trans>
                    The portal project this favorite goes into — it fills that
                    project's form row. A favorite left without a project
                    follows the default project's row, or the first row when no
                    default project is set
                  </Trans>
                </TooltipContent>
              </Tooltip>
              <SelectContent className="w-2xs">
                <SelectGroup>
                  {projects.map((item) => (
                    <SelectItem
                      key={item.value}
                      value={item.value}
                      data-testid={`favorite-project-option-${item.value}`}
                    >
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
          <Button type="submit" disabled={!canAdd} data-testid="favorite-add">
            <PlusIcon />
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
