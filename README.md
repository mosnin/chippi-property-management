# Chippi Property Management

Preserved optional domain module extracted from Chippi's local application source. This repository is **not a standalone runnable SaaS or activated business service**. It contains the implemented Convex handlers, original synthetic tests and additive integration fragments. Core Chippi deliberately excludes these capabilities.

Leases, recorded occupancies, attested rent entries, maintenance cases and administrative renewal/move-out review. No real rent collection, legal notices, deductions, eligibility decision, vendor dispatch or physical completion.

## Offline verification

Supply the local Chippi core checkout with its already installed dependencies:

```sh
node scripts/test-in-core.mjs /path/to/chippiv2
```

The script creates a new ignored `.local/fixture-*` directory, copies only the host Convex source, adds this module's schema/tenant/catalog fragments there, regenerates types offline, typechecks and runs the original tests. It never modifies the host, inherits provider credentials, installs dependencies, contacts a deployment, seeds an account or sends messages. Results and receipts remain local. Compatibility anchors fail explicitly when the host contract changes. The shared core authentication, source evidence and workforce authority implementation must remain intact; this is an extension contract, not replacement permission logic.

`provenance.json` records original hashes and the source baseline. These local additions were not present at the baseline commit. Integration fragments and finance support separation are adaptations; original source snapshots remain in the core's ignored local evidence. No unrelated app/template/customer data is exported. No new license grant is asserted; preserve existing source notices when extending this module.

See [verification](docs/verification.md) for observed results and remaining acceptance.
