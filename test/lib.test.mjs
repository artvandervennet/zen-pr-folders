/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from "node:test";
import assert from "node:assert/strict";

import { composeQuery, hasQualifier, itemId, parseItemId } from "../lib/query.sys.mjs";
import { searchPulls, normalizePull, GithubError } from "../lib/github.sys.mjs";
import { buildEntries, filterStack } from "../lib/group.sys.mjs";
import { diffContainer } from "../lib/reconcile.sys.mjs";

function pull(number, updatedAt, stack = null, repo = "acme/app") {
  return {
    key: `${repo}#${number}`,
    repo,
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    updatedAt,
    author: "octo",
    stack: stack && {
      key: `${repo}~${stack.number}`,
      number: stack.number,
      size: stack.size ?? 3,
      base: "main",
      position: stack.position,
    },
  };
}

// --- query ---------------------------------------------------------------

test("composeQuery joins parts and adds is:pr and a default sort", () => {
  assert.equal(
    composeQuery("org:acme is:open", "user-review-requested:@me"),
    "org:acme is:open user-review-requested:@me is:pr sort:updated-desc"
  );
});

test("composeQuery keeps an existing is:pr and sort", () => {
  assert.equal(composeQuery("is:pr is:open sort:created-asc"), "is:pr is:open sort:created-asc");
  assert.equal(composeQuery("type:pr", ""), "type:pr sort:updated-desc");
});

test("composeQuery wraps a part with OR once other parts join it", () => {
  assert.equal(
    composeQuery("author:@me OR assignee:@me", "label:bug"),
    "(author:@me OR assignee:@me) label:bug is:pr sort:updated-desc"
  );
  assert.equal(
    composeQuery("author:@me OR assignee:@me"),
    "(author:@me OR assignee:@me) is:pr sort:updated-desc"
  );
  assert.equal(composeQuery("(a:1 OR b:2)", "c:3"), "(a:1 OR b:2) c:3 is:pr sort:updated-desc");
  assert.equal(composeQuery("(a:1) OR (b:2)"), "((a:1) OR (b:2)) is:pr sort:updated-desc");
});

test("hasQualifier sees negated and parenthesised qualifiers", () => {
  assert.ok(hasQualifier("is:open -sort:updated", "sort"));
  assert.ok(hasQualifier("(sort:updated)", "sort"));
  assert.ok(!hasQualifier("resort:x", "sort"));
});

test("item ids round-trip", () => {
  assert.deepEqual(parseItemId(itemId("f1", "acme/app#7")), { containerId: "f1", key: "acme/app#7" });
  assert.equal(parseItemId("nope"), null);
});

// --- github --------------------------------------------------------------

function fakeFetch(pages, calls = []) {
  return async (url, init) => {
    calls.push(JSON.parse(init.body).variables);
    const page = pages.shift();
    return {
      status: page.status ?? 200,
      ok: (page.status ?? 200) < 400,
      headers: new Map(Object.entries(page.headers ?? {})),
      json: async () => page.body,
    };
  };
}

const node = (number, extra = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  isDraft: false,
  state: "OPEN",
  updatedAt: "2026-11-10T10:00:00Z",
  repository: { nameWithOwner: "acme/app" },
  author: { login: "octo", avatarUrl: "https://avatars/x" },
  stack: null,
  stackEntry: null,
  ...extra,
});

test("normalizePull maps stack fields and skips non-PR nodes", () => {
  const stacked = normalizePull(
    node(5, { stack: { number: 12, size: 3, baseRefName: "main" }, stackEntry: { position: 2 } })
  );
  assert.deepEqual(stacked.stack, { key: "acme/app~12", number: 12, size: 3, base: "main", position: 2 });
  assert.equal(normalizePull(node(6)).stack, null);
  assert.equal(normalizePull({}), null);
});

test("searchPulls pages until done and removes duplicates", async () => {
  const calls = [];
  const fetchImpl = fakeFetch(
    [
      { body: { data: { search: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [node(1), node(2), {}] } } } },
      { body: { data: { search: { pageInfo: { hasNextPage: false }, nodes: [node(2), node(3)] } } } },
    ],
    calls
  );
  const pulls = await searchPulls({ query: "is:pr", token: "t", fetchImpl });
  assert.deepEqual(pulls.map(p => p.number), [1, 2, 3]);
  assert.equal(calls[1].after, "c1");
});

test("searchPulls stops at the limit", async () => {
  const fetchImpl = fakeFetch([
    { body: { data: { search: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [node(1), node(2)] } } } },
  ]);
  const pulls = await searchPulls({ query: "is:pr", token: "t", fetchImpl, limit: 2 });
  assert.equal(pulls.length, 2);
});

test("searchPulls reports auth, rate and query errors", async () => {
  await assert.rejects(searchPulls({ query: "q", token: "" }), { kind: "auth" });
  await assert.rejects(searchPulls({ query: "q", token: "t", fetchImpl: fakeFetch([{ status: 401, body: {} }]) }), {
    kind: "auth",
  });
  const rate = await searchPulls({
    query: "q",
    token: "t",
    now: () => 1000,
    fetchImpl: fakeFetch([{ status: 403, headers: { "retry-after": "30" }, body: {} }]),
  }).catch(error => error);
  assert.ok(rate instanceof GithubError);
  assert.equal(rate.kind, "rate");
  assert.equal(rate.retryAt, 31000);
  await assert.rejects(
    searchPulls({ query: "q", token: "t", fetchImpl: fakeFetch([{ body: { errors: [{ message: "bad" }] } }]) }),
    { kind: "query", message: "bad" }
  );
  await assert.rejects(
    searchPulls({
      query: "q",
      token: "t",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
    { kind: "network" }
  );
});

// --- group ---------------------------------------------------------------

test("buildEntries groups stacks, orders them by position and sorts by activity", () => {
  const entries = buildEntries([
    pull(1, "2026-11-10T09:00:00Z"),
    pull(12, "2026-11-10T08:00:00Z", { number: 4, position: 2 }),
    pull(3, "2026-11-10T07:00:00Z"),
    pull(11, "2026-11-09T08:00:00Z", { number: 4, position: 1 }),
    pull(13, "2026-11-10T12:00:00Z", { number: 4, position: 3 }),
  ]);
  assert.deepEqual(entries.map(e => e.type), ["stack", "pr", "pr"]);
  assert.deepEqual(entries[0].prs.map(p => p.number), [11, 12, 13]);
  assert.equal(entries[0].updatedAt, "2026-11-10T12:00:00Z");
  assert.equal(entries[0].label, "PR 11 (3)");
  assert.deepEqual(entries.slice(1).map(e => e.pr.number), [1, 3]);
});

test("buildEntries keeps GitHub's order when the query sorts itself", () => {
  const entries = buildEntries(
    [
      pull(3, "2026-11-01T00:00:00Z"),
      pull(12, "2026-11-10T00:00:00Z", { number: 4, position: 2 }),
      pull(1, "2026-11-09T00:00:00Z"),
      pull(11, "2026-11-10T00:00:00Z", { number: 4, position: 1 }),
    ],
    { searchOrder: true }
  );
  assert.deepEqual(
    entries.map(e => (e.type === "pr" ? e.pr.number : `s${e.number}`)),
    [3, "s4", 1]
  );
});

test("stacks with the same number in different repos stay apart", () => {
  const entries = buildEntries([
    pull(1, "2026-11-10T00:00:00Z", { number: 1, position: 1 }, "acme/a"),
    pull(1, "2026-11-09T00:00:00Z", { number: 1, position: 1 }, "acme/b"),
  ]);
  assert.equal(entries.length, 2);
});

test("filterStack narrows a stack and keeps it when empty", () => {
  const [stack] = buildEntries([
    pull(11, "2026-11-09T00:00:00Z", { number: 4, position: 1 }),
    pull(12, "2026-11-10T00:00:00Z", { number: 4, position: 2 }),
  ]);
  const narrowed = filterStack(stack, new Set(["acme/app#12"]));
  assert.deepEqual(narrowed.prs.map(p => p.number), [12]);
  const empty = filterStack(stack, new Set());
  assert.equal(empty.prs.length, 0);
  assert.ok(empty.keep);
  assert.equal(empty.label, "PR 11 (3)");
});

// --- reconcile -----------------------------------------------------------

const entriesFixture = () =>
  buildEntries([
    pull(1, "2026-11-10T09:00:00Z"),
    pull(11, "2026-11-10T08:00:00Z", { number: 4, position: 1 }),
    pull(12, "2026-11-10T07:00:00Z", { number: 4, position: 2 }),
  ]);

test("diffContainer adds everything to an empty folder", () => {
  const diff = diffContainer({ containerId: "f", entries: entriesFixture(), current: [] });
  assert.deepEqual(diff.add.map(a => [a.itemId, a.stackKey]), [
    ["f|acme/app#1", null],
    ["f|acme/app#11", "acme/app~4"],
    ["f|acme/app#12", "acme/app~4"],
  ]);
  assert.deepEqual(diff.layout, [
    { type: "pr", itemId: "f|acme/app#1" },
    { type: "stack", key: "acme/app~4", label: "PR 11 (3)", items: ["f|acme/app#11", "f|acme/app#12"] },
  ]);
  assert.deepEqual(diff.remove, []);
});

test("diffContainer is a no-op when the folder already matches", () => {
  const current = ["f|acme/app#1", "f|acme/app#11", "f|acme/app#12"].map(id => ({ itemId: id, open: false, stale: false }));
  const diff = diffContainer({ containerId: "f", entries: entriesFixture(), current });
  assert.deepEqual([diff.add, diff.remove, diff.markStale, diff.clearStale], [[], [], [], []]);
});

test("diffContainer removes closed-over tabs but keeps open ones as stale", () => {
  const current = [
    { itemId: "f|acme/app#1", open: false, stale: false },
    { itemId: "f|acme/app#98", open: false, stale: false },
    { itemId: "f|acme/app#99", open: true, stale: false },
    { itemId: "f|acme/app#97", open: true, stale: true },
    { itemId: "f|acme/app#96", open: false, stale: true },
  ];
  const diff = diffContainer({ containerId: "f", entries: entriesFixture(), current });
  assert.deepEqual(diff.remove, ["f|acme/app#98", "f|acme/app#96"]);
  assert.deepEqual(diff.markStale, ["f|acme/app#99"]);
});

test("diffContainer clears the stale mark when a PR matches again", () => {
  const current = [{ itemId: "f|acme/app#1", open: true, stale: true }];
  const diff = diffContainer({ containerId: "f", entries: entriesFixture(), current });
  assert.deepEqual(diff.clearStale, ["f|acme/app#1"]);
});

test("diffContainer skips dismissed PRs and forgets dismissals that stopped matching", () => {
  const diff = diffContainer({
    containerId: "f",
    entries: entriesFixture(),
    current: [],
    dismissed: ["acme/app#11", "acme/app#500"],
  });
  assert.deepEqual(diff.add.map(a => a.pr.number), [1, 12]);
  assert.deepEqual(diff.layout[1].items, ["f|acme/app#12"]);
  assert.deepEqual(diff.dismissed, ["acme/app#11"]);
});

test("diffContainer keeps dismissals when the result is empty", () => {
  const diff = diffContainer({ containerId: "f", entries: [], current: [], dismissed: ["acme/app#11"] });
  assert.deepEqual(diff.dismissed, ["acme/app#11"]);
});

test("diffContainer removes duplicate tabs for one PR", () => {
  const current = [
    { itemId: "f|acme/app#1", open: false, stale: false },
    { itemId: "f|acme/app#1", open: true, stale: false },
  ];
  const diff = diffContainer({ containerId: "f", entries: entriesFixture(), current });
  assert.deepEqual(diff.remove, ["f|acme/app#1"]);
});

test("diffContainer keeps an empty stack group that has its own query", () => {
  const [stack] = buildEntries([pull(11, "2026-11-10T08:00:00Z", { number: 4, position: 1 })]);
  const diff = diffContainer({ containerId: "f", entries: [filterStack(stack, new Set())], current: [] });
  assert.deepEqual(diff.layout, [{ type: "stack", key: "acme/app~4", label: "PR 11 (3)", items: [] }]);
});
