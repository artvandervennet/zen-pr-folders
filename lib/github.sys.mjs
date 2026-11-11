/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// GitHub GraphQL client for pull request searches, including GitHub Stacks membership.
import { prKey, stackKey } from "./query.sys.mjs";

export const API_URL = "https://api.github.com/graphql";
export const PAGE_SIZE = 50;

// ISSUE_ADVANCED is the search type that understands OR and parentheses.
// With plain ISSUE a query containing them returns nothing (checked against api.github.com).
export const SEARCH_QUERY = `
query PrFolders($q: String!, $first: Int!, $after: String) {
  search(type: ISSUE_ADVANCED, query: $q, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        url
        isDraft
        state
        updatedAt
        repository { nameWithOwner }
        author { login avatarUrl }
        stack { number size baseRefName }
        stackEntry { position }
      }
    }
  }
}`;

/** kind: "auth" | "rate" | "query" | "network". retryAt is a timestamp in ms, when known. */
export class GithubError extends Error {
  constructor(kind, message, retryAt = null) {
    super(message);
    this.name = "GithubError";
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

export function normalizePull(node) {
  if (!node || typeof node.number !== "number" || !node.repository) {
    return null;
  }
  const repo = node.repository.nameWithOwner;
  return {
    key: prKey(repo, node.number),
    repo,
    number: node.number,
    title: node.title ?? "",
    url: node.url,
    isDraft: !!node.isDraft,
    state: node.state ?? "OPEN",
    updatedAt: node.updatedAt ?? "",
    author: node.author?.login ?? "",
    avatarUrl: node.author?.avatarUrl ?? "",
    stack: node.stack
      ? {
          key: stackKey(repo, node.stack.number),
          number: node.stack.number,
          size: node.stack.size ?? 0,
          base: node.stack.baseRefName ?? "",
          position: node.stackEntry?.position ?? 0,
        }
      : null,
  };
}

function retryAtFrom(headers, now) {
  const retryAfter = Number(headers.get("retry-after"));
  if (retryAfter > 0) {
    return now + retryAfter * 1000;
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (reset > 0 && headers.get("x-ratelimit-remaining") === "0") {
    return reset * 1000;
  }
  return now + 60_000;
}

async function request({ token, variables, fetchImpl, now }) {
  let response;
  try {
    response = await fetchImpl(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: SEARCH_QUERY, variables }),
    });
  } catch (error) {
    throw new GithubError("network", `GitHub is unreachable: ${error.message}`);
  }

  if (response.status === 401) {
    throw new GithubError("auth", "GitHub rejected the token. Set a new one.");
  }
  if (response.status === 403 || response.status === 429) {
    throw new GithubError("rate", "GitHub rate limit reached.", retryAtFrom(response.headers, now()));
  }
  if (!response.ok) {
    throw new GithubError("network", `GitHub answered ${response.status}.`);
  }

  const body = await response.json();
  if (body.errors?.length && !body.data?.search) {
    const first = body.errors[0];
    if (first.type === "RATE_LIMITED") {
      throw new GithubError("rate", "GitHub rate limit reached.", retryAtFrom(response.headers, now()));
    }
    throw new GithubError("query", first.message ?? "GitHub could not run this query.");
  }
  return body.data.search;
}

/**
 * Runs one search and returns normalized pull requests in GitHub's order.
 * Stops at `limit` results.
 */
export async function searchPulls({
  query,
  token,
  limit = 200,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  if (!token) {
    throw new GithubError("auth", "No GitHub token set.");
  }
  const pulls = [];
  const seen = new Set();
  let after = null;
  while (pulls.length < limit) {
    const first = Math.min(PAGE_SIZE, limit - pulls.length);
    const page = await request({ token, variables: { q: query, first, after }, fetchImpl, now });
    for (const node of page.nodes ?? []) {
      const pull = normalizePull(node);
      if (pull && !seen.has(pull.key)) {
        seen.add(pull.key);
        pulls.push(pull);
      }
    }
    if (!page.pageInfo?.hasNextPage) {
      break;
    }
    after = page.pageInfo.endCursor;
  }
  return pulls;
}
