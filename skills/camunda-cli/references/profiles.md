# Profiles and authentication safety

## Select a profile safely

Ask the user for the intended cluster and stored profile name before live
requests. `--profile` is command-specific; there is no default profile or
`-p` alias. Names are trimmed and case-sensitive. The CLI provides no profile
listing, editing, or deletion command. Do not invent one or dump the profile
store to discover names.

Profiles default to `~/.lmoesle-camunda-cli/profiles.json`. A
`.lmoesle-camunda-cli/profiles.json` in the invocation's current working
directory overrides the entire home document. The CLI never searches ancestor
directories, merges documents, or falls back to home for a missing profile name.
`{ "profiles": [] }` selects an empty set of profiles. Only missing local storage
falls back to home; malformed, unreadable, or unsafe local storage fails instead.

`add profile` always appends to home storage and checks duplicates only there.
New home profiles remain hidden while the local override is active.

Both stores keep secrets in **plaintext**. Protect the files, directories, and
backups, and keep project profile configuration out of version control. Never
print, attach, commit, or paste the store into a conversation or log. Avoid exposing tokens
or sensitive API results as well. Ask users to configure credentials through
their own trusted local workflow; secret command arguments can appear in
shell history and process listings. Environment-variable substitution does
not remove the process-argument exposure. The CLI does not automatically
load connection credentials from environment settings.

## Create a profile

Read `camunda-cli add profile --help` first. The syntax is:

```text
camunda-cli add profile --name <name> --base-url <gateway-rest-root> [options]
```

Do not execute the placeholders literally. A unique name and `--base-url`
are required even for an Operate-only profile. Duplicate names fail instead
of overwriting. Creation stores configuration but does not test connectivity
or authentication.

| Flag | Purpose |
| --- | --- |
| `--client-id <id>` | OAuth client ID. |
| `--client-secret <secret>` | OAuth client secret; stored unencrypted. |
| `--oauth-url <url>` | Client-credentials OAuth token endpoint. |
| `--audience <audience>` | Gateway audience and legacy Operate fallback. |
| `--operate-audience <audience>` | Override the audience for Operate. |
| `--operate-url <url>` | Operate root for `api`, `incidents`, `migration-monitor`, and `migrate`. |
| `--zeebe-url <url>` | Stored only; current commands do not use it. |
| `--no-auth` | Store the JSON boolean `noAuth: true` to disable authentication. |

Use HTTP(S) service roots with any required SaaS cluster ID or reverse-proxy
prefix. Do not embed credentials, query parameters, or fragments. Gateway
commands (`add-variables`, `create-process-instance`, `deploy`, `incident retry`, and the gateway
part of `migrate`) use `baseUrl`; Operate commands use `operateUrl`. They do not fall
back to `zeebeUrl`. For migration, both roots must address the same cluster.

## Match authentication to the command

| Command | Authentication |
| --- | --- |
| `api`, `incidents`, `migration-monitor` | Require `--client-id`, `--client-secret`, and `--oauth-url` unless the profile sets `noAuth: true`. No Basic or cookie mode. |
| `add-variables`, `create-process-instance`, `deploy`, `incident retry`, `migrate` | Support OAuth; Self-Managed can omit all OAuth fields, including audiences, only when the relevant services intentionally allow unauthenticated access. This is not the default C8Run configuration. |
| `api ls`, help/version, `create-migration-bundle` | No cluster connection or profile needed. Bundling still writes a local file. |

When `noAuth` is false or omitted, supply all OAuth credential fields together; partial or blank configuration
fails when used. SaaS gateway commands require an audience, normally
`zeebe.camunda.io`; SaaS Operate requires one, normally `operate.camunda.io`.
For a shared SaaS migration profile, configure **both** `--audience` and
`--operate-audience` and grant access to both APIs.

Operate uses `operateAudience` when present, otherwise `audience`. A blank
override fails; it does not trigger fallback. Self-Managed OAuth can omit
audiences. Never substitute unsupported Basic authentication or an existing
browser session when OAuth configuration is missing.

## Deliberately unauthenticated services

Use `noAuth: true` only for services intentionally configured without authentication,
**not default C8Run**. Literal `true` overrides and ignores retained OAuth settings,
even partial or malformed ones. All cluster command families skip OAuth requests
and send no authentication headers. Required service URL validation still applies.
`noAuth: false` or an omitted field preserves existing behavior, including implicit
anonymous add-variables, create-process-instance, deploy, retry, and Self-Managed migrate with no OAuth fields.

Creation uses a fresh client-credentials token per invocation with the selected
profile's gateway audience. Literal `noAuth: true` skips that token request and
strips inherited authentication headers and cookies. It never falls back to
OAuth after an anonymous request fails. Creation uses neither Operate nor Zeebe,
offers no custom tenant selection, and does not relax mutation permission rules.

Example configuration for the user's trusted local setup:

```sh
camunda-cli add profile --name local --base-url http://localhost:8080 --operate-url http://localhost:8081 --zeebe-url http://localhost:26500 --no-auth
camunda-cli incidents --profile local
```

Equivalent entry in the `profiles` array:

```json
{"name":"local","baseUrl":"http://localhost:8080","operateUrl":"http://localhost:8081","zeebeUrl":"http://localhost:26500","noAuth":true}
```

Use a JSON boolean, not `"true"`. Select the profile explicitly with `--profile local`.
`zeebeUrl` stays stored-only; no endpoint defaults or fallbacks apply. This mode does
not relax the agent's read-only command restrictions.
