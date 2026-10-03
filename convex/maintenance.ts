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
import { rentalScope, rentalDate } from "./rental_model"
import { revision, replay, receipt } from "./rentals"
import { requiredText } from "./record_validation"
import { canonicalTimeZone, localDateKey } from "./availability"
import { cleanDocument } from "./document_scan_state"
import { evidenceVersion } from "./source_evidence"

type Ctx = QueryCtx | MutationCtx
type Scope = Infer<typeof rentalScope> | undefined
const priority = v.union(
  v.literal("routine"),
  v.literal("urgent"),
  v.literal("emergency")
)
const scopeArgs = { scope: v.optional(rentalScope) }
const commands = { ...scopeArgs, requestId: v.string() }
const changes = {
  ...commands,
  caseId: v.id("maintenanceCases"),
  expectedRevision: v.number(),
}
async function access(ctx: Ctx, scope: Scope) {
  const actorId = await requireUserId(ctx)
  const principal = await resolveWorkforceScope(
    ctx,
    actorId,
    scope?.kind ?? "personal",
    scope?.id ?? actorId
  )
  return { actorId, allowed: await spacesFor(ctx, principal) }
}
async function ownedCase(
  ctx: Ctx,
  id: Id<"maintenanceCases">,
  allowed: Id<"spaces">[]
) {
  const row = await ctx.db.get(id)
  if (!row || !allowed.includes(row.spaceId)) throw new NotFound()
  await relationships(ctx, row)
  return row
}
async function relationships(
  ctx: Ctx,
  row: Pick<
    Doc<"maintenanceCases">,
    | "spaceId"
    | "propertyId"
    | "unitId"
    | "occupancyId"
    | "reporterId"
    | "vendorContactId"
    | "timeZone"
  >
) {
  await assertInSpace(ctx, "properties", row.propertyId, row.spaceId)
  if (row.reporterId)
    await assertInSpace(ctx, "contacts", row.reporterId, row.spaceId)
  if (row.vendorContactId)
    await assertInSpace(ctx, "contacts", row.vendorContactId, row.spaceId)
  if (row.unitId) {
    const unit = await assertInSpace(
      ctx,
      "rentalUnits",
      row.unitId,
      row.spaceId
    )
    if (unit.propertyId !== row.propertyId) throw new NotFound()
    if (canonicalTimeZone(unit.timeZone) !== row.timeZone)
      throw new Error("Work report time zone must match the recorded unit")
  }
  if (row.occupancyId) {
    const occupancy = await assertInSpace(
      ctx,
      "occupancies",
      row.occupancyId,
      row.spaceId
    )
    if (!row.unitId || occupancy.unitId !== row.unitId) throw new NotFound()
    const lease = await assertInSpace(
      ctx,
      "leases",
      occupancy.leaseId,
      row.spaceId
    )
    const version = await assertInSpace(
      ctx,
      "leaseVersions",
      occupancy.versionId,
      row.spaceId
    )
    if (lease.unitId !== row.unitId || version.leaseId !== lease._id)
      throw new NotFound()
    for (const party of [
      ...version.terms.tenantContactIds,
      ...version.terms.landlordContactIds,
    ])
      await assertInSpace(ctx, "contacts", party, row.spaceId)
    if (
      row.reporterId &&
      ![
        ...version.terms.tenantContactIds,
        ...version.terms.landlordContactIds,
      ].includes(row.reporterId)
    )
      throw new Error("Reporter does not match the recorded occupancy parties")
  }
}
function timestamp(value: number | null | undefined) {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || value < 0 || value > Date.UTC(2200, 0, 1))
    throw new Error("Enter a supported exact date and time")
  return value
}
function observed(
  row: { timeZone: string; reportedOn: string },
  value: string
) {
  const zone = canonicalTimeZone(row.timeZone)
  if (!zone) throw new Error("Confirm the recorded time zone")
  const date = rentalDate(value)
  if (date > localDateKey(new Date(), zone))
    throw new Error("An observed work date cannot be in the future")
  if (date < row.reportedOn)
    throw new Error("An observed work date cannot precede the report")
  return date
}
export async function assignee(ctx: Ctx, spaceId: Id<"spaces">, userId: Id<"users">) {
  if (
    !(await ctx.db.get(userId)) ||
    !(await ctx.db
      .query("spaceMembers")
      .withIndex("by_space_user", (q) =>
        q.eq("spaceId", spaceId).eq("userId", userId)
      )
      .unique())
  )
    throw new Error("Choose a current member of this record workspace")
}
async function content(row: Doc<"maintenanceCases">) {
  return evidenceVersion({
    propertyId: row.propertyId,
    unitId: row.unitId ?? null,
    occupancyId: row.occupancyId ?? null,
    reporterId: row.reporterId ?? null,
    title: row.title,
    problem: row.problem,
    sourceNote: row.sourceNote,
    reportedOn: row.reportedOn,
    timeZone: row.timeZone,
    priority: row.priority,
    dueAt: row.dueAt ?? null,
    assignedTo: row.assignedTo ?? null,
    vendorContactId: row.vendorContactId ?? null,
    startedOn: row.startedOn ?? null,
    startedSourceNote: row.startedSourceNote ?? null,
    emergencyResponseNote: row.emergencyResponseNote ?? null,
  })
}
async function document(
  ctx: Ctx,
  row: Doc<"maintenanceCases">,
  id: Id<"documentFiles">
) {
  const file = await assertInSpace(ctx, "documentFiles", id, row.spaceId)
  const request = await assertInSpace(
    ctx,
    "documentRequests",
    file.requestId,
    row.spaceId
  )
  const application = await assertInSpace(
    ctx,
    "applications",
    request.applicationId,
    row.spaceId
  )
  await assertInSpace(ctx, "contacts", application.contactId, row.spaceId)
  if (
    !cleanDocument(file) ||
    request.status !== "accepted" ||
    !request.reviewedAt ||
    request.revision !== file.requestRevision ||
    (row.reporterId && application.contactId !== row.reporterId)
  )
    throw new Error(
      "Current accepted and scanned evidence for this recorded reporter is required"
    )
  return { file, request }
}
async function evidenceCurrent(ctx: Ctx, row: Doc<"maintenanceCases">) {
  if (!row.completionEvidenceId)
    throw new Error("No recorded completion evidence")
  const proof = await assertInSpace(
    ctx,
    "maintenanceEvidence",
    row.completionEvidenceId,
    row.spaceId
  )
  if (proof.caseId !== row._id) throw new NotFound()
  if (proof.contentVersion !== (await content(row)))
    throw new Error(
      "The plan changed; submit evidence against the current instructions"
    )
  observed(row, proof.completedOn)
  if (!row.startedOn || proof.completedOn < row.startedOn)
    throw new Error("Completion evidence dates need review")
  const { file, request } = await document(ctx, row, proof.fileId)
  if (
    file.digest !== proof.fileDigest ||
    file.revision !== proof.fileRevision ||
    request.revision !== proof.requestRevision
  )
    throw new Error("Completion evidence changed; review the current source")
  return proof
}
async function change(
  ctx: MutationCtx,
  args: {
    scope?: Scope
    caseId: Id<"maintenanceCases">
    expectedRevision: number
    requestId: string
  },
  action: string
) {
  const a = await access(ctx, args.scope),
    row = await ownedCase(ctx, args.caseId, a.allowed)
  const r = await replay(
    ctx,
    row.spaceId,
    a.actorId,
    args.requestId,
    action,
    args
  )
  if (!r.old) revision(row.revision, args.expectedRevision)
  return { ...a, row, ...r }
}
async function save(
  ctx: MutationCtx,
  args: { requestId: string },
  a: Awaited<ReturnType<typeof change>>,
  kind: string,
  patch: Partial<Doc<"maintenanceCases">>
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
    kind
  )
}
function active(row: Doc<"maintenanceCases">) {
  if (row.status === "cancelled" || row.status === "review_recorded")
    throw new Error("Reopen this case before changing its plan")
}
export const create = mutation({
  args: {
    ...commands,
    propertyId: v.id("properties"),
    unitId: v.optional(v.id("rentalUnits")),
    occupancyId: v.optional(v.id("occupancies")),
    reporterId: v.optional(v.id("contacts")),
    title: v.string(),
    problem: v.string(),
    sourceNote: v.string(),
    reportedOn: v.string(),
    timeZone: v.string(),
    priority,
    dueAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const a = await access(ctx, args.scope),
      property = await ctx.db.get(args.propertyId)
    if (!property || !a.allowed.includes(property.spaceId)) throw new NotFound()
    const timeZone = canonicalTimeZone(
      requiredText(args.timeZone, 100, "time zone")
    )
    if (!timeZone) throw new Error("Enter a valid explicit time zone")
    const reportedOn = rentalDate(args.reportedOn)
    if (reportedOn > localDateKey(new Date(), timeZone))
      throw new Error("A reported observation cannot be in the future")
    const title = requiredText(args.title, 300, "work title"),
      problem = requiredText(args.problem, 5000, "reported problem"),
      sourceNote = requiredText(args.sourceNote, 2000, "report source"),
      dueAt = timestamp(args.dueAt)
    const relation = {
      spaceId: property.spaceId,
      propertyId: property._id,
      unitId: args.unitId,
      occupancyId: args.occupancyId,
      reporterId: args.reporterId,
      timeZone,
    }
    await relationships(ctx, relation)
    const r = await replay(
      ctx,
      property.spaceId,
      a.actorId,
      args.requestId,
      "maintenance.created",
      args
    )
    if (r.old) return r.old
    const emergency = args.priority === "emergency",
      now = Date.now()
    const id = await ctx.db.insert("maintenanceCases", {
      ...relation,
      title,
      problem,
      sourceNote,
      reportedOn,
      timeZone,
      priority: args.priority,
      dueAt,
      status: emergency ? "held" : "open",
      holdReason: emergency
        ? "Emergency report requires a human response decision"
        : undefined,
      nextAction: emergency
        ? "Follow your existing emergency response procedure and record what was confirmed. Chippi has not alerted anyone."
        : undefined,
      revision: 0,
      createdBy: a.actorId,
      createdAt: now,
      updatedAt: now,
    })
    return receipt(
      ctx,
      property.spaceId,
      a.actorId,
      args.requestId,
      r.fingerprint,
      { recordId: id, revision: 0 },
      "maintenance.created"
    )
  },
})
export const assign = mutation({
  args: {
    ...changes,
    assignedTo: v.id("users"),
    vendorContactId: v.optional(v.id("contacts")),
    emergencyResponseNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "maintenance.assigned")
    if (a.old) return a.old
    if (!["open", "assigned", "held"].includes(a.row.status))
      throw new Error("Assignment requires an open, assigned or held case")
    await assignee(ctx, a.row.spaceId, args.assignedTo)
    if (args.vendorContactId)
      await assertInSpace(ctx, "contacts", args.vendorContactId, a.row.spaceId)
    const emergencyResponseNote =
      a.row.priority === "emergency"
        ? requiredText(
            args.emergencyResponseNote ?? "",
            2000,
            "confirmed emergency response record"
          )
        : undefined
    return save(ctx, args, a, "maintenance.assigned", {
      assignedTo: args.assignedTo,
      vendorContactId: args.vendorContactId,
      status: "assigned",
      holdReason: undefined,
      nextAction: undefined,
      followUpAt: undefined,
      emergencyResponseNote,
      startedOn: undefined,
      startedSourceNote: undefined,
      completionEvidenceId: undefined,
      completionReviewId: undefined,
    })
  },
})
export const updatePlan = mutation({
  args: {
    ...changes,
    title: v.string(),
    problem: v.string(),
    dueAt: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "maintenance.plan_changed")
    if (a.old) return a.old
    active(a.row)
    return save(ctx, args, a, "maintenance.plan_changed", {
      title: requiredText(args.title, 300, "work title"),
      problem: requiredText(args.problem, 5000, "reported problem"),
      dueAt: timestamp(args.dueAt),
    })
  },
})
export const recordStart = mutation({
  args: { ...changes, startedOn: v.string(), sourceNote: v.string() },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "maintenance.start_recorded")
    if (a.old) return a.old
    if (a.row.status !== "assigned" || !a.row.assignedTo)
      throw new Error("Assign a current workspace member before recording work")
    await assignee(ctx, a.row.spaceId, a.row.assignedTo)
    return save(ctx, args, a, "maintenance.start_recorded", {
      status: "in_progress",
      startedOn: observed(a.row, args.startedOn),
      startedSourceNote: requiredText(
        args.sourceNote,
        2000,
        "work-start source"
      ),
    })
  },
})
export const recordHold = mutation({
  args: {
    ...changes,
    reason: v.string(),
    nextAction: v.string(),
    followUpAt: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "maintenance.held")
    if (a.old) return a.old
    active(a.row)
    return save(ctx, args, a, "maintenance.held", {
      status: "held",
      holdReason: requiredText(args.reason, 2000, "hold reason"),
      nextAction: requiredText(args.nextAction, 2000, "next action"),
      followUpAt: timestamp(args.followUpAt),
    })
  },
})
export const recordOutcome = mutation({
  args: {
    ...changes,
    completedOn: v.string(),
    summary: v.string(),
    fileId: v.id("documentFiles"),
  },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "maintenance.outcome_recorded")
    if (a.old) return a.old
    if (a.row.status !== "in_progress" || !a.row.assignedTo || !a.row.startedOn)
      throw new Error(
        "Record assigned work in progress before submitting its outcome"
      )
    await assignee(ctx, a.row.spaceId, a.row.assignedTo)
    const completedOn = observed(a.row, args.completedOn)
    if (completedOn < a.row.startedOn)
      throw new Error("Completion cannot precede the recorded work start")
    const { file, request } = await document(ctx, a.row, args.fileId)
    const proof = await ctx.db.insert("maintenanceEvidence", {
      spaceId: a.row.spaceId,
      caseId: a.row._id,
      reviewRevision: a.row.revision + 1,
      contentVersion: await content(a.row),
      completedOn,
      summary: requiredText(args.summary, 5000, "recorded outcome"),
      fileId: file._id,
      fileDigest: file.digest,
      fileRevision: file.revision,
      requestRevision: request.revision,
      recordedBy: a.actorId,
      recordedAt: Date.now(),
    })
    return save(ctx, args, a, "maintenance.outcome_recorded", {
      status: "awaiting_review",
      completionEvidenceId: proof,
      completionReviewId: undefined,
    })
  },
})
export const reviewOutcome = mutation({
  args: {
    ...changes,
    approved: v.boolean(),
    note: v.string(),
    confirmation: v.literal(
      "I checked the recorded completion evidence and the work outcome"
    ),
  },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "maintenance.review_recorded")
    if (a.old) return a.old
    if (a.row.status !== "awaiting_review" || !a.row.completionEvidenceId)
      throw new Error("Review a saved outcome before completing this record")
    const proof = await assertInSpace(
      ctx,
      "maintenanceEvidence",
      a.row.completionEvidenceId,
      a.row.spaceId
    )
    if (proof.caseId !== a.row._id) throw new NotFound()
    if (args.approved) {
      if (!a.row.assignedTo) throw new Error("Confirm the accountable member")
      await assignee(ctx, a.row.spaceId, a.row.assignedTo)
      if (proof.reviewRevision !== a.row.revision)
        throw new Error(
          "The record changed; reject and submit current evidence"
        )
      await evidenceCurrent(ctx, a.row)
    }
    const id = await ctx.db.insert("maintenanceReviews", {
      spaceId: a.row.spaceId,
      caseId: a.row._id,
      evidenceId: proof._id,
      contentVersion: await content(a.row),
      evidenceVersion: await evidenceVersion(proof),
      approved: args.approved,
      note: requiredText(args.note, 2000, "review record"),
      recordedBy: a.actorId,
      recordedAt: Date.now(),
    })
    return save(ctx, args, a, "maintenance.review_recorded", {
      status: args.approved ? "review_recorded" : "in_progress",
      completionReviewId: id,
      completionEvidenceId: args.approved ? proof._id : undefined,
    })
  },
})
export const cancel = mutation({
  args: { ...changes, note: v.string() },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "maintenance.cancelled")
    if (a.old) return a.old
    active(a.row)
    return save(ctx, args, a, "maintenance.cancelled", {
      status: "cancelled",
      cancellationNote: requiredText(args.note, 2000, "cancellation reason"),
      nextAction: undefined,
      holdReason: undefined,
      followUpAt: undefined,
    })
  },
})
export const reopen = mutation({
  args: { ...changes, note: v.string() },
  handler: async (ctx, args) => {
    const a = await change(ctx, args, "maintenance.reopened")
    if (a.old) return a.old
    if (
      !["review_recorded", "cancelled", "awaiting_review"].includes(
        a.row.status
      )
    )
      throw new Error("Reopen a reviewed, cancelled or stale submitted case")
    const reason = requiredText(args.note, 2000, "reopen reason")
    return save(ctx, args, a, "maintenance.reopened", {
      status: "held",
      holdReason: reason,
      nextAction:
        "Confirm the current plan and member assignment before further work.",
      completionEvidenceId: undefined,
      completionReviewId: undefined,
      startedOn: undefined,
      startedSourceNote: undefined,
      cancellationNote: undefined,
    })
  },
})
async function context(ctx: Ctx, row: Doc<"maintenanceCases">) {
  await relationships(ctx, row)
  const property = await assertInSpace(
    ctx,
    "properties",
    row.propertyId,
    row.spaceId
  )
  let evidenceState:
      "not_recorded" | "current_accepted_record" | "needs_review" =
      "not_recorded",
    outcome: Doc<"maintenanceEvidence"> | null = null
  if (row.completionEvidenceId) {
    outcome = await assertInSpace(
      ctx,
      "maintenanceEvidence",
      row.completionEvidenceId,
      row.spaceId
    )
    if (outcome.caseId !== row._id) throw new NotFound()
    try {
      await evidenceCurrent(ctx, row)
      evidenceState = "current_accepted_record"
    } catch {
      evidenceState = "needs_review"
    }
  }
  let assigneeCurrent = true,
    assignedName: string | null = null
  if (row.assignedTo) {
    try {
      await assignee(ctx, row.spaceId, row.assignedTo)
      assignedName = (await ctx.db.get(row.assignedTo))?.name ?? null
    } catch {
      assigneeCurrent = false
    }
  }
  let reviewCurrent = false
  if (row.completionReviewId) {
    const review = await assertInSpace(
      ctx,
      "maintenanceReviews",
      row.completionReviewId,
      row.spaceId
    )
    if (review.caseId !== row._id) throw new NotFound()
    reviewCurrent =
      review.approved &&
      review.evidenceId === row.completionEvidenceId &&
      review.contentVersion === (await content(row)) &&
      outcome !== null &&
      review.evidenceVersion === (await evidenceVersion(outcome)) &&
      evidenceState === "current_accepted_record" &&
      assigneeCurrent
  }
  const staleRevision =
    row.status === "awaiting_review" && outcome?.reviewRevision !== row.revision
  return {
    recordId: row._id,
    revision: row.revision,
    address: property.address,
    unit: row.unitId
      ? (await assertInSpace(ctx, "rentalUnits", row.unitId, row.spaceId)).label
      : null,
    title: row.title,
    problem: row.problem,
    priority: row.priority,
    reportedOn: row.reportedOn,
    timeZone: row.timeZone,
    dueAt: row.dueAt ?? null,
    status: row.status,
    assignee: assignedName,
    assigneeCurrent,
    vendorCandidate: row.vendorContactId
      ? (await assertInSpace(ctx, "contacts", row.vendorContactId, row.spaceId))
          .name
      : null,
    sourceNote: row.sourceNote,
    startedOn: row.startedOn ?? null,
    outcome: outcome
      ? {
          completedOn: outcome.completedOn,
          summary: outcome.summary,
          recordedAt: outcome.recordedAt,
        }
      : null,
    evidenceState,
    reviewState: reviewCurrent
      ? "human_review_recorded"
      : row.status === "review_recorded"
        ? "needs_review"
        : "not_currently_approved",
    staleRevision,
    nextAction: !assigneeCurrent
      ? "Reassign this case to a current record-workspace member before further work."
      : staleRevision ||
          evidenceState === "needs_review" ||
          (row.status === "review_recorded" && !reviewCurrent)
        ? "Reopen or reject the stale outcome, then submit evidence against the current plan and source."
        : (row.nextAction ??
          (row.status === "awaiting_review"
            ? "A human must check the saved evidence and work outcome before recording approval."
            : null)),
    cancellationNote: row.cancellationNote ?? null,
    holdReason: row.holdReason ?? null,
    followUpAt: row.followUpAt ?? null,
    emergencyResponseNote: row.emergencyResponseNote ?? null,
    vendorSelectionState: "candidate_record_only",
    externalDispatchState: "not_verified",
    physicalCompletionState: "not_independently_verified",
    limitations:
      "Entered reports, document-backed outcome observations and human review records only. No vendor dispatch, acceptance, emergency notification, spending, appointment, physical repair or tenancy/legal decision is established.",
    retrievedAt: Date.now(),
  }
}
export async function maintenancePage(
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
        ? ctx.db.normalizeId("maintenanceCases", input.recordId)
        : null
    if (!id) throw new NotFound()
    return {
      records: [await context(ctx, await ownedCase(ctx, id, allowed))],
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
    .query("maintenanceCases")
    .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
    .order("desc")
    .paginate(page)
  return {
    records: await Promise.all(result.page.map((row) => context(ctx, row))),
    isDone: result.isDone,
    continuationCursor: result.continueCursor,
    limit: 20,
  }
}
export const list = query({
  args: {
    ...scopeArgs,
    recordId: v.optional(v.id("maintenanceCases")),
    workspaceId: v.optional(v.id("spaces")),
    pagination: v.optional(paginationOptsValidator),
  },
  handler: async (ctx, args) =>
    maintenancePage(ctx, (await access(ctx, args.scope)).allowed, args),
})
