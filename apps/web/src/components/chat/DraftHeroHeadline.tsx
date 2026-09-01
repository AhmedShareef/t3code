import type { DraftId } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { FolderPlusIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo, useReducer } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useClientSettings } from "~/hooks/useSettings";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import { selectProjectGroupingSettings } from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  reduceSidebarProjectScopeMenuState,
  sortLogicalProjectsForSidebar,
} from "../Sidebar.logic";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;

  const projectItems = useMemo(
    () =>
      projectPickerEntries.map(({ group }) => ({
        value: group.projectKey,
        label: group.displayName,
      })),
    [projectPickerEntries],
  );
  const selectedProjectItem = useMemo(
    () => projectItems.find((item) => item.value === activeProjectKey) ?? null,
    [activeProjectKey, projectItems],
  );
  const [projectMenuState, dispatchProjectMenu] = useReducer(reduceSidebarProjectScopeMenuState, {
    open: false,
    query: "",
  });
  const projectFilter = useComboboxFilter();
  // Same wiring as the sidebar project filter: the query state drives both the
  // input and the filtered list, so they can never desync.
  const filteredProjectItems = useMemo(() => {
    const query = projectMenuState.query.trim();
    if (query.length === 0) return projectItems;
    return projectItems.filter((item) =>
      projectFilter.contains(item, query, (candidate) => candidate.label),
    );
  }, [projectFilter, projectItems, projectMenuState.query]);
  const openAddProjectFromMenu = useCallback(() => {
    dispatchProjectMenu({ type: "open-changed", open: false });
    openAddProject();
  }, [openAddProject]);

  const projectSelector = shouldShowProjectMenu ? (
    <Combobox
      items={projectItems}
      filteredItems={filteredProjectItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={projectMenuState.open}
      onOpenChange={(open) => {
        dispatchProjectMenu({ type: "open-changed", open });
      }}
      value={selectedProjectItem}
      onValueChange={(item) => {
        if (!item || item.value === activeProjectKey) return;
        const entry = projectEntryByKey.get(item.value);
        if (!entry || !draftId) return;
        const project = entry.targetProject;
        // Project selection changes the target of the open draft in
        // place. The prompt stays in the same composer session, so the
        // sidebar only gets a draft row if the user later navigates away.
        const currentDraft = getComposerDraft(draftId);
        setLogicalProjectDraftThreadId(
          entry.group.projectKey,
          scopeProjectRef(project.environmentId, project.id),
          draftId,
        );
        if (!hasExplicitComposerModelSelection(currentDraft)) {
          applyStickyState(draftId);
          const defaultModelSelection =
            project.defaultModelSelection ??
            environments.find((environment) => environment.environmentId === project.environmentId)
              ?.serverConfig?.settings.defaultModelSelection;
          if (defaultModelSelection) {
            setModelSelection(draftId, defaultModelSelection, {
              replaceOptions: true,
            });
          }
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              aria-label={hasResolvedProject ? "Change project" : "Choose a project"}
              className="pointer-events-auto inline-block max-w-64 truncate border-foreground/60 border-b border-dotted align-baseline text-foreground transition-colors hover:border-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {activeProjectDisplayName ?? "Choose a project"}
        </TooltipTrigger>
        {activeProjectDisplayName ? (
          <TooltipPopup side="top" className="max-w-80">
            {activeProjectDisplayName}
          </TooltipPopup>
        ) : null}
      </Tooltip>
      <ComboboxPopup align="center" className="w-64 min-w-0 overflow-hidden">
        <div className="shrink-0 px-3 pt-2.5">
          <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
            />
            <ComboboxInput
              aria-label="Search projects"
              className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
              inputClassName="rounded-none bg-transparent text-sm"
              placeholder="Search projects..."
              showTrigger={false}
              size="sm"
              unstyled
              value={projectMenuState.query}
              onChange={(event) =>
                dispatchProjectMenu({ type: "query-changed", query: event.target.value })
              }
            />
          </div>
        </div>
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: (typeof projectItems)[number]) => {
            const group = projectEntryByKey.get(item.value)?.group ?? null;
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                value={item}
                className="h-8 min-h-8 py-0 font-medium"
                contentClassName="flex min-w-0 items-center gap-2"
              >
                {group ? <ProjectFavicon project={group} className="size-4 shrink-0" /> : null}
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-sm" />}>
                    {item.label}
                  </TooltipTrigger>
                  <TooltipPopup side="top" className="max-w-80">
                    {item.label}
                  </TooltipPopup>
                </Tooltip>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
        <button
          type="button"
          onClick={openAddProjectFromMenu}
          className="flex h-9 w-full shrink-0 cursor-pointer items-center gap-2 border-t border-border/60 px-3 font-medium text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
        >
          <FolderPlusIcon />
          New project
        </button>
      </ComboboxPopup>
    </Combobox>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {activeProjectTitle ?? "Add a project"}
    </button>
  );

  return (
    <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
      {hasResolvedProject ? (
        <>What should we build in {projectSelector}?</>
      ) : canChooseProject ? (
        <>{projectSelector} to start</>
      ) : (
        <>Add a project to start</>
      )}
    </h1>
  );
}
