/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Runs in every browser window. Creates, moves and removes the tabs the engine asks for,
// and adds the menu items.

const { Engine, diffContainer, arrangeLayout, parseItemId } = ChromeUtils.importESModule(
  "chrome://sine/content/zen-pr-folders/engine.sys.mjs"
);

const ITEM = "prf-item"; // on a managed tab: "<container folder id>|owner/repo#number"
const STALE = "prf-stale"; // on the selected managed tab after its pull request stopped matching
const GITHUB_ICON = "chrome://browser/content/zen-images/favicons/github.svg";
const INTERVALS = [
  [30, "30 seconds"],
  [60, "1 minute"],
  [120, "2 minutes"],
  [300, "5 minutes"],
  [900, "15 minutes"],
];

const removing = new WeakSet();
const cleanups = [];

function listen(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  cleanups.push(() => target.removeEventListener(type, handler, options));
}

function folderEl(id) {
  const el = id ? document.getElementById(id) : null;
  return el?.isZenFolder ? el : null;
}

function nextTick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// --- tabs ------------------------------------------------------------------

/** The item id of a tab. After a restart the attribute is gone, so it is read back from the session. */
function itemOf(tab) {
  let id = tab.getAttribute(ITEM);
  if (!id) {
    try {
      id = SessionStore.getCustomTabValue(tab, ITEM);
    } catch {}
    if (id) {
      tab.setAttribute(ITEM, id);
      if (SessionStore.getCustomTabValue(tab, STALE)) {
        tab.setAttribute(STALE, "true");
      }
    }
  }
  return id || null;
}

/** Only the tab you are looking at survives a refresh that drops its pull request. */
function isOpen(tab) {
  return tab.selected;
}

function setStale(tab, stale) {
  if (stale) {
    tab.setAttribute(STALE, "true");
    SessionStore.setCustomTabValue(tab, STALE, "true");
  } else {
    tab.removeAttribute(STALE);
    SessionStore.deleteCustomTabValue(tab, STALE);
  }
}

function release(tab) {
  tab.removeAttribute(ITEM);
  tab.removeAttribute(STALE);
  try {
    SessionStore.deleteCustomTabValue(tab, ITEM);
    SessionStore.deleteCustomTabValue(tab, STALE);
  } catch {}
}

function closeTabs(tabs) {
  const list = tabs.filter(Boolean);
  if (!list.length) {
    return;
  }
  for (const tab of list) {
    removing.add(tab);
  }
  gBrowser.removeTabs(list, { skipSessionStore: true, animate: false });
}

/** Removes the grey second line Zen shows under a tab title (set by earlier versions of this mod). */
function clearSublabel(tab) {
  if (!tab.hasAttribute("zen-show-sublabel")) {
    return;
  }
  tab.removeAttribute("zen-show-sublabel");
  const label = tab.querySelector(".zen-tab-sublabel");
  if (label) {
    document.l10n.setArgs(label, { tabSubtitle: "zen-default-pinned" });
  }
}

// Same sequence Zen uses for its own live folders (ZenLiveFoldersManager.onLiveFolderFetch).
function createTab(item, containerEl) {
  const { pr } = item;
  try {
    const space = gZenWorkspaces.getWorkspaceFromId(containerEl.getAttribute("zen-workspace-id"));
    const userContextId = space?.containerTabId || 0;
    const tab = gBrowser.addTrustedTab(pr.url, {
      createLazyBrowser: true,
      inBackground: true,
      skipAnimation: true,
      noInitialLabel: true,
      lazyTabTitle: pr.title,
      userContextId,
    });
    gBrowser.pinTab(tab);
    if (userContextId) {
      tab.setAttribute("zenDefaultUserContextId", "true");
    }
    gBrowser.setIcon(tab, GITHUB_ICON);
    tab.setAttribute(ITEM, item.itemId);
    SessionStore.setCustomTabValue(tab, ITEM, item.itemId);
    return tab;
  } catch (error) {
    console.error("[zen-pr-folders] could not add a tab for", pr.url, error);
    return null;
  }
}

// --- ordering --------------------------------------------------------------

function moveAfter(node, anchor) {
  if (anchor.nextElementSibling === node) {
    return;
  }
  if (gBrowser.isTab(node)) {
    try {
      gBrowser.moveTabAfter(node, anchor);
    } catch {}
  }
  if (anchor.nextElementSibling !== node) {
    anchor.after(node);
    gBrowser.tabContainer._invalidateCachedTabs?.();
  }
}

/** Puts `nodes` (direct children of the folder) in the given order, leaving other children alone. */
function order(folder, nodes) {
  const wanted = nodes.filter(node => node && node.parentElement === folder.groupContainer);
  const set = new Set(wanted);
  const now = [...folder.groupContainer.children].filter(child => set.has(child));
  if (now.every((node, index) => node === wanted[index])) {
    return;
  }
  // The first one goes before all the others, then each one follows its predecessor.
  if (now[0] !== wanted[0]) {
    const first = wanted[0];
    if (gBrowser.isTab(first) && gBrowser.isTab(now[0])) {
      try {
        gBrowser.moveTabBefore(first, now[0]);
      } catch {}
    }
    if (now[0].previousElementSibling !== first) {
      now[0].before(first);
      gBrowser.tabContainer._invalidateCachedTabs?.();
    }
  }
  for (let i = 1; i < wanted.length; i++) {
    moveAfter(wanted[i], wanted[i - 1]);
  }
}

// --- applying a plan ---------------------------------------------------------

async function applyContainer(plan) {
  const unchanged = {
    id: plan.id,
    dismissed: plan.dismissed,
    stackFolders: plan.stackFolders,
    stackNames: plan.stackNames,
  };
  const el = folderEl(plan.id);
  if (!el) {
    return unchanged;
  }
  // "root" for the top folder, "sub" for a subfolder: the stylesheet treats them differently.
  const config = Engine.describe(plan.id);
  el.setAttribute("prf-folder", config?.kind === "folder" ? "root" : "sub");
  el.toggleAttribute("prf-divider", config?.container.divider !== false);

  // A managed tab the user dragged out of the folder is theirs now.
  const dismissed = new Set(plan.dismissed);
  for (const tab of document.querySelectorAll(`tab[${ITEM}^="${CSS.escape(plan.id)}|"]`)) {
    if (!el.contains(tab)) {
      dismissed.add(parseItemId(tab.getAttribute(ITEM)).key);
      release(tab);
    }
  }

  const tabs = new Map();
  const current = [];
  const duplicates = [];
  for (const tab of el.tabs) {
    const id = itemOf(tab);
    if (!id || parseItemId(id)?.containerId !== plan.id) {
      continue;
    }
    if (tabs.has(id)) {
      duplicates.push(tab);
      continue;
    }
    tabs.set(id, tab);
    current.push({ itemId: id, open: isOpen(tab), stale: tab.hasAttribute(STALE) });
  }

  // What the folder shows now, top to bottom, so a refresh can leave it in place.
  const shownOrder = [];
  for (const child of el.groupContainer.children) {
    const id = gBrowser.isTab(child) ? itemOf(child) : null;
    if (id) {
      shownOrder.push(id);
    } else if (child.hasAttribute?.("prf-stack")) {
      shownOrder.push(`stack:${child.getAttribute("prf-stack")}`);
    }
  }

  const diff = diffContainer({
    containerId: plan.id,
    entries: plan.entries,
    current,
    dismissed: [...dismissed],
  });

  closeTabs([...duplicates, ...diff.remove.map(id => tabs.get(id))]);
  for (const id of diff.remove) {
    tabs.delete(id);
  }
  for (const id of diff.markStale) {
    setStale(tabs.get(id), true);
  }
  for (const id of diff.clearStale) {
    setStale(tabs.get(id), false);
  }

  for (const tab of tabs.values()) {
    clearSublabel(tab);
  }

  // Stack groups are Zen subfolders, created when a stack first shows up.
  const stackFolders = { ...plan.stackFolders };
  const stackNames = { ...plan.stackNames };
  const stackEls = new Map();
  for (const group of diff.layout) {
    if (group.type !== "stack") {
      continue;
    }
    let stackEl = folderEl(stackFolders[group.key]);
    if (!stackEl || !el.contains(stackEl)) {
      stackEl = gZenFolders.createFolder([], {
        label: group.label,
        insertAfter: el.groupContainer.lastElementChild,
      });
      stackFolders[group.key] = stackEl.id;
      if (Engine.stackIcon) {
        gZenFolders.setFolderUserIcon(stackEl, Engine.stackIcon);
      }
    }
    // prf-label holds the name this mod last gave the group. When the label differs from it,
    // the user renamed the group with Zen's "Rename": keep that name from now on.
    const lastSet = stackEl.getAttribute("prf-label");
    if (lastSet !== null && stackEl.label !== lastSet) {
      const typed = (stackEl.label ?? "").trim();
      if (typed && typed !== group.label) {
        stackNames[group.key] = typed;
      } else {
        delete stackNames[group.key];
      }
    }
    const label = stackNames[group.key] || group.label;
    if (stackEl.label !== label) {
      stackEl.label = label;
    }
    stackEl.setAttribute("prf-label", label);
    stackEl.setAttribute("prf-stack", group.key);
    stackEl.toggleAttribute("prf-divider", config?.container.stackDivider !== false);
    stackEls.set(group.key, stackEl);
  }

  for (const item of diff.add) {
    const tab = createTab(item, el);
    if (tab) {
      tabs.set(item.itemId, tab);
    }
  }
  // Zen waits a tick here too, so the new tabs exist in every synced window before they move.
  await nextTick();

  // Put every tab in its folder: loose ones in the container, stacked ones in their group.
  const rootNodes = [];
  const resort = config?.container.resort === true;
  for (const group of arrangeLayout(diff.layout, shownOrder, { resort })) {
    if (group.type === "pr") {
      const tab = tabs.get(group.itemId);
      if (tab && tab.group !== el) {
        el.addTabs([tab]);
      }
      rootNodes.push(tab);
      continue;
    }
    const stackEl = stackEls.get(group.key);
    const members = group.items.map(id => tabs.get(id)).filter(Boolean);
    const outside = members.filter(tab => tab.group !== stackEl);
    if (outside.length) {
      stackEl.addTabs(outside);
    }
    order(stackEl, members);
    rootNodes.push(stackEl);
  }
  order(el, rootNodes);

  // A stack that no longer matches loses its group, unless something is still in it.
  for (const [key, id] of Object.entries(stackFolders)) {
    if (stackEls.has(key)) {
      continue;
    }
    const stackEl = folderEl(id);
    if (stackEl) {
      const left = stackEl.allItems.filter(node => !node.hasAttribute?.("zen-empty-tab"));
      if (left.length) {
        continue;
      }
      try {
        await stackEl.delete();
      } catch (error) {
        console.error("[zen-pr-folders] could not remove an empty stack group", error);
      }
    }
    delete stackFolders[key];
  }

  return { id: plan.id, dismissed: diff.dismissed, stackFolders, stackNames };
}

const ui = {
  exists(id) {
    return !!folderEl(id);
  },

  /** The container (cookie jar) of the space the folder is in, so the right GitHub login is used. */
  contextId(id) {
    const el = folderEl(id);
    const space = el && gZenWorkspaces.getWorkspaceFromId(el.getAttribute("zen-workspace-id"));
    return space?.containerTabId || 0;
  },

  async apply(plan) {
    const containers = [];
    for (const container of plan.containers) {
      containers.push(await applyContainer(container));
    }
    return { containers };
  },

  showError(folderId, message) {
    const el = folderEl(folderId);
    if (!el) {
      return;
    }
    const found = Engine.describe(folderId);
    const tooltip = message ? `${message}\n\n${found?.query ?? ""}` : (found?.query ?? "");
    if (message) {
      el.setAttribute("prf-error", message);
    } else {
      el.removeAttribute("prf-error");
    }
    el.labelElement?.setAttribute("tooltiptext", tooltip);
  },
};

// --- prompts and menu --------------------------------------------------------

function ask(title, text, value = "") {
  const input = { value };
  const ok = Services.prompt.prompt(window, title, text, input, null, { value: false });
  return ok ? (input.value ?? "").trim() : null;
}

async function askToken() {
  const input = { value: "" };
  const ok = Services.prompt.promptPassword(
    window,
    "GitHub token",
    "Optional. Without a token the folder uses your github.com login in this browser.\nWith one it uses GitHub's API instead. Leave empty to remove a stored token.",
    input,
    null,
    { value: false }
  );
  if (!ok) {
    return false;
  }
  await Engine.setToken((input.value ?? "").trim());
  return true;
}

const QUERY_HELP =
  "GitHub search syntax, for example:\nis:open org:my-org user-review-requested:@me -label:wip";

async function newFolder() {
  const query = ask("New PR live folder", `Query for this folder.\n${QUERY_HELP}`, "is:open involves:@me");
  if (query === null) {
    return;
  }
  const folder = gZenFolders.createFolder([], { label: "Pull requests" });
  await Engine.addFolder(folder.id, query);
}

async function manageFolder(folder) {
  const query = ask("PR live folder", `Query for "${folder.label}".\n${QUERY_HELP}`, "is:open involves:@me");
  if (query !== null) {
    await Engine.addFolder(folder.id, query);
  }
}

async function addSubfolder(parent, existing = null) {
  const name = existing ? existing.label : ask("New subfolder", "Name of the subfolder", "Needs my review");
  if (!name) {
    return;
  }
  const query = ask(
    "Subfolder query",
    `Added to the folder's query (${Engine.describe(parent.id)?.query || "empty"}).\n${QUERY_HELP}`,
    "user-review-requested:@me"
  );
  if (query === null) {
    return;
  }
  const el =
    existing ??
    gZenFolders.createFolder([], { label: name, insertAfter: parent.groupContainer.lastElementChild });
  await Engine.addSubfolder(parent.id, el.id, name, query);
}

/** Creates a folder (parent null) or a subfolder from a preset: name, icon and query in one go. */
async function createFromPreset(parent, preset) {
  const el = gZenFolders.createFolder([], {
    label: preset.name,
    ...(parent ? { insertAfter: parent.groupContainer.lastElementChild } : {}),
  });
  if (preset.icon) {
    gZenFolders.setFolderUserIcon(el, preset.icon);
  }
  const options = { divider: preset.divider, stackDivider: preset.stackDivider, resort: preset.resort };
  if (parent) {
    await Engine.addSubfolder(parent.id, el.id, preset.name, preset.query, options);
  } else {
    await Engine.addFolder(el.id, preset.query, options);
  }
}

function presetMenu(label, onPick) {
  const menu = document.createXULElement("menu");
  menu.className = "prf-menu";
  menu.setAttribute("label", label);
  const popup = document.createXULElement("menupopup");
  for (const preset of Engine.presets) {
    const item = menuItem(preset.name, () => onPick(preset));
    item.setAttribute("tooltiptext", preset.query || "(no query)");
    popup.append(item);
  }
  menu.append(popup);
  return menu;
}

/** A checkbox menu item for one of the two divider settings. Applies at once, no refresh needed. */
function dividerItem(label, found, key, targets) {
  const enabled = found.container[key] !== false;
  const item = menuItem(label, async () => {
    await Engine.setOption(found.container.id, key, !enabled);
    for (const target of targets()) {
      target.toggleAttribute("prf-divider", !enabled);
    }
  });
  item.setAttribute("type", "checkbox");
  if (enabled) {
    item.setAttribute("checked", "true");
  }
  return item;
}

/** Off by default: a refresh keeps the folder's order and adds new pull requests on top. */
function resortItem(found, folder) {
  const enabled = found.container.resort === true;
  const item = menuItem("Re-sort by activity on every refresh", async () => {
    await Engine.setOption(found.container.id, "resort", !enabled);
    Engine.refresh(folder.id);
  });
  item.setAttribute("type", "checkbox");
  if (enabled) {
    item.setAttribute("checked", "true");
  }
  return item;
}

function stackElsOf(container) {
  return Object.values(container.stackFolders).map(folderEl).filter(Boolean);
}

/** Names a stack group. Zen's own "Rename" works too; the next refresh picks that up. */
async function renameStack(folder, found) {
  const name = ask(
    "Rename stack",
    "Name for this stack group. Leave empty to name it after its bottom pull request again.",
    found.name || folder.label
  );
  if (name === null) {
    return;
  }
  await Engine.setStackName(folder.id, name);
  if (name) {
    folder.label = name;
    folder.setAttribute("prf-label", name);
  } else {
    // The next refresh sets the automatic name.
    folder.removeAttribute("prf-label");
    await Engine.refresh(folder.id);
  }
}

async function useIconForAllStacks(folder) {
  const icon = folder.iconURL;
  await Engine.setStackIcon(icon);
  for (const stackEl of document.querySelectorAll("zen-folder[prf-stack]")) {
    gZenFolders.setFolderUserIcon(stackEl, icon);
  }
}

async function editQuery(folder, found) {
  const title = found.kind === "stack" ? "Filter this stack" : "Edit query";
  const text =
    found.kind === "stack"
      ? `Narrows the pull requests shown in this stack. Leave empty to show all that match.\n${QUERY_HELP}`
      : `Query for "${folder.label}".\n${QUERY_HELP}`;
  const query = ask(title, text, found.query);
  if (query !== null) {
    await Engine.setQuery(folder.id, query);
  }
}

function menuItem(label, onCommand) {
  const item = document.createXULElement("menuitem");
  item.className = "prf-menu";
  item.setAttribute("label", label);
  item.addEventListener("command", event => {
    event.stopPropagation();
    Promise.resolve(onCommand()).catch(error => console.error("[zen-pr-folders]", error));
  });
  return item;
}

function intervalMenu(found) {
  const menu = document.createXULElement("menu");
  menu.className = "prf-menu";
  menu.setAttribute("label", "Refresh every");
  const popup = document.createXULElement("menupopup");
  for (const [seconds, label] of INTERVALS) {
    const item = menuItem(label, () => Engine.setFolderInterval(found.folder.id, seconds));
    item.setAttribute("type", "radio");
    if ((found.folder.interval || Engine.defaultInterval) === seconds) {
      item.setAttribute("checked", "true");
    }
    popup.append(item);
  }
  menu.append(popup);
  return menu;
}

function folderFromMenuTarget(menu, event) {
  const target =
    event.target === menu ? (menu.triggerNode ?? event.explicitOriginalTarget) : event.explicitOriginalTarget;
  if (!target) {
    return null;
  }
  if (gBrowser.isTabGroupLabel(target)) {
    return target.group;
  }
  if (gBrowser.isTabGroupLabel(target.parentElement)) {
    return target.parentElement.group;
  }
  if (target.parentElement?.isZenFolder) {
    return target.parentElement;
  }
  return target.closest?.("zen-folder") ?? null;
}

function buildFolderMenu(menu, event) {
  if (event.target !== menu) {
    return;
  }
  for (const old of menu.querySelectorAll(".prf-menu")) {
    old.remove();
  }
  const folder = folderFromMenuTarget(menu, event);
  if (!folder?.isZenFolder) {
    return;
  }

  const items = [];
  const found = Engine.describe(folder.id);
  if (!found) {
    const parent = folder.group && Engine.describe(folder.group.id);
    if (parent?.kind === "folder") {
      items.push(menuItem("Give this subfolder a PR query…", () => addSubfolder(folder.group, folder)));
    } else if (!parent && !folder.isLiveFolder) {
      items.push(menuItem("Make this a PR live folder…", () => manageFolder(folder)));
    }
  } else if (found.kind === "stack") {
    items.push(
      menuItem(found.query ? "Edit stack filter…" : "Filter this stack…", () => editQuery(folder, found)),
      menuItem("Rename stack…", () => renameStack(folder, found)),
      menuItem("Refresh now", () => Engine.refresh(folder.id)),
      menuItem("Use this icon for all stacks", () => useIconForAllStacks(folder)),
      dividerItem("Line under stacks in this folder", found, "stackDivider", () => stackElsOf(found.container))
    );
  } else {
    const hidden =
      found.kind === "folder"
        ? [found.folder, ...found.folder.subfolders].reduce((sum, c) => sum + c.dismissed.length, 0)
        : found.container.dismissed.length;
    items.push(menuItem("Edit query…", () => editQuery(folder, found)));
    if (found.kind === "folder") {
      items.push(menuItem("Add subfolder with query…", () => addSubfolder(folder)));
      if (Engine.presets.length) {
        items.push(presetMenu("Add subfolder from preset", preset => createFromPreset(folder, preset)));
      }
    }
    if (found.kind === "subfolder") {
      items.push(dividerItem("Line under this folder", found, "divider", () => [folder]));
    }
    items.push(
      resortItem(found, folder),
      dividerItem("Line under stacks in this folder", found, "stackDivider", () => stackElsOf(found.container)),
      menuItem("Save as preset", () =>
        Engine.savePreset({
          name: folder.label,
          icon: folder.iconURL,
          query: found.query,
          divider: found.container.divider !== false,
          stackDivider: found.container.stackDivider !== false,
          resort: found.container.resort === true,
        })
      )
    );
    if (found.kind === "folder" && Engine.presets.length) {
      items.push(presetMenu("Remove preset", preset => Engine.removePreset(preset.name)));
    }
    items.push(menuItem("Refresh now", () => Engine.refresh(folder.id)));
    if (found.kind === "folder") {
      items.push(intervalMenu(found));
    }
    if (hidden) {
      items.push(menuItem(`Restore ${hidden} closed pull request${hidden === 1 ? "" : "s"}`, () => Engine.restoreDismissed(folder.id)));
    }
    if (found.kind === "folder") {
      items.push(menuItem("Use a GitHub token (optional)…", askToken));
    }
    items.push(menuItem("Turn into a plain folder (no more updates)", () => Engine.forget(folder.id)));
  }
  if (!items.length) {
    return;
  }
  const separator = document.createXULElement("menuseparator");
  separator.className = "prf-menu";
  menu.prepend(...items, separator);
}

// --- start and stop ----------------------------------------------------------

function topFolderId(folder) {
  let current = folder;
  while (current) {
    const found = Engine.describe(current.id);
    if (found) {
      return found.folder.id;
    }
    current = current.group;
  }
  return null;
}

function stop() {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {}
  }
  Engine.unregister(window);
}

async function start() {
  if (window.delayedStartupPromise) {
    await window.delayedStartupPromise;
  }
  try {
    await SessionStore.promiseAllWindowsRestored;
  } catch {}
  if (!window.gZenFolders || !window.gBrowser) {
    return;
  }

  const folderMenu = document.getElementById("zenFolderActions");
  if (folderMenu) {
    listen(folderMenu, "popupshowing", event => buildFolderMenu(folderMenu, event));
    cleanups.push(() => folderMenu.querySelectorAll(".prf-menu").forEach(node => node.remove()));
  }

  const newTabItem = document.getElementById("toolbar-context-openANewTab");
  if (newTabItem) {
    const item = menuItem("New PR live folder…", newFolder);
    item.id = "prf-new-folder";
    newTabItem.after(item);
    cleanups.push(() => item.remove());

    // "New PR live folder from preset" is rebuilt each time the sidebar menu opens.
    const sidebarMenu = newTabItem.closest("menupopup");
    if (sidebarMenu) {
      listen(sidebarMenu, "popupshowing", event => {
        if (event.target !== sidebarMenu) {
          return;
        }
        sidebarMenu.querySelector("#prf-new-from-preset")?.remove();
        if (Engine.presets.length) {
          const menu = presetMenu("New PR live folder from preset", preset => createFromPreset(null, preset));
          menu.id = "prf-new-from-preset";
          item.after(menu);
        }
      });
      cleanups.push(() => sidebarMenu.querySelector("#prf-new-from-preset")?.remove());
    }
  }

  // Closing a managed tab by hand hides that pull request until it stops matching.
  listen(gBrowser.tabContainer, "TabClose", event => {
    const tab = event.target;
    const id = tab.getAttribute(ITEM);
    if (id && !removing.has(tab) && !tab.hasAttribute(STALE)) {
      Engine.dismiss(id);
    }
  });

  // A tab kept only because it was selected goes once you switch away from it.
  listen(gBrowser.tabContainer, "TabSelect", event => {
    const previous = event.detail?.previousTab;
    if (previous?.hasAttribute(STALE) && previous.isConnected && !removing.has(previous)) {
      closeTabs([previous]);
    }
  });

  listen(gBrowser.tabContainer, "TabGroupExpand", event => {
    const id = event.target?.isZenFolder ? topFolderId(event.target) : null;
    if (id) {
      Engine.refreshStale(10_000, id);
    }
  });
  listen(window, "activate", () => Engine.refreshStale(30_000));
  listen(window, "unload", stop, { once: true });
  window.addUnloadListener?.(stop);

  // Give Zen a moment to finish restoring folders before the first refresh.
  setTimeout(() => Engine.register(window, ui), 2000);
}

start().catch(error => console.error("[zen-pr-folders] could not start", error));
