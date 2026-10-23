// Node built-in test runner. Run from the package root with:
//   node --test test/manual-downmerge.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DOWNMERGE_ROUTES,
  MANUAL_DOWNMERGE_DOC,
  ManualDownmergeRequired,
  describeManualDownmerge,
  parseDownmergeRoute,
  renderManualDownmerge,
} from "../lib/manual-downmerge.js";

test("every route parses back to itself", () => {
  for (const route of DOWNMERGE_ROUTES) {
    assert.deepEqual(parseDownmergeRoute(route.source, route.target), route);
  }
});

test("a route that does not exist names the ones that do", () => {
  assert.throws(
    () => parseDownmergeRoute("develop", "main"),
    /no downmerge from 'develop' to 'main'.*main → develop, release → develop/
  );
  assert.throws(() => parseDownmergeRoute(undefined, undefined), /Valid routes/);
});

const handoff = describeManualDownmerge({
  route: { source: "release", target: "develop" },
  sourceBranch: "release/4.125.0",
  version: "4.125.0",
  conflictedFiles: ["VERSION", "src/app.ts"],
  pullRequestTitle: "Release 4.125.0 to develop",
});

test("the rendering lists the files, numbers the steps and points at the doc", () => {
  const text = renderManualDownmerge(handoff);

  assert.match(text, /^Manual downmerge needed: release\/4\.125\.0 → develop/);
  assert.match(text, /  - VERSION\n  - src\/app\.ts/);
  assert.match(text, /  1\. Cut release-4\.125\.0-into-develop-<unix-timestamp> off origin\/develop/);
  assert.ok(text.includes(MANUAL_DOWNMERGE_DOC));
});

test("a decision into main says not to resolve it and lists the options", () => {
  const text = renderManualDownmerge(
    describeManualDownmerge({
      route: { source: "release", target: "main" },
      sourceBranch: "release/4.125.0",
      version: "4.125.0",
      conflictedFiles: ["VERSION"],
      pullRequestTitle: "Release 4.125.0 to main",
    })
  );

  assert.match(text, /^Decision needed: release\/4\.125\.0 → main conflicts/);
  assert.match(text, /Do not resolve this or merge main into release\/4\.125\.0/);
  assert.match(text, /  1\. Option 1, take main's changes/);
  assert.match(text, /  2\. Option 2, leave them out/);
  assert.doesNotMatch(text, /^Steps:/m);
});

test("the error carries the handoff and says nothing was created", () => {
  const error = new ManualDownmergeRequired(handoff);

  assert.equal(error.handoff, handoff);
  assert.match(error.message, /Nothing was created/);
  assert.match(error.message, /VERSION, src\/app\.ts/);
});
