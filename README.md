# camunda-cli

camunda-cli is a TypeScript CLI for interacting with Camunda 8.

This initial setup provides:
- A Commander-based CLI entrypoint (`camunda-cli`).
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
camunda-cli download files
```

Download the latest content of one file to the current directory:

```bash
camunda-cli download file <file-id>
```

Download a specific saved version of one file:

```bash
camunda-cli download file <file-id> --version-id <version-id>
```

Both commands download to the current directory by default. Use `--destination-directory <path>` or `-d <path>` to choose another directory:

```bash
camunda-cli download files --destination-directory ./downloads
camunda-cli download file <file-id> -d ./downloads
```

Alternatively, pass the token directly to any download command with `--bearer-token <token>`.

The CLI targets Web Modeler REST API v1 at `https://modeler.camunda.io/api/v1` by default. Use `--modeler-api-url` to target a self-hosted Camunda 8 instance:

```bash
camunda-cli download files --modeler-api-url http://localhost:8070/api/v1
camunda-cli download file <file-id> --modeler-api-url http://localhost:8070/api/v1
```

Library consumers can pass `modelerApiBaseUrl` to `createDefaultCamundaCli` to change the default URL. Web Modeler API v1 is deprecated; future releases will migrate to the Camunda Hub API v2.

Downloads replace regular files with the same output name through a same-directory temporary file. The CLI refuses to replace symbolic links.

For local development, place command arguments after `--`:

```bash
npm start -- hello-world
npm start -- hello-world Camunda
npm start -- download file <file-id> --bearer-token <token>
```

After installing the package globally or using it through npm, the command name is `camunda-cli`:

```bash
camunda-cli hello-world
```

## Development

- `npm run lint` lints source and test files.
- `npm test` runs unit tests.

## Structure

- `src/adapter/in` contains inbound adapters such as the Commander CLI.
- `src/adapter/out` contains outbound adapters such as console presenters.
- `src/application/ports` contains inbound and outbound application ports.
- `src/application/usecases` contains application use cases.
- `src/domain` contains domain behavior.
