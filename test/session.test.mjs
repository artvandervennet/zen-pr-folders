/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  findRows,
  normalizeRow,
  extractStack,
  stackMembers,
  searchPullsBySession,
} from "../lib/session.sys.mjs";

const row = (number, extra = {}) => ({
  number,
  title: `PR ${number}`,
  repoNameWithOwner: "acme/app",
  permalink: `https://github.com/acme/app/pull/${number}`,
  author: { displayLogin: "octo" },
  ...extra,
});

const listPage = rows => ({
  status: 200,
  text: JSON.stringify({ payload: { pullsDashboardSurfaceContentRoute: { results: rows } } }),
});

const stackPage = (stack, asHtml = false) => {
  const json = JSON.stringify({ payload: { pullRequestsLayoutRoute: { stack } } });
  return {
    status: 200,
    text: asHtml
      ? `<html><script type="application/json" data-target="react-app.embeddedData">${json}</script></html>`
      : json,
  };
};

test("findRows reads the known route and falls back to any route with results", () => {
  assert.equal(findRows(JSON.parse(listPage([row(1)]).text)).length, 1);
  assert.equal(findRows({ payload: { renamedRoute: { results: [row(1)] } } }).length, 1);
  assert.equal(findRows({ payload: { other: {} } }), null);
  assert.equal(findRows({}), null);
});

test("normalizeRow maps a row and keeps the stack hint", () => {
  const pull = normalizeRow(row(7, { stackPosition: 2, stackSize: 3, isDraft: true }));
  assert.equal(pull.key, "acme/app#7");
  assert.equal(pull.url, "https://github.com/acme/app/pull/7");
  assert.equal(pull.author, "octo");
  assert.ok(pull.isDraft);
  assert.deepEqual(pull.stackHint, { position: 2, size: 3 });
  assert.equal(normalizeRow(row(8)).stackHint, null);
  assert.equal(normalizeRow({ title: "x" }), null);
  assert.equal(normalizeRow(row(9, { permalink: "/acme/app/pull/9" })).url, "https://github.com/acme/app/pull/9");
});

test("extractStack reads JSON and embedded JSON in HTML", () => {
  const stack = { number: 580, size: 2, position: 2, pulls: [{ number: 579 }, { number: 578 }] };
  assert.equal(extractStack(stackPage(stack).text).number, 580);
  assert.equal(extractStack(stackPage(stack, true).text).number, 580);
  assert.equal(extractStack("<html>no data</html>"), null);
});

test("stackMembers handles top-first and bottom-first lists", () => {
  const self = { number: 579, stackHint: { position: 2, size: 2 } };
  const topFirst = stackMembers("acme/app", { number: 580, size: 2, position: 2, pulls: [{ number: 579 }, { number: 578 }] }, self);
  assert.equal(topFirst.get("acme/app#578").position, 1);
  assert.equal(topFirst.get("acme/app#579").position, 2);
  const bottomFirst = stackMembers("acme/app", { number: 580, size: 2, position: 2, pulls: [{ number: 578 }, { number: 579 }] }, self);
  assert.equal(bottomFirst.get("acme/app#578").position, 1);
  assert.equal(bottomFirst.get("acme/app#579").position, 2);
  assert.equal(bottomFirst.get("acme/app#579").key, "acme/app~580");
});

test("searchPullsBySession resolves a stack with one page request for all its members", async () => {
  const urls = [];
  const fetchText = async url => {
    urls.push(url);
    if (url.startsWith("https://github.com/pulls")) {
      return listPage([
        row(1),
        row(579, { stackPosition: 2, stackSize: 2 }),
        row(578, { stackPosition: 1, stackSize: 2 }),
      ]);
    }
    return stackPage({ number: 580, size: 2, position: 2, baseBranch: "main", pulls: [{ number: 579 }, { number: 578 }] }, true);
  };
  const cache = new Map();
  const pulls = await searchPullsBySession({ query: "is:pr is:open", fetchText, cache });
  assert.deepEqual(pulls.map(p => [p.number, p.stack?.key ?? null, p.stack?.position ?? null]), [
    [1, null, null],
    [579, "acme/app~580", 2],
    [578, "acme/app~580", 1],
  ]);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\?q=is%3Apr\+is%3Aopen$/);

  // A second run uses the cache: only the list is fetched.
  urls.length = 0;
  await searchPullsBySession({ query: "is:pr is:open", fetchText, cache });
  assert.equal(urls.length, 1);
});

test("a stacked PR whose page cannot be read is shown as loose", async () => {
  const fetchText = async url =>
    url.startsWith("https://github.com/pulls")
      ? listPage([row(5, { stackPosition: 1, stackSize: 2 })])
      : { status: 500, text: "" };
  const [pull] = await searchPullsBySession({ query: "q", fetchText });
  assert.equal(pull.stack, null);
});

test("searchPullsBySession pages until rows repeat", async () => {
  const pages = [];
  const first = Array.from({ length: 25 }, (_, i) => row(i + 1));
  const fetchText = async url => {
    const page = Number(new URL(url).searchParams.get("page") ?? 1);
    pages.push(page);
    return listPage(page === 1 ? first : page === 2 ? [row(26), row(27)] : first);
  };
  const pulls = await searchPullsBySession({ query: "q", fetchText });
  assert.equal(pulls.length, 27);
  assert.deepEqual(pages, [1, 2]);

  pages.length = 0;
  const ignoresPage = async url => {
    pages.push(Number(new URL(url).searchParams.get("page") ?? 1));
    return listPage(first);
  };
  assert.equal((await searchPullsBySession({ query: "q", fetchText: ignoresPage })).length, 25);
  assert.deepEqual(pages, [1, 2]);
});

test("searchPullsBySession reports sign-in and format problems", async () => {
  await assert.rejects(searchPullsBySession({ query: "q", fetchText: async () => ({ status: 404, text: "" }) }), { kind: "auth" });
  await assert.rejects(searchPullsBySession({ query: "q", fetchText: async () => ({ status: 200, text: "<html>" }) }), { kind: "query" });
  await assert.rejects(searchPullsBySession({ query: "q", fetchText: async () => ({ status: 200, text: '{"payload":{}}' }) }), { kind: "query" });
  await assert.rejects(searchPullsBySession({ query: "q", fetchText: async () => ({ status: 429, text: "" }) }), { kind: "rate" });
  await assert.rejects(
    searchPullsBySession({
      query: "q",
      fetchText: async () => {
        throw new Error("offline");
      },
    }),
    { kind: "network" }
  );
});

test("onShape receives key names only", async () => {
  let shape;
  await searchPullsBySession({ query: "q", fetchText: async () => listPage([row(1)]), onShape: s => (shape = s) });
  assert.deepEqual(shape.routes, ["pullsDashboardSurfaceContentRoute"]);
  assert.ok(shape.row.includes("repoNameWithOwner"));
});
