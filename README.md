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
Deploy, migrate, and retry have no dry-run or confirmation prompt. Check your profile and inputs before running them. The `api` command supports only read-only cluster requests.

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
| `--operate-url <url>` | Optional Operate service root; required by api, incidents, and migrate. |
| `--zeebe-url <url>` | Optional stored Zeebe URL; current commands do not use it. |

Creating a profile does not test connectivity or authentication.
Profiles live in `~/.lmoesle-camunda-cli/profiles.json`. **Secrets are unencrypted**, and secret arguments can appear in shell history and process listings. Protect the file and its backups.

For cluster commands, use HTTP(S) service roots including any SaaS cluster ID or reverse-proxy path prefix, without embedded credentials, query, or fragment.
Cluster commands do not fall back to `--zeebe-url` or environment settings.

- **OAuth:** Supply all three of `--client-id`, `--client-secret`, and `--oauth-url`; partial or blank configuration fails at use. SaaS gateway commands require an audience, normally `zeebe.camunda.io`; SaaS Operate also requires an audience, normally `operate.camunda.io`.
  For a shared SaaS migration profile, set **both** `--audience` and `--operate-audience` and grant access to both APIs. Self-Managed OAuth can omit audiences; incidents and Self-Managed migration use `--audience` when no Operate override is present.
- **No authentication:** Self-Managed deploy, retry, and migrate can omit all OAuth fields (including audiences) only when the relevant services are intentionally configured without authentication. This does not describe default C8Run.
  **Incidents and api always require OAuth**, even on Self-Managed. Cookie and Basic authentication are not supported.

### api

List the **20 supported read-only operations** from the pinned official Operate 8.7 OpenAPI document, without a profile or network connection:

```sh
camunda-cli api ls
```

The JSON array includes each exact `operationId`, HTTP method, endpoint template, summary, and parameter/body schema references. Use the exact, case-sensitive `operationId` as the use case; names such as `search_3` come from the upstream document, not CLI aliases.

```sh
camunda-cli api <usecase> <request-json> --profile <name>

# Read a process instance; preserve the int64 key exactly.
camunda-cli api byKey_1 '{"path":{"key":9007199254740993}}' --profile local

# Search ACTIVE incidents (one response page; api does not auto-paginate).
camunda-cli api search_3 '{"body":{"filter":{"state":"ACTIVE"},"size":100,"sort":[{"field":"key","order":"ASC"}]}}' --profile local

# Retrieve BPMN XML as a JSON string.
camunda-cli api xmlByKey '{"path":{"key":9007199254740993}}' --profile local
```

Pass **inline JSON**, not a file path. The envelope accepts only these sections:

| Section | Meaning |
| --- | --- |
| `path` | Object mapping the endpoint's `{placeholder}` names to values. Required path parameters must be present; each value becomes one percent-encoded URL segment. |
| `query` | Object mapping spec-defined query parameter names to values. The pinned document currently defines **no query parameters**, so omit this section or use `{}`; unknown parameters fail. |
| `body` | The actual JSON request body, without another wrapper. Omit it to send no body. Explicit `null` is not omission and must satisfy the schema. |

For example, `{"path":{},"query":{},"body":{"size":10}}` invokes a search. Even operations without parameters or a body require a request envelope (`'{}'`). Unknown operationIds, envelope sections, and path/query parameters fail before OAuth or API requests. Validation follows the pinned schemas, including references, types, enums, and signed int32/int64 ranges. Additional body properties remain allowed where OpenAPI permits them. Supply integers as JSON numbers, not quoted strings; the CLI preserves their exact decimal value in requests and responses without JavaScript number rounding.

The pinned upstream schema declares `searchAfter` items as objects even though some upstream examples show primitive cursor values. Validation follows the schema, not those contradictory examples. `api` does not infer additional operations, correct upstream schemas, or use another API version.

Execution requires the selected profile's `operateUrl`, `oAuthUrl`, `clientId`, and `clientSecret`. `operateAudience` overrides the legacy `audience` fallback; SaaS requires an audience, while Self-Managed OAuth can omit it. The CLI preserves reverse-proxy/cluster path prefixes and avoids duplicating a trailing `/v1`. Request JSON cannot override the origin, authentication, or headers. Requests time out after 30 seconds and do not follow redirects.

Stdout contains one pretty-printed JSON value: parsed JSON (including lossless int64 numbers), a JSON string for text/XML, or `null` for an empty response. Startup notices and errors go to stderr.

`api` permits only explicitly reviewed operationId/method/path combinations: 12 GET reads and 8 read-only POST searches. OAuth also uses POST; neither authentication nor search changes cluster state. The upstream document and generated SDK retain all 21 operations, but `api ls` excludes deletion. The CLI rejects deletion and unapproved operations before parsing the request, looking up a profile, authenticating, or contacting the cluster. There is no override flag. For write, change, or delete support, [submit a feature request](https://github.com/lmoesle/camunda-cli/issues/new). Existing dedicated `deploy`, `migrate`, and `incident retry` commands remain unchanged; the camunda-cli agent skill must not execute them or use another HTTP client to bypass its read-only boundary.

For provenance, licensing, and regeneration instructions, see [the pinned spec README](resources/operate-8.7/README.md). The checked-in Axios clients come from `@openapitools/openapi-generator-cli generate`. Normal builds and tests run offline without Java; regeneration requires Java and may download the pinned generator. Tests check all 20 supported generated operation dispatches against the vendored document and verify rejection of deletion and unapproved operations.

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

### create-migration-bundle

Combine local migration plan files into one plan without a cluster connection or profile.

```sh
camunda-cli create-migration-bundle --sourceDir <directory> [--target <file>]
camunda-cli migrate --profile <name> --migrationPlan <directory>/bundled-migrations.json
```

| Flag | Description |
| --- | --- |
| `--sourceDir <directory>` | Required existing non-symlink directory; recursively discover regular files with the exact `.json` suffix. Capital `D` is required. |
| `--target <file>` | Optional output path, relative to the current working directory or absolute. Defaults to `bundled-migrations.json` inside sourceDir. The parent directory must already exist. |

Every input file must contain a nonempty migration plan array using the schema described under `migrate`.
The command sorts file paths, preserves each array's entry order, and normalizes version strings to numbers.
It skips symlinks and non-JSON files and excludes the resolved target path on reruns.
Invalid JSON, invalid plans, duplicate process/source-version selectors (including across files), or no input files fail without changing the output.
After validating all inputs and the combined plan, the command atomically replaces a regular target file using a temporary file in the same directory. Symlink and special-file targets are rejected.

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
