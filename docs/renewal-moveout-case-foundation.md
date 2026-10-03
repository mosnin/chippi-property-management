# Extracted module documentation

This historical implementation report describes local record foundations, not a standalone deployed product. The current extraction acceptance is in verification.md. Production, legal, provider and real-model acceptance remains open.

# Renewal and move-out case foundation

DOM-04a · 2026-10-03 · Existing application session, sole writer.

**Implemented and verified through isolated Convex handlers and mocked signed transport. Full DOM-04 remains open.** These administrative records support preparing and reviewing proposed renewal terms or selected before/after condition observations. They do not send notices, renew a contract, determine damage liability, authorize deductions/refunds, make housing eligibility decisions or move money.

## Saved work and authority

`apps/web/convex/lease_cases.ts` reuses current rental/occupancy validation, space membership, document-source checks and the existing immutable rental command/audit journal. Three space-indexed tables save case heads, submitted packets and human administrative decisions. It adds no parallel job engine, provider outbox, schedule or agent write grant.

Cases reference the original recorded executed agreement, property/unit and optional occupancy; move-out requires occupancy. Current accepted/scanned document metadata and execution proof must still match. Original agreement and current proposal remain separate. Planned dates need an explicit source; no jurisdiction deadline is inferred. Selected condition observations preserve before/after facts and missingness without calculating liability or deductions.

Lifecycle: collecting → awaiting review → administrative review recorded; explicit hold, rejection/correction, cancellation and reopen are supported. A current record-workspace member is required before saving a packet and before approval. Rejection/correction retains old packets and decisions. Changed instructions, membership, proposal terms, occupancy, original agreement, scan/source or saved outcome invalidate dependent review. Occupancy can refresh only explicitly while the original agreement remains current; original agreement changes cannot be adopted through that operation. Cancellation removes current approval; an active replacement prevents reopening the cancelled case.

The existing signed CRM gateway exposes read-only `leaseCases`, complete by-ID references or scoped pages of 1–20. It returns readable subjects/terms, planned dates, source/packet/review states, accountable next action and explicit limits. Malformed record/workspace references fail rather than silently returning a default page. Inquiry-only delegated grants still reject this broader query. Agent tool guidance describes the distinction between saved preparation and actual business completion.

Every read retains `businessCompletionState: not_verified`, `noticeDeliveryState: not_verified`, `jurisdictionRuleState: not_activated`, and unauthorized financial/contractual actions. An administrative human record is not independent legal, physical-condition or provider verification. A model's statement is not completion evidence.

## Verification

| Check | Actual result / boundary |
| --- | --- |
| Full web unit/in-memory backend suite | **1,119/1,119**, 113 files, exit 0, no failed/skipped tests or suites. **27 new + 1,092 existing**. Existing unrelated long-timer warnings remain. |
| Case-specific suite | **27/27**, including personal renewal and move-out plus team/brokerage-owned renewal flows. Four saved administrative-review flows pass; **zero verified external business outcomes**. |
| Paired original/current falsifiers | Frozen draft **0/5**, repaired **5/5** with identical fixture/data/oracles, 22 unselected in each. Covers proposal mutation, duplicate reopened case, revoked assignee before submission, cancelled approval and malformed workspace fallback. |
| Agent transport | **36/36** mocked-HTTP authority tests; one added case query. This is not a real model or provider run. |
| Types / static checks | Web and Convex no-emit types; nine-file scoped ESLint; two-file agent Biome; offline codegen and whitespace pass. No application schema activation. |
| Current native/model/provider/browser | **Not run.** No large model rerun, live effect, intended-account seed or rendered change. Native disk headroom last observed **896,536 KiB**, below unchanged 2 GiB floor. |

Failures are retained: initial 6/20 contained a nonexistent amendment-function fixture call and callbacks returning nonserializable assertion objects; corrected fixture then exposed three implementation gaps (17/20). Expanded shared tests 24/24; cancellation falsifier 26/27 then repaired; first malformed-workspace check fails before strict handling. Earlier focused regression **128/128** and first full **1,119/1,119** overlap final counts. Initial web type check exposed two union-narrowing fixture errors, repaired without casts or oracle changes. Default formatter invocation failed to resolve the existing Tailwind plugin from the root; an explicit TS-only config formatted only the two newly owned files, with no dependency/configuration change.

Runnable checks from the application checkout:

```sh
cd apps/web
node node_modules/vitest/vitest.mjs run tests/lease-cases.test.ts tests/rentals.test.ts tests/maintenance.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --maxWorkers=1
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex
node node_modules/eslint/bin/eslint.js convex/lease_cases.ts convex/rental_model.ts convex/rentals.ts convex/maintenance.ts convex/schema.ts convex/tenant.ts convex/workforce.ts tests/lease-cases.test.ts tests/rentals.test.ts
```

From the separate `agent/` workspace:

```sh
node node_modules/vitest/vitest.mjs run packages/adapters/src/chippi-authority.test.ts --maxWorkers=1
node_modules/.bin/biome check packages/adapters/src/builtin-tools.ts packages/adapters/src/chippi-authority.test.ts
```

Working evidence, negative trials, frozen baseline transform and final outputs: `.local/audit/orchestration/lease-cases/`. The dated immutable receipt links exact source/test/report hashes. Local fixture IDs are isolated and ephemeral; no customer account/database or real object was written.

## Remaining work

Full DOM-04 requires actual document ingestion/extraction and provenance, case/history UI with current source compliance, jurisdiction/broker-approved rules and applicable human review, supported notice/provider verification, occupancy reconciliation beyond these entered records, native coordinator/delegation follow-through, cancellation/recovery/endurance and production acceptance. Positive native concurrency/driver behavior is unverified. Default staff are not activated by these foundations. Finance/legal effects remain unsupported until their independent deterministic records, policies and authority are implemented and verified.

Next coherent local work: retain this foundation while completing original allowance/adoption/cumulative policy and business follow-through, and PX-00 capability/destination mapping plus PX-01 truthful job/result vocabulary from the [companion experience plan](product-simplification-and-experience-plan.md). Keys and customer login remain deferred. No current model allowance or provider permission is increased.

Final immutable receipt: 20261003T185837Z (historical local evidence retained in core).
