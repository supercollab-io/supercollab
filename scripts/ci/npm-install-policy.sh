#!/usr/bin/env bash
set -euo pipefail

npm install-scripts ls --json | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const report = JSON.parse(input);
    if (!Array.isArray(report.allowScripts)) {
      console.error("npm did not return an install-script policy report");
      process.exit(1);
    }
    if (report.allowScripts.length !== 0) {
      console.error("unreviewed dependency install scripts remain");
      process.exit(1);
    }
  });
'
