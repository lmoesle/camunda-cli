# Operate API usage

## Discover the operation and schema

```sh
camunda-cli api --help
camunda-cli api ls
```

`api ls` returns a JSON array of 20 supported read-only operations (12 GET reads
and 8 POST searches) from the pinned official Operate 8.7 OpenAPI document.
The upstream document and generated SDK retain 21 operations, including deletion;
they are not the supported CLI catalogue. Listing needs no profile or network request; do not
pass a request or `--profile`. Each entry contains `operationId`, `method`,
`path`, `summary`, `parameters`, and, where applicable, `requestBody` metadata.
Use the exact operationId, including suffixes such as `search_3`; do not use
generated client method names or infer an operation from a URL.

The catalogue supplies inline parameter schemas and body schema references.
Resolve a reference such as `#/components/schemas/QueryIncident` in the
document's `components.schemas`.


## Build the inline request envelope

```sh
camunda-cli api <operationId> '<request-json>' --profile <name>
```

Replace the angle-bracket placeholders; do not type them. Shell examples use
POSIX single-quote syntax to pass the JSON as one argument. The request must
be an inline JSON object, **not `@file`, a file path, or stdin**. Even an
operation without parameters or a body requires `'{}'`.

| Section | Rules |
| --- | --- |
| `path` | Object with the exact endpoint placeholder names, such as `key` or `id`. Supply all required parameters. The CLI encodes each value as one URL segment. |
| `query` | Object with spec-defined query parameters. The current pin defines **none**; omit it or use `{}`. Do not invent query filters. |
| `body` | The actual JSON body. Put filters, `size`, and `sort` here for searches, not in `query` or another body wrapper. |

Only these three envelope sections exist. Omit `body` to send no body.
Explicit `"body": null` is different: it must satisfy the schema, and the
current search object schemas reject it. Operations without a body schema
reject any supplied body. Empty `path` and `query` objects are optional;
`null` is not an object.

Unknown operationIds, envelope sections, and path/query names fail before
profile lookup, OAuth, or API requests. Validation follows referenced schemas,
types, enums, required fields, and signed int32/int64 ranges. Body properties
can remain allowed when the schema permits additional properties; successful
local validation does not guarantee the server accepts a request.

Supply integer fields as **JSON numeric literals**, not quoted strings.
Use exact decimal keys, for example `9007199254740993`. The CLI preserves int64
values in requests and responses without JavaScript number rounding. Avoid
constructing or re-parsing them with ordinary JavaScript `Number` or other
tools that round large JSON numbers; use lossless tooling end to end.

## Verified read-only patterns

First run `api ls` and confirm the selected profile. These examples use
placeholder resource keys and the profile name `local`:

```sh
# Read one process instance (instance key).
camunda-cli api byKey_1 '{"path":{"key":9007199254740993}}' --profile local

# One page of ACTIVE incidents; POST search is read-only.
camunda-cli api search_3 '{"body":{"filter":{"state":"ACTIVE"},"size":100,"sort":[{"field":"key","order":"ASC"}]}}' --profile local

# One page of process definitions.
camunda-cli api search_2 '{"body":{"size":10}}' --profile local

# Retrieve BPMN XML using a process definition key.
camunda-cli api xmlByKey '{"path":{"key":9007199254740993}}' --profile local
```

Other catalogue operations cover variables, flow-node instances, decision
definitions, decision requirements, and decision instances. Inspect their
schemas rather than reusing another resource's filter or key type.

## Pagination limits

`api` makes one operation call; it does **not** auto-paginate. A search result
is one page, not proof that you retrieved all matching records. Consult the
response and query schemas before planning more requests.

The pinned schema declares `searchAfter` array items as **objects**, while
some upstream examples show primitive cursor values. The CLI validates the
schema, not those contradictory examples. Do not blindly copy `sortValues`
into `searchAfter`, stringify numeric keys, invent cursor objects, or promise
complete pagination. If a required cursor conflicts with the schema, report
the limitation rather than claiming that an unsupported request will work.
For all ACTIVE incidents, consider the dedicated `incidents` command instead.

## Connection, output, and failures

- Execution requires a stored profile with `operateUrl`, `oAuthUrl`,
  `clientId`, and `clientSecret`, **even on Self-Managed**. See
  [profiles](profiles.md) for audience selection and credential safety.
- The CLI preserves reverse-proxy and cluster path prefixes and avoids
  duplicating a trailing `/v1`. Request JSON cannot override the origin,
  authentication, or headers. There is no arbitrary-URL API mode.
- Requests time out after 30 seconds and do not follow redirects.
- Stdout contains one pretty-printed JSON value: parsed JSON with exact int64
  numbers, a JSON string for text/XML, or `null` for an empty response.
  Decode the JSON string if you need XML; redirecting stdout alone does not
  produce a raw BPMN XML file. Startup notices and errors go to stderr.
- On errors, share only sanitized diagnostics. Verify inputs and profile
  configuration without exposing secrets. Do not work around rejected operations.

## Read-only boundary

Select only supported operations from `api ls`. The CLI explicitly approves
reviewed operationId/method/path tuples, not all GETs or arbitrary POST searches.
The eight POST searches read data without changing cluster state. OAuth uses POST
for authentication and remains supported.


