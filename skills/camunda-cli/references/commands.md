# Command discovery and catalogue

Use the installed CLI as the first discovery source:

```sh
camunda-cli --version
camunda-cli --help
camunda-cli help deploy
camunda-cli api --help
camunda-cli add profile --help
camunda-cli incident retry --help
```

All commands accept `-h, --help`. Only the root accepts `-V, --version`
(uppercase `V`); there is no `version` subcommand or lowercase `-v` alias.
`help [command]` covers direct children; use nested help for subcommands.
`add` and `incident` are groups, not standalone actions.

In syntax below, replace `<...>` and omit optional `[...]` brackets. Quote
values containing spaces. Every cluster command requires explicit
`--profile <name>`; there is no `-p` alias or default profile.

| Command syntax | Purpose and cautions |
| --- | --- |
| `api ls` | Offline pinned Operate operation catalogue; accepts neither request nor profile. |
| `api <operationId> <request-json> --profile <name>` | Execute a pinned Operate operation; see [API usage](api.md). Inline request required; mutation operations run immediately. |
| `add profile --name <name> --base-url <url> [options]` | Store connection settings; see [profiles](profiles.md). Writes plaintext credentials locally, without testing them. |
| `incidents --profile <name> [--json]` | List all visible ACTIVE incidents through Operate. Requires OAuth even on Self-Managed. Default output is a table; JSON key fields are decimal strings to preserve precision. No process or tenant filter; non-job incidents have no job key. |
| `migration-monitor --profile <name>` | One-shot read-only Camunda 8.7 report of processes with ACTIVE instances older than the latest visible deployed numeric version (even if that version has no instances). Counts incident-bearing ACTIVE instances. Shows name, BPMN process ID, latest version, total active count across versions, and Number of outdated instances (total active instances on older versions, excluding the latest); separates tenants. Never migrates. |
| `deploy <path> --profile <name> [-r\|--recursive]` | Deploy eligible local files independently. Mutates the cluster. |
| `migrate --profile <name> --migrationPlan <json-or-path>` | Migrate ACTIVE instances of selected source definitions, including instances with incidents. Mutates the cluster. Capital `P` matters; no `--migration-plan` alias. |
| `create-migration-bundle --sourceDir <directory> [--target <file>]` | Recursively combine local migration plans; no profile or cluster required. Writes/replaces the target file. Capital `D` matters. |
| `incident retry --incident <incidentKey> --job <jobKey> --profile <name>` | Set the job's retries to 3, then request incident resolution through the gateway. Mutates the cluster; does not use Operate. |

## Migration monitor boundaries

The summary below the table totals active and outdated instances for displayed
processes only (those with outdated instances), not the entire cluster. An empty
report shows zero totals.

The selected profile needs
`operateUrl`, `oAuthUrl`, `clientId`, and `clientSecret`; no gateway is used.
`operateAudience` overrides `audience`, and SaaS requires an audience, as for
`incidents`. Discovery paginates all definitions and ACTIVE instances visible to
the profile, not just definitions with instances. Operate is eventually
consistent, not an atomic snapshot: missing or inconsistent data fails safely;
wait for indexing and retry rather than treating the failure as a clean report.

## Deploy boundaries

Only regular files with exact, case-sensitive `.bpmn`, `.dmn`, or `.form`
suffixes qualify. Directory scans are shallow unless `-r`/`--recursive` is
present. Scans skip symlinks; explicit symlinks fail.

Each file gets a separate deployment request and transaction. Do not promise
cross-file same-deployment bindings. Execution stops at the first failure;
earlier successes stay committed. Confirm authorization and review resources
before deploying. Inspect cluster state before retrying uncertain requests.

## Migration plans and bundles

`--migrationPlan` accepts a nonempty inline JSON array or a UTF-8 JSON file
path, absolute or relative to the current directory. File inputs must be
regular files, not symlinks. Example plan structure:

```json
[
  {
    "processDefinition": "order-process",
    "sourceVersion": 1,
    "targetVersion": 2,
    "mappingInstructions": [
      { "sourceElementId": "Task_Old", "targetElementId": "Task_New" }
    ]
  }
]
```

- `processDefinition` is the exact BPMN process ID, not a definition key.
  Source and target must resolve to exactly one visible definition each and
  belong to the same tenant.
- Versions mean deployment versions, **not version tags**. Use integers
  `1`–`2147483647` or strings such as `"1"`/`"v1"`. Source and target must differ.
- Use element IDs from the corresponding versions. An empty
  `mappingInstructions: []` is allowed.
- The CLI validates and discovers all plans before mutating anything.
  Chained plans use initial snapshots: a `v2 -> v3` plan does not pick up
  instances newly moved by a preceding `v1 -> v2` plan.

The bundle command recursively reads exact `.json` files under a non-symlink
source directory. Each input must contain a nonempty valid plan array. It
sorts file paths, preserves entry order, normalizes version strings, skips
symlinks/non-JSON files, and excludes the resolved target on reruns.

The default target is `bundled-migrations.json` inside the source directory.
A custom target is absolute or relative to the current directory; its parent
must exist. After validation, bundling atomically replaces a regular target
file. It rejects symlink/special-file targets. Invalid inputs, duplicate
process/source-version selectors, or no inputs fail without changing output.
Bundling does **not** perform migration or validate the cluster's definitions.

## Incident retry boundaries

Fix the underlying cause first. Only job incidents qualify. Supply the matching
incident and job keys as positive decimal int64 values
(`1`–`9223372036854775807`); the CLI does not verify their relationship.
The retry count is fixed at 3, with no adjustable flag.

If resolution fails after the job update, retries stay updated without
rollback. Success means the requests were accepted, not that the job
completed. Obtain authorization and inspect state before rerunning.

Deploy, migrate, retry, and API mutations provide **no dry-run or confirmation
prompt**. Treat partial or uncertain outcomes explicitly.
