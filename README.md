# camunda-cli

camunda-cli interacts with Camunda 8 clusters to automates generic and/or time-consuming tasks. I created this mainly to fix chores I have to do constantly.

Currently camunda-cli supports camunda 8.7 clusters.

## Usage

Use **Node.js 24 or newer**. Run without installing or install globally to use the `camunda-cli` executable shown in the command examples below:

```sh
npx @lmoesle/camunda-cli <command>
npm install -g @lmoesle/camunda-cli
```

In usage blocks, `<...>` marks a value to replace and `[...]` marks optional input;
do not type the brackets. Quote values containing spaces.
All commands accept `-h, --help`. The root accepts `-V, --version` (uppercase `V`), which prints the CLI version.
`--profile` is command-specific, with no default profile or `-p` alias.
Deploy, migrate, and retry have no dry-run or confirmation prompt. Check your profile and inputs before running them.

### add profile

Store a uniquely named connection profile for cluster commands.

```sh
camunda-cli add profile --name <name> --base-url <url> [options]
```

| Flag | Description |
| --- | --- |
| `--name <name>` | Required, unique, trimmed, case-sensitive name; duplicates fail rather than overwrite. |
| `--base-url <url>` | Required gateway REST root for deploy, retry, and migrate. |
| `--client-id <id>` | Optional OAuth client ID. |
| `--client-secret <secret>` | Optional OAuth client secret, stored in cleartext. |
| `--audience <audience>` | Optional gateway OAuth audience; also the legacy Operate fallback. |
| `--operate-audience <audience>` | Optional Operate OAuth audience override. |
| `--oauth-url <url>` | Optional OAuth token endpoint for client-credentials authentication. |
| `--operate-url <url>` | Optional Operate service root; required by incidents and migrate. |
| `--zeebe-url <url>` | Optional stored Zeebe URL; current commands do not use it. |

Creating a profile does not test connectivity or authentication.
Profiles live in `~/.lmoesle-camunda-cli/profiles.json`. **Secrets are unencrypted**, and secret arguments can appear in shell history and process listings. Protect the file and its backups.

For cluster commands, use HTTP(S) service roots including any SaaS cluster ID or reverse-proxy path prefix, without embedded credentials, query, or fragment.
Cluster commands do not fall back to `--zeebe-url` or environment settings.

- **OAuth:** Supply all three of `--client-id`, `--client-secret`, and `--oauth-url`; partial or blank configuration fails at use. SaaS gateway commands require an audience, normally `zeebe.camunda.io`; SaaS Operate also requires an audience, normally `operate.camunda.io`.
  For a shared SaaS migration profile, set **both** `--audience` and `--operate-audience` and grant access to both APIs. Self-Managed OAuth can omit audiences; incidents and Self-Managed migration use `--audience` when no Operate override is present.
- **No authentication:** Self-Managed deploy, retry, and migrate can omit all OAuth fields (including audiences) only when the relevant services are intentionally configured without authentication. This does not describe default C8Run.
  **Incidents always requires OAuth**, even on Self-Managed. Cookie and Basic authentication are not supported.

### deploy

Deploy each eligible resource file independently to the selected cluster.

```sh
camunda-cli deploy <path> --profile <name> [--recursive]
```

`<path>` is a required file or directory; only regular files with exact,
case-sensitive `.bpmn`, `.dmn`, or `.form` suffixes qualify.

| Flag | Description |
| --- | --- |
| `--profile <name>` | Required stored, case-sensitive profile name; uses its gateway REST root and authentication. |
| `-r, --recursive` | Include subdirectories; defaults to a shallow directory scan. |

Directory scans skip symlinks; explicitly supplied symlinks are rejected.
**Each file uses a separate deployment request and transaction**, so cross-file same-deployment bindings are unsupported.
Deployment stops on the first failure; earlier successes remain committed. Check cluster state before rerunning if the failed request's outcome is uncertain.

### migrate

Migrate all ACTIVE instances of each selected source definition, including instances with incidents.

```sh
camunda-cli migrate --profile <name> --migrationPlan <json-or-path>
```

| Flag | Description |
| --- | --- |
| `--profile <name>` | Required stored, case-sensitive profile name; gateway and Operate roots must address the same cluster. |
| `--migrationPlan <json-or-path>` | Required nonempty inline JSON array or UTF-8 JSON file path, absolute or relative to the current directory; the file must be regular and not a symlink. Capital `P` is required; there is no `--migration-plan` alias. |

For example, pass this array as a quoted inline value or save it in a JSON file:

```json
[
  {
    "processDefinition":"order-process",
    "sourceVersion":1,
    "targetVersion":2,
    "mappingInstructions":
    [
      {
        "sourceElementId":"Task_Old",
        "targetElementId":"Task_New"
        }
    ]
  }
]
```

- `processDefinition` is the exact BPMN process ID, not a definition key. Source and target must each resolve to exactly one visible definition and belong to the same tenant.
- Versions are **deployment versions, not version tags**: integers from `1` to `2147483647`, or strings such as `"1"` or `"v1"`; source and target must differ.
  Mappings use element IDs from the corresponding versions; an empty `mappingInstructions: []` is allowed.
- The CLI validates the plan and discovers **all plans before any mutation**.
  Chained plans use initial snapshots: a `v2 -> v3` plan does not pick up instances newly moved by a preceding `v1 -> v2` plan.

### incidents

List all ACTIVE incidents visible to the selected profile's Operate credentials.

```sh
camunda-cli incidents --profile <name> [--json]
```

| Flag | Description |
| --- | --- |
| `--profile <name>` | Required stored, case-sensitive profile name with Operate root, OAuth token URL, client ID, and client secret, even on Self-Managed; no no-auth mode. |
| `--json` | Print a JSON array instead of the default table; key fields are decimal strings to preserve precision. |

The listing has no process or tenant filter. Non-job incidents have no job key.

### incident retry

Set a failed job's retries to 3, then request resolution of its incident.

```sh
camunda-cli incident retry --incident <incidentKey> --job <jobKey> --profile <name>
```

| Flag | Description |
| --- | --- |
| `--incident <incidentKey>` | Required positive decimal int64 incident key (`1`–`9223372036854775807`). |
| `--job <jobKey>` | Required matching job key, with the same decimal int64 range; the CLI does not verify the relationship. |
| `--profile <name>` | Required stored, case-sensitive profile name; uses its gateway REST root and authentication, not Operate. |

Fix the underlying cause first; only job incidents are supported. The retry count is fixed, with no adjustable flag.
If resolution fails after the job update, retries remain updated with no rollback. Check state before rerunning.
Success means the requests were accepted, **not that the job completed**.

### Help and version

Show command help or the installed CLI version.

```sh
camunda-cli --help
camunda-cli help deploy
camunda-cli --version
```

`help [command]` covers direct children of the current command; use nested help as shown for subcommands. `add`, and `incident` are command groups, not standalone actions.
Use `-h, --help` on any command and root `-V, --version`; there is no `version` subcommand or lowercase `-v` alias.
