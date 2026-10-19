# Pinned Operate 8.7 OpenAPI

- Publisher: Camunda documentation contributors, `camunda/camunda-docs`.
- Version: the official `api/operate/version-8.7/operate-openapi.yaml` document (its internal API version is `1.0.0`).
- Commit: `5f4b195d9beba5c4cc3e9c6d2d4edc3bdbff894a`.
- Source: <https://raw.githubusercontent.com/camunda/camunda-docs/5f4b195d9beba5c4cc3e9c6d2d4edc3bdbff894a/api/operate/version-8.7/operate-openapi.yaml>.
- Upstream license: <https://docs.camunda.io/docs/reference/licenses/>

The YAML is an unchanged upstream download. The project's MIT license does not replace the upstream document's license.

## Generate the Axios clients

The repository pins `@openapitools/openapi-generator-cli` **2.41.0** in `package.json` and OpenAPI Generator **7.22.0** in `openapitools.json`. Install Node dependencies, then run from the repository root with Java 11+ available:

```sh
npm run generate:operate-api
```

This runs `openapi-generator-cli generate -g typescript-axios` against the downloaded YAML, using `generator-config.json`. The CLI may need network access to download the pinned generator JAR. Check in the resulting TypeScript under `src/adapter/out/generated/operate/`; never hand-edit it. Regeneration must leave that directory unchanged for the current pin.
