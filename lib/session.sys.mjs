/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reads pull requests from github.com with the browser's own login, no token.
// These are the pages GitHub's web UI uses, not a documented API, so every field is read defensively.
import { prKey, stackKey } from "./query.sys.mjs";
import { GithubError } from "./github.sys.mjs";

export const PULLS_URL = "https://github.com/pulls";
const JSON_ACCEPT = { Accept: "application/json,text/html" };
const STACK_TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 4;
const FULL_PAGE = 20;

/** Finds the search result rows in the /pulls payload, wherever GitHub puts them. */
export function findRows(parsed) {
  const payload = parsed?.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const known = payload.pullsDashboardSurfaceContentRoute?.results;
  if (Array.isArray(known)) {
    return known;
  }
  for (const route of Object.values(payload)) {
    if (Array.isArray(route?.results)) {
      return route.results;
    }
  }
  return null;
}

export function normalizeRow(row) {
  const repo = row?.repoNameWithOwner;
  const number = Number(row?.number);
  if (!repo || !Number.isInteger(number)) {
    return null;
  }
  const url = row.permalink
    ? new URL(row.permalink, "https://github.com").href
    : `https://github.com/${repo}/pull/${number}`;
  const position = Number(row.stackPosition);
  const size = Number(row.stackSize);
  return {
    key: prKey(repo, number),
    repo,
    number,
    title: row.title ?? "",
    url,
    isDraft: !!(row.isDraft ?? row.draft),
    state: row.state ?? "OPEN",
    updatedAt: row.updatedAt ?? "",
    author: row.author?.displayLogin ?? row.author?.login ?? "",
    avatarUrl: row.author?.avatarUrl ?? "",
    stack: null,
    // The list says a PR is stacked but not in which stack. resolveStacks fills that in.
    stackHint: position > 0 && size > 0 ? { position, size } : null,
  };
}

/** Looks through a parsed page payload for the stack object: { number, size, pulls: [...] }. */
export function findStack(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStack(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }
  const stack = value.stack;
  if (stack && typeof stack === "object" && Array.isArray(stack.pulls) && stack.number != null) {
    return stack;
  }
  for (const child of Object.values(value)) {
    const found = findStack(child, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

/** Reads the stack from a pull request page: either JSON, or HTML with embedded JSON. */
export function extractStack(text) {
  try {
    return findStack(JSON.parse(text));
  } catch {}
  const pattern = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const match of text.matchAll(pattern)) {
    if (!match[1].includes('"stack"')) {
      continue;
    }
    try {
      const found = findStack(JSON.parse(match[1]));
      if (found) {
        return found;
      }
    } catch {}
  }
  return null;
}

/**
 * Turns a page's stack object into one entry per member pull request.
 * `self` is the pull request whose page it came from; its known position tells whether
 * the page lists the stack bottom-first or top-first.
 */
export function stackMembers(repo, stack, self) {
  const numbers = stack.pulls.map(pull => Number(pull.number)).filter(Number.isInteger);
  const size = Number(stack.size) || numbers.length;
  const index = numbers.indexOf(self.number);
  const selfPosition = Number(stack.position) || self.stackHint?.position || 0;
  const bottomFirst = index >= 0 && selfPosition === index + 1;
  const members = new Map();
  numbers.forEach((number, i) => {
    members.set(prKey(repo, number), {
      key: stackKey(repo, stack.number),
      number: Number(stack.number),
      size,
      base: stack.baseBranch ?? stack.baseRefName ?? "",
      position: bottomFirst ? i + 1 : numbers.length - i,
    });
  });
  return members;
}

/**
 * Fills in `stack` for pull requests the list marked as stacked.
 * One page request per stack, not per pull request: a page lists all members.
 * `cache` is a Map kept by the caller: pull request key -> { stack, at }.
 */
export async function resolveStacks(pulls, { fetchText, cache, now = Date.now }) {
  for (const pull of pulls) {
    if (!pull.stackHint) {
      continue;
    }
    const cached = cache.get(pull.key);
    const fresh =
      cached &&
      now() - cached.at < STACK_TTL_MS &&
      cached.stack.size === pull.stackHint.size &&
      cached.stack.position === pull.stackHint.position;
    if (fresh) {
      pull.stack = cached.stack;
      continue;
    }
    let stack = null;
    try {
      // Asked for as HTML on purpose: the JSON variant of a pull request page leaves the stack out
      // (checked on a public stacked pull request), the HTML embeds it.
      const { status, text } = await fetchText(pull.url, { Accept: "text/html" });
      stack = status === 200 ? extractStack(text) : null;
    } catch {}
    if (!stack) {
      continue; // shown as a loose pull request until the page can be read
    }
    for (const [key, member] of stackMembers(pull.repo, stack, pull)) {
      cache.set(key, { stack: member, at: now() });
    }
    pull.stack = cache.get(pull.key)?.stack ?? null;
  }
  return pulls;
}

async function fetchPage({ query, page, fetchText }) {
  const url = new URL(PULLS_URL);
  url.searchParams.set("q", query);
  if (page > 1) {
    url.searchParams.set("page", String(page));
  }
  let response;
  try {
    response = await fetchText(url.href, JSON_ACCEPT);
  } catch (error) {
    throw new GithubError("network", `github.com is unreachable: ${error.message}`);
  }
  if (response.status === 404 || response.status === 401) {
    throw new GithubError("auth", "Not signed in to github.com in this space. Sign in, or set a token.");
  }
  if (response.status === 429) {
    throw new GithubError("rate", "github.com is rate limiting requests.", Date.now() + 120_000);
  }
  if (response.status !== 200) {
    throw new GithubError("network", `github.com answered ${response.status}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new GithubError(
      "query",
      "github.com did not return the pull request list as data. Sign in, or set a token."
    );
  }
  const rows = findRows(parsed);
  if (!rows) {
    throw new GithubError("query", "github.com changed its pull request list. Set a token to use the API.");
  }
  return { rows, parsed };
}

/**
 * Same result shape as searchPulls in github.sys.mjs, read through the logged-in session.
 * fetchText(url, headers) resolves to { status, text } and must send github.com cookies.
 * onShape, when given, receives the key names of the payload once, for diagnosing format changes.
 */
export async function searchPullsBySession({
  query,
  fetchText,
  cache = new Map(),
  limit = 200,
  now = Date.now,
  onShape = null,
}) {
  const pulls = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES && pulls.length < limit; page++) {
    const { rows, parsed } = await fetchPage({ query, page, fetchText });
    if (page === 1 && onShape) {
      onShape({
        routes: Object.keys(parsed.payload ?? {}),
        row: rows[0] ? Object.keys(rows[0]) : [],
      });
    }
    let added = 0;
    for (const row of rows) {
      const pull = normalizeRow(row);
      if (pull && !seen.has(pull.key) && pulls.length < limit) {
        seen.add(pull.key);
        pulls.push(pull);
        added++;
      }
    }
    // Stop when the page was short, or when "page" was ignored and the same rows came back.
    if (!added || rows.length < FULL_PAGE) {
      break;
    }
  }
  return resolveStacks(pulls, { fetchText, cache, now });
}
