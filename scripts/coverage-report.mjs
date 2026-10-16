#!/usr/bin/env node
/**
 * The pull-request coverage summary.
 *
 * `vitest --coverage` writes `coverage/coverage-summary.json` (per-file
 * numbers); this turns it into the per-directory markdown table the CI step
 * appends to the run summary. The point is O5's: **which modules changed
 * without tests** — no thresholds, no trend lines, one table on every pull
 * request.
 *
 * Grouping is by the second path segment (`src/features/reader`), which is
 * where this app's modules actually live: a `src/features` row would be one
 * number over a hundred files, and per-file rows would bury the signal.
 */
import { readFileSync } from "node:fs";

const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));

const metrics = ["statements", "branches", "functions", "lines"];
const groups = new Map();
for (const [file, entry] of Object.entries(summary)) {
  if (file === "total") continue;
  // The summary's keys are absolute paths; the grouping this app cares about
  // starts at `src/`, and is the file's own directory — flat directories
  // (`hooks`, `lib`) collapse to one row, deep ones (`features/reader`) keep
  // their own.
  const within = file.split("/src/")[1];
  if (!within) continue;
  const cut = within.lastIndexOf("/");
  const group = cut === -1 ? "src" : `src/${within.slice(0, cut)}`;
  if (!groups.has(group)) {
    groups.set(group, Object.fromEntries(metrics.map((metric) => [metric, [0, 0]])));
  }
  const bucket = groups.get(group);
  for (const metric of metrics) {
    bucket[metric][0] += entry[metric].covered;
    bucket[metric][1] += entry[metric].total;
  }
}

const percent = (covered, total) =>
  total === 0 ? "—" : `${((covered / total) * 100).toFixed(1)}%`;

const row = (name, bucket) =>
  `| ${name} | ${metrics.map((metric) => percent(...bucket[metric])).join(" | ")} |`;

console.log("## Test coverage");
console.log("");
console.log("| 目录 | 语句 | 分支 | 函数 | 行 |");
console.log("| --- | --- | --- | --- | --- |");
for (const [group, bucket] of [...groups.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))) {
  console.log(row(group, bucket));
}
const total = summary.total;
console.log(
  `| **全部** | ${metrics.map((metric) => percent(total[metric].covered, total[metric].total)).join(" | ")} |`,
);
