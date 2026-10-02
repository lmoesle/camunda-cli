---
name: cli-development
description: Orchestrates planning, delegated implementation and tests, local CI, and independent review whenever code changes are requested or made in camunda-cli, including features, fixes, refactors, and test or configuration changes.
---

# CLI development

Use this workflow for every code modification in this repository. Read-only
questions, plan-only requests, and review-only requests do not authorize edits.

The coordinator owns planning, validation, review, and the final decision. Route
all source, test, and configuration implementation or remediation through `Task`
with `subagent_type: execution`. Delegated execution, review, and CI agents perform
only their assigned phase; they must not restart this orchestration workflow.
If a required agent or the Task tool is unavailable, report the blocker instead
of bypassing delegation or claiming completion.

## 1. Plan the change

- Read repository instructions, the current diff and relevant untracked files,
  requirements, affected code, and existing tests. Preserve concurrent user work.
- Define acceptance criteria, likely files, test cases, and risks. Keep the plan
  proportionate and the scope minimal; clarify material ambiguities before edits.
- Follow the strict TypeScript and hexagonal layout: CLI inbound adapters in
  `src/adapter/in`, outbound adapters in `src/adapter/out`, application ports and
  use cases in `src/application/ports` and `src/application/usecases`, domain
  behavior in `src/domain`, and runtime profile cache utilities in `src/shared`.

## 2. Delegate implementation

Call `Task` with `subagent_type: execution`, supplying the scoped plan, acceptance
criteria, relevant files, existing user changes, and validation boundaries.
Require the smallest complete change consistent with repository conventions.
Include test writing in this delegation, not in coordinator edits.

## 3. Create tests and verify functionality

Require the execution agent to add or update meaningful Jest/ts-jest tests in the
existing `test/*.test.ts` patterns, covering intended behavior and relevant error,
edge, and regression cases. For bug fixes, apply the `bugfixing` skill's test-first
workflow when applicable. Respect isolation patterns: temporary homes and dummy
credentials, no real clusters or personal profile storage. Focused checks may
help development but cannot replace full verification.

The coordinator calls `Task` with `subagent_type: local-ci-runner` to run each
mandatory command exactly, from the repository root:

```sh
npm run lint
npm run test
npm run build
```

Require actual results and exit status for each command, including any command
not run. The CI runner must not fix code. Return change-related failures to step
2; distinguish unchanged pre-existing or environmental failures and report them
as blockers, never silently accept them. After fixes, repeat the affected tests
and all three mandatory commands against the final changes.

## 4. Obtain a fresh independent review

After successful verification, the coordinator starts a **NEW** `Task` with
`subagent_type: code-reviewer`, without reusing a `task_id`. Request a detailed,
independent, read-only review of the actual diff, including relevant untracked
new files, surrounding context, acceptance criteria, and verification evidence.

Review correctness, CLI behavior and backward compatibility where relevant,
hexagonal architecture, security, error and edge cases, maintainability, and test
coverage. Require actionable findings with severity and file/line references,
plus an explicit approval or changes-needed disposition—not just a summary.

## 5. Resolve findings or finish

- Return actionable findings to step 2. Address valid findings through execution;
  explicitly explain any rejected finding and obtain a reviewer disposition on
  the remaining concerns.
- After changes, rerun affected tests and all mandatory CI commands, then obtain
  another fresh independent review as in step 4. Repeat until successful.
- Finish only when all checks pass, the final changes are approved, and no
  actionable findings or required work remain. Missing agents, failed checks,
  or unresolved requirements mean blocked or partial work, not completion.
- Report the change summary, actual command results, review outcome, and any
  limitations or blockers. Do not commit or push unless explicitly requested.
