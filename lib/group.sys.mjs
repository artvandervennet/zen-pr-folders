/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Turns a flat list of pull requests into the list shown in a folder:
// loose pull requests and stack groups, sorted together.

function newest(pulls) {
  return pulls.reduce((latest, pull) => (pull.updatedAt > latest ? pull.updatedAt : latest), "");
}

export function stackLabel(pulls, size) {
  const bottom = pulls[0];
  const title = bottom ? bottom.title : "Stack";
  return `${title} (${size || pulls.length})`;
}

/**
 * @param pulls        pull requests in GitHub's result order
 * @param searchOrder  true when the query has its own sort: qualifier. GitHub's order then wins
 *                     and a stack sits where its first member appeared. Otherwise everything is
 *                     sorted by latest activity, a stack counting as its most recently updated PR.
 * @returns entries: { type: "pr", pr } or { type: "stack", key, repo, number, size, label, prs, updatedAt }
 *          Inside a stack, prs run in merge order: position 1 (closest to the base) first.
 */
export function buildEntries(pulls, { searchOrder = false } = {}) {
  const entries = [];
  const stacks = new Map();

  pulls.forEach((pull, index) => {
    if (!pull.stack) {
      entries.push({ type: "pr", pr: pull, updatedAt: pull.updatedAt, index });
      return;
    }
    let entry = stacks.get(pull.stack.key);
    if (!entry) {
      entry = {
        type: "stack",
        key: pull.stack.key,
        repo: pull.repo,
        number: pull.stack.number,
        size: pull.stack.size,
        prs: [],
        index,
      };
      stacks.set(pull.stack.key, entry);
      entries.push(entry);
    }
    entry.prs.push(pull);
  });

  for (const entry of stacks.values()) {
    finishStack(entry);
  }

  if (searchOrder) {
    entries.sort((a, b) => a.index - b.index);
  } else {
    entries.sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) {
        return a.updatedAt < b.updatedAt ? 1 : -1;
      }
      return a.index - b.index;
    });
  }
  return entries.map(({ index, ...entry }) => entry);
}

function finishStack(entry) {
  entry.prs.sort((a, b) => a.stack.position - b.stack.position || a.number - b.number);
  entry.updatedAt = newest(entry.prs);
  entry.label = stackLabel(entry.prs, entry.size);
}

/**
 * Narrows one stack entry to the pull requests whose key is in `allowedKeys`.
 * The entry is kept even when empty (keep: true), so its folder and its query stay reachable.
 */
export function filterStack(entry, allowedKeys) {
  const prs = entry.prs.filter(pull => allowedKeys.has(pull.key));
  const filtered = { ...entry, prs, keep: true };
  filtered.updatedAt = newest(prs) || entry.updatedAt;
  filtered.label = stackLabel(prs.length ? prs : entry.prs, entry.size);
  return filtered;
}
