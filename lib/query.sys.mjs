/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure helpers for GitHub search queries. No browser globals, so this runs under Node too.

/** True when the query already contains the qualifier, e.g. hasQualifier("sort:updated", "sort"). */
export function hasQualifier(query, name) {
  return new RegExp(`(^|[\\s(])-?${name}:`, "i").test(query ?? "");
}

function isPullRequestQuery(query) {
  return /(^|[\s(])(is|type):(pr|pull-request)\b/i.test(query);
}

/** True when one pair of parentheses encloses the whole part: "(a OR b)" but not "(a) OR (b)". */
function isWrapped(part) {
  if (!part.startsWith("(") || !part.endsWith(")")) {
    return false;
  }
  let depth = 0;
  for (let i = 0; i < part.length; i++) {
    if (part[i] === "(") {
      depth++;
    } else if (part[i] === ")") {
      depth--;
      if (depth === 0 && i < part.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

/**
 * Joins query parts the way GitHub reads them: a space means AND.
 * A part that contains OR is wrapped in parentheses. Without them GitHub reads
 * "repo:a author:x OR base:main is:pr" as two alternatives, the second one searching all of GitHub.
 */
export function composeQuery(...parts) {
  const clean = parts.map(part => (part ?? "").trim()).filter(Boolean);
  const wrapped = clean.map(part =>
    /\sOR\s/.test(part) && !isWrapped(part) ? `(${part})` : part
  );
  let query = wrapped.join(" ");
  if (!isPullRequestQuery(query)) {
    query = `${query} is:pr`.trim();
  }
  if (!hasQualifier(query, "sort")) {
    query = `${query} sort:updated-desc`;
  }
  return query;
}

export function prKey(repo, number) {
  return `${repo}#${number}`;
}

export function stackKey(repo, stackNumber) {
  return `${repo}~${stackNumber}`;
}

export function itemId(containerId, key) {
  return `${containerId}|${key}`;
}

export function parseItemId(id) {
  const at = (id ?? "").indexOf("|");
  return at < 0 ? null : { containerId: id.slice(0, at), key: id.slice(at + 1) };
}
