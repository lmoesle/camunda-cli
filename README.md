# npx @lmoesle/camunda-cli

npx @lmoesle/camunda-cli is a TypeScript CLI for interacting with Camunda 8.

This initial setup provides:
- A Commander-based CLI entrypoint (`npx @lmoesle/camunda-cli`).
- A hexagonal project structure with `adapter`, `application`, and `domain` layers.
- Commands for downloading files from Camunda 8 Web Modeler.
- TypeScript build with `webpack`.
- npm scripts for build, lint, and test.

## Setup

Use Node.js 24 or newer.

```bash
npm install
```

## Build

```bash
npm run build
```

The bundled CLI is emitted to `dist/bin/camunda-cli.js`. The package library entrypoint is emitted to `dist/index.js`.

## Run

Generate a Web Modeler JWT access token with file read permissions. Pass the token without the `Bearer` prefix. Provide it through `CAMUNDA_MODELER_BEARER_TOKEN` to keep it out of process listings. For example, read it without displaying or recording the value:

```bash
read -rsp 'Web Modeler bearer token: ' CAMUNDA_MODELER_BEARER_TOKEN
export CAMUNDA_MODELER_BEARER_TOKEN
```

Download the latest content of every Web Modeler file to the current directory:

```bash
npx @lmoesle/camunda-cli download files
```

Download the latest content of one file to the current directory:

```bash
npx @lmoesle/camunda-cli download file <file-id>
```

Download a specific saved version of one file:

```bash
npx @lmoesle/camunda-cli download file <file-id> --version-id <version-id>
```

Both commands download to the current directory by default. Use `--destination-directory <path>` or `-d <path>` to choose another directory:

```bash
npx @lmoesle/camunda-cli download files --destination-directory ./downloads
npx @lmoesle/camunda-cli download file <file-id> -d ./downloads
```

Alternatively, pass the token directly to any download command with `--bearer-token <token>`.

The CLI targets Web Modeler REST API v1 at `https://modeler.camunda.io/api/v1` by default. Use `--modeler-api-url` to target a self-hosted Camunda 8 instance:

```bash
npx @lmoesle/camunda-cli download files --modeler-api-url http://localhost:8070/api/v1
npx @lmoesle/camunda-cli download file <file-id> --modeler-api-url http://localhost:8070/api/v1
```

Library consumers can pass `modelerApiBaseUrl` to `createDefaultCamundaCli` to change the default URL. Web Modeler API v1 is deprecated; future releases will migrate to the Camunda Hub API v2.

Downloads replace regular files with the same output name through a same-directory temporary file. The CLI refuses to replace symbolic links.

For local development, place command arguments after `--`:

```bash
npm start -- hello-world
npm start -- hello-world Camunda
npm start -- download file <file-id> --bearer-token <token>
```

After installing the package globally or using it through npm, the command name is `npx @lmoesle/camunda-cli`:

```bash
npx @lmoesle/camunda-cli hello-world
```

## Stored profiles

Store a named authentication configuration:

```bash
npx @lmoesle/camunda-cli add profile --name local --base-url xxx
```

Only `--name` and `--base-url` are required. The CLI accepts non-whitespace strings without enforcing URL schemes or requiring a particular combination of authentication fields. It trims profile names and compares them case-sensitively. Adding an existing name fails without replacing the profile; `local` and `Local` are distinct names. It preserves other field values, including whitespace in secrets.

Use optional fields to store a complete configuration (the values below are placeholders, not real credentials):

```bash
npx @lmoesle/camunda-cli add profile --name remote --base-url https://camunda.example \
  --client-id example-client --client-secret dummy-secret --audience example-audience \
  --oauth-url https://auth.example/token --operate-url https://operate.example \
  --zeebe-url zeebe.example:26500
```

| CLI flag | JSON key |
| --- | --- |
| `--name` | `name` |
| `--base-url` | `baseUrl` |
| `--client-id` | `clientId` |
| `--client-secret` | `clientSecret` |
| `--audience` | `audience` |
| `--oauth-url` | `oAuthUrl` |
| `--operate-url` | `operateUrl` |
| `--zeebe-url` | `zeebeUrl` |

The CLI stores profiles in `~/.lmoesle-camunda-cli/profiles.json`, under your home directory, not the current directory. It omits unspecified optional fields and appends profiles in order:

```json
{"profiles":[{"name":"local","baseUrl":"xxx"}]}
```

**Security:** Secrets are unencrypted cleartext. On POSIX systems, the CLI restricts the managed directory to mode `0700` and newly written profile files to mode `0600`; it refuses symbolic-link configuration directories and files. These permissions are not encryption and do not protect against privileged users or exposed backups. Passing a secret as a CLI argument can expose it through shell history and process listings. Do not use real credentials in shared terminals or logs, and protect the stored file and its backups.

Writes use a temporary file and atomic replacement. Invalid or unreadable existing storage fails without overwriting it. Concurrent additions use an exclusive `profiles.lock` file; retry if another addition holds the lock. If a process crashes and leaves a lock, remove it only after confirming no addition is running.

At startup, the CLI validates and loads `~/.lmoesle-camunda-cli/profiles.json` before running commands, including help and version requests. If the directory or file does not exist, it continues with an empty cache and prints this notice once:

```text
Please add a profile with the add profile command.
```

Loading never creates storage. An existing configuration with an empty `profiles` array does not trigger the notice. Invalid, unreadable, or symbolic-link storage stops startup with a safe error without printing credentials.

Each default CLI runtime owns a shared in-memory startup snapshot. Queries preserve profile order and values, return defensive copies, and match trimmed names case-sensitively without reading disk. The `add profile` command writes configuration only; the current runtime's cache stays unchanged. New profiles and external file edits become visible at the next CLI invocation or when a new runtime initializes, not through automatic reloads.

`createDefaultCamundaCli` remains synchronous and returns a Commander-compatible runtime. Await its memoized `initialize()` before querying profiles; `parseAsync()` also initializes before command actions. Constructing the runtime or generating help with `helpInformation()` alone performs no I/O. `runDefaultCamundaCli` explicitly initializes before parsing, including help, version, and no-command invocations. The generic `createCamundaCli` dependency-injection factory does not initialize profile storage.

```typescript
import { createDefaultCamundaCli } from '@lmoesle/camunda-cli';

const cli = createDefaultCamundaCli();
await cli.initialize();
const profiles = cli.profiles.getProfiles();
const local = cli.profiles.getProfile('local');
// Use profiles in your application; do not log stored credentials.
```

Download commands still use their existing bearer-token configuration; stored profiles do not change download behavior. Library consumers can inject `homeDirectory` into `createDefaultCamundaCli` or `JsonProfileRepositoryAdapter` for isolated storage, and provide `addProfileInPort` to `createCamundaCli` to handle the add command.

## Open incidents (Camunda 8.7)

Select a stored profile explicitly to list open incidents:

```bash
npx @lmoesle/camunda-cli incidents --profile remote
npx @lmoesle/camunda-cli incidents --profile remote --json
```

The command requires nonblank `operateUrl`, `oAuthUrl`, `clientId`, and `clientSecret` in the selected profile. Both URLs must use HTTP(S) without embedded credentials, query parameters, or fragments. Set `operateUrl` to the service root (including the SaaS cluster ID or reverse-proxy path), or to that root followed by `/v1`. The CLI preserves path segments and ignores trailing slashes. It does not fall back to `baseUrl`, `zeebeUrl`, environment variables, or default endpoints.

Set a nonblank `audience` for SaaS profiles: the CLI requires it when the Operate hostname ends in `.operate.camunda.io` or the OAuth hostname is `login.cloud.camunda.io`. Operate SaaS uses `operate.camunda.io`; the CLI sends your configured audience unchanged. Self-Managed profiles can omit `audience`, but a supplied audience must not be blank. The command obtains a bearer token with an OAuth client-credentials form request to `oAuthUrl`, preserves secret bytes, disables redirects, and keeps the token only in memory for that invocation. Requests time out after 30 seconds; authentication or request failures abort without retries or partial output.

“Open” means Operate state `ACTIVE`, excluding `RESOLVED`, `MIGRATED`, and `PENDING`. The command uses the stable [Operate v1 incident search API](https://docs.camunda.io/docs/8.7/apis-tools/operate-api/specifications/search-3/) (`POST /v1/incidents/search`), not the v2 alpha API. It lists every matching incident visible to the credentials, without process or tenant filters, and follows the complete `sortValues` cursor until an empty page, regardless of reported totals or short pages.

The default table shows incident key, process-instance key, job key (`-` when absent), type, creation time, and the full message. It escapes terminal controls and newlines visibly. `--json` prints one JSON array (`[]` when empty), preserves original messages, and represents int64 key fields as exact decimal strings. JSON omits `jobKey` for non-job incidents. The CLI sends startup notices for incidents to stderr and writes no successful output until every page succeeds. Library consumers can inject `writeDiagnostic` separately from `writeLine`, or supply `listIncidentsInPort` to `createCamundaCli`.

### Retry a job incident

Fix the underlying cause, then use the incident and job keys from the listing:

```bash
npx @lmoesle/camunda-cli incident retry --incident 9007199254740993 --job 9007199254740999 --profile remote
```

All three options are required. Keys must be positive base-10 signed-int64 identifiers (1–9223372036854775807); the CLI trims surrounding whitespace and normalizes leading zeros without losing precision. This command supports job incidents only. Supply the job belonging to the incident; the CLI does not look up or verify that relationship.

Set the profile's `baseUrl` to the HTTP(S) REST gateway root, including any cluster or reverse-proxy prefix, optionally ending in `/v2`. Trailing slashes are ignored. URLs must not contain credentials, query parameters, or fragments. Retry does not use `operateUrl`, `zeebeUrl`, or environment fallbacks. For OAuth, configure nonblank `oAuthUrl`, `clientId`, and `clientSecret`; a supplied `audience` must be nonblank. SaaS (`*.zeebe.camunda.io` or OAuth at `login.cloud.camunda.io`) requires an audience, typically `zeebe.camunda.io`. Credentials and audience are sent unchanged. For an explicitly unauthenticated gateway, omit **all** OAuth properties; partial or blank configuration fails before requests. Operate listing and gateway retry may require separate profiles because their OAuth audiences differ.

The CLI first [updates the job](https://docs.camunda.io/docs/8.7/apis-tools/camunda-api-rest/specifications/update-a-job/) with `PATCH /v2/jobs/<jobKey>` and `{"changeset":{"retries":3}}`. Only after success does it [resolve the incident](https://docs.camunda.io/docs/8.7/apis-tools/camunda-api-rest/specifications/resolve-incident/) with a bodyless `POST /v2/incidents/<incidentKey>/resolution`. Both endpoints accept the operation with an empty `204` response. The CLI authenticates once per invocation, disables redirects, and uses a 30-second timeout per request, without automatic retries or version fallback.

If the job update fails, the CLI does not resolve the incident. If resolution fails, job retries remain updated: no rollback occurs, and the failed request outcome may be uncertain. Check state before rerunning. “Retry requested” appears only after both operations succeed; it does not mean a worker has executed or completed the job. Startup notices go to stderr. Library consumers can supply the optional `retryIncidentInPort` dependency to `createCamundaCli`.

## Deploy resources (Camunda 8.7)

Deploy one file, a shallow directory, or a directory with subdirectories:

```bash
npx @lmoesle/camunda-cli deploy "models/order process.bpmn" --profile remote
npx @lmoesle/camunda-cli deploy models --profile remote
npx @lmoesle/camunda-cli deploy models --profile remote --recursive
# -r is an alias for --recursive
```

The required `--profile` selects a stored, case-sensitive profile. Set `baseUrl` to the HTTP(S) REST gateway root, including any cluster or reverse-proxy path prefix, or to that root followed by `/v2`. The CLI ignores trailing slashes and posts to `/v2/deployments`. URLs cannot contain embedded credentials, query parameters, or fragments. Deployment does not use `zeebeUrl`, `operateUrl`, or environment-variable fallbacks.

For OAuth, configure nonblank `oAuthUrl`, `clientId`, and `clientSecret`. A supplied `audience` must be nonblank; SaaS profiles (`*.zeebe.camunda.io` or OAuth at `login.cloud.camunda.io`) require it, typically `zeebe.camunda.io`. The CLI preserves credentials and audience unchanged and obtains one fresh client-credentials token per invocation. For example (dummy credentials only):

```bash
npx @lmoesle/camunda-cli add profile --name remote \
  --base-url https://bru-1.zeebe.camunda.io/your-cluster \
  --oauth-url https://login.cloud.camunda.io/oauth/token \
  --client-id dummy-client --client-secret dummy-secret --audience zeebe.camunda.io
```

For a gateway explicitly configured with authentication disabled, omit **all** OAuth fields:

```bash
npx @lmoesle/camunda-cli add profile --name local --base-url http://localhost:8080
npx @lmoesle/camunda-cli deploy models --profile local
```

This does not imply that default C8Run accepts unauthenticated requests. Cookie and Basic authentication are not supported. Partial or blank OAuth configuration fails before any request. Stored secrets remain unencrypted.

- Only regular files with exact, case-sensitive `.bpmn`, `.dmn`, or `.form` suffixes qualify. Directory scans skip other entries and symlinks, and never traverse symlink directories. Explicit symlinks, special files, unsupported files, missing/unreadable inputs, and directories with no eligible files produce errors before HTTP requests.
- The CLI discovers files in lexicographic path order before making requests, then reads and deploys them sequentially. It preserves each original basename and binary content without parsing or rewriting resources.
- **Each file has its own deployment POST and independent transaction.** Resources never share a request, even when they have the same basename. Cross-file same-deployment bindings cannot work with separate deployments; the CLI does not resolve dependencies or invent dependency ordering.
- Each successful deployment prints its path and exact deployment key immediately. A final summary appears only after all files succeed. On failure, the CLI stops, reports the failed file and success count, and leaves prior successes committed. A timeout or malformed response can leave the failed request's outcome uncertain; check the gateway before rerunning.
- OAuth and deployment requests disable redirects, time out after 30 seconds, and never retry automatically. Paths escape terminal controls visibly; startup notices for deploy go to stderr. Library consumers can provide `deployFilesInPort` to `createCamundaCli`.

## Development

- `npm run lint` lints source and test files.
- `npm test` runs unit tests.

## Structure

- `src/adapter/in` contains inbound adapters such as the Commander CLI.
- `src/adapter/out` contains outbound adapters such as console presenters.
- `src/application/ports` contains inbound and outbound application ports.
- `src/application/usecases` contains application use cases.
- `src/domain` contains domain behavior.
- `src/shared` contains the per-runtime profile cache and its read API.
