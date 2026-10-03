import { canonicalTimeZone, localDateKey } from "./availability"
import { v, type Infer } from "convex/values"
import { paginationOptsValidator } from "convex/server"
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { requireUserId, assertInSpace, NotFound } from "./tenant"
import { resolveWorkforceScope, spacesFor } from "./workforce_scope"
import {
  rentalScope,
  leaseTerms,
  rentalDate,
  validateLeaseTerms,
} from "./rental_model"
import { evidenceVersion } from "./source_evidence"
import { cleanDocument } from "./document_scan_state"
import { requiredText } from "./record_validation"

type Ctx = MutationCtx | QueryCtx
type Scope = Infer<typeof rentalScope> | undefined
const scopeArgs = { scope: v.optional(rentalScope) }
const commandArgs = { ...scopeArgs, requestId: v.string() }
const reviewed = v.literal("I verified the signatures and the recorded terms")

async function access(ctx: Ctx, scope: Scope) {
  const actorId = await requireUserId(ctx)
  const principal = await resolveWorkforceScope(
    ctx,
    actorId,
    scope?.kind ?? "personal",
    scope?.id ?? actorId
  )
  return { actorId, spaces: await spacesFor(ctx, principal) }
}
async function owned<
  T extends "properties" | "rentalUnits" | "leases" | "occupancies",
>(ctx: Ctx, id: Id<T>, allowed: Id<"spaces">[]): Promise<Doc<T>> {
  const row = await ctx.db.get(id)
  if (!row || !allowed.includes(row.spaceId)) throw new NotFound()
  return row
}
async function unitSource(ctx: Ctx, unit: Doc<"rentalUnits">) {
  await assertInSpace(ctx, "properties", unit.propertyId, unit.spaceId)
}
async function observedDate(
  ctx: Ctx,
  unitId: Id<"rentalUnits">,
  spaceId: Id<"spaces">,
  value: string
) {
  const unit = await assertInSpace(ctx, "rentalUnits", unitId, spaceId)
  const timeZone = canonicalTimeZone(unit.timeZone)
  if (!timeZone)
    throw new Error(
      "Confirm the unit time zone before recording an observed date"
    )
  const day = rentalDate(value)
  if (day > localDateKey(new Date(), timeZone))
    throw new Error(
      "An observed date cannot be in the future. Keep planned work separate."
    )
  return day
}
async function parties(
  ctx: Ctx,
  spaceId: Id<"spaces">,
  terms: Infer<typeof leaseTerms>
) {
  for (const id of [...terms.tenantContactIds, ...terms.landlordContactIds])
    await assertInSpace(ctx, "contacts", id, spaceId)
}
async function version(
  ctx: Ctx,
  lease: Doc<"leases">,
  id: Id<"leaseVersions"> | undefined
) {
  if (!id) throw new Error("No recorded lease version")
  const row = await assertInSpace(ctx, "leaseVersions", id, lease.spaceId)
  if (row.leaseId !== lease._id) throw new NotFound()
  await parties(ctx, lease.spaceId, row.terms)
  return row
}
export function revision(actual: number, expected: number) {
  if (
    !Number.isSafeInteger(actual) ||
    actual >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    actual !== expected
  )
    throw new Error("The record changed. Reload before saving.")
}
export async function replay(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  actorId: Id<"users">,
  requestId: string,
  action: string,
  input: unknown
) {
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(requestId))
    throw new Error("Enter a stable request reference")
  const fingerprint = await evidenceVersion({ action, input })
  const old = await ctx.db
    .query("rentalCommands")
    .withIndex("by_space_actor_request", (q) =>
      q.eq("spaceId", spaceId).eq("actorId", actorId).eq("requestId", requestId)
    )
    .unique()
  if (old && old.fingerprint !== fingerprint)
    throw new Error("Request reference was already used for different work")
  return { old: old?.result, fingerprint }
}
export async function receipt(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  actorId: Id<"users">,
  requestId: string,
  fingerprint: string,
  result: { recordId: string; revision: number },
  kind: string
) {
  const createdAt = Date.now()
  await ctx.db.insert("rentalCommands", {
    spaceId,
    actorId,
    requestId,
    fingerprint,
    result,
    createdAt,
  })
  await ctx.db.insert("rentalEvents", {
    spaceId,
    actorId,
    ...result,
    kind,
    evidence: fingerprint,
    createdAt,
  })
  return result
}

export const createUnit = mutation({
  args: {
    ...commandArgs,
    propertyId: v.id("properties"),
    label: v.string(),
    timeZone: v.string(),
  },
  handler: async (ctx, args) => {
    const a = await access(ctx, args.scope),
      property = await owned(ctx, args.propertyId, a.spaces)
    const timeZone = canonicalTimeZone(
      requiredText(args.timeZone, 100, "unit time zone")
    )
    if (!timeZone) throw new Error("Enter a valid unit time zone")
    const label = requiredText(args.label, 100, "unit label"),
      key = label.normalize("NFKC").toLowerCase().replace(/\s+/g, " ")
    const r = await replay(
      ctx,
      property.spaceId,
      a.actorId,
      args.requestId,
      "unit.create",
      { propertyId: property._id, label, timeZone }
    )
    if (r.old) return r.old
    if (
      await ctx.db
        .query("rentalUnits")
        .withIndex("by_space_property_key", (q) =>
          q
            .eq("spaceId", property.spaceId)
            .eq("propertyId", property._id)
            .eq("key", key)
        )
        .unique()
    )
      throw new Error("This unit is already recorded")
    const id = await ctx.db.insert("rentalUnits", {
      spaceId: property.spaceId,
      propertyId: property._id,
      label,
      key,
      timeZone,
      createdBy: a.actorId,
      createdAt: Date.now(),
    })
    return receipt(
      ctx,
      property.spaceId,
      a.actorId,
      args.requestId,
      r.fingerprint,
      { recordId: id, revision: 0 },
      "unit.created"
    )
  },
})
export const proposeLease = mutation({
  args: { ...commandArgs, unitId: v.id("rentalUnits"), terms: leaseTerms },
  handler: async (ctx, args) => {
    const a = await access(ctx, args.scope),
      unit = await owned(ctx, args.unitId, a.spaces)
    await unitSource(ctx, unit)
    const terms = validateLeaseTerms(args.terms)
    await parties(ctx, unit.spaceId, terms)
    const r = await replay(
      ctx,
      unit.spaceId,
      a.actorId,
      args.requestId,
      "lease.propose",
      { unitId: unit._id, terms }
    )
    if (r.old) return r.old
    const history = await ctx.db
      .query("leases")
      .withIndex("by_space_unit", (q) =>
        q.eq("spaceId", unit.spaceId).eq("unitId", unit._id)
      )
      .take(101)
    if (history.length >= 100)
      throw new Error(
        "Unit lease history needs reconciliation before another proposal"
      )
    const now = Date.now(),
      id = await ctx.db.insert("leases", {
        spaceId: unit.spaceId,
        unitId: unit._id,
        revision: 0,
        createdBy: a.actorId,
        createdAt: now,
        updatedAt: now,
      })
    const proposedVersionId = await ctx.db.insert("leaseVersions", {
      spaceId: unit.spaceId,
      leaseId: id,
      number: 1,
      terms,
      recordedBy: a.actorId,
      recordedAt: now,
    })
    await ctx.db.patch(id, { proposedVersionId })
    return receipt(
      ctx,
      unit.spaceId,
      a.actorId,
      args.requestId,
      r.fingerprint,
      { recordId: id, revision: 0 },
      "lease.proposed"
    )
  },
})
export const amendProposal = mutation({
  args: {
    ...commandArgs,
    leaseId: v.id("leases"),
    expectedRevision: v.number(),
    terms: leaseTerms,
  },
  handler: async (ctx, args) => {
    const a = await access(ctx, args.scope),
      lease = await owned(ctx, args.leaseId, a.spaces)
    await unitSource(
      ctx,
      await assertInSpace(ctx, "rentalUnits", lease.unitId, lease.spaceId)
    )
    const terms = validateLeaseTerms(args.terms)
    await parties(ctx, lease.spaceId, terms)
    const r = await replay(
      ctx,
      lease.spaceId,
      a.actorId,
      args.requestId,
      "lease.amend",
      {
        leaseId: lease._id,
        expectedRevision: args.expectedRevision,
        terms,
      }
    )
    if (r.old) return r.old
    revision(lease.revision, args.expectedRevision)
    const prior = await version(
      ctx,
      lease,
      lease.proposedVersionId ?? lease.executedVersionId
    )
    const now = Date.now(),
      proposedVersionId = await ctx.db.insert("leaseVersions", {
        spaceId: lease.spaceId,
        leaseId: lease._id,
        number: prior.number + 1,
        terms,
        recordedBy: a.actorId,
        recordedAt: now,
      })
    await ctx.db.patch(lease._id, {
      proposedVersionId,
      revision: lease.revision + 1,
      updatedAt: now,
    })
    return receipt(
      ctx,
      lease.spaceId,
      a.actorId,
      args.requestId,
      r.fingerprint,
      { recordId: lease._id, revision: lease.revision + 1 },
      "lease.amendment_proposed"
    )
  },
})

export async function executionFile(
  ctx: Ctx,
  lease: Doc<"leases">,
  terms: Infer<typeof leaseTerms>,
  fileId: Id<"documentFiles">
) {
  const file = await assertInSpace(ctx, "documentFiles", fileId, lease.spaceId)
  const request = await assertInSpace(
    ctx,
    "documentRequests",
    file.requestId,
    lease.spaceId
  )
  const application = await assertInSpace(
    ctx,
    "applications",
    request.applicationId,
    lease.spaceId
  )
  if (
    !cleanDocument(file) ||
    request.status !== "accepted" ||
    file.requestRevision !== request.revision ||
    !request.reviewedAt ||
    !terms.tenantContactIds.includes(application.contactId)
  )
    throw new Error(
      "A current accepted, scanned document for a recorded tenant is required"
    )
  return { file, request }
}
export const recordExecution = mutation({
  args: {
    ...commandArgs,
    leaseId: v.id("leases"),
    expectedRevision: v.number(),
    proposedVersionId: v.id("leaseVersions"),
    fileId: v.id("documentFiles"),
    signedOn: v.string(),
    confirmation: reviewed,
  },
  handler: async (ctx, args) => {
    const a = await access(ctx, args.scope),
      lease = await owned(ctx, args.leaseId, a.spaces)
    await unitSource(
      ctx,
      await assertInSpace(ctx, "rentalUnits", lease.unitId, lease.spaceId)
    )
    const r = await replay(
      ctx,
      lease.spaceId,
      a.actorId,
      args.requestId,
      "lease.execution_recorded",
      args
    )
    if (r.old) return r.old
    revision(lease.revision, args.expectedRevision)
    if (lease.proposedVersionId !== args.proposedVersionId)
      throw new Error("Review the current proposed version")
    const proposed = await version(ctx, lease, args.proposedVersionId)
    const signedOn = await observedDate(
        ctx,
        lease.unitId,
        lease.spaceId,
        args.signedOn
      ),
      { file, request } = await executionFile(
        ctx,
        lease,
        proposed.terms,
        args.fileId
      )
    const executionEvidenceId = await ctx.db.insert("leaseExecutionEvidence", {
      spaceId: lease.spaceId,
      leaseId: lease._id,
      versionId: proposed._id,
      fileId: file._id,
      fileDigest: file.digest,
      fileRevision: file.revision,
      requestRevision: request.revision,
      signedOn,
      termsDigest: await evidenceVersion(proposed.terms),
      recordedBy: a.actorId,
      recordedAt: Date.now(),
    })
    await ctx.db.patch(lease._id, {
      executedVersionId: proposed._id,
      executionEvidenceId,
      proposedVersionId: undefined,
      revision: lease.revision + 1,
      updatedAt: Date.now(),
    })
    return receipt(
      ctx,
      lease.spaceId,
      a.actorId,
      args.requestId,
      r.fingerprint,
      { recordId: lease._id, revision: lease.revision + 1 },
      "lease.execution_recorded"
    )
  },
})
export async function executionCurrent(ctx: Ctx, lease: Doc<"leases">) {
  const current = await version(ctx, lease, lease.executedVersionId)
  if (!lease.executionEvidenceId) throw new Error("No execution evidence")
  const proof = await assertInSpace(
    ctx,
    "leaseExecutionEvidence",
    lease.executionEvidenceId,
    lease.spaceId
  )
  if (
    proof.leaseId !== lease._id ||
    proof.versionId !== current._id ||
    proof.termsDigest !== (await evidenceVersion(current.terms))
  )
    throw new Error("Execution evidence changed")
  const { file, request } = await executionFile(
    ctx,
    lease,
    current.terms,
    proof.fileId
  )
  if (
    proof.fileDigest !== file.digest ||
    proof.fileRevision !== file.revision ||
    proof.requestRevision !== request.revision
  )
    throw new Error("Execution source changed; review it before continuing")
  return current
}
async function recordedTermConflict(
  ctx: Ctx,
  lease: Doc<"leases">,
  current: Doc<"leaseVersions">
) {
  const related = await ctx.db
    .query("leases")
    .withIndex("by_space_unit", (q) =>
      q.eq("spaceId", lease.spaceId).eq("unitId", lease.unitId)
    )
    .take(101)
  if (related.length > 100)
    throw new Error("Unit lease history needs a bounded reconciliation")
  for (const row of related) {
    if (row._id === lease._id || !row.executedVersionId) continue
    const other = await version(ctx, row, row.executedVersionId)
    if (
      (current.terms.endsOn === null ||
        other.terms.startsOn <= current.terms.endsOn) &&
      (other.terms.endsOn === null ||
        current.terms.startsOn <= other.terms.endsOn)
    )
      return true
  }
  return false
}
export const recordMoveIn = mutation({
  args: {
    ...commandArgs,
    leaseId: v.id("leases"),
    expectedRevision: v.number(),
    executedVersionId: v.id("leaseVersions"),
    startsOn: v.string(),
    sourceNote: v.string(),
  },
  handler: async (ctx, args) => {
    const a = await access(ctx, args.scope),
      lease = await owned(ctx, args.leaseId, a.spaces)
    await unitSource(
      ctx,
      await assertInSpace(ctx, "rentalUnits", lease.unitId, lease.spaceId)
    )
    const r = await replay(
      ctx,
      lease.spaceId,
      a.actorId,
      args.requestId,
      "occupancy.start",
      args
    )
    if (r.old) return r.old
    revision(lease.revision, args.expectedRevision)
    if (lease.executedVersionId !== args.executedVersionId)
      throw new Error("Review the recorded executed version")
    const executed = await executionCurrent(ctx, lease)
    if (await recordedTermConflict(ctx, lease, executed))
      throw new Error("Overlapping recorded leases need human reconciliation")
    const startsOn = await observedDate(
        ctx,
        lease.unitId,
        lease.spaceId,
        args.startsOn
      ),
      sourceNote = requiredText(args.sourceNote, 2000, "occupancy source")
    if (
      await ctx.db
        .query("occupancies")
        .withIndex("by_space_unit_status", (q) =>
          q
            .eq("spaceId", lease.spaceId)
            .eq("unitId", lease.unitId)
            .eq("status", "recorded_current")
        )
        .first()
    )
      throw new Error("This unit already has a recorded current occupancy")
    const id = await ctx.db.insert("occupancies", {
      spaceId: lease.spaceId,
      unitId: lease.unitId,
      leaseId: lease._id,
      versionId: args.executedVersionId,
      startsOn,
      sourceNote,
      status: "recorded_current",
      revision: 0,
      recordedBy: a.actorId,
      recordedAt: Date.now(),
    })
    return receipt(
      ctx,
      lease.spaceId,
      a.actorId,
      args.requestId,
      r.fingerprint,
      { recordId: id, revision: 0 },
      "occupancy.started"
    )
  },
})
export const recordMoveOut = mutation({
  args: {
    ...commandArgs,
    occupancyId: v.id("occupancies"),
    expectedRevision: v.number(),
    endsOn: v.string(),
    sourceNote: v.string(),
  },
  handler: async (ctx, args) => {
    const a = await access(ctx, args.scope),
      row = await owned(ctx, args.occupancyId, a.spaces)
    await unitSource(
      ctx,
      await assertInSpace(ctx, "rentalUnits", row.unitId, row.spaceId)
    )
    const originalLease = await assertInSpace(
      ctx,
      "leases",
      row.leaseId,
      row.spaceId
    )
    if (originalLease.unitId !== row.unitId) throw new NotFound()
    await version(ctx, originalLease, row.versionId)
    const r = await replay(
      ctx,
      row.spaceId,
      a.actorId,
      args.requestId,
      "occupancy.end",
      args
    )
    if (r.old) return r.old
    revision(row.revision, args.expectedRevision)
    const endsOn = await observedDate(
        ctx,
        row.unitId,
        row.spaceId,
        args.endsOn
      ),
      note = requiredText(args.sourceNote, 2000, "move-out source")
    if (row.status !== "recorded_current" || endsOn < row.startsOn)
      throw new Error("Check the recorded occupancy dates and status")
    await ctx.db.patch(row._id, {
      endsOn,
      moveOutSourceNote: note,
      status: "recorded_ended",
      revision: row.revision + 1,
    })
    return receipt(
      ctx,
      row.spaceId,
      a.actorId,
      args.requestId,
      r.fingerprint,
      { recordId: row._id, revision: row.revision + 1 },
      "occupancy.ended"
    )
  },
})

async function termsContext(
  ctx: Ctx,
  lease: Doc<"leases">,
  item: Doc<"leaseVersions"> | null
) {
  return item
    ? {
        versionId: item._id,
        number: item.number,
        ...item.terms,
        tenantNames: await Promise.all(
          item.terms.tenantContactIds.map(
            async (id) =>
              (await assertInSpace(ctx, "contacts", id, lease.spaceId)).name
          )
        ),
        landlordNames: await Promise.all(
          item.terms.landlordContactIds.map(
            async (id) =>
              (await assertInSpace(ctx, "contacts", id, lease.spaceId)).name
          )
        ),
        recordedAt: item.recordedAt,
      }
    : null
}
export async function leaseContext(ctx: Ctx, lease: Doc<"leases">) {
  const unit = await assertInSpace(
    ctx,
    "rentalUnits",
    lease.unitId,
    lease.spaceId
  )
  const property = await assertInSpace(
    ctx,
    "properties",
    unit.propertyId,
    lease.spaceId
  )
  const proposed = lease.proposedVersionId
    ? await version(ctx, lease, lease.proposedVersionId)
    : null
  const executed = lease.executedVersionId
    ? await version(ctx, lease, lease.executedVersionId)
    : null
  let executionSourceCurrent = false
  if (executed) {
    try {
      await executionCurrent(ctx, lease)
      executionSourceCurrent = true
    } catch {
      /* Missing evidence stays unknown. */
    }
  }
  const occupancy = await ctx.db
    .query("occupancies")
    .withIndex("by_space_unit_status", (q) =>
      q
        .eq("spaceId", lease.spaceId)
        .eq("unitId", unit._id)
        .eq("status", "recorded_current")
    )
    .take(2)
  if (occupancy.length > 1) throw new Error("Occupancy needs reconciliation")
  for (const row of occupancy) {
    const originalLease = await assertInSpace(
      ctx,
      "leases",
      row.leaseId,
      lease.spaceId
    )
    if (originalLease.unitId !== unit._id) throw new NotFound()
    await version(ctx, originalLease, row.versionId)
  }
  const recordedTermsOverlap = executed
    ? await recordedTermConflict(ctx, lease, executed)
    : false
  return {
    recordId: lease._id,
    revision: lease.revision,
    address: property.address,
    unit: unit.label,
    timeZone: unit.timeZone,
    state: executed
      ? "human_recorded_execution"
      : proposed
        ? "proposal_only"
        : "incomplete_record",
    proposed: await termsContext(ctx, lease, proposed),
    executed: await termsContext(ctx, lease, executed),
    executionSourceCurrent,
    recordedTermsOverlap,
    executionEvidenceState: executed
      ? executionSourceCurrent
        ? "current"
        : "needs_review"
      : "not_recorded",
    nextStep:
      !executed && !proposed
        ? "Reconcile the missing original lease version before further work."
        : recordedTermsOverlap
          ? "Reconcile the overlapping recorded lease dates before occupancy work."
          : executed && !executionSourceCurrent
            ? "Review the current accepted document and recorded lease version before occupancy work."
            : occupancy[0]?.leaseId === lease._id &&
                occupancy[0].versionId !== lease.executedVersionId
              ? "Confirm which executed version governs the recorded occupancy before further work."
              : null,
    unitOccupiedByAnotherRecordedLease: Boolean(
      occupancy[0] && occupancy[0].leaseId !== lease._id
    ),
    occupancyUsesEarlierVersion: Boolean(
      occupancy[0]?.leaseId === lease._id &&
      occupancy[0].versionId !== lease.executedVersionId
    ),
    occupancy:
      occupancy[0]?.leaseId === lease._id
        ? {
            recordId: occupancy[0]._id,
            startsOn: occupancy[0].startsOn,
            versionId: occupancy[0].versionId,
            revision: occupancy[0].revision,
            sourceNote: occupancy[0].sourceNote,
          }
        : null,
    limitations:
      "Recorded contract facts only. No rent balance, valuation, eligibility decision, legal notice or payment authority.",
    retrievedAt: Date.now(),
  }
}
export async function rentalContextPage(
  ctx: Ctx,
  allowed: Id<"spaces">[],
  input: {
    recordId?: string
    workspaceId?: string
    pagination?: { numItems: number; cursor: string | null }
  }
) {
  if (input.recordId !== undefined) {
    const id =
      typeof input.recordId === "string" && input.recordId
        ? ctx.db.normalizeId("leases", input.recordId)
        : null
    if (!id) throw new NotFound()
    return {
      records: [await leaseContext(ctx, await owned(ctx, id, allowed))],
      isDone: true,
    }
  }
  const spaceId = input.workspaceId
    ? ctx.db.normalizeId("spaces", input.workspaceId)
    : allowed.length === 1
      ? allowed[0]
      : null
  if (!spaceId || !allowed.includes(spaceId))
    throw new Error("Choose an authorized workspace")
  const page = input.pagination ?? { numItems: 20, cursor: null }
  if (
    !Number.isInteger(page.numItems) ||
    page.numItems < 1 ||
    page.numItems > 20 ||
    (page.cursor !== null &&
      (typeof page.cursor !== "string" || page.cursor.length > 10000))
  )
    throw new Error("Invalid pagination")
  const result = await ctx.db
    .query("leases")
    .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
    .order("desc")
    .paginate(page)
  return {
    records: await Promise.all(
      result.page.map((row) => leaseContext(ctx, row))
    ),
    continuationCursor: result.continueCursor,
    isDone: result.isDone,
    limit: 20,
  }
}
export const list = query({
  args: {
    ...scopeArgs,
    recordId: v.optional(v.id("leases")),
    workspaceId: v.optional(v.id("spaces")),
    pagination: v.optional(paginationOptsValidator),
  },
  handler: async (ctx, args) =>
    rentalContextPage(ctx, (await access(ctx, args.scope)).spaces, args),
})

export async function rentalHistoryPage(
  ctx: Ctx,
  allowed: Id<"spaces">[],
  input: {
    recordId?: string
    pagination?: { numItems: number; cursor: string | null }
  }
) {
  const id =
    typeof input.recordId === "string" && input.recordId
      ? ctx.db.normalizeId("leases", input.recordId)
      : null
  if (!id) throw new NotFound()
  const lease = await owned(ctx, id, allowed)
  await unitSource(
    ctx,
    await assertInSpace(ctx, "rentalUnits", lease.unitId, lease.spaceId)
  )
  const page = input.pagination ?? { numItems: 20, cursor: null }
  if (
    !Number.isInteger(page.numItems) ||
    page.numItems < 1 ||
    page.numItems > 20 ||
    (page.cursor !== null &&
      (typeof page.cursor !== "string" || page.cursor.length > 10000))
  )
    throw new Error("Invalid pagination")
  const result = await ctx.db
    .query("leaseVersions")
    .withIndex("by_space_lease", (q) =>
      q.eq("spaceId", lease.spaceId).eq("leaseId", id)
    )
    .order("desc")
    .paginate(page)
  const records = []
  for (const row of result.page) {
    await version(ctx, lease, row._id)
    records.push(await termsContext(ctx, lease, row))
  }
  return {
    records,
    isDone: result.isDone,
    continuationCursor: result.continueCursor,
    limit: 20,
    provenance:
      "Immutable human-entered versions; historical facts are not current permission or verified legal validity.",
  }
}
export const history = query({
  args: {
    ...scopeArgs,
    recordId: v.id("leases"),
    pagination: v.optional(paginationOptsValidator),
  },
  handler: async (ctx, args) =>
    rentalHistoryPage(ctx, (await access(ctx, args.scope)).spaces, args),
})

// A bounded record ledger, not a collection, trust-account or payment service.
const ledgerLimit = 500
const ledgerConfirmation = v.literal(
  "I verified this entry against its recorded source"
)
const ledgerInput = v.union(
  v.object({
    kind: v.literal("rent_charge"),
    amountMinor: v.number(),
    currency: v.string(),
    periodStartsOn: v.string(),
    periodEndsOn: v.string(),
    dueOn: v.string(),
  }),
  v.object({
    kind: v.literal("payment_record"),
    amountMinor: v.number(),
    currency: v.string(),
  }),
  v.object({
    kind: v.literal("credit_record"),
    amountMinor: v.number(),
    currency: v.string(),
  }),
  v.object({
    kind: v.literal("reversal"),
    reversesId: v.id("rentLedgerEntries"),
  })
)
async function ledgerSourceCurrent(
  ctx: Ctx,
  lease: Doc<"leases">,
  terms: Infer<typeof leaseTerms>,
  row: Doc<"rentLedgerEntries">
) {
  const proof = await assertInSpace(
    ctx,
    "leaseExecutionEvidence",
    row.executionEvidenceId,
    lease.spaceId
  )
  if (proof.leaseId !== lease._id || proof.versionId !== row.versionId)
    throw new NotFound()
  if (proof.termsDigest !== (await evidenceVersion(terms))) return false
  try {
    const source = await executionFile(ctx, lease, terms, row.fileId)
    const execution = await executionFile(ctx, lease, terms, proof.fileId)
    return (
      source.file.digest === row.fileDigest &&
      source.file.revision === row.fileRevision &&
      source.request.revision === row.requestRevision &&
      execution.file.digest === proof.fileDigest &&
      execution.file.revision === proof.fileRevision &&
      execution.request.revision === proof.requestRevision
    )
  } catch {
    return false
  }
}
async function ledgerRows(ctx: Ctx, lease: Doc<"leases">) {
  const unit = await assertInSpace(
    ctx,
    "rentalUnits",
    lease.unitId,
    lease.spaceId
  )
  const timeZone = canonicalTimeZone(unit.timeZone)
  if (!timeZone) throw new Error("Recorded unit time zone needs reconciliation")
  const today = localDateKey(new Date(), timeZone)
  const rows = await ctx.db
    .query("rentLedgerEntries")
    .withIndex("by_space_lease", (q) =>
      q.eq("spaceId", lease.spaceId).eq("leaseId", lease._id)
    )
    .take(ledgerLimit + 1)
  if (rows.length > ledgerLimit)
    throw new Error(
      "Ledger coverage exceeds the verified record limit; reconcile before proceeding"
    )
  const sorted = rows.sort((a, b) => a.sequence - b.sequence)
  const versions = new Map<Id<"leaseVersions">, Doc<"leaseVersions">>()
  const seen = new Map<Id<"rentLedgerEntries">, Doc<"rentLedgerEntries">>()
  const reversed = new Set<Id<"rentLedgerEntries">>()
  const references = new Set<string>()
  let net = BigInt(0)
  for (let n = 0; n < sorted.length; n++) {
    const row = sorted[n]
    let terms = versions.get(row.versionId)
    if (!terms) {
      terms = await version(ctx, lease, row.versionId)
      versions.set(row.versionId, terms)
    }
    if (
      row.sequence !== n + 1 ||
      !Number.isSafeInteger(row.amountMinor) ||
      row.amountMinor <= 0 ||
      !Number.isSafeInteger(row.deltaMinor) ||
      row.currency !== terms.terms.currency ||
      (n && row.currency !== sorted[0].currency) ||
      references.has(row.sourceKey)
    )
      throw new Error("Recorded ledger needs reconciliation")
    references.add(row.sourceKey)
    try {
      if (
        row.sourceKey !==
        requiredText(row.sourceReference, 150, "source reference")
          .normalize("NFKC")
          .toLowerCase()
          .replace(/\s+/g, " ")
      )
        throw new Error("source mismatch")
      requiredText(row.sourceNote, 2000, "source note")
      if (rentalDate(row.observedOn) > today)
        throw new Error("Future observation")
      if (row.kind === "rent_charge") {
        if (
          !row.periodStartsOn ||
          !row.periodEndsOn ||
          !row.dueOn ||
          row.amountMinor !== terms.terms.rentMinor
        )
          throw new Error("rent facts missing")
        const start = rentalDate(row.periodStartsOn),
          end = rentalDate(row.periodEndsOn)
        rentalDate(row.dueOn)
        if (
          end < start ||
          start < terms.terms.startsOn ||
          (terms.terms.endsOn && end > terms.terms.endsOn)
        )
          throw new Error("period mismatch")
      } else if (
        row.periodStartsOn !== undefined ||
        row.periodEndsOn !== undefined ||
        row.dueOn !== undefined
      )
        throw new Error("unexpected period")
    } catch {
      throw new Error("Recorded ledger facts need reconciliation")
    }
    let expected =
      row.kind === "rent_charge" ? row.amountMinor : -row.amountMinor
    if (row.kind === "reversal") {
      const original = row.reversesId ? seen.get(row.reversesId) : null
      if (
        !original ||
        original.kind === "reversal" ||
        reversed.has(original._id) ||
        original.versionId !== row.versionId ||
        original.amountMinor !== row.amountMinor
      )
        throw new Error("Recorded reversal needs reconciliation")
      if (row.observedOn < original.observedOn)
        throw new Error("Recorded reversal needs reconciliation")
      reversed.add(original._id)
      expected = -original.deltaMinor
    } else if (row.reversesId)
      throw new Error("Recorded ledger needs reconciliation")
    if (row.deltaMinor !== expected)
      throw new Error("Recorded ledger needs reconciliation")
    seen.set(row._id, row)
    net += BigInt(row.deltaMinor)
  }
  const activeCharges = sorted
    .filter((row) => row.kind === "rent_charge" && !reversed.has(row._id))
    .sort((a, b) => a.periodStartsOn!.localeCompare(b.periodStartsOn!))
  for (let n = 1; n < activeCharges.length; n++)
    if (activeCharges[n].periodStartsOn! <= activeCharges[n - 1].periodEndsOn!)
      throw new Error("Recorded rent periods need reconciliation")
  if (
    net > BigInt(Number.MAX_SAFE_INTEGER) ||
    net < -BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("Recorded total exceeds the supported integer range")
  return { rows: sorted, versions, reversed, net: Number(net) }
}
export const recordLedgerEntry = mutation({
  args: {
    ...commandArgs,
    leaseId: v.id("leases"),
    versionId: v.id("leaseVersions"),
    expectedLedgerRevision: v.number(),
    entry: ledgerInput,
    observedOn: v.string(),
    sourceReference: v.string(),
    sourceNote: v.string(),
    fileId: v.id("documentFiles"),
    confirmation: ledgerConfirmation,
  },
  handler: async (ctx, args) => {
    const a = await access(ctx, args.scope),
      lease = await owned(ctx, args.leaseId, a.spaces)
    await unitSource(
      ctx,
      await assertInSpace(ctx, "rentalUnits", lease.unitId, lease.spaceId)
    )
    const r = await replay(
      ctx,
      lease.spaceId,
      a.actorId,
      args.requestId,
      "rent.entry_recorded",
      args
    )
    if (r.old) return r.old
    const ledger = await ledgerRows(ctx, lease)
    revision(ledger.rows.length, args.expectedLedgerRevision)
    if (ledger.rows.length >= ledgerLimit)
      throw new Error(
        "Ledger record limit reached; reconcile before adding more entries"
      )
    const sourceReference = requiredText(
        args.sourceReference,
        150,
        "source reference"
      ),
      sourceNote = requiredText(args.sourceNote, 2000, "recorded source note"),
      sourceKey = sourceReference
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\s+/g, " ")
    if (ledger.rows.some((row) => row.sourceKey === sourceKey))
      throw new Error(
        "This source is already recorded; inspect its receipt before retrying"
      )
    const observedOn = await observedDate(
      ctx,
      lease.unitId,
      lease.spaceId,
      args.observedOn
    )
    const terms = await version(ctx, lease, args.versionId)
    let amountMinor: number,
      deltaMinor: number,
      currency: string,
      executionEvidenceId: Id<"leaseExecutionEvidence">,
      reversesId: Id<"rentLedgerEntries"> | undefined
    let periodStartsOn: string | undefined,
      periodEndsOn: string | undefined,
      dueOn: string | undefined
    const entry = args.entry
    if (entry.kind === "reversal") {
      const original = ledger.rows.find((row) => row._id === entry.reversesId)
      if (!original) throw new NotFound()
      if (original.kind === "reversal" || ledger.reversed.has(original._id))
        throw new Error("This entry cannot be reversed again")
      if (original.versionId !== args.versionId)
        throw new Error(
          "Use the original recorded lease version for the correction"
        )
      if (observedOn < original.observedOn)
        throw new Error(
          "A correction cannot precede its original recorded observation"
        )
      if (!(await ledgerSourceCurrent(ctx, lease, terms.terms, original)))
        throw new Error("Review the original entry evidence before correction")
      amountMinor = original.amountMinor
      deltaMinor = -original.deltaMinor
      currency = original.currency
      executionEvidenceId = original.executionEvidenceId
      reversesId = original._id
    } else {
      if (
        lease.executedVersionId !== args.versionId ||
        !lease.executionEvidenceId
      )
        throw new Error(
          "Use the current recorded executed version, not a proposal"
        )
      await executionCurrent(ctx, lease)
      amountMinor = entry.amountMinor
      currency = entry.currency
      executionEvidenceId = lease.executionEvidenceId
      if (
        !Number.isSafeInteger(amountMinor) ||
        amountMinor <= 0 ||
        currency !== terms.terms.currency
      )
        throw new Error(
          "Enter a positive integer amount in the recorded agreement currency"
        )
      deltaMinor = entry.kind === "rent_charge" ? amountMinor : -amountMinor
      if (entry.kind === "rent_charge") {
        if (amountMinor !== terms.terms.rentMinor)
          throw new Error(
            "Only the entered full periodic rent amount is supported; proration and fees require a separate reviewed policy"
          )
        periodStartsOn = rentalDate(entry.periodStartsOn)
        periodEndsOn = rentalDate(entry.periodEndsOn)
        dueOn = rentalDate(entry.dueOn)
        if (
          periodEndsOn < periodStartsOn ||
          periodStartsOn < terms.terms.startsOn ||
          (terms.terms.endsOn && periodEndsOn > terms.terms.endsOn)
        )
          throw new Error(
            "Recorded rent period must fall within the entered lease dates"
          )
        if (
          ledger.rows.some(
            (row) =>
              row.kind === "rent_charge" &&
              !ledger.reversed.has(row._id) &&
              row.periodStartsOn! <= periodEndsOn! &&
              row.periodEndsOn! >= periodStartsOn!
          )
        )
          throw new Error(
            "An overlapping rent period is already recorded; reconcile before posting"
          )
      }
    }
    if (ledger.rows.length && ledger.rows[0].currency !== currency)
      throw new Error(
        "Currency changed; separate currency reconciliation is required"
      )
    const net = BigInt(ledger.net) + BigInt(deltaMinor)
    if (
      net > BigInt(Number.MAX_SAFE_INTEGER) ||
      net < -BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error("Recorded total exceeds the supported integer range")
    const { file, request } = await executionFile(
      ctx,
      lease,
      terms.terms,
      args.fileId
    )
    const sequence = ledger.rows.length + 1
    const id = await ctx.db.insert("rentLedgerEntries", {
      spaceId: lease.spaceId,
      leaseId: lease._id,
      versionId: terms._id,
      executionEvidenceId,
      sequence,
      kind: entry.kind,
      amountMinor,
      deltaMinor,
      currency,
      observedOn,
      periodStartsOn,
      periodEndsOn,
      dueOn,
      reversesId,
      sourceReference,
      sourceKey,
      sourceNote,
      fileId: file._id,
      fileDigest: file.digest,
      fileRevision: file.revision,
      requestRevision: request.revision,
      recordedBy: a.actorId,
      recordedAt: Date.now(),
    })
    return receipt(
      ctx,
      lease.spaceId,
      a.actorId,
      args.requestId,
      r.fingerprint,
      { recordId: id, revision: sequence },
      "rent.entry_recorded"
    )
  },
})
export async function rentLedgerPage(
  ctx: Ctx,
  allowed: Id<"spaces">[],
  input: {
    recordId?: string
    pagination?: { numItems: number; cursor: string | null }
  }
) {
  const id =
    typeof input.recordId === "string" && input.recordId
      ? ctx.db.normalizeId("leases", input.recordId)
      : null
  if (!id) throw new NotFound()
  const lease = await owned(ctx, id, allowed)
  await unitSource(
    ctx,
    await assertInSpace(ctx, "rentalUnits", lease.unitId, lease.spaceId)
  )
  const page = input.pagination ?? { numItems: 20, cursor: null }
  if (
    !Number.isInteger(page.numItems) ||
    page.numItems < 1 ||
    page.numItems > 20 ||
    (page.cursor !== null &&
      (typeof page.cursor !== "string" || page.cursor.length > 10000))
  )
    throw new Error("Invalid pagination")
  const ledger = await ledgerRows(ctx, lease)
  let staleEvidenceCount = 0
  const freshness = new Map<Id<"rentLedgerEntries">, boolean>()
  for (const row of ledger.rows) {
    const fresh = await ledgerSourceCurrent(
      ctx,
      lease,
      ledger.versions.get(row.versionId)!.terms,
      row
    )
    freshness.set(row._id, fresh)
    if (!fresh) staleEvidenceCount++
  }
  const result = await ctx.db
    .query("rentLedgerEntries")
    .withIndex("by_space_lease", (q) =>
      q.eq("spaceId", lease.spaceId).eq("leaseId", id)
    )
    .paginate(page)
  return {
    records: result.page.map((row) => ({
      recordId: row._id,
      sequence: row.sequence,
      kind: row.kind,
      amountMinor: row.amountMinor,
      deltaMinor: row.deltaMinor,
      currency: row.currency,
      observedOn: row.observedOn,
      periodStartsOn: row.periodStartsOn ?? null,
      periodEndsOn: row.periodEndsOn ?? null,
      dueOn: row.dueOn ?? null,
      reversesId: row.reversesId ?? null,
      leaseVersion: ledger.versions.get(row.versionId)!.number,
      sourceReference: row.sourceReference,
      sourceNote: row.sourceNote,
      evidenceState: freshness.get(row._id)
        ? "current_accepted_record"
        : "needs_review",
      recordedAt: row.recordedAt,
    })),
    isDone: result.isDone,
    continuationCursor: result.continueCursor,
    limit: 20,
    revision: ledger.rows.length,
    summary: {
      recordedNetMinor: ledger.net,
      currency: ledger.rows[0]?.currency ?? null,
      entryCount: ledger.rows.length,
      staleEvidenceCount,
      completeness: "unknown",
      authoritativeBalanceMinor: null,
      state: ledger.rows.length
        ? staleEvidenceCount
          ? "needs_review"
          : "recorded_entries_only"
        : "no_recorded_entries",
      nextStep: staleEvidenceCount
        ? "Reconcile the changed entry or agreement evidence before relying on these records."
        : "Reconcile these entries with the complete authorized source ledger before drawing financial conclusions.",
    },
    provenance:
      "Manually attested observations from accepted documents; neither payment-provider verification nor complete tenant debt. No fees, proration, notices, trust accounting, collection or payment authority.",
    retrievedAt: Date.now(),
  }
}
export const ledger = query({
  args: {
    ...scopeArgs,
    recordId: v.id("leases"),
    pagination: v.optional(paginationOptsValidator),
  },
  handler: async (ctx, args) =>
    rentLedgerPage(ctx, (await access(ctx, args.scope)).spaces, args),
})
