# Profiles and authentication safety

## Select a profile safely

Ask the user for the intended cluster and stored profile name before live
requests. `--profile` is command-specific; there is no default profile or
`-p` alias. Names are trimmed and case-sensitive. The CLI provides no profile
listing, editing, or deletion command. Do not invent one or dump the profile
store to discover names.

Profiles live in `~/.lmoesle-camunda-cli/profiles.json` and store secrets in
**plaintext**. Protect the file, directory, and backups. Never print, attach,
commit, or paste the store into a conversation or log. Avoid exposing tokens
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
| `--operate-url <url>` | Operate root for `api`, `incidents`, and `migrate`. |
| `--zeebe-url <url>` | Stored only; current commands do not use it. |

Use HTTP(S) service roots with any required SaaS cluster ID or reverse-proxy
prefix. Do not embed credentials, query parameters, or fragments. Gateway
commands use `baseUrl`; Operate commands use `operateUrl`. They do not fall
back to `zeebeUrl`. For migration, both roots must address the same cluster.

## Match authentication to the command

| Command | Authentication |
| --- | --- |
| `api`, `incidents` | Always require `--client-id`, `--client-secret`, and `--oauth-url`, including on Self-Managed. No unauthenticated, Basic, or cookie mode. |
| `deploy`, `incident retry`, `migrate` | Support OAuth; Self-Managed can omit all OAuth fields, including audiences, only when the relevant services intentionally allow unauthenticated access. This is not the default C8Run configuration. |
| `api ls`, help/version, `create-migration-bundle` | No cluster connection or profile needed. Bundling still writes a local file. |

Supply all OAuth credential fields together; partial or blank configuration
fails when used. SaaS gateway commands require an audience, normally
`zeebe.camunda.io`; SaaS Operate requires one, normally `operate.camunda.io`.
For a shared SaaS migration profile, configure **both** `--audience` and
`--operate-audience` and grant access to both APIs.

Operate uses `operateAudience` when present, otherwise `audience`. A blank
override fails; it does not trigger fallback. Self-Managed OAuth can omit
audiences. Never substitute unsupported Basic authentication or an existing
browser session when OAuth configuration is missing.
