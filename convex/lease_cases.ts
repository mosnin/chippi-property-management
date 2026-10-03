import { v, type Infer } from "convex/values"
import {
  paginationOptsValidator,
  type WithoutSystemFields,
} from "convex/server"
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
  rentalDate,
  validateLeaseTerms,
  conditionObservation,
  validateConditionObservations,
} from "./rental_model"
import {
  executionCurrent,
  executionFile,
  revision,
  replay,
  receipt,
} from "./rentals"
import { assignee } from "./maintenance"
import { canonicalTimeZone, localDateKey } from "./availability"
import { evidenceVersion } from "./source_evidence"
import { requiredText } from "./record_validation"

type Ctx = MutationCtx | QueryCtx
type Scope = Infer<typeof rentalScope> | undefined
const kind = v.union(v.literal("renewal"), v.literal("move_out"))
const scopeArgs = { scope: v.optional(rentalScope) }
const commands = { ...scopeArgs, requestId: v.string() }
const changes = {
  ...commands,
  caseId: v.id("leaseCases"),
  expectedRevision: v.number(),
}
async function access(ctx: Ctx, scope: Scope) {
  const actorId = await requireUserId(ctx),
    principal = await resolveWorkforceScope(
      ctx,
      actorId,
      scope?.kind ?? "personal",
      scope?.id ?? actorId
    )
  return { actorId, allowed: await spacesFor(ctx, principal) }
}
type Link = Pick<
  Doc<"leaseCases">,
  "spaceId" | "leaseId" | "unitId" | "baseVersionId" | "occupancyId"
>
async function graph(ctx: Ctx, row: Link) {
  const lease = await assertInSpace(ctx, "leases", row.leaseId, row.spaceId),
    unit = await assertInSpace(ctx, "rentalUnits", row.unitId, row.spaceId),
    base = await assertInSpace(
      ctx,
      "leaseVersions",
      row.baseVersionId,
      row.spaceId
    )
  if (lease.unitId !== unit._id || base.leaseId !== lease._id)
    throw new NotFound()
  const property = await assertInSpace(
    ctx,
    "properties",
    unit.propertyId,
    row.spaceId
  )
  for (const id of [
    ...base.terms.tenantContactIds,
    ...base.terms.landlordContactIds,
  ])
    await assertInSpace(ctx, "contacts", id, row.spaceId)
  let occupancy: Doc<"occupancies"> | null = null
  if (row.occupancyId) {
    occupancy = await assertInSpace(
      ctx,
      "occupancies",
      row.occupancyId,
      row.spaceId
    )
    if (occupancy.unitId !== unit._id || occupancy.leaseId !== lease._id)
      throw new NotFound()
    const original = await assertInSpace(
      ctx,
      "leaseVersions",
      occupancy.versionId,
      row.spaceId
    )
    if (original.leaseId !== lease._id) throw new NotFound()
    for (const id of [
      ...original.terms.tenantContactIds,
      ...original.terms.landlordContactIds,
    ])
      await assertInSpace(ctx, "contacts", id, row.spaceId)
  }
  return { lease, unit, base, property, occupancy }
}
async function owned(ctx: Ctx, id: Id<"leaseCases">, allowed: Id<"spaces">[]) {
  const row = await ctx.db.get(id)
  if (!row || !allowed.includes(row.spaceId)) throw new NotFound()
  await graph(ctx, row)
  return row
}
async function leaseWitness(ctx: Ctx, g: Awaited<ReturnType<typeof graph>>) {
  const current = await executionCurrent(ctx, g.lease)
  if (current._id !== g.base._id)
    throw new Error(
      "The original agreement changed; create a case against the current recorded version"
    )
  const proof = await assertInSpace(
    ctx,
    "leaseExecutionEvidence",
    g.lease.executionEvidenceId!,
    g.lease.spaceId
  )
  return evidenceVersion({
    base: current,
    proof,
    unit: g.unit,
    address: g.property.address,
  })
}
async function sourceCurrent(
  ctx: Ctx,
  row: Doc<"leaseCases">,
  includeOccupancy = true
) {
  const g = await graph(ctx, row)
  if (row.kind === "move_out" && !g.occupancy)
    throw new Error("A move-out case needs a recorded occupancy")
  if ((await leaseWitness(ctx, g)) !== row.leaseSourceVersion)
    throw new Error(
      "Original agreement source changed; start a reviewed case against the current source"
    )
  if (g.occupancy && g.occupancy.versionId !== row.baseVersionId)
    throw new Error(
      "Reconcile occupancy and agreement versions before case work"
    )
  if (
    includeOccupancy &&
    (g.occupancy ? await evidenceVersion(g.occupancy) : undefined) !==
      row.occupancySourceVersion
  )
    throw new Error(
      "Recorded occupancy changed; explicitly refresh the case source"
    )
  return g
}
function exactTime(input: number | null | undefined) {
  if (input === null || input === undefined) return undefined
  if (!Number.isSafeInteger(input) || input < 0 || input > Date.UTC(2200, 0, 1))
    throw new Error("Enter a supported exact administrative date and time")
  return input
}
function observed(zone: string, input: string) {
  const valid = canonicalTimeZone(zone),
    date = rentalDate(input)
  if (!valid || date > localDateKey(new Date(), valid))
    throw new Error(
      "A recorded observation cannot be in the future or use an unknown time zone"
    )
  return date
}
async function caseVersion(row: Doc<"leaseCases">) {
  return evidenceVersion({
    leaseId: row.leaseId,
    baseVersionId: row.baseVersionId,
    unitId: row.unitId,
    kind: row.kind,
    leaseSourceVersion: row.leaseSourceVersion,
    occupancyId: row.occupancyId ?? null,
    occupancySourceVersion: row.occupancySourceVersion ?? null,
    title: row.title,
    sourceNote: row.sourceNote,
    targetOn: row.targetOn,
    timelineSourceNote: row.timelineSourceNote,
    administrativeDueAt: row.administrativeDueAt ?? null,
    assignedTo: row.assignedTo ?? null,
  })
}
async function change(
  ctx: MutationCtx,
  args: {
    scope?: Scope
    caseId: Id<"leaseCases">
    expectedRevision: number
    requestId: string
  },
  action: string
) {
  const a = await access(ctx, args.scope),
    row = await owned(ctx, args.caseId, a.allowed),
    r = await replay(ctx, row.spaceId, a.actorId, args.requestId, action, args)
  if (!r.old) revision(row.revision, args.expectedRevision)
  return { ...a, row, ...r }
}
async function save(
  ctx: MutationCtx,
  args: { requestId: string },
  a: Awaited<ReturnType<typeof change>>,
  action: string,
  patch: Partial<WithoutSystemFields<Doc<"leaseCases">>>
) {
  const next = a.row.revision + 1
  await ctx.db.patch(a.row._id, {
    ...patch,
    revision: next,
    updatedAt: Date.now(),
  })
  return receipt(
    ctx,
    a.row.spaceId,
    a.actorId,
    args.requestId,
    a.fingerprint,
    { recordId: a.row._id, revision: next },
    action
  )
}
function mutable(row: Doc<"leaseCases">) {
  if (row.status === "cancelled" || row.status === "review_recorded")
    throw new Error("Reopen this administrative case before changing it")
}
async function document(
  ctx: Ctx,
  g: Awaited<ReturnType<typeof graph>>,
  fileId: Id<"documentFiles">
) {
  const { file, request } = await executionFile(
    ctx,
    g.lease,
    g.base.terms,
    fileId
  )
  return {
    fileId: file._id,
    digest: file.digest!,
    fileRevision: file.revision!,
    requestRevision: request.revision!,
  }
}
async function proposal(
  ctx: Ctx,
  g: Awaited<ReturnType<typeof graph>>,
  id: Id<"leaseVersions">
) {
  const row = await assertInSpace(ctx, "leaseVersions", id, g.lease.spaceId)
  if (row.leaseId !== g.lease._id) throw new NotFound()
  if (g.lease.proposedVersionId !== id)
    throw new Error(
      "Use the current saved proposal, not an old or executed version"
    )
  const terms = validateLeaseTerms(row.terms)
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id) => b.includes(id))
  if (
    !same(terms.tenantContactIds, g.base.terms.tenantContactIds) ||
    !same(terms.landlordContactIds, g.base.terms.landlordContactIds)
  )
    throw new Error(
      "Changed parties need a separate reviewed client/agreement case"
    )
  for (const id of [...terms.tenantContactIds, ...terms.landlordContactIds])
    await assertInSpace(ctx, "contacts", id, g.lease.spaceId)
  return row
}
async function packetCurrent(ctx: Ctx, row: Doc<"leaseCases">) {
  const g = await sourceCurrent(ctx, row)
  if (!row.packetId) throw new Error("No saved administrative packet")
  const packet = await assertInSpace(
    ctx,
    "leaseCasePackets",
    row.packetId,
    row.spaceId
  )
  if (packet.caseId !== row._id) throw new NotFound()
  if (packet.sourceVersion !== (await caseVersion(row)))
    throw new Error(
      "Case instructions or source changed; submit a current packet"
    )
  if (row.kind === "renewal") {
    if (
      !packet.proposalVersionId ||
      packet.documents.length !== 1 ||
      packet.conditions !== undefined ||
      packet.beforeOn !== undefined ||
      packet.afterOn !== undefined
    )
      throw new Error("Renewal packet needs reconciliation")
    const currentProposal = await proposal(ctx, g, packet.proposalVersionId)
    if (
      packet.proposalSourceVersion !== (await evidenceVersion(currentProposal))
    )
      throw new Error(
        "Saved proposal terms changed; submit and review a current packet"
      )
  } else {
    if (
      !packet.conditions ||
      packet.documents.length !== 2 ||
      packet.proposalVersionId !== undefined ||
      packet.proposalSourceVersion !== undefined ||
      !packet.beforeOn ||
      !packet.afterOn
    )
      throw new Error("Move-out packet needs reconciliation")
    validateConditionObservations(packet.conditions)
    if (
      observed(g.unit.timeZone, packet.beforeOn) >
      observed(g.unit.timeZone, packet.afterOn)
    )
      throw new Error("Condition evidence dates need reconciliation")
    if (packet.documents[0].fileId === packet.documents[1].fileId)
      throw new Error("Distinct before and after sources are required")
  }
  for (const proof of packet.documents)
    if (
      (await evidenceVersion(await document(ctx, g, proof.fileId))) !==
      (await evidenceVersion(proof))
    )
      throw new Error(
        "Packet document source changed; review the current evidence"
      )
  return packet
}
async function accountable(ctx: Ctx, row: Doc<"leaseCases">) {
  if (!row.assignedTo)
    throw new Error("Assign an accountable current record-workspace member")
  await assignee(ctx, row.spaceId, row.assignedTo)
}
export const create = mutation({
  args: {
    ...commands,
    leaseId: v.id("leases"),
    baseVersionId: v.id("leaseVersions"),
    occupancyId: v.optional(v.id("occupancies")),
    kind,
    title: v.string(),
    sourceNote: v.string(),
    targetOn: v.union(v.string(), v.null()),
    timelineSourceNote: v.string(),
    administrativeDueAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const a = await access(ctx, args.scope),
      lease = await ctx.db.get(args.leaseId)
    if (!lease || !a.allowed.includes(lease.spaceId)) throw new NotFound()
    const link = {
        spaceId: lease.spaceId,
        leaseId: lease._id,
        unitId: lease.unitId,
        baseVersionId: args.baseVersionId,
        occupancyId: args.occupancyId,
      },
      g = await graph(ctx, link)
    if (args.kind === "move_out" && !g.occupancy)
      throw new Error("Choose the recorded occupancy for a move-out case")
    if (g.occupancy && g.occupancy.versionId !== args.baseVersionId)
      throw new Error(
        "Reconcile occupancy and agreement versions before case work"
      )
    const r = await replay(
      ctx,
      lease.spaceId,
      a.actorId,
      args.requestId,
      "lease_case.created",
      args
    )
    if (r.old) return r.old
    const witness = await leaseWitness(ctx, g),
      past = await ctx.db
        .query("leaseCases")
        .withIndex("by_space_lease_kind", (q) =>
          q
            .eq("spaceId", lease.spaceId)
            .eq("leaseId", lease._id)
            .eq("kind", args.kind)
        )
        .take(101)
    if (past.length >= 100)
      throw new Error(
        "Case history requires reconciliation before another case"
      )
    if (
      past.some(
        (row) =>
          row.baseVersionId === args.baseVersionId && row.status !== "cancelled"
      )
    )
      throw new Error(
        "An administrative case for this original agreement is already recorded"
      )
    const title = requiredText(args.title, 300, "case title"),
      sourceNote = requiredText(args.sourceNote, 2000, "case source"),
      timelineSourceNote = requiredText(
        args.timelineSourceNote,
        2000,
        "timeline source"
      ),
      targetOn = args.targetOn === null ? null : rentalDate(args.targetOn)
    let assignedTo: Id<"users"> | undefined
    if (
      await ctx.db
        .query("spaceMembers")
        .withIndex("by_space_user", (q) =>
          q.eq("spaceId", lease.spaceId).eq("userId", a.actorId)
        )
        .unique()
    )
      assignedTo = a.actorId
    const now = Date.now(),
      id = await ctx.db.insert("leaseCases", {
        ...link,
        leaseSourceVersion: witness,
        occupancySourceVersion: g.occupancy
          ? await evidenceVersion(g.occupancy)
          : undefined,
        kind: args.kind,
        status: "collecting",
        title,
        sourceNote,
        targetOn,
        timelineSourceNote,
        administrativeDueAt: exactTime(args.administrativeDueAt),
        assignedTo,
        revision: 0,
        createdBy: a.actorId,
        createdAt: now,
        updatedAt: now,
      })
    return receipt(
      ctx,
      lease.spaceId,
      a.actorId,
      args.requestId,
      r.fingerprint,
      { recordId: id, revision: 0 },
      "lease_case.created"
    )
  },
})
export const assign = mutation({
  args: { ...changes, assignedTo: v.id("users") },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "lease_case.assigned")
    if (a.old) return a.old
    mutable(a.row)
    await assignee(ctx, a.row.spaceId, args.assignedTo)
    return save(ctx, args, a, "lease_case.assigned", {
      assignedTo: args.assignedTo,
    })
  },
})
export const updatePlan = mutation({
  args: {
    ...changes,
    title: v.string(),
    targetOn: v.union(v.string(), v.null()),
    timelineSourceNote: v.string(),
    administrativeDueAt: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "lease_case.plan_changed")
    if (a.old) return a.old
    mutable(a.row)
    return save(ctx, args, a, "lease_case.plan_changed", {
      title: requiredText(args.title, 300, "case title"),
      targetOn: args.targetOn === null ? null : rentalDate(args.targetOn),
      timelineSourceNote: requiredText(
        args.timelineSourceNote,
        2000,
        "timeline source"
      ),
      administrativeDueAt: exactTime(args.administrativeDueAt),
    })
  },
})
export const refreshOccupancy = mutation({
  args: { ...changes, note: v.string() },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "lease_case.occupancy_refreshed")
    if (a.old) return a.old
    mutable(a.row)
    requiredText(args.note, 2000, "source refresh reason")
    const g = await sourceCurrent(ctx, a.row, false)
    return save(ctx, args, a, "lease_case.occupancy_refreshed", {
      occupancySourceVersion: g.occupancy
        ? await evidenceVersion(g.occupancy)
        : undefined,
      status: "collecting",
      packetId: undefined,
      reviewId: undefined,
      holdReason: undefined,
      nextAction: undefined,
      followUpAt: undefined,
    })
  },
})
export const submitRenewal = mutation({
  args: {
    ...changes,
    proposalVersionId: v.id("leaseVersions"),
    fileId: v.id("documentFiles"),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "lease_case.renewal_packet_saved")
    if (a.old) return a.old
    if (a.row.kind !== "renewal" || a.row.status !== "collecting")
      throw new Error("Collect a renewal case before saving its packet")
    await accountable(ctx, a.row)
    const g = await sourceCurrent(ctx, a.row)
    const currentProposal = await proposal(ctx, g, args.proposalVersionId)
    const id = await ctx.db.insert("leaseCasePackets", {
      spaceId: a.row.spaceId,
      caseId: a.row._id,
      reviewRevision: a.row.revision + 1,
      sourceVersion: await caseVersion(a.row),
      proposalVersionId: args.proposalVersionId,
      proposalSourceVersion: await evidenceVersion(currentProposal),
      documents: [await document(ctx, g, args.fileId)],
      summary: requiredText(args.summary, 5000, "administrative summary"),
      recordedBy: a.actorId,
      recordedAt: Date.now(),
    })
    return save(ctx, args, a, "lease_case.renewal_packet_saved", {
      status: "awaiting_review",
      packetId: id,
      reviewId: undefined,
    })
  },
})
export const submitMoveOut = mutation({
  args: {
    ...changes,
    beforeOn: v.string(),
    afterOn: v.string(),
    beforeFileId: v.id("documentFiles"),
    afterFileId: v.id("documentFiles"),
    conditions: v.array(conditionObservation),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "lease_case.moveout_packet_saved")
    if (a.old) return a.old
    if (a.row.kind !== "move_out" || a.row.status !== "collecting")
      throw new Error("Collect a move-out case before saving its packet")
    await accountable(ctx, a.row)
    const g = await sourceCurrent(ctx, a.row),
      beforeOn = observed(g.unit.timeZone, args.beforeOn),
      afterOn = observed(g.unit.timeZone, args.afterOn)
    if (beforeOn > afterOn)
      throw new Error("Before evidence cannot follow the after observation")
    if (args.beforeFileId === args.afterFileId)
      throw new Error("Distinct before and after sources are required")
    const id = await ctx.db.insert("leaseCasePackets", {
      spaceId: a.row.spaceId,
      caseId: a.row._id,
      reviewRevision: a.row.revision + 1,
      sourceVersion: await caseVersion(a.row),
      beforeOn,
      afterOn,
      conditions: validateConditionObservations(args.conditions),
      documents: [
        await document(ctx, g, args.beforeFileId),
        await document(ctx, g, args.afterFileId),
      ],
      summary: requiredText(args.summary, 5000, "administrative summary"),
      recordedBy: a.actorId,
      recordedAt: Date.now(),
    })
    return save(ctx, args, a, "lease_case.moveout_packet_saved", {
      status: "awaiting_review",
      packetId: id,
      reviewId: undefined,
    })
  },
})
export const review = mutation({
  args: {
    ...changes,
    approved: v.boolean(),
    note: v.string(),
    confirmation: v.literal(
      "I checked the current case sources and administrative packet"
    ),
  },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "lease_case.review_recorded")
    if (a.old) return a.old
    if (a.row.status !== "awaiting_review" || !a.row.packetId)
      throw new Error("Review a saved administrative packet")
    const packet = await assertInSpace(
      ctx,
      "leaseCasePackets",
      a.row.packetId,
      a.row.spaceId
    )
    if (packet.caseId !== a.row._id) throw new NotFound()
    if (args.approved) {
      if (!a.row.assignedTo)
        throw new Error("Assign an accountable current record-workspace member")
      await assignee(ctx, a.row.spaceId, a.row.assignedTo)
      if (packet.reviewRevision !== a.row.revision)
        throw new Error(
          "The record changed; reject and submit a current packet"
        )
      await packetCurrent(ctx, a.row)
    }
    const id = await ctx.db.insert("leaseCaseReviews", {
      spaceId: a.row.spaceId,
      caseId: a.row._id,
      packetId: packet._id,
      sourceVersion: await caseVersion(a.row),
      packetVersion: await evidenceVersion(packet),
      approved: args.approved,
      note: requiredText(args.note, 2000, "administrative review note"),
      recordedBy: a.actorId,
      recordedAt: Date.now(),
    })
    return save(ctx, args, a, "lease_case.review_recorded", {
      status: args.approved ? "review_recorded" : "collecting",
      reviewId: id,
      packetId: args.approved ? packet._id : undefined,
    })
  },
})
export const hold = mutation({
  args: {
    ...changes,
    reason: v.string(),
    nextAction: v.string(),
    followUpAt: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "lease_case.held")
    if (a.old) return a.old
    mutable(a.row)
    return save(ctx, args, a, "lease_case.held", {
      status: "held",
      holdReason: requiredText(args.reason, 2000, "hold reason"),
      nextAction: requiredText(args.nextAction, 2000, "next action"),
      followUpAt: exactTime(args.followUpAt),
    })
  },
})
export const cancel = mutation({
  args: { ...changes, note: v.string() },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "lease_case.cancelled")
    if (a.old) return a.old
    if (a.row.status === "cancelled")
      throw new Error("Case is already cancelled")
    return save(ctx, args, a, "lease_case.cancelled", {
      status: "cancelled",
      cancellationNote: requiredText(args.note, 2000, "cancellation note"),
      holdReason: undefined,
      nextAction: undefined,
      followUpAt: undefined,
    })
  },
})
export const reopen = mutation({
  args: { ...changes, note: v.string() },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "lease_case.reopened")
    if (a.old) return a.old
    if (
      !["review_recorded", "cancelled", "awaiting_review", "held"].includes(
        a.row.status
      )
    )
      throw new Error("Reopen a reviewed, submitted, held or cancelled case")
    requiredText(args.note, 2000, "reopen reason")
    const peers = await ctx.db
      .query("leaseCases")
      .withIndex("by_space_lease_kind", (q) =>
        q
          .eq("spaceId", a.row.spaceId)
          .eq("leaseId", a.row.leaseId)
          .eq("kind", a.row.kind)
      )
      .take(101)
    if (peers.length > 100)
      throw new Error("Case history requires reconciliation before reopening")
    if (
      peers.some(
        (row) =>
          row._id !== a.row._id &&
          row.baseVersionId === a.row.baseVersionId &&
          row.status !== "cancelled"
      )
    )
      throw new Error(
        "An administrative case for this original agreement is already recorded"
      )
    return save(ctx, args, a, "lease_case.reopened", {
      status: "collecting",
      packetId: undefined,
      reviewId: undefined,
      holdReason: undefined,
      nextAction: undefined,
      followUpAt: undefined,
      cancellationNote: undefined,
    })
  },
})
async function context(ctx: Ctx, row: Doc<"leaseCases">) {
  const g = await graph(ctx, row)
  let sourceState: "current_recorded_source" | "needs_review" =
      "current_recorded_source",
    packetState: "not_recorded" | "current_accepted_record" | "needs_review" =
      "not_recorded",
    currentReview = false,
    assignedName: string | null = null,
    memberCurrent = false
  try {
    await sourceCurrent(ctx, row)
  } catch {
    sourceState = "needs_review"
  }
  if (row.assignedTo)
    try {
      await assignee(ctx, row.spaceId, row.assignedTo)
      assignedName = (await ctx.db.get(row.assignedTo))?.name ?? null
      memberCurrent = true
    } catch {
      /* No foreign account names. */
    }
  let packet: Doc<"leaseCasePackets"> | null = null,
    proposed: Doc<"leaseVersions"> | null = null
  if (row.packetId) {
    packet = await assertInSpace(
      ctx,
      "leaseCasePackets",
      row.packetId,
      row.spaceId
    )
    if (packet.caseId !== row._id) throw new NotFound()
    if (packet.proposalVersionId) {
      proposed = await assertInSpace(
        ctx,
        "leaseVersions",
        packet.proposalVersionId,
        row.spaceId
      )
      if (proposed.leaseId !== row.leaseId) throw new NotFound()
      for (const id of [
        ...proposed.terms.tenantContactIds,
        ...proposed.terms.landlordContactIds,
      ])
        await assertInSpace(ctx, "contacts", id, row.spaceId)
    }
    try {
      await packetCurrent(ctx, row)
      packetState = "current_accepted_record"
    } catch {
      packetState = "needs_review"
    }
  }
  if (row.reviewId) {
    const review = await assertInSpace(
      ctx,
      "leaseCaseReviews",
      row.reviewId,
      row.spaceId
    )
    if (review.caseId !== row._id) throw new NotFound()
    currentReview =
      row.status === "review_recorded" &&
      review.approved &&
      review.packetId === row.packetId &&
      packet !== null &&
      review.packetVersion === (await evidenceVersion(packet)) &&
      review.sourceVersion === (await caseVersion(row)) &&
      sourceState === "current_recorded_source" &&
      packetState === "current_accepted_record" &&
      memberCurrent
  }
  const staleRevision =
    row.status === "awaiting_review" && packet?.reviewRevision !== row.revision
  return {
    recordId: row._id,
    leaseReference: row.leaseId,
    revision: row.revision,
    kind: row.kind,
    status: row.status,
    title: row.title,
    address: g.property.address,
    unit: g.unit.label,
    timeZone: g.unit.timeZone,
    tenantNames: await Promise.all(
      g.base.terms.tenantContactIds.map(
        async (id) =>
          (await assertInSpace(ctx, "contacts", id, row.spaceId)).name
      )
    ),
    baseAgreement: {
      version: g.base.number,
      startsOn: g.base.terms.startsOn,
      endsOn: g.base.terms.endsOn,
      rentMinor: g.base.terms.rentMinor,
      currency: g.base.terms.currency,
    },
    occupancy: g.occupancy
      ? {
          state: g.occupancy.status,
          startsOn: g.occupancy.startsOn,
          endsOn: g.occupancy.endsOn ?? null,
        }
      : null,
    targetOn: row.targetOn,
    timelineSourceNote: row.timelineSourceNote,
    administrativeDueAt: row.administrativeDueAt ?? null,
    assignee: assignedName,
    assigneeCurrent: memberCurrent,
    sourceState,
    packetState,
    staleRevision,
    reviewState: currentReview
      ? "administrative_human_review_recorded"
      : row.status === "review_recorded"
        ? "needs_review"
        : "not_currently_approved",
    proposedTerms: proposed
      ? {
          version: proposed.number,
          startsOn: proposed.terms.startsOn,
          endsOn: proposed.terms.endsOn,
          rentMinor: proposed.terms.rentMinor,
          currency: proposed.terms.currency,
          frequency: proposed.terms.frequency,
          paymentTerms: proposed.terms.paymentTerms,
          depositMinor: proposed.terms.depositMinor,
          sourceNote: proposed.terms.sourceNote,
        }
      : null,
    conditions: packet?.conditions ?? null,
    conditionCoverage: packet?.conditions
      ? "selected_recorded_areas_only"
      : "not_recorded",
    packetSummary: packet?.summary ?? null,
    observedBeforeOn: packet?.beforeOn ?? null,
    observedAfterOn: packet?.afterOn ?? null,
    holdReason: row.holdReason ?? null,
    cancellationNote: row.cancellationNote ?? null,
    followUpAt: row.followUpAt ?? null,
    nextAction: !memberCurrent
      ? "Assign a current record-workspace member before further review."
      : sourceState === "needs_review"
        ? "Reconcile the original agreement/occupancy; explicitly refresh occupancy or create a case against the current agreement source."
        : staleRevision ||
            packetState === "needs_review" ||
            (row.status === "review_recorded" && !currentReview)
          ? "Reject or reopen the stale packet, then submit current evidence for administrative review."
          : (row.nextAction ??
            (row.status === "awaiting_review"
              ? "A human must review the current administrative packet; this does not authorize a notice or commitment."
              : null)),
    jurisdictionRuleState: "not_activated",
    noticeDeliveryState: "not_verified",
    financialActionAuthority: "not_authorized",
    contractCommitmentAuthority: "not_authorized",
    businessCompletionState: "not_verified",
    limitations:
      "Recorded administrative cases and human review only. Proposed terms are not executed renewal. Condition differences do not prove liability or authorize deductions. No legal deadline, notice, delivery, refund, eligibility, payment or contractual commitment is established.",
    retrievedAt: Date.now(),
  }
}
export async function leaseCasePage(
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
        ? ctx.db.normalizeId("leaseCases", input.recordId)
        : null
    if (!id) throw new NotFound()
    return {
      records: [await context(ctx, await owned(ctx, id, allowed))],
      isDone: true,
    }
  }
  const spaceId =
    input.workspaceId !== undefined
      ? typeof input.workspaceId === "string" && input.workspaceId
        ? ctx.db.normalizeId("spaces", input.workspaceId)
        : null
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
    .query("leaseCases")
    .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
    .order("desc")
    .paginate(page)
  return {
    records: await Promise.all(result.page.map((row) => context(ctx, row))),
    continuationCursor: result.continueCursor,
    isDone: result.isDone,
    limit: 20,
  }
}
export const list = query({
  args: {
    ...scopeArgs,
    recordId: v.optional(v.id("leaseCases")),
    workspaceId: v.optional(v.id("spaces")),
    pagination: v.optional(paginationOptsValidator),
  },
  handler: async (ctx, args) =>
    leaseCasePage(ctx, (await access(ctx, args.scope)).allowed, args),
})
