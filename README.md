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

Store a named authentication configuration for future use:

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

Profile selection and OAuth authentication in other commands are future scope. Download commands still use their existing bearer-token configuration; stored profiles do not change download behavior. Library consumers can inject `homeDirectory` into `createDefaultCamundaCli` or `JsonProfileRepositoryAdapter` for isolated storage, and provide `addProfileInPort` to `createCamundaCli` to handle the new command.

## Development

- `npm run lint` lints source and test files.
- `npm test` runs unit tests.

## Structure

- `src/adapter/in` contains inbound adapters such as the Commander CLI.
- `src/adapter/out` contains outbound adapters such as console presenters.
- `src/application/ports` contains inbound and outbound application ports.
- `src/application/usecases` contains application use cases.
- `src/domain` contains domain behavior.
