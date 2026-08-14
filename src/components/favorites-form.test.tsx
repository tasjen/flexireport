import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";

import FavoritesForm from "@/components/favorites-form";
import type { Favorite } from "@/lib/store";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

const PROJECTS = [
  { label: "Alpha", value: "100" },
  { label: "Beta", value: "200" },
];

// Stored favorites may predate the project field entirely (plain strings) or
// carry the superseded project_key tag, so the fixture type is deliberately
// looser than Favorite.
function setup(
  favorites: (string | Record<string, unknown>)[],
  projects = PROJECTS,
) {
  const saved: Favorite[][] = [];
  // useTaskParameters is enabled only when an account exists.
  mockTauri({ account: { phone: "0812345678" }, favorites }, (cmd, args) => {
    if (cmd === "get_task_parameters") {
      return { dates: [], leaves: [], projects };
    }
    if (cmd === "plugin:store|set") {
      saved.push((args as { value: Favorite[] }).value);
    }
    return undefined;
  });
  return saved;
}

// Elements are queried by data-testid, never by their rendered copy: every
// visible string here goes through lingui, so a message or catalog edit would
// otherwise break the test. Favorite text and project labels are user/portal
// data, not copy, so those stay asserted by text.
async function openDialog() {
  await renderWithProviders(<FavoritesForm />);
  await userEvent.click(screen.getByTestId("favorites-open"));
  return await screen.findByTestId("favorite-text");
}

// A second open only takes once the previous popup has finished closing, so
// the trigger is clicked until the popup reports itself open rather than once.
async function selectProject(value: string) {
  const trigger = await screen.findByTestId("favorite-project");
  await waitFor(async () => {
    if (!trigger.hasAttribute("data-popup-open")) {
      await userEvent.click(trigger);
    }
    expect(trigger).toHaveAttribute("data-popup-open");
  });
  await userEvent.click(
    await screen.findByTestId(`favorite-project-option-${value}`),
  );
}

it("lists stored favorites and disables add for blank and duplicate text", async () => {
  setup([{ text: "Standup", project: "200" }]);
  const textInput = await openDialog();
  expect(screen.getByText("Standup")).toBeInTheDocument();
  // The stored project is an option id; the list shows its portal label.
  expect(await screen.findByText("Beta")).toBeInTheDocument();

  expect(screen.getByTestId("favorite-add")).toBeDisabled();
  await userEvent.type(textInput, "  Standup  ");
  expect(screen.getByTestId("favorite-add")).toBeDisabled();
});

it("adds a favorite with trimmed text and the selected portal project", async () => {
  const saved = setup([]);
  const textInput = await openDialog();
  await userEvent.type(textInput, "  Deploy  ");
  await selectProject("200");
  await userEvent.click(screen.getByTestId("favorite-add"));
  expect(saved).toEqual([[{ text: "Deploy", project: "200" }]]);
});

it("defaults to the first portal project when the select is left alone", async () => {
  const saved = setup([]);
  const textInput = await openDialog();
  expect(await screen.findByTestId("favorite-project")).toHaveTextContent(
    "Alpha",
  );
  await userEvent.type(textInput, "Standup");
  await userEvent.click(screen.getByTestId("favorite-add"));
  expect(saved).toEqual([[{ text: "Standup", project: "100" }]]);
});

// The portal keeps a blank-valued placeholder among its project options, and
// it is usually the first one — so the default a favorite picks up is "no
// project", which buildSubmission routes to the default project.
it("stores the portal's blank placeholder option as-is", async () => {
  const saved = setup([], [{ label: "-- Select --", value: "" }, ...PROJECTS]);
  const textInput = await openDialog();
  await userEvent.type(textInput, "Standup");
  await userEvent.click(screen.getByTestId("favorite-add"));
  expect(saved).toEqual([[{ text: "Standup", project: "" }]]);
});

// No account or a failed scrape leaves the project list empty; adding a
// favorite must not depend on it.
it("still adds a favorite when the portal projects are unavailable", async () => {
  const saved = setup([], []);
  const textInput = await openDialog();
  await userEvent.type(textInput, "Standup");
  expect(screen.queryByTestId("favorite-project")).not.toBeInTheDocument();
  await userEvent.click(screen.getByTestId("favorite-add"));
  expect(saved).toEqual([[{ text: "Standup", project: null }]]);
});

it("deletes a favorite by saving the remaining list", async () => {
  const saved = setup([
    { text: "Standup", project: null },
    { text: "Deploy", project: "200" },
  ]);
  await openDialog();
  const deleteButtons = screen.getAllByTestId("favorite-delete");
  expect(deleteButtons).toHaveLength(2);
  await userEvent.click(deleteButtons[0]!);
  expect(saved).toEqual([[{ text: "Deploy", project: "200" }]]);
});
