---
name: camunda-cli
description: Discover and use the camunda-cli command-line tool to query Camunda 8.7 Operate through its pinned API catalogue, configure connection profiles, inspect incidents, create process instances, deploy resources, and manage migrations or incident retries. Use for CLI usage, not CLI development.
---

# Use camunda-cli

Use **Node.js 24 or newer** and the package **`@lmoesle/camunda-cli`**.
This CLI targets Camunda 8.7; its `api` command exposes the pinned Operate 8.7
read-only API catalogue, not arbitrary Camunda endpoints or newer Orchestration Cluster APIs.

Before running any of the commands `create-process-instance`, `deploy`, `migrate` or `incident retry` ask the user for permission.

## Discover before executing

1. Check the executable and version:

   ```sh
   camunda-cli --version
   camunda-cli --help
   ```

   If needed, run `npx @lmoesle/camunda-cli --help` without installing, or
   install with `npm install -g @lmoesle/camunda-cli`. Replace `camunda-cli`
   in examples with `npx @lmoesle/camunda-cli` when using npx.
   Package acquisition can require network access.
2. Read command help, including nested help:

   ```sh
   camunda-cli api --help
   camunda-cli add profile --help
   camunda-cli incidents --help
   ```

   See [command discovery and catalogue](references/commands.md) for the
   available commands, exact flags, and limits. Do not invent flags.
3. For API work, run **`camunda-cli api ls` first**. It lists operations offline
   without a profile. Select the exact, case-sensitive `operationId`, inspect
   its method, path, and schemas, then follow [API usage](references/api.md).
4. Confirm the intended cluster and profile with the user. Follow
   [profiles and authentication safety](references/profiles.md). Do not print
   or attach the profile store, secrets, or access tokens.
5. Prefer read-only inspection. Before a mutation, obtain explicit user
   authorization for the target and action. Create-process-instance, deploy, migrate, incident retry,
   and API mutations have **no dry-run or confirmation prompt**.
6. Report the command, target, result, and limits without credentials or
   sensitive response data. Distinguish one API response page from a complete
   listing; inspect state before retrying a mutation with an uncertain outcome.

## Read-only API examples

After discovery and profile verification, replace `local` with the selected
profile and the example key with the actual resource key:

```sh
camunda-cli api ls
camunda-cli api byKey_1 '{"path":{"key":9007199254740993}}' --profile local
camunda-cli api search_3 '{"body":{"filter":{"state":"ACTIVE"},"size":100,"sort":[{"field":"key","order":"ASC"}]}}' --profile local
camunda-cli api xmlByKey '{"path":{"key":9007199254740993}}' --profile local
```

These read a process instance, search incidents, and retrieve a process
definition's BPMN XML, respectively. `xmlByKey` needs a **definition** key,
not an instance key. Search uses POST but does not mutate state.
Execution requires both inline request JSON and `--profile`; `api ls` accepts
neither. XML appears as a JSON string, not raw XML.

## Create a process instance

Only after explicit authorization for the target and action:

```sh
camunda-cli create-process-instance --id order-process --version -1 --variables '{"orderId":"A-123"}' --profile local
```

All four flags are required. Use an exact BPMN process ID, not a definition key;
use a deployed decimal version `1`–`2147483647` or `-1` for latest, not a version
tag. Variables must be an inline JSON object (`'{}'` is valid); large numbers
retain precision. The selected profile supplies gateway `baseUrl` and OAuth or
anonymous access, not Operate or Zeebe. No custom tenant selection is available.
Root `--version` prints the CLI version; the child option selects a process version.
Success confirms creation and the exact key, not completion. The CLI never waits,
polls, follows redirects, or automatically retries creation. Check cluster state
before rerunning an uncertain outcome. Do not expose sensitive variables in logs,
shell history, or process arguments. See [commands](references/commands.md) and
[profiles](references/profiles.md) for validation and authentication details.

## Install this skill

Copy this entire `camunda-cli/` directory, including `references/`, into your
agent's skill directory, for example `.opencode/skills/camunda-cli/` or
`.agents/skills/camunda-cli/` in a project. The repository's root `skills/`
directory does not auto-load in OpenCode, and the npm package ships `dist/`,
not this skill. Keep the references alongside `SKILL.md` when copying it.
