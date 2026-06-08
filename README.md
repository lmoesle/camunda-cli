# camunda-cli

camunda-cli is a TypeScript CLI for interacting with the Camunda 7 REST API.

This initial setup provides:
- A Commander-based CLI entrypoint (`camunda-cli`).
- A hexagonal project structure with `adapter`, `application`, and `domain` layers.
- A first `hello-world` command.
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

```bash
npm start -- hello-world
npm start -- hello-world Camunda
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
