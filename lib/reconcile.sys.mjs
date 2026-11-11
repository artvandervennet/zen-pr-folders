/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Compares what a folder should show with the tabs it has.
import { itemId } from "./query.sys.mjs";

/**
 * @param containerId  id of the folder (or subfolder) these entries belong to
 * @param entries      output of buildEntries for this container
 * @param current      managed tabs now in the container: { itemId, open, stale }
 *                     open = selected or loaded, stale = already marked as no longer matching
 * @param dismissed    pull request keys the user closed in this container
 *
 * @returns
 *   add        [{ itemId, pr, stackKey }]  tabs to create (stackKey null for loose ones)
 *   remove     [itemId]                    tabs to close
 *   markStale  [itemId]                    open tabs that no longer match: keep, mark
 *   clearStale [itemId]                    marked tabs that match again
 *   layout     [{ type: "pr", itemId } | { type: "stack", key, label, items: [itemId] }]
 *   dismissed  the dismissed list without keys that stopped matching
 */
export function diffContainer({ containerId, entries, current, dismissed = [] }) {
  const dismissedSet = new Set(dismissed);
  const desired = new Map();
  const matching = new Set();
  const layout = [];

  const want = (pull, stack) => {
    matching.add(pull.key);
    if (dismissedSet.has(pull.key)) {
      return null;
    }
    const id = itemId(containerId, pull.key);
    desired.set(id, { itemId: id, pr: pull, stackKey: stack });
    return id;
  };

  for (const entry of entries) {
    if (entry.type === "pr") {
      const id = want(entry.pr, null);
      if (id) {
        layout.push({ type: "pr", itemId: id });
      }
      continue;
    }
    const items = entry.prs.map(pull => want(pull, entry.key)).filter(Boolean);
    if (items.length || entry.keep) {
      layout.push({ type: "stack", key: entry.key, label: entry.label, items });
    }
  }

  const present = new Set();
  const remove = [];
  const markStale = [];
  const clearStale = [];
  for (const tab of current) {
    if (desired.has(tab.itemId) && !present.has(tab.itemId)) {
      present.add(tab.itemId);
      if (tab.stale) {
        clearStale.push(tab.itemId);
      }
    } else if (tab.open && !present.has(tab.itemId)) {
      present.add(tab.itemId);
      if (!tab.stale) {
        markStale.push(tab.itemId);
      }
    } else {
      remove.push(tab.itemId);
    }
  }

  const add = [...desired.values()].filter(item => !present.has(item.itemId));

  // An empty result can be a failed or half-finished search. Keep dismissals in that case.
  const keptDismissed = matching.size ? dismissed.filter(key => matching.has(key)) : [...dismissed];

  return { add, remove, markStale, clearStale, layout, dismissed: keptDismissed };
}
