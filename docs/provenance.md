# Source inventory

## Runtime

The maintained runtime lives in `cmd`, `internal`, `sdk`, `extensions` and `web`. Tests import the actual TypeScript SDK and adapter, and exercise the Go service against PostgreSQL. Implementation and documentation were developed with assistance from Codex.

## Reference profiles

`profiles/reference` contains the Pi security profile, full-stack profile and shared profile loader. The collection includes tool implementations, role prompts, schemas and technical skills. These files are not loaded by the maintained extension or included in the coordinator image.

The import excludes runtime state, examples and legacy tests. Personal model/provider overrides were removed, a token-shaped authentication example was replaced with a placeholder, and trailing whitespace was normalized. `profiles/manifest.json` records the SHA-256 digest of every transformed file.

Some reference tools use JSON-file persistence or incomplete scope interception. Consult [security boundaries](security.md) before adapting them. The maintained coordinator is the supported task storage path.

## Licensing

No redistribution license has been granted for the collected profile material. Review third-party provenance before publishing or redistributing it. The manifest is an integrity inventory, not a license or an authorship assertion.
