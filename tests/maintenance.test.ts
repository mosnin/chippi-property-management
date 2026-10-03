import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
import schema from "../convex/schema"
import { api } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
const modules = {
  "../convex/maintenance.ts": () => import("../convex/maintenance"),
  "../convex/rentals.ts": () => import("../convex/rentals"),
  "../convex/workforce.ts": () => import("../convex/workforce"),
  "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
const confirmation =
  "I checked the recorded completion evidence and the work outcome" as const
async function fixture(
  priority: "routine" | "urgent" | "emergency" = "routine"
) {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Avery Fictional" }),
      other = await ctx.db.insert("users", { name: "Blake Fictional" })
    const desk = async (user: Id<"users">, slug: string) => {
      const spaceId = await ctx.db.insert("spaces", {
        name: slug,
        slug,
        emoji: "",
        ownerId: user,
      })
      const membership = await ctx.db.insert("spaceMembers", {
        spaceId,
        userId: user,
        role: "owner",
      })
      const propertyId = await ctx.db.insert("properties", {
        spaceId,
        address: "100 Fictional Way",
        listingStatus: "owned",
        photos: [],
      })
      const reporter = await ctx.db.insert("contacts", {
        spaceId,
        name: "Taylor Fictional",
        leadType: "rental",
        tags: [],
      })
      const vendor = await ctx.db.insert("contacts", {
        spaceId,
        name: "Fictional Maintenance Desk",
        leadType: "rental",
        tags: ["synthetic_vendor_candidate"],
      })
      return { spaceId, membership, propertyId, reporter, vendor }
    }
    return {
      owner,
      other,
      a: await desk(owner, "maintenance-a"),
      b: await desk(other, "maintenance-b"),
    }
  })
  const mine = t.withIdentity({ subject: ids.owner }),
    theirs = t.withIdentity({ subject: ids.other })
  const args = {
    propertyId: ids.a.propertyId,
    reporterId: ids.a.reporter,
    title: "Inspect reported kitchen leak",
    problem:
      "Fictional client reported a slow drip under the sink. No emergency diagnosis has been made.",
    sourceNote: "Synthetic local report; no real customer/provider",
    reportedOn: "2026-10-01",
    timeZone: "America/New_York",
    priority,
    requestId: "maintenance-intake",
  }
  const created = await mine.mutation(api.maintenance.create, args),
    caseId = created.recordId as Id<"maintenanceCases">
  const read = async () =>
    (await mine.query(api.maintenance.list, { recordId: caseId })).records[0]!
  const command = (requestId: string, expectedRevision: number) => ({
    caseId,
    requestId,
    expectedRevision,
  })
  const document = async (reporter = ids.a.reporter, spaceId = ids.a.spaceId) =>
    t.run(async (ctx) => {
      const applicationId = await ctx.db.insert("applications", {
        spaceId,
        contactId: reporter,
        name: "Fictional maintenance evidence",
        leadType: "rental",
        accessHash: "fixture-only",
        accessExpiresAt: Date.now() + 86400000,
        answers: {},
        formConfig: {},
        consentGiven: false,
        submittedAt: Date.now(),
        status: "received",
      })
      const requestId = await ctx.db.insert("documentRequests", {
        spaceId,
        applicationId,
        title: "Fictional completion evidence",
        instructions: "Synthetic accepted fixture, not physical repair proof",
        status: "accepted",
        createdAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        revision: 1,
        reviewedAt: Date.now(),
      })
      const fileId = await ctx.db.insert("documentFiles", {
        spaceId,
        requestId,
        objectKey: "synthetic/not-a-real-service-report.pdf",
        name: "fictional-service.pdf",
        contentType: "application/pdf",
        size: 20,
        digest: "a".repeat(64),
        status: "ready",
        scanStatus: "clean",
        scanDigest: "a".repeat(64),
        scanObjectKey: "synthetic/not-a-real-service-report.pdf",
        scanFileRevision: 1,
        createdAt: Date.now(),
        revision: 1,
        requestRevision: 1,
      })
      return { fileId, requestId, applicationId }
    })
  const assign = async () =>
    mine.mutation(api.maintenance.assign, {
      ...command("maintenance-assign", 0),
      assignedTo: ids.owner,
      vendorContactId: ids.a.vendor,
      ...(priority === "emergency"
        ? {
            emergencyResponseNote:
              "Fictional human response confirmation; no dispatch claimed",
          }
        : {}),
    })
  const start = async () => {
    await assign()
    return mine.mutation(api.maintenance.recordStart, {
      ...command("maintenance-start", 1),
      startedOn: "2026-10-01",
      sourceNote: "Fictional clerk recorded work-start observation",
    })
  }
  const submit = async () => {
    await start()
    const doc = await document()
    const outcome = {
      ...command("maintenance-outcome", 2),
      completedOn: "2026-10-02",
      summary:
        "Fictional service report says the connection was replaced; inspection is required",
      fileId: doc.fileId,
    }
    await mine.mutation(api.maintenance.recordOutcome, outcome)
    const review = {
      ...command("maintenance-review", 3),
      approved: true,
      note: "Fictional human checked the supplied record and entered outcome",
      confirmation,
    }
    return { ...doc, outcome, review }
  }
  return {
    t,
    ...ids,
    mine,
    theirs,
    args,
    created,
    caseId,
    read,
    command,
    document,
    assign,
    start,
    submit,
  }
}
describe("scoped maintenance lifecycle", () => {
  it("does not expose an unrelated account name through a corrupted assignee reference", async () => {
    const f = await fixture()
    await f.t.run((ctx) =>
      ctx.db.patch(f.caseId, { assignedTo: f.other, status: "assigned" })
    )
    const read = await f.read()
    expect(read.assigneeCurrent).toBe(false)
    expect(read.assignee).toBeNull()
    expect(JSON.stringify(read)).not.toContain("Blake Fictional")
  })
  it("publishes read-only typed context and refuses malformed references and a completion write through the signed gateway", async () => {
    const f = await fixture(),
      secret = "synthetic-only-maintenance-boundary-".repeat(3)
    vi.stubEnv("CHIPPI_WORKFORCE_SECRET", secret)
    const base = {
      secret,
      principal: {
        actorId: f.owner,
        kind: "personal" as const,
        scopeId: f.owner,
        name: "Fictional Desk",
        role: "owner" as const,
      },
      expiresAt: Date.now() + 10000,
      operation: "query",
    }
    expect(
      await f.t.mutation(api.workforce.bridge, {
        ...base,
        nonce: "maintenance-catalog",
        input: { operation: "catalog", operations: ["maintenanceCases"] },
      })
    ).toMatchObject({
      operations: [
        {
          operation: "maintenanceCases",
          pagination: expect.stringContaining("1–20"),
        },
      ],
    })
    for (const [n, recordId] of ["", 123].entries())
      await expect(
        f.t.mutation(api.workforce.bridge, {
          ...base,
          nonce: `malformed-${n}`,
          input: { operation: "maintenanceCases", recordId },
        })
      ).rejects.toThrow("Not found")
    await expect(
      f.t.mutation(api.workforce.bridge, {
        ...base,
        nonce: "forbidden-completion",
        input: {
          operation: "review_maintenance",
          caseId: f.caseId,
          approved: true,
        },
      })
    ).rejects.toThrow()
    expect((await f.read()).revision).toBe(0)
  })
  it("connects real rental/occupancy handlers and refuses wrong-property, unrelated-party and time-zone links", async () => {
    const f = await fixture(),
      landlord = await f.t.run((ctx) =>
        ctx.db.insert("contacts", {
          spaceId: f.a.spaceId,
          name: "Fictional Property Owner",
          leadType: "seller",
          tags: [],
        })
      )
    const u = await f.mine.mutation(api.rentals.createUnit, {
        propertyId: f.a.propertyId,
        label: "Unit 1",
        timeZone: "America/New_York",
        requestId: "rental-unit",
      }),
      unitId = u.recordId as Id<"rentalUnits">
    const lease = await f.mine.mutation(api.rentals.proposeLease, {
        unitId,
        terms: {
          tenantContactIds: [f.a.reporter],
          landlordContactIds: [landlord],
          startsOn: "2026-10-01",
          endsOn: "2027-09-30",
          rentMinor: 240000,
          currency: "USD",
          frequency: "monthly",
          paymentTerms: "Fictional recorded terms; no automated fees",
          depositMinor: null,
          sourceNote: "Fictional entered lease",
        },
        requestId: "rental-lease",
      }),
      leaseId = lease.recordId as Id<"leases">
    const proposed = (
        await f.mine.query(api.rentals.list, { recordId: leaseId })
      ).records[0]!.proposed!,
      doc = await f.document()
    await f.mine.mutation(api.rentals.recordExecution, {
      leaseId,
      expectedRevision: 0,
      proposedVersionId: proposed.versionId,
      fileId: doc.fileId,
      signedOn: "2026-09-30",
      confirmation: "I verified the signatures and the recorded terms",
      requestId: "rental-execution",
    })
    const occupancy = await f.mine.mutation(api.rentals.recordMoveIn, {
        leaseId,
        expectedRevision: 1,
        executedVersionId: proposed.versionId,
        startsOn: "2026-10-01",
        sourceNote: "Fictional observed occupancy",
        requestId: "rental-move-in",
      }),
      occupancyId = occupancy.recordId as Id<"occupancies">
    const linked = await f.mine.mutation(api.maintenance.create, {
      ...f.args,
      unitId,
      occupancyId,
      requestId: "occupied-case",
    })
    expect(
      (
        await f.mine.query(api.maintenance.list, {
          recordId: linked.recordId as Id<"maintenanceCases">,
        })
      ).records[0]!.unit
    ).toBe("Unit 1")
    await expect(
      f.mine.mutation(api.maintenance.create, {
        ...f.args,
        unitId,
        occupancyId,
        reporterId: f.a.vendor,
        requestId: "unrelated-occupant",
      })
    ).rejects.toThrow("occupancy parties")
    await expect(
      f.mine.mutation(api.maintenance.create, {
        ...f.args,
        unitId,
        occupancyId,
        timeZone: "Asia/Tokyo",
        requestId: "wrong-zone",
      })
    ).rejects.toThrow("time zone")
    const second = await f.t.run((ctx) =>
      ctx.db.insert("properties", {
        spaceId: f.a.spaceId,
        address: "200 Fictional Private Way",
        listingStatus: "owned",
        photos: [],
      })
    )
    await expect(
      f.mine.mutation(api.maintenance.create, {
        ...f.args,
        propertyId: second,
        unitId,
        occupancyId,
        requestId: "wrong-property",
      })
    ).rejects.toThrow("Not found")
  })
  it("later changed source evidence invalidates a recorded human review without erasing the review", async () => {
    const f = await fixture(),
      e = await f.submit()
    await f.mine.mutation(api.maintenance.reviewOutcome, e.review)
    await f.t.run((ctx) => ctx.db.patch(e.fileId, { digest: "b".repeat(64) }))
    expect(await f.read()).toMatchObject({
      status: "review_recorded",
      evidenceState: "needs_review",
      reviewState: "needs_review",
      physicalCompletionState: "not_independently_verified",
    })
    await f.t.run(async (ctx) => {
      expect(
        (await ctx.db.query("maintenanceReviews").collect())[0].approved
      ).toBe(true)
    })
  })
  it.each([
    { summary: "Different unreviewed worker assertion" },
    { completedOn: "2026-10-01" },
  ])(
    "invalidates the old review when saved outcome facts change %j",
    async (patch) => {
      const f = await fixture(),
        e = await f.submit()
      await f.mine.mutation(api.maintenance.reviewOutcome, e.review)
      await f.t.run(async (ctx) => {
        const row = (await ctx.db.get(f.caseId))!
        await ctx.db.patch(row.completionEvidenceId!, patch)
      })
      expect(await f.read()).toMatchObject({
        reviewState: "needs_review",
        physicalCompletionState: "not_independently_verified",
        nextAction: expect.stringContaining("stale outcome"),
      })
    }
  )
  it.each(["team", "brokerage"] as const)(
    "runs a %s-owned saved record flow without exposing affiliated private records",
    async (kind) => {
      const f = await fixture()
      const org = await f.t.run(async (ctx) => {
        const brokerage = await ctx.db.insert("brokerages", {
          name: "Fictional Office",
          slug: "maintenance-office",
          ownerId: f.owner,
          joinCode: "fixture-only",
          status: "active",
          firstResponseTargetMinutes: 5,
        })
        const bm = await ctx.db.insert("brokerageMembers", {
          brokerageId: brokerage,
          userId: f.owner,
          role: "owner",
        })
        const team = await ctx.db.insert("teams", {
          name: "Fictional Team",
          slug: "maintenance-team",
          leadId: f.owner,
          joinCode: "fixture-only",
          status: "active",
          brokerageId: brokerage,
        })
        const tm = await ctx.db.insert("teamMembers", {
          teamId: team,
          userId: f.owner,
          role: "lead",
        })
        await ctx.db.patch(f.a.spaceId, {
          brokerageId: brokerage,
          teamId: team,
        })
        const spaceId = await ctx.db.insert("spaces", {
          name: "Shared maintenance",
          slug: "shared-maintenance",
          emoji: "",
          ownerId: f.owner,
          organizationOwned: true,
          brokerageId: brokerage,
          teamId: team,
        })
        await ctx.db.insert("spaceMembers", {
          spaceId,
          userId: f.owner,
          role: "owner",
        })
        const propertyId = await ctx.db.insert("properties", {
          spaceId,
          address: "200 Fictional Office Way",
          listingStatus: "owned",
          photos: [],
        })
        const reporter = await ctx.db.insert("contacts", {
          spaceId,
          name: "Shared Fictional Client",
          leadType: "rental",
          tags: [],
        })
        return { brokerage, team, bm, tm, spaceId, propertyId, reporter }
      })
      const scope = { kind, id: kind === "team" ? org.team : org.brokerage }
      await expect(
        f.mine.query(api.maintenance.list, { scope, recordId: f.caseId })
      ).rejects.toThrow("Not found")
      const created = await f.mine.mutation(api.maintenance.create, {
          ...f.args,
          scope,
          propertyId: org.propertyId,
          reporterId: org.reporter,
          requestId: "shared-intake",
        }),
        caseId = created.recordId as Id<"maintenanceCases">
      const command = (requestId: string, expectedRevision: number) => ({
        scope,
        caseId,
        requestId,
        expectedRevision,
      })
      await f.mine.mutation(api.maintenance.assign, {
        ...command("shared-assign", 0),
        assignedTo: f.owner,
      })
      await f.mine.mutation(api.maintenance.recordStart, {
        ...command("shared-start", 1),
        startedOn: "2026-10-01",
        sourceNote: "Synthetic shared observed start",
      })
      const doc = await f.document(org.reporter, org.spaceId)
      await f.mine.mutation(api.maintenance.recordOutcome, {
        ...command("shared-outcome", 2),
        completedOn: "2026-10-02",
        summary: "Synthetic shared report; not live service verification",
        fileId: doc.fileId,
      })
      await f.mine.mutation(api.maintenance.reviewOutcome, {
        ...command("shared-review", 3),
        approved: true,
        note: "Fictional shared human review",
        confirmation,
      })
      const secret = "synthetic-only-maintenance-gateway-".repeat(3)
      vi.stubEnv("CHIPPI_WORKFORCE_SECRET", secret)
      const base = {
        secret,
        principal: {
          actorId: f.owner,
          kind,
          scopeId: scope.id,
          name: "Fictional scope",
          routeId: scope.id,
          role: kind === "team" ? ("admin" as const) : ("owner" as const),
        },
        expiresAt: Date.now() + 10000,
        operation: "query",
      }
      const read = await f.t.mutation(api.workforce.bridge, {
        ...base,
        nonce: `maintenance-${kind}-read`,
        input: {
          operation: "maintenanceCases",
          workspaceId: org.spaceId,
          pagination: { numItems: 20, cursor: null },
        },
      })
      expect(read).toMatchObject({
        records: [
          {
            address: "200 Fictional Office Way",
            reviewState: "human_review_recorded",
            physicalCompletionState: "not_independently_verified",
          },
        ],
        isDone: true,
      })
      expect(JSON.stringify(read)).not.toContain("100 Fictional Way")
      await expect(
        f.mine.query(api.maintenance.list, { recordId: caseId })
      ).rejects.toThrow("Not found")
      await f.t.run(async (ctx) => {
        await ctx.db.delete(org.bm)
        await ctx.db.delete(org.tm)
      })
      await expect(
        f.mine.query(api.maintenance.list, { scope, recordId: caseId })
      ).rejects.toThrow("Not allowed")
      await expect(
        f.t.mutation(api.workforce.bridge, {
          ...base,
          nonce: `maintenance-${kind}-revoked`,
          input: { operation: "maintenanceCases", recordId: caseId },
        })
      ).rejects.toThrow("Not allowed")
    }
  )
  it("saves intake, assignment, work observation, evidence and human review with immutable receipts and no outward effects", async () => {
    const f = await fixture(),
      e = await f.submit()
    expect(await f.read()).toMatchObject({
      status: "awaiting_review",
      evidenceState: "current_accepted_record",
      reviewState: "not_currently_approved",
      physicalCompletionState: "not_independently_verified",
      externalDispatchState: "not_verified",
    })
    const result = await f.mine.mutation(
      api.maintenance.reviewOutcome,
      e.review
    )
    expect(
      await f.mine.mutation(api.maintenance.reviewOutcome, e.review)
    ).toEqual(result)
    const read = await f.read()
    expect(read).toMatchObject({
      status: "review_recorded",
      revision: 4,
      reviewState: "human_review_recorded",
      physicalCompletionState: "not_independently_verified",
      externalDispatchState: "not_verified",
      assignee: "Avery Fictional",
      vendorCandidate: "Fictional Maintenance Desk",
    })
    expect(JSON.stringify(read)).not.toContain("synthetic/not-a-real-service")
    expect(JSON.stringify(read)).not.toContain("fileDigest")
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("maintenanceEvidence").collect()).toHaveLength(
        1
      )
      expect(await ctx.db.query("maintenanceReviews").collect()).toHaveLength(1)
      expect(
        (await ctx.db.query("rentalEvents").collect()).filter((r) =>
          r.kind.startsWith("maintenance.")
        )
      ).toHaveLength(5)
      expect(await ctx.db.query("workforceEvents").collect()).toHaveLength(0)
      expect(await ctx.db.query("emailOutbox").collect()).toHaveLength(0)
    })
  })
  it("keeps emergency reports in an actionable human hold and requires a recorded response before assignment", async () => {
    const f = await fixture("emergency")
    expect(await f.read()).toMatchObject({
      status: "held",
      priority: "emergency",
      nextAction: expect.stringContaining("has not alerted anyone"),
      externalDispatchState: "not_verified",
    })
    await expect(
      f.mine.mutation(api.maintenance.assign, {
        ...f.command("unacknowledged", 0),
        assignedTo: f.owner,
      })
    ).rejects.toThrow("emergency response")
    await f.assign()
    expect((await f.read()).emergencyResponseNote).toContain(
      "no dispatch claimed"
    )
  })
  it.each([
    { title: " " },
    { problem: " " },
    { sourceNote: " " },
    { timeZone: "Mars/Fictional" },
    { reportedOn: "2200-01-01" },
    { reportedOn: "2026-02-30" },
    { dueAt: 0.1 },
    { dueAt: Number.MAX_SAFE_INTEGER },
  ])("rejects invalid intake facts %j", async (patch) => {
    const f = await fixture()
    await expect(
      f.mine.mutation(api.maintenance.create, {
        ...f.args,
        requestId: "invalid",
        ...patch,
      })
    ).rejects.toThrow()
    expect((await f.mine.query(api.maintenance.list, {})).records).toHaveLength(
      1
    )
  })
  it("deduplicates identical concurrent starts and rejects changed retry payloads", async () => {
    const f = await fixture()
    const results = await Promise.all([
      f.mine.mutation(api.maintenance.create, f.args),
      f.mine.mutation(api.maintenance.create, f.args),
    ])
    expect(results).toEqual([f.created, f.created])
    await expect(
      f.mine.mutation(api.maintenance.create, {
        ...f.args,
        problem: "Changed instructions",
      })
    ).rejects.toThrow("different work")
    expect((await f.mine.query(api.maintenance.list, {})).records).toHaveLength(
      1
    )
  })
  it("prevents conflicting assignments from both overwriting the same revision", async () => {
    const f = await fixture()
    const results = await Promise.allSettled([
      f.assign(),
      f.mine.mutation(api.maintenance.assign, {
        ...f.command("competing", 0),
        assignedTo: f.owner,
      }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
    expect((await f.read()).revision).toBe(1)
  })
  it("denies unassigned outcomes, empty evidence and model-only completion claims", async () => {
    const f = await fixture(),
      doc = await f.document()
    await expect(
      f.mine.mutation(api.maintenance.recordOutcome, {
        ...f.command("premature", 0),
        completedOn: "2026-10-02",
        summary: "Worker says done",
        fileId: doc.fileId,
      })
    ).rejects.toThrow("in progress")
    const e = await f.submit()
    await expect(
      f.mine.mutation(api.maintenance.reviewOutcome, {
        ...e.review,
        confirmation: "AI says complete" as typeof confirmation,
      })
    ).rejects.toThrow()
    expect((await f.read()).status).toBe("awaiting_review")
  })
  it("routes an incorrect result back for correction without deleting rejected evidence", async () => {
    const f = await fixture(),
      e = await f.submit()
    await f.mine.mutation(api.maintenance.reviewOutcome, {
      ...e.review,
      approved: false,
      note: "Fictional review: submitted evidence does not support the claimed repair",
    })
    expect((await f.read()).status).toBe("in_progress")
    const doc = await f.document()
    await f.mine.mutation(api.maintenance.recordOutcome, {
      ...e.outcome,
      requestId: "corrected-outcome",
      expectedRevision: 4,
      fileId: doc.fileId,
      summary: "Fictional corrected record names the inspection limits",
    })
    await f.mine.mutation(api.maintenance.reviewOutcome, {
      ...e.review,
      requestId: "corrected-review",
      expectedRevision: 5,
      note: "Fictional review of corrected source, no provider verification",
    })
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("maintenanceEvidence").collect()).toHaveLength(
        2
      )
      expect(
        (await ctx.db.query("maintenanceReviews").collect()).map(
          (r) => r.approved
        )
      ).toEqual([false, true])
    })
    expect((await f.read()).status).toBe("review_recorded")
  })
  it("changed instructions/deadline invalidate a submitted outcome and require a fresh submission", async () => {
    const f = await fixture(),
      e = await f.submit()
    await f.mine.mutation(api.maintenance.updatePlan, {
      ...f.command("changed-plan", 3),
      title: "Inspect kitchen and supply valve",
      problem: "Fictional changed scope includes the valve",
      dueAt: Date.UTC(2026, 10, 1),
    })
    expect(await f.read()).toMatchObject({
      status: "awaiting_review",
      staleRevision: true,
      evidenceState: "needs_review",
      nextAction: expect.stringContaining("current plan"),
    })
    await expect(
      f.mine.mutation(api.maintenance.reviewOutcome, {
        ...e.review,
        requestId: "stale-review",
        expectedRevision: 4,
      })
    ).rejects.toThrow("record changed")
    await f.mine.mutation(api.maintenance.reviewOutcome, {
      ...e.review,
      requestId: "reject-stale",
      expectedRevision: 4,
      approved: false,
      note: "Changed plan requires fresh evidence",
    })
    expect((await f.read()).status).toBe("in_progress")
  })
  it.each(["file", "request", "scan"] as const)(
    "holds changed %s evidence at review and preserves source history",
    async (which) => {
      const f = await fixture(),
        e = await f.submit()
      await f.t.run(async (ctx) => {
        if (which === "request")
          await ctx.db.patch(e.requestId, { revision: 2 })
        else
          await ctx.db.patch(
            e.fileId,
            which === "file" ? { revision: 2 } : { scanStatus: "pending" }
          )
      })
      await expect(
        f.mine.mutation(api.maintenance.reviewOutcome, e.review)
      ).rejects.toThrow()
      expect(await f.read()).toMatchObject({
        status: "awaiting_review",
        evidenceState: "needs_review",
      })
    }
  )
  it("revoked member assignment holds review without silently completing work", async () => {
    const f = await fixture(),
      e = await f.submit()
    await f.t.run(async (ctx) => {
      await ctx.db.delete(f.a.membership)
      await ctx.db.insert("spaceMembers", {
        spaceId: f.a.spaceId,
        userId: f.owner,
        role: "owner",
      })
      const member = await ctx.db.insert("spaceMembers", {
        spaceId: f.a.spaceId,
        userId: f.other,
        role: "member",
      })
      await ctx.db.patch(f.caseId, { assignedTo: f.other })
      await ctx.db.delete(member)
    })
    expect(await f.read()).toMatchObject({
      assigneeCurrent: false,
      nextAction: expect.stringContaining("current record-workspace member"),
    })
    await expect(
      f.mine.mutation(api.maintenance.reviewOutcome, e.review)
    ).rejects.toThrow("current member")
  })
  it("cancellation blocks late outcome/review; reopen keeps immutable evidence and requires fresh work", async () => {
    const f = await fixture(),
      e = await f.submit()
    const cancelled = {
      ...f.command("cancel-work", 3),
      note: "Fictional owner changed instructions before review",
    }
    const receipt = await f.mine.mutation(api.maintenance.cancel, cancelled)
    expect(await f.mine.mutation(api.maintenance.cancel, cancelled)).toEqual(
      receipt
    )
    await expect(
      f.mine.mutation(api.maintenance.reviewOutcome, {
        ...e.review,
        requestId: "late-review",
        expectedRevision: 4,
      })
    ).rejects.toThrow("saved outcome")
    await f.mine.mutation(api.maintenance.reopen, {
      ...f.command("reopen-work", 4),
      note: "Fictional follow-up needs a new inspection",
    })
    expect(await f.read()).toMatchObject({ status: "held", outcome: null })
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("maintenanceEvidence").collect()).toHaveLength(
        1
      )
    })
  })
  it("retains an actionable owned hold without enqueueing a provider or helper", async () => {
    const f = await fixture()
    await f.start()
    await f.mine.mutation(api.maintenance.recordHold, {
      ...f.command("provider-uncertain", 2),
      reason: "Fictional provider reply is ambiguous",
      nextAction: "Owner must confirm the allowed vendor's availability",
      followUpAt: Date.UTC(2026, 10, 1),
    })
    expect(await f.read()).toMatchObject({
      status: "held",
      holdReason: expect.stringContaining("ambiguous"),
      nextAction: expect.stringContaining("Owner"),
      followUpAt: Date.UTC(2026, 10, 1),
      externalDispatchState: "not_verified",
    })
    await expect(
      f.mine.mutation(api.maintenance.recordStart, {
        ...f.command("held-start", 3),
        startedOn: "2026-10-02",
        sourceNote: "Claimed restart",
      })
    ).rejects.toThrow("Assign")
  })
  it("denies foreign properties, reporters, vendors, case reads and writes", async () => {
    const f = await fixture()
    await expect(
      f.theirs.query(api.maintenance.list, { recordId: f.caseId })
    ).rejects.toThrow("Not found")
    await expect(
      f.theirs.mutation(api.maintenance.cancel, {
        ...f.command("foreign-cancel", 0),
        note: "Forbidden",
      })
    ).rejects.toThrow("Not found")
    await expect(
      f.mine.mutation(api.maintenance.create, {
        ...f.args,
        propertyId: f.b.propertyId,
        requestId: "foreign-property",
      })
    ).rejects.toThrow("Not found")
    await expect(
      f.mine.mutation(api.maintenance.create, {
        ...f.args,
        reporterId: f.b.reporter,
        requestId: "foreign-reporter",
      })
    ).rejects.toThrow("Not found")
    await expect(
      f.mine.mutation(api.maintenance.assign, {
        ...f.command("foreign-vendor", 0),
        assignedTo: f.owner,
        vendorContactId: f.b.vendor,
      })
    ).rejects.toThrow("Not found")
    await expect(
      f.mine.mutation(api.maintenance.assign, {
        ...f.command("foreign-assignee", 0),
        assignedTo: f.other,
      })
    ).rejects.toThrow("current member")
  })
  it("denies a foreign or unrelated completion document", async () => {
    const f = await fixture()
    await f.start()
    const doc = await f.document(f.a.vendor)
    await expect(
      f.mine.mutation(api.maintenance.recordOutcome, {
        ...f.command("unrelated-document", 2),
        completedOn: "2026-10-02",
        summary: "Fictional unrelated source",
        fileId: doc.fileId,
      })
    ).rejects.toThrow("recorded reporter")
    await f.t.run((ctx) => ctx.db.patch(doc.fileId, { spaceId: f.b.spaceId }))
    await expect(
      f.mine.mutation(api.maintenance.recordOutcome, {
        ...f.command("foreign-document", 2),
        completedOn: "2026-10-02",
        summary: "Fictional forbidden source",
        fileId: doc.fileId,
      })
    ).rejects.toThrow("Not found")
  })
  it("future and contradictory work observations cannot become review evidence", async () => {
    const f = await fixture()
    await f.assign()
    await expect(
      f.mine.mutation(api.maintenance.recordStart, {
        ...f.command("future-start", 1),
        startedOn: "2200-01-01",
        sourceNote: "Future claim",
      })
    ).rejects.toThrow("future")
    await f.mine.mutation(api.maintenance.recordStart, {
      ...f.command("start-later", 1),
      startedOn: "2026-10-02",
      sourceNote: "Fictional observed start",
    })
    const doc = await f.document()
    await expect(
      f.mine.mutation(api.maintenance.recordOutcome, {
        ...f.command("before-start", 2),
        completedOn: "2026-10-01",
        summary: "Impossible claim",
        fileId: doc.fileId,
      })
    ).rejects.toThrow("precede")
    await expect(
      f.mine.mutation(api.maintenance.recordOutcome, {
        ...f.command("future-end", 2),
        completedOn: "2200-01-01",
        summary: "Future claim",
        fileId: doc.fileId,
      })
    ).rejects.toThrow("future")
  })
  it("bounds pagination and denies unauthenticated access and revoked retries", async () => {
    const f = await fixture()
    await expect(f.t.query(api.maintenance.list, {})).rejects.toThrow()
    await expect(
      f.mine.query(api.maintenance.list, {
        pagination: { cursor: null, numItems: 21 },
      })
    ).rejects.toThrow("pagination")
    await f.mine.mutation(api.maintenance.create, {
      ...f.args,
      requestId: "second-case",
      title: "Fictional separate report",
    })
    const first = await f.mine.query(api.maintenance.list, {
        pagination: { cursor: null, numItems: 1 },
      }),
      second = await f.mine.query(api.maintenance.list, {
        pagination: { cursor: first.continuationCursor!, numItems: 1 },
      })
    expect(first.records).toHaveLength(1)
    expect(second.records).toHaveLength(1)
    expect(first.isDone).toBe(false)
    expect(second.isDone).toBe(true)
    await f.t.run((ctx) => ctx.db.delete(f.a.membership))
    await expect(
      f.mine.mutation(api.maintenance.create, f.args)
    ).rejects.toThrow("No workspace")
  })
})
