// SPDX-License-Identifier: MIT
// GHA workflow-command annotations. They go to stdout so the runner
// parses them and surfaces them in the step's UI summary.
export const warn = (msg) => console.log(`::warning::${msg}`);
export const error = (msg) => console.log(`::error::${msg}`);
