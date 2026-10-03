import { convexTest } from "convex-test"
import { describe, expect, it, vi, afterEach } from "vitest"
import schema from "../convex/schema"
import { api } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
const modules = {
  "../convex/lease_cases.ts": () => import("../convex/lease_cases"),
  "../convex/rentals.ts": () => import("../convex/rentals"),
  "../convex/workforce.ts": () => import("../convex/workforce"),
  "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
const executionConfirmation =
  "I verified the signatures and the recorded terms" as const
async function baseFixture(
  workspaceKind: "personal" | "team" | "brokerage" = "personal"
) {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-03T12:00:00Z"))
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Avery Fictional" })
    const other = await ctx.db.insert("users", { name: "Blake Fictional" })
    const desk = async (user: Id<"users">, slug: string) => {
      const spaceId = await ctx.db.insert("spaces", {
        ownerId: user,
        slug,
        name: slug,
        emoji: "",
      })
      await ctx.db.insert("spaceMembers", {
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
      const tenant = await ctx.db.insert("contacts", {
        spaceId,
        name: "Taylor Fictional",
        leadType: "rental",
        tags: [],
      })
      const landlord = await ctx.db.insert("contacts", {
        spaceId,
        name: "Morgan Fictional",
        leadType: "seller",
        tags: [],
      })
      return { spaceId, propertyId, tenant, landlord }
    }
    const privateDesk =
      workspaceKind === "personal"
        ? null
        : await desk(owner, "private-affiliated")
    const a = await desk(owner, "rental-a"),
      b = await desk(other, "rental-b")
    let scope: { kind: "team" | "brokerage"; id: string } | undefined
    let orgMembership: Id<"teamMembers"> | Id<"brokerageMembers"> | undefined
    if (workspaceKind !== "personal") {
      const brokerageId = await ctx.db.insert("brokerages", {
        name: "Synthetic Office",
        slug: "case-office",
        ownerId: owner,
        joinCode: "fixture-only",
        status: "active",
        firstResponseTargetMinutes: 5,
      })
      const bm = await ctx.db.insert("brokerageMembers", {
        brokerageId,
        userId: owner,
        role: "owner",
      })
      const teamId = await ctx.db.insert("teams", {
        name: "Synthetic Team",
        slug: "case-team",
        leadId: owner,
        joinCode: "fixture-only",
        status: "active",
        brokerageId,
      })
      const tm = await ctx.db.insert("teamMembers", {
        teamId,
        userId: owner,
        role: "lead",
      })
      await ctx.db.patch(a.spaceId, {
        organizationOwned: true,
        brokerageId,
        teamId,
      })
      await ctx.db.patch(privateDesk!.spaceId, { brokerageId, teamId })
      scope = {
        kind: workspaceKind,
        id: workspaceKind === "team" ? teamId : brokerageId,
      }
      orgMembership = workspaceKind === "team" ? tm : bm
    }
    return { owner, other, a, b, privateDesk, scope, orgMembership }
  })
  const mine = t.withIdentity({ subject: ids.owner }),
    theirs = t.withIdentity({ subject: ids.other })
  const unit = await mine.mutation(api.rentals.createUnit, {
    scope: ids.scope,
    propertyId: ids.a.propertyId,
    label: "Unit 1",
    timeZone: "America/New_York",
    requestId: "unit-one",
  })
  const terms = {
    tenantContactIds: [ids.a.tenant],
    landlordContactIds: [ids.a.landlord],
    startsOn: "2026-10-01",
    endsOn: "2027-09-30",
    rentMinor: 245000,
    currency: "USD",
    frequency: "monthly" as const,
    paymentTerms: "Recorded agreement: first of each month. No default fees.",
    depositMinor: 245000,
    sourceNote: "Fictional owner-entered agreement facts",
  }
  const lease = await mine.mutation(api.rentals.proposeLease, {
    scope: ids.scope,
    unitId: unit.recordId as Id<"rentalUnits">,
    terms,
    requestId: "lease-one",
  })
  const leaseId = lease.recordId as Id<"leases">
  const read = async () =>
    (
      await mine.query(api.rentals.list, {
        scope: ids.scope,
        recordId: leaseId,
      })
    ).records[0]!
  const document = async (tenant = ids.a.tenant) =>
    t.run(async (ctx) => {
      const applicationId = await ctx.db.insert("applications", {
        spaceId: ids.a.spaceId,
        contactId: tenant,
        name: "Fictional rental inquiry",
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
        spaceId: ids.a.spaceId,
        applicationId,
        title: "Fictional signed lease",
        instructions: "Synthetic fixture",
        status: "accepted",
        createdAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        revision: 1,
        reviewedAt: Date.now(),
      })
      const fileId = await ctx.db.insert("documentFiles", {
        spaceId: ids.a.spaceId,
        requestId,
        objectKey: "synthetic/not-a-live-object.pdf",
        name: "fictional-lease.pdf",
        contentType: "application/pdf",
        size: 20,
        digest: "a".repeat(64),
        status: "ready",
        scanStatus: "clean",
        scanDigest: "a".repeat(64),
        scanObjectKey: "synthetic/not-a-live-object.pdf",
        scanFileRevision: 1,
        createdAt: Date.now(),
        revision: 1,
        requestRevision: 1,
      })
      return { requestId, fileId }
    })
  const execute = async () => {
    const current = await read(),
      doc = await document()
    const args = {
      scope: ids.scope,
      leaseId,
      expectedRevision: current.revision,
      proposedVersionId: current.proposed!.versionId,
      fileId: doc.fileId,
      signedOn: "2026-09-30",
      confirmation: executionConfirmation,
      requestId: "execute-one",
    }
    const result = await mine.mutation(api.rentals.recordExecution, args)
    return { ...doc, args, result, current: await read() }
  }
  return {
    t,
    ...ids,
    mine,
    theirs,
    unit,
    terms,
    leaseId,
    read,
    document,
    execute,
  }
}

const confirmation =
  "I checked the current case sources and administrative packet" as const
async function fixture(
  kind: "renewal" | "move_out" = "renewal",
  workspaceKind: "personal" | "team" | "brokerage" = "personal"
) {
  const f = await baseFixture(workspaceKind),
    execution = await f.execute()
  const baseVersionId = execution.current.executed!.versionId
  const occupancy = await f.mine.mutation(api.rentals.recordMoveIn, {
    scope: f.scope,
    leaseId: f.leaseId,
    expectedRevision: execution.current.revision,
    executedVersionId: baseVersionId,
    startsOn: "2026-10-01",
    sourceNote: "Synthetic recorded occupancy, no actual resident",
    requestId: "occupancy",
  })
  const occupancyId = occupancy.recordId as Id<"occupancies">
  const args = {
    scope: f.scope,
    leaseId: f.leaseId,
    baseVersionId,
    occupancyId,
    kind,
    title:
      kind === "renewal"
        ? "Prepare proposed renewal for Taylor"
        : "Compare selected move-out observations for Taylor",
    sourceNote: "Synthetic owner request; no notice/financial authority",
    targetOn: "2027-09-30",
    timelineSourceNote: "User-entered planned date, no jurisdiction rule",
    requestId: "case-create",
  }
  const created = await f.mine.mutation(api.lease_cases.create, args),
    caseId = created.recordId as Id<"leaseCases">
  const view = async () =>
    (
      await f.mine.query(api.lease_cases.list, {
        scope: f.scope,
        recordId: caseId,
      })
    ).records[0]!
  const command = (requestId: string, expectedRevision: number) => ({
    scope: f.scope,
    caseId,
    requestId,
    expectedRevision,
  })
  const packet = async () =>
    f.t.run(async (ctx) => {
      const row = (await ctx.db.get(caseId))!
      return (await ctx.db.get(row.packetId!))!
    })
  const submit = async (expectedRevision = 0, requestId = "packet-save") => {
    const doc = await f.document()
    if (kind === "renewal") {
      const lease = await f.read()
      await f.mine.mutation(api.rentals.amendProposal, {
        scope: f.scope,
        leaseId: f.leaseId,
        expectedRevision: lease.revision,
        requestId: `proposal-${requestId}`,
        terms: {
          ...f.terms,
          startsOn: "2027-10-01",
          endsOn: "2028-09-30",
          rentMinor: 250000,
        },
      })
      const proposalVersionId = (await f.read()).proposed!.versionId
      const submission = {
        ...command(requestId, expectedRevision),
        proposalVersionId,
        fileId: doc.fileId,
        summary:
          "Proposed owner-entered terms only; original executed agreement remains authoritative.",
      }
      await f.mine.mutation(api.lease_cases.submitRenewal, submission)
      return { ...doc, proposalVersionId, submission }
    }
    const afterDoc = await f.document()
    const submission = {
      ...command(requestId, expectedRevision),
      beforeOn: "2026-10-01",
      afterOn: "2026-10-02",
      beforeFileId: doc.fileId,
      afterFileId: afterDoc.fileId,
      conditions: [
        {
          area: "Kitchen counter",
          before: "No observed mark in fixture",
          after: "One reported mark in fixture",
          comparison: "changed" as const,
          sourceNote: "Selected fictional observation only; liability unknown",
        },
      ],
      summary:
        "Selected recorded condition difference; no damage liability, deduction or refund determination.",
    }
    await f.mine.mutation(api.lease_cases.submitMoveOut, submission)
    return { ...doc, afterDoc, submission }
  }
  const approve = (expectedRevision = 1, requestId = "case-review") =>
    f.mine.mutation(api.lease_cases.review, {
      ...command(requestId, expectedRevision),
      approved: true,
      note: "Fictional clerk checked administrative sources only",
      confirmation,
    })
  return {
    ...f,
    args,
    created,
    baseVersionId,
    occupancyId,
    caseId,
    view,
    command,
    packet,
    submit,
    approve,
  }
}

describe("version-bound renewal and move-out administrative cases", () => {
  it("does not present a cancelled reviewed case as current approval", async () => {
    const f = await fixture()
    await f.submit()
    await f.approve()
    await f.mine.mutation(api.lease_cases.cancel, {
      ...f.command("cancel-reviewed", 2),
      note: "User cancelled further administrative work",
    })
    expect((await f.view()).reviewState).toBe("not_currently_approved")
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("leaseCaseReviews").collect()).toHaveLength(1)
    })
  })
  it("publishes scoped typed reads and denies malformed IDs, search and invented writes", async () => {
    const f = await fixture(),
      secret = "synthetic-only-case-gateway-".repeat(3)
    vi.stubEnv("CHIPPI_WORKFORCE_SECRET", secret)
    const base = {
      secret,
      principal: {
        actorId: f.owner,
        kind: "personal" as const,
        scopeId: f.owner,
        name: "Synthetic desk",
        role: "owner" as const,
      },
      expiresAt: Date.now() + 10000,
      operation: "query",
    }
    const catalog = await f.t.mutation(api.workforce.bridge, {
      ...base,
      nonce: "case-catalog",
      input: { operation: "catalog", operations: ["leaseCases"] },
    })
    expect(catalog).toMatchObject({
      operations: [
        {
          operation: "leaseCases",
          pagination: expect.stringContaining("1–20"),
        },
      ],
    })
    const read = await f.t.mutation(api.workforce.bridge, {
      ...base,
      nonce: "case-read",
      input: { operation: "leaseCases", recordId: f.caseId },
    })
    expect(read).toMatchObject({
      records: [
        { recordId: f.caseId, businessCompletionState: "not_verified" },
      ],
    })
    for (const [index, workspaceId] of ["", 0, null].entries())
      await expect(
        f.t.mutation(api.workforce.bridge, {
          ...base,
          nonce: `malformed-case-workspace-${index}`,
          input: { operation: "leaseCases", workspaceId },
        })
      ).rejects.toThrow("authorized workspace")
    for (const [index, recordId] of ["", 123].entries())
      await expect(
        f.t.mutation(api.workforce.bridge, {
          ...base,
          nonce: `malformed-case-${index}`,
          input: { operation: "leaseCases", recordId },
        })
      ).rejects.toThrow("Not found")
    await expect(
      f.t.mutation(api.workforce.bridge, {
        ...base,
        nonce: "case-search",
        input: { operation: "leaseCases", search: "Taylor" },
      })
    ).rejects.toThrow("search is not available")
    await expect(
      f.t.mutation(api.workforce.bridge, {
        ...base,
        nonce: "case-write",
        operation: "action",
        input: { operation: "approve_renewal", caseId: f.caseId },
      })
    ).rejects.toThrow()
    expect((await f.view()).revision).toBe(0)
  })
  it("changed original agreement source cannot be silently refreshed or approved", async () => {
    const f = await fixture()
    await f.submit()
    await f.t.run(async (ctx) => {
      const base = (await ctx.db.get(f.baseVersionId))!
      await ctx.db.patch(base._id, {
        terms: { ...base.terms, rentMinor: 888888 },
      })
    })
    expect((await f.view()).sourceState).toBe("needs_review")
    await expect(f.approve()).rejects.toThrow()
    await expect(
      f.mine.mutation(api.lease_cases.refreshOccupancy, {
        ...f.command("unsafe-refresh", 1),
        note: "Cannot adopt modified original terms",
      })
    ).rejects.toThrow()
  })
  it.each(["team", "brokerage"] as const)(
    "reviews an organization-owned %s case and denies affiliated private sources",
    async (kind) => {
      const f = await fixture("renewal", kind)
      await f.submit()
      await f.approve()
      expect((await f.view()).reviewState).toBe(
        "administrative_human_review_recorded"
      )
      const page = await f.mine.query(api.lease_cases.list, {
        scope: f.scope,
        workspaceId: f.a.spaceId,
      })
      expect(page.records.map((r) => r.recordId)).toEqual([f.caseId])
      await expect(
        f.mine.query(api.lease_cases.list, {
          scope: f.scope,
          workspaceId: f.privateDesk!.spaceId,
        })
      ).rejects.toThrow("authorized workspace")
      await expect(
        f.mine.query(api.lease_cases.list, { recordId: f.caseId })
      ).rejects.toThrow("Not found")
      await f.t.run(async (ctx) => {
        await ctx.db.delete(f.orgMembership!)
        if (kind === "team") {
          const rows = await ctx.db.query("brokerageMembers").collect()
          for (const row of rows) await ctx.db.delete(row._id)
        }
      })
      await expect(f.view()).rejects.toThrow("Not allowed")
      await expect(f.approve()).rejects.toThrow("Not allowed")
    }
  )
  it("does not retain approval after current assignee membership is revoked", async () => {
    const f = await fixture()
    const member = await f.t.run((ctx) =>
      ctx.db.insert("spaceMembers", {
        spaceId: f.a.spaceId,
        userId: f.other,
        role: "member",
      })
    )
    await f.mine.mutation(api.lease_cases.assign, {
      ...f.command("assign", 0),
      assignedTo: f.other,
    })
    await f.submit(1)
    await f.approve(2)
    await f.t.run((ctx) => ctx.db.delete(member))
    expect((await f.view()).reviewState).toBe("needs_review")
    expect((await f.view()).assignee).toBeNull()
  })
  it("exact concurrent packet retries save one packet and do not regenerate work", async () => {
    const f = await fixture(),
      saved = await f.submit()
    if (!("proposalVersionId" in saved.submission))
      throw new Error("Expected renewal fixture")
    const attempts = await Promise.all([
      f.mine.mutation(api.lease_cases.submitRenewal, saved.submission),
      f.mine.mutation(api.lease_cases.submitRenewal, saved.submission),
    ])
    expect(attempts[0]).toEqual(attempts[1])
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("leaseCasePackets").collect()).toHaveLength(1)
    })
  })
  it.each(["renewal", "move_out"] as const)(
    "saves %s evidence and exact human administrative review without business effects",
    async (kind) => {
      const f = await fixture(kind),
        submitted = await f.submit()
      expect((await f.view()).reviewState).toBe("not_currently_approved")
      await f.approve()
      const view = await f.view()
      expect(view.reviewState).toBe("administrative_human_review_recorded")
      expect(view.sourceState).toBe("current_recorded_source")
      expect(view.packetState).toBe("current_accepted_record")
      expect(view.businessCompletionState).toBe("not_verified")
      expect(view.noticeDeliveryState).toBe("not_verified")
      expect(view.financialActionAuthority).toBe("not_authorized")
      expect(view.contractCommitmentAuthority).toBe("not_authorized")
      if (kind === "renewal") {
        expect(view.proposedTerms?.rentMinor).toBe(250000)
        expect(view.baseAgreement.rentMinor).toBe(245000)
      } else {
        expect(view.conditionCoverage).toBe("selected_recorded_areas_only")
        expect(view.conditions).toHaveLength(1)
      }
      await f.t.run(async (ctx) => {
        expect(await ctx.db.query("leaseCasePackets").collect()).toHaveLength(1)
        expect(await ctx.db.query("leaseCaseReviews").collect()).toHaveLength(1)
        expect(await ctx.db.query("emailOutbox").collect()).toHaveLength(0)
        expect(await ctx.db.query("workforceEvents").collect()).toHaveLength(0)
        expect(
          (await ctx.db.query("rentalCommands").collect()).filter(
            (r) => r.requestId === "case-review"
          )
        ).toHaveLength(1)
      })
      expect(submitted.fileId).toBeDefined()
    }
  )
  it("invalidates the saved packet when proposed terms are changed in place", async () => {
    const f = await fixture(),
      s = await f.submit()
    if (!("proposalVersionId" in s)) throw new Error("Expected renewal fixture")
    const proposalId = s.proposalVersionId
    await f.t.run(async (ctx) => {
      const p = (await ctx.db.get(proposalId))!
      await ctx.db.patch(p._id, { terms: { ...p.terms, rentMinor: 999999 } })
    })
    expect((await f.view()).packetState).toBe("needs_review")
    await expect(f.approve()).rejects.toThrow()
    expect((await f.view()).reviewState).not.toBe(
      "administrative_human_review_recorded"
    )
  })
  it("does not reopen a cancelled case over an active replacement", async () => {
    const f = await fixture()
    await f.mine.mutation(api.lease_cases.cancel, {
      ...f.command("cancel", 0),
      note: "Synthetic cancelled preparation",
    })
    await f.mine.mutation(api.lease_cases.create, {
      ...f.args,
      requestId: "replacement",
    })
    await expect(
      f.mine.mutation(api.lease_cases.reopen, {
        ...f.command("reopen", 1),
        note: "Restore old case",
      })
    ).rejects.toThrow("already recorded")
    expect((await f.view()).status).toBe("cancelled")
  })
  it("requires a current assignee before saving a packet", async () => {
    const f = await fixture()
    const membership = await f.t.run((ctx) =>
      ctx.db.insert("spaceMembers", {
        spaceId: f.a.spaceId,
        userId: f.other,
        role: "member",
      })
    )
    await f.mine.mutation(api.lease_cases.assign, {
      ...f.command("assign-other", 0),
      assignedTo: f.other,
    })
    await f.t.run((ctx) => ctx.db.delete(membership))
    await expect(f.submit(1)).rejects.toThrow("member")
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("leaseCasePackets").collect()).toHaveLength(0)
    })
  })
  it("idempotently saves concurrent identical creates but refuses changed retry payloads", async () => {
    const f = await fixture()
    expect(
      await Promise.all([
        f.mine.mutation(api.lease_cases.create, f.args),
        f.mine.mutation(api.lease_cases.create, f.args),
      ])
    ).toEqual([f.created, f.created])
    await expect(
      f.mine.mutation(api.lease_cases.create, {
        ...f.args,
        title: "Changed intent",
      })
    ).rejects.toThrow()
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("leaseCases").collect()).toHaveLength(1)
    })
  })
  it("routes rejected work to correction and retains both packets and reviews", async () => {
    const f = await fixture()
    await f.submit()
    await f.mine.mutation(api.lease_cases.review, {
      ...f.command("reject", 1),
      approved: false,
      note: "Missing clarification in fictional packet",
      confirmation,
    })
    expect((await f.view()).status).toBe("collecting")
    await f.submit(2, "corrected-packet")
    await f.approve(3, "corrected-review")
    expect((await f.view()).reviewState).toBe(
      "administrative_human_review_recorded"
    )
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("leaseCasePackets").collect()).toHaveLength(2)
      expect(await ctx.db.query("leaseCaseReviews").collect()).toHaveLength(2)
    })
  })
  it("changed deadline/instructions invalidate submitted review without silently replacing evidence", async () => {
    const f = await fixture()
    await f.submit()
    await f.mine.mutation(api.lease_cases.updatePlan, {
      ...f.command("new-plan", 1),
      title: "Changed fictional instruction",
      targetOn: "2027-09-01",
      timelineSourceNote: "New owner-entered date",
      administrativeDueAt: null,
    })
    expect((await f.view()).packetState).toBe("needs_review")
    await expect(f.approve(2)).rejects.toThrow("changed")
    await f.mine.mutation(api.lease_cases.review, {
      ...f.command("reject-old", 2),
      approved: false,
      note: "Correct outdated packet",
      confirmation,
    })
    await f.submit(3, "updated-packet")
    await f.approve(4, "updated-review")
    expect((await f.view()).reviewState).toBe(
      "administrative_human_review_recorded"
    )
  })
  it.each(["digest", "scan", "request"])(
    "holds changed %s evidence",
    async (mode) => {
      const f = await fixture(),
        s = await f.submit()
      await f.t.run((ctx) =>
        mode === "request"
          ? ctx.db.patch(s.requestId, { revision: 2 })
          : mode === "scan"
            ? ctx.db.patch(s.fileId, { scanStatus: "pending" })
            : ctx.db.patch(s.fileId, { digest: "b".repeat(64) })
      )
      expect((await f.view()).packetState).toBe("needs_review")
      await expect(f.approve()).rejects.toThrow()
    }
  )
  it("changed occupancy holds work until an explicit source refresh, preserving prior packet", async () => {
    const f = await fixture("move_out")
    await f.submit()
    await f.mine.mutation(api.rentals.recordMoveOut, {
      occupancyId: f.occupancyId,
      expectedRevision: 0,
      endsOn: "2026-10-02",
      sourceNote: "Synthetic changed occupancy",
      requestId: "changed-occupancy",
    })
    expect((await f.view()).sourceState).toBe("needs_review")
    await expect(f.approve()).rejects.toThrow("occupancy")
    await f.mine.mutation(api.lease_cases.refreshOccupancy, {
      ...f.command("refresh", 1),
      note: "Clerk reconciled current recorded occupancy",
    })
    expect((await f.view()).sourceState).toBe("current_recorded_source")
    expect((await f.view()).packetState).toBe("not_recorded")
    await f.submit(2, "new-condition-packet")
    await f.approve(3)
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("leaseCasePackets").collect()).toHaveLength(2)
    })
  })
  it("cancel blocks late review; explicit reopen requires a new packet", async () => {
    const f = await fixture()
    await f.submit()
    await f.mine.mutation(api.lease_cases.cancel, {
      ...f.command("cancel", 1),
      note: "User stopped administrative work",
    })
    await expect(f.approve(2)).rejects.toThrow()
    await f.mine.mutation(api.lease_cases.reopen, {
      ...f.command("reopen", 2),
      note: "User requested revised preparation",
    })
    expect((await f.view()).packetState).toBe("not_recorded")
    await expect(f.approve(3)).rejects.toThrow()
  })
  it("rejects unrelated/foreign document parties and foreign reads/writes", async () => {
    const f = await fixture(),
      doc = await f.document(f.b.tenant)
    await f.submit()
    await expect(
      f.theirs.query(api.lease_cases.list, { recordId: f.caseId })
    ).rejects.toThrow("Not found")
    await expect(
      f.theirs.mutation(api.lease_cases.cancel, {
        ...f.command("foreign-cancel", 1),
        note: "Foreign",
      })
    ).rejects.toThrow("Not found")
    await f.mine.mutation(api.lease_cases.reopen, {
      ...f.command("reopen", 1),
      note: "Prepare corrected packet",
    })
    const proposal = (await f.read()).proposed!.versionId
    await expect(
      f.mine.mutation(api.lease_cases.submitRenewal, {
        ...f.command("bad-document", 2),
        proposalVersionId: proposal,
        fileId: doc.fileId,
        summary: "Foreign source",
      })
    ).rejects.toThrow()
  })
  it("holds an approved packet when saved summary is corrupted", async () => {
    const f = await fixture()
    await f.submit()
    await f.approve()
    const packet = await f.packet()
    await f.t.run((ctx) =>
      ctx.db.patch(packet._id, { summary: "Changed result after human review" })
    )
    expect((await f.view()).reviewState).toBe("needs_review")
  })
  it("refuses empty/duplicate condition observations and future dates", async () => {
    const f = await fixture("move_out"),
      before = await f.document(),
      after = await f.document()
    const input = {
      ...f.command("bad-conditions", 0),
      beforeOn: "2026-10-01",
      afterOn: "2026-10-02",
      beforeFileId: before.fileId,
      afterFileId: after.fileId,
      summary: "Synthetic",
      conditions: [],
    }
    await expect(
      f.mine.mutation(api.lease_cases.submitMoveOut, input)
    ).rejects.toThrow()
    const item = {
      area: "Hall",
      before: "Unknown",
      after: "Unknown",
      comparison: "unknown" as const,
      sourceNote: "Unknown evidence",
    }
    await expect(
      f.mine.mutation(api.lease_cases.submitMoveOut, {
        ...input,
        conditions: [item, { ...item, area: " HALL " }],
      })
    ).rejects.toThrow()
    await expect(
      f.mine.mutation(api.lease_cases.submitMoveOut, {
        ...input,
        conditions: [item],
        afterOn: "2200-01-01",
      })
    ).rejects.toThrow("future")
    await expect(
      f.mine.mutation(api.lease_cases.submitMoveOut, {
        ...input,
        conditions: [item],
        afterFileId: before.fileId,
      })
    ).rejects.toThrow("Distinct")
  })
  it("refuses stale concurrent plan revisions rather than losing an instruction", async () => {
    const f = await fixture(),
      plan = {
        targetOn: null,
        timelineSourceNote: "Unknown planned date",
        administrativeDueAt: null,
      }
    const results = await Promise.allSettled([
      f.mine.mutation(api.lease_cases.updatePlan, {
        ...f.command("plan-a", 0),
        ...plan,
        title: "A",
      }),
      f.mine.mutation(api.lease_cases.updatePlan, {
        ...f.command("plan-b", 0),
        ...plan,
        title: "B",
      }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect((await f.view()).revision).toBe(1)
  })
  it("retains an owned hold and no claimed notification or legal deadline", async () => {
    const f = await fixture()
    await f.mine.mutation(api.lease_cases.hold, {
      ...f.command("hold", 0),
      reason: "Missing local broker policy",
      nextAction: "Ask the authorized policy owner to supply rules",
      followUpAt: null,
    })
    const view = await f.view()
    expect(view.status).toBe("held")
    expect(view.nextAction).toContain("policy owner")
    expect(view.jurisdictionRuleState).toBe("not_activated")
  })
  it("never exposes an unrelated user name from a corrupted assignee", async () => {
    const f = await fixture()
    await f.t.run((ctx) => ctx.db.patch(f.caseId, { assignedTo: f.other }))
    const view = await f.view()
    expect(view.assignee).toBeNull()
    expect(view.assigneeCurrent).toBe(false)
  })
  it("bounds pages and refuses unauthenticated requests", async () => {
    const f = await fixture()
    await expect(f.t.query(api.lease_cases.list, {})).rejects.toThrow()
    await expect(
      f.mine.query(api.lease_cases.list, {
        pagination: { numItems: 21, cursor: null },
      })
    ).rejects.toThrow("pagination")
  })
})
