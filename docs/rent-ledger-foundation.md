# Extracted module documentation

This historical implementation report describes local record foundations, not a standalone deployed product. The current extraction acceptance is in verification.md. Production, legal, provider and real-model acceptance remains open.

# Recorded rent ledger foundation

Report timestamp: 2026-10-03T17:54:05.223695+00:00. DOM-02a is locally implemented and isolated-backend verified; DOM-02 remains partial and unattended rental/financial workflows remain unsupported.

## Product behavior

The existing rental service now records manually attested rent charges, observed payments, already-agreed credits and exact correction reversals. Every immutable entry retains its original executed lease version, accepted/scanned document fingerprint and revision, source reference/note, observed date, actor/time, sequence and transactional command/audit receipt. This records observed source facts; it creates no payment, contractual credit or collection action. Entered attestation is neither cryptographic human-presence proof nor provider verification.

A normal saved flow records a full entered periodic rent amount, partial payment, credit and reversal. Integer arithmetic computes their **recorded net only**, using checked integer inputs and BigInt accumulation. Reversal negates exactly the original amount/delta and retains it; double reversals, reversal chains and corrections predating the observation are refused. Executed amendments do not rewrite old entries. Mixed-currency accumulation, invented fees/proration, unsupported amount/period facts and overlapping unreversed charge periods are refused. Period/due dates are explicitly entered and document-attested; the software does not derive a legally governing billing schedule from free text or validate its legal meaning.

Exact retries return the original receipt after current scope/membership authorization; changed requests, normalized duplicate source references, concurrent stale revisions and future observations are refused. A changed document, scan, request or original execution source produces a review hold. Persisted amount/period/date/sequence/reference/reversal/version corruption cannot yield a reassuring balance. Shared public facts are unrelated to these private customer records; access reuses existing personal/team/brokerage scope resolution and space-first indexes.

The existing signed CRM gateway and typed agent query now expose **read-only `rentLedger`**. A complete permitted lease reference is required; pages are 1–20 records. Inquiry-only grants stay restricted. No new financial action tool, standing permission or orchestration engine is added. Reads show source state, immutable lease version, dated facts, recorded net, an actionable reconciliation instruction, **completeness unknown** and **authoritative balance null**. Empty records do not mean all clear. No object keys or document digests are returned to the agent/customer context.

Coverage is explicitly bounded to 500 entries per lease. Reads use a 501-row probe and refuse larger history; new posts stop at the limit. This is a foundation constraint, not complete ledger archival/reconciliation support. Changed agreement currency requires separate reviewed reconciliation rather than conversion or mixing.

## Exact verification

- Full web unit/in-memory integration: **1,059/1,059**, no failed/skipped tests/suites, success true, exit 0. **31 new ledger + 37 prior rental + 991 other existing checks.** Includes actual Convex mutation/query and signed-gateway handlers in isolated fixtures; it is not hosted Convex/native agent execution.
- Agent scoped transport/authority: **34/34**, one new rentLedger mocked-HTTP case + 33 existing. No model/provider transport.
- One personal saved record flow: four immutable entries and four command/audit receipts, original correction retained, **zero outbox/workforce events**. Existing team/brokerage fixtures now verify scoped empty-ledger reads, private exclusion and membership revocation. Shared ledger posting/source ingestion has not been end-to-end accepted.
- Initial domain **56/56**; inconsistent saved-fact falsifiers **0/3**, repaired **59/59** retaining the refusal oracles. Expanded **65/66** had a test callback incorrectly returning a circular Vitest assertion object to Convex; fixed callback returns no value, not weakened assertions. Corrected **66/66**. Persisted future observation falsifier **0/1** retained; latest full suite passes its unchanged refusal oracle. Earlier full **1,057/1,057** preceded that final two-case addition. Counts overlap.
- Web/Convex types, scoped ESLint, agent Biome and whitespace pass. Initial web type failure used a BigInt literal unsupported by the web compiler target; replaced with `BigInt(0)`, preserving exact arithmetic. No dependency or compiler-target change.
- Existing long-future Convex test timer warnings remain in other fixtures; no scheduler/endurance acceptance is inferred. No current native PostgreSQL, real-model, live-provider, browser/UI, intended-account or hosted/release/endurance test ran. Latest headroom **961,248 KiB**, below unchanged **2 GiB** native guard; no redundant allocation attempt.

## Evidence and executable checks

Frozen source/results/negative evidence (historical local evidence retained in core). Working evidence: `.local/audit/orchestration/rent-ledger/`. Prior rental source and receipt stay intact. All writes are isolated in-memory synthetic fixtures; no application schema activation/database write, customer seeding, external effect or financial action.

Commands: from `apps/web`, one-worker full Vitest with JSON receipt; scoped ESLint on rentals/schema/workforce/rental tests. From root, web/Convex `tsc --noEmit`; offline Convex codegen. From `agent`, one-worker chippi-authority Vitest and two-file Biome. `git diff --check`. Commands/logs and failed results are retained locally; no secrets or raw private runtime logs appear in this report.

## Remaining acceptance and next owned action

DOM-02 remains open: complete authorized source-ledger import/reconciliation and allocation/dispute status, reporting completeness evidence, recorded human posting policy, correction lifecycle/archival beyond 500 entries, reviewed billing/proration rules, deposit/trust/finance services, polished UI, real ingestion/provider reconciliation and native coordinator/delegation follow-through. No collection, eligibility, notice, deductions or payment staff is activated. Model-written success is insufficient.

Next coherent implementation: versioned maintenance/work-order records with scoped assignment, lifecycle and completion evidence, without contacting vendors, spending or overriding human housing/legal/financial decisions. Then verify existing-runtime domain follow-through when native test capacity permits. Positive cumulative model-budget adoption/period/debt policy, actual recurring business execution, polished first useful onboarding and production/endurance gates remain open.

Customer login/seeding and Census ACS/Geoapify keys/live setup stay deferred; existing adapters/fixtures retained and live configuration unverified. FHFA/NWS previous code/smoke evidence retained without new live acceptance. Wasabi/Cloudflare and separate website unchanged. Model envelope **590,319/600,000**, historical listing **0/1 delegated versus 0/1 baseline**, no large rerun. No dependency, spending, credentials/grants/security permission, push/merge/publish/deploy, communications/bookings or money movement. Goal remains active; no production checkbox or completion percentage advances.
