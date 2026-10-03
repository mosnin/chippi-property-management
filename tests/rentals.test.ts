import { convexTest } from "convex-test"
import { describe, expect, it, vi, afterEach } from "vitest"
import schema from "../convex/schema"
import { api } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
const modules = {
  "../convex/rentals.ts": () => import("../convex/rentals"),
  "../convex/workforce.ts": () => import("../convex/workforce"),
  "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
const confirmation = "I verified the signatures and the recorded terms" as const
async function fixture() {
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
    return {
      owner,
      other,
      a: await desk(owner, "rental-a"),
      b: await desk(other, "rental-b"),
    }
  })
  const mine = t.withIdentity({ subject: ids.owner }),
    theirs = t.withIdentity({ subject: ids.other })
  const unit = await mine.mutation(api.rentals.createUnit, {
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
    unitId: unit.recordId as Id<"rentalUnits">,
    terms,
    requestId: "lease-one",
  })
  const leaseId = lease.recordId as Id<"leases">
  const read = async () =>
    (await mine.query(api.rentals.list, { recordId: leaseId })).records[0]!
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
      leaseId,
      expectedRevision: current.revision,
      proposedVersionId: current.proposed!.versionId,
      fileId: doc.fileId,
      signedOn: "2026-09-30",
      confirmation,
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

const ledgerConfirmation =
  "I verified this entry against its recorded source" as const
async function ledgerFixture() {
  const f = await fixture(),
    execution = await f.execute(),
    source = await f.document()
  const args = {
    leaseId: f.leaseId,
    versionId: execution.current.executed!.versionId,
    expectedLedgerRevision: 0,
    entry: {
      kind: "rent_charge" as const,
      amountMinor: f.terms.rentMinor,
      currency: "USD",
      periodStartsOn: "2026-10-01",
      periodEndsOn: "2026-10-31",
      dueOn: "2026-10-01",
    },
    observedOn: "2026-10-01",
    sourceReference: "Fictional October Charge",
    sourceNote:
      "Synthetic accepted source fixture; not live provider verification",
    fileId: source.fileId,
    confirmation: ledgerConfirmation,
    requestId: "ledger-charge",
  }
  const ledger = () => f.mine.query(api.rentals.ledger, { recordId: f.leaseId })
  return { ...f, execution, source, args, ledger }
}
describe("bounded recorded rent ledger", () => {
  it("holds a corrupted future observation rather than presenting current evidence", async () => {
    const f = await ledgerFixture(),
      saved = await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    await f.t.run((ctx) =>
      ctx.db.patch(saved.recordId as Id<"rentLedgerEntries">, {
        observedOn: "2200-01-01",
      })
    )
    await expect(f.ledger()).rejects.toThrow("reconciliation")
  })
  it("does not probe a foreign reversal target", async () => {
    const f = await ledgerFixture(),
      saved = await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    const foreign = await f.t.run(async (ctx) => {
      const original = (await ctx.db.get(
        saved.recordId as Id<"rentLedgerEntries">
      ))!
      const { _id, _creationTime, ...data } = original
      void _id
      void _creationTime
      return ctx.db.insert("rentLedgerEntries", {
        ...data,
        spaceId: f.b.spaceId,
      })
    })
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        expectedLedgerRevision: 1,
        requestId: "foreign-reversal",
        sourceReference: "Foreign target",
        entry: { kind: "reversal", reversesId: foreign },
      })
    ).rejects.toThrow("Not found")
    expect((await f.ledger()).revision).toBe(1)
  })
  it("concurrent identical commands retain one record and one immutable receipt", async () => {
    const f = await ledgerFixture(),
      results = await Promise.all([
        f.mine.mutation(api.rentals.recordLedgerEntry, f.args),
        f.mine.mutation(api.rentals.recordLedgerEntry, f.args),
      ])
    expect(results[0]).toEqual(results[1])
    expect((await f.ledger()).revision).toBe(1)
    await f.t.run(async (ctx) => {
      expect(
        (await ctx.db.query("rentalCommands").collect()).filter(
          (r) => r.requestId === f.args.requestId
        )
      ).toHaveLength(1)
    })
  })
  it("rejects a foreign accepted document and creates no entry", async () => {
    const f = await ledgerFixture()
    await f.t.run((ctx) =>
      ctx.db.patch(f.source.fileId, { spaceId: f.b.spaceId })
    )
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    ).rejects.toThrow("Not found")
    expect((await f.ledger()).revision).toBe(0)
  })
  it("refuses corrupted foreign agreement versions without exposing their facts", async () => {
    const f = await ledgerFixture(),
      saved = await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    await f.t.run(async (ctx) => {
      const v = await ctx.db.insert("leaseVersions", {
        spaceId: f.b.spaceId,
        leaseId: f.leaseId,
        number: 99,
        terms: { ...f.terms, sourceNote: "FOREIGN SECRET" },
        recordedBy: f.other,
        recordedAt: Date.now(),
      })
      await ctx.db.patch(saved.recordId as Id<"rentLedgerEntries">, {
        versionId: v,
      })
    })
    await expect(f.ledger()).rejects.toThrow("Not found")
  })
  it("requires exact safe integer totals even when individual payments are valid", async () => {
    const f = await ledgerFixture()
    await f.mine.mutation(api.rentals.recordLedgerEntry, {
      ...f.args,
      entry: {
        kind: "payment_record",
        amountMinor: Number.MAX_SAFE_INTEGER,
        currency: "USD",
      },
    })
    expect((await f.ledger()).summary.recordedNetMinor).toBe(
      -Number.MAX_SAFE_INTEGER
    )
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        expectedLedgerRevision: 1,
        requestId: "overflow",
        sourceReference: "Other payment",
        entry: { kind: "payment_record", amountMinor: 1, currency: "USD" },
      })
    ).rejects.toThrow("integer range")
    expect((await f.ledger()).revision).toBe(1)
  })
  it("preserves executed-version facts through a new recorded execution and refuses combining currencies", async () => {
    const f = await ledgerFixture()
    await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    await f.mine.mutation(api.rentals.amendProposal, {
      leaseId: f.leaseId,
      expectedRevision: 1,
      terms: { ...f.terms, currency: "EUR", rentMinor: 200000 },
      requestId: "currency-proposal",
    })
    const p = (await f.read()).proposed!,
      doc = await f.document()
    await f.mine.mutation(api.rentals.recordExecution, {
      leaseId: f.leaseId,
      expectedRevision: 2,
      proposedVersionId: p.versionId,
      fileId: doc.fileId,
      signedOn: "2026-10-01",
      confirmation,
      requestId: "currency-executed",
    })
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        versionId: p.versionId,
        expectedLedgerRevision: 1,
        requestId: "mixed",
        sourceReference: "Euro payment",
        entry: { kind: "payment_record", amountMinor: 10000, currency: "EUR" },
      })
    ).rejects.toThrow("Currency changed")
    const read = await f.ledger()
    expect(read.records[0].leaseVersion).toBe(1)
    expect(read.summary.currency).toBe("USD")
    await f.mine.mutation(api.rentals.recordLedgerEntry, {
      ...f.args,
      expectedLedgerRevision: 1,
      requestId: "historical-correction",
      sourceReference: "Historical correction",
      entry: { kind: "reversal", reversesId: read.records[0].recordId },
    })
    expect((await f.ledger()).summary.recordedNetMinor).toBe(0)
  })
  it("refuses unreadably large source history instead of returning a newest-record balance", async () => {
    const f = await ledgerFixture(),
      saved = await f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        entry: { kind: "payment_record", amountMinor: 1, currency: "USD" },
      })
    await f.t.run(async (ctx) => {
      const original = (await ctx.db.get(
        saved.recordId as Id<"rentLedgerEntries">
      ))!
      const { _id, _creationTime, ...fields } = original
      void _id
      void _creationTime
      for (let n = 2; n <= 501; n++)
        await ctx.db.insert("rentLedgerEntries", {
          ...fields,
          sequence: n,
          sourceReference: `fixture ${n}`,
          sourceKey: `fixture ${n}`,
        })
    })
    await expect(f.ledger()).rejects.toThrow("coverage")
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        expectedLedgerRevision: 501,
        requestId: "oversized",
        sourceReference: "Another source",
      })
    ).rejects.toThrow("coverage")
  })
  it("uses the real signed read gateway and denies an unrecognized financial write operation", async () => {
    const f = await ledgerFixture()
    await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    const secret = "synthetic-only-ledger-gateway-".repeat(3)
    vi.stubEnv("CHIPPI_WORKFORCE_SECRET", secret)
    const base = {
      secret,
      principal: {
        actorId: f.owner,
        kind: "personal" as const,
        scopeId: f.owner,
        name: "Fictional desk",
        role: "owner" as const,
      },
      expiresAt: Date.now() + 10000,
      operation: "query",
    }
    const read = await f.t.mutation(api.workforce.bridge, {
      ...base,
      nonce: "ledger-read",
      input: {
        operation: "rentLedger",
        recordId: f.leaseId,
        pagination: { numItems: 1, cursor: null },
      },
    })
    expect(read).toMatchObject({
      summary: { recordedNetMinor: 245000, authoritativeBalanceMinor: null },
      revision: 1,
    })
    await expect(
      f.t.mutation(api.workforce.bridge, {
        ...base,
        nonce: "ledger-write",
        input: { operation: "recordLedgerEntry", ...f.args },
      })
    ).rejects.toThrow()
    expect((await f.ledger()).revision).toBe(1)
  })
  it.each([
    { amountMinor: 1, deltaMinor: 1 },
    { periodEndsOn: "2026-09-30" },
    { dueOn: undefined },
  ])("holds inconsistent persisted rent facts %j", async (patch) => {
    const f = await ledgerFixture(),
      saved = await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    await f.t.run((ctx) =>
      ctx.db.patch(saved.recordId as Id<"rentLedgerEntries">, patch)
    )
    await expect(f.ledger()).rejects.toThrow("reconciliation")
  })
  it("saves charge, partial payment, recorded credit and correction; retains original rows and exact receipts without business effects", async () => {
    const f = await ledgerFixture()
    const charge = await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    expect(
      await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    ).toEqual(charge)
    const payment = await f.mine.mutation(api.rentals.recordLedgerEntry, {
      ...f.args,
      expectedLedgerRevision: 1,
      entry: { kind: "payment_record", amountMinor: 100000, currency: "USD" },
      requestId: "ledger-payment",
      sourceReference: "Fictional Payment Receipt",
    })
    const credit = await f.mine.mutation(api.rentals.recordLedgerEntry, {
      ...f.args,
      expectedLedgerRevision: 2,
      entry: { kind: "credit_record", amountMinor: 20000, currency: "USD" },
      requestId: "ledger-credit",
      sourceReference: "Fictional Already Agreed Credit",
    })
    const undo = {
      ...f.args,
      expectedLedgerRevision: 3,
      entry: {
        kind: "reversal" as const,
        reversesId: credit.recordId as Id<"rentLedgerEntries">,
      },
      requestId: "ledger-correction",
      sourceReference: "Fictional Correction Receipt",
    }
    const correction = await f.mine.mutation(
      api.rentals.recordLedgerEntry,
      undo
    )
    expect(await f.mine.mutation(api.rentals.recordLedgerEntry, undo)).toEqual(
      correction
    )
    const read = await f.ledger()
    expect(read).toMatchObject({
      revision: 4,
      summary: {
        recordedNetMinor: 145000,
        entryCount: 4,
        staleEvidenceCount: 0,
        completeness: "unknown",
        authoritativeBalanceMinor: null,
        state: "recorded_entries_only",
      },
    })
    expect(read.records.map((r) => r.deltaMinor)).toEqual([
      245000, -100000, -20000, 20000,
    ])
    expect(read.records[3].reversesId).toBe(credit.recordId)
    expect(read.records[1].recordId).toBe(payment.recordId)
    expect(JSON.stringify(read)).not.toContain("synthetic/not-a-live-object")
    expect(JSON.stringify(read)).not.toContain("fileDigest")
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("rentLedgerEntries").collect()).toHaveLength(4)
      expect(await ctx.db.query("emailOutbox").collect()).toHaveLength(0)
      expect(await ctx.db.query("workforceEvents").collect()).toHaveLength(0)
      expect(
        (await ctx.db.query("rentalEvents").collect()).filter(
          (r) => r.kind === "rent.entry_recorded"
        )
      ).toHaveLength(4)
    })
  })
  it.each([
    { amountMinor: 0 },
    { amountMinor: -1 },
    { amountMinor: 0.5 },
    { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
    { currency: "EUR" },
    { amountMinor: 244999 },
    { periodStartsOn: "2026-09-30" },
    { periodEndsOn: "2027-10-01" },
    { periodEndsOn: "2026-09-30" },
    { dueOn: "2026-02-30" },
  ])("rejects unsupported or inconsistent charge fields %j", async (patch) => {
    const f = await ledgerFixture()
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        entry: { ...f.args.entry, ...patch },
      })
    ).rejects.toThrow()
    expect((await f.ledger()).revision).toBe(0)
  })
  it("never treats an empty ledger as all clear or a complete zero balance", async () => {
    const f = await ledgerFixture()
    expect((await f.ledger()).summary).toMatchObject({
      recordedNetMinor: 0,
      currency: null,
      completeness: "unknown",
      authoritativeBalanceMinor: null,
      state: "no_recorded_entries",
    })
  })
  it("denies changed retries, reused normalized sources, overlapping charge periods and stale revisions", async () => {
    const f = await ledgerFixture()
    await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        sourceNote: "changed",
      })
    ).rejects.toThrow("different work")
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        expectedLedgerRevision: 1,
        requestId: "same-source",
        sourceReference: " FICTIONAL  October Charge ",
      })
    ).rejects.toThrow("already recorded")
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        expectedLedgerRevision: 1,
        requestId: "overlap",
        sourceReference: "Different Charge",
        entry: {
          ...f.args.entry,
          periodStartsOn: "2026-10-15",
          periodEndsOn: "2026-11-14",
        },
      })
    ).rejects.toThrow("overlapping")
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        requestId: "stale",
        sourceReference: "Other",
        entry: { kind: "payment_record", amountMinor: 5000, currency: "USD" },
      })
    ).rejects.toThrow("record changed")
    expect((await f.ledger()).revision).toBe(1)
  })
  it("concurrent starts save one entry, refuse stale work and preserve exact replay", async () => {
    const f = await ledgerFixture(),
      outcomes = await Promise.allSettled([
        f.mine.mutation(api.rentals.recordLedgerEntry, f.args),
        f.mine.mutation(api.rentals.recordLedgerEntry, {
          ...f.args,
          requestId: "competing",
          sourceReference: "Competing source",
        }),
      ])
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1)
    expect((await f.ledger()).revision).toBe(1)
  })
  it("refuses proposals, false attestations and future observed payment dates", async () => {
    const f = await ledgerFixture()
    await f.mine.mutation(api.rentals.amendProposal, {
      leaseId: f.leaseId,
      expectedRevision: 1,
      terms: { ...f.terms, rentMinor: 260000 },
      requestId: "ledger-proposal",
    })
    const proposal = (await f.read()).proposed!
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        versionId: proposal.versionId,
      })
    ).rejects.toThrow("executed version")
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        confirmation: "AI approved" as typeof ledgerConfirmation,
      })
    ).rejects.toThrow()
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        observedOn: "2200-01-01",
        entry: { kind: "payment_record", amountMinor: 5000, currency: "USD" },
      })
    ).rejects.toThrow("future")
    expect((await f.ledger()).revision).toBe(0)
  })
  it("holds changed receipt/agreement evidence without rewriting history or claiming verified balance", async () => {
    const f = await ledgerFixture()
    await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    await f.t.run((ctx) => ctx.db.patch(f.source.fileId, { revision: 2 }))
    const read = await f.ledger()
    expect(read.summary).toMatchObject({
      recordedNetMinor: 245000,
      staleEvidenceCount: 1,
      state: "needs_review",
      authoritativeBalanceMinor: null,
    })
    expect(read.records[0].evidenceState).toBe("needs_review")
    await f.t.run((ctx) =>
      ctx.db.patch(f.execution.fileId, { scanStatus: "pending" })
    )
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...f.args,
        expectedLedgerRevision: 1,
        requestId: "held-payment",
        sourceReference: "Held Receipt",
        entry: { kind: "payment_record", amountMinor: 5000, currency: "USD" },
      })
    ).rejects.toThrow("scanned document")
    expect((await f.ledger()).revision).toBe(1)
  })
  it("denies foreign/read/write/source records and rechecks revoked membership on replay", async () => {
    const f = await ledgerFixture()
    await expect(
      f.theirs.query(api.rentals.ledger, { recordId: f.leaseId })
    ).rejects.toThrow("Not found")
    await expect(
      f.theirs.mutation(api.rentals.recordLedgerEntry, f.args)
    ).rejects.toThrow("Not found")
    await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    await f.t.run(async (ctx) => {
      const member = await ctx.db
        .query("spaceMembers")
        .withIndex("by_user", (q) => q.eq("userId", f.owner))
        .first()
      await ctx.db.delete(member!._id)
    })
    await expect(
      f.mine.query(api.rentals.ledger, { recordId: f.leaseId })
    ).rejects.toThrow("No workspace")
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    ).rejects.toThrow("No workspace")
  })
  it("preserves original facts after amendments and bounds source pages", async () => {
    const f = await ledgerFixture()
    await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    await f.mine.mutation(api.rentals.recordLedgerEntry, {
      ...f.args,
      expectedLedgerRevision: 1,
      requestId: "page-payment",
      sourceReference: "Another receipt",
      entry: { kind: "payment_record", amountMinor: 5000, currency: "USD" },
    })
    await f.mine.mutation(api.rentals.amendProposal, {
      leaseId: f.leaseId,
      expectedRevision: 1,
      terms: { ...f.terms, rentMinor: 260000 },
      requestId: "ledger-amend",
    })
    const first = await f.mine.query(api.rentals.ledger, {
      recordId: f.leaseId,
      pagination: { numItems: 1, cursor: null },
    })
    const second = await f.mine.query(api.rentals.ledger, {
      recordId: f.leaseId,
      pagination: { numItems: 1, cursor: first.continuationCursor },
    })
    expect(first.records).toHaveLength(1)
    expect(second.records).toHaveLength(1)
    expect(first.records[0].leaseVersion).toBe(1)
    expect(second.summary.recordedNetMinor).toBe(240000)
    expect(first.isDone).toBe(false)
    expect(second.isDone).toBe(true)
    await expect(
      f.mine.query(api.rentals.ledger, {
        recordId: f.leaseId,
        pagination: { numItems: 21, cursor: null },
      })
    ).rejects.toThrow("pagination")
  })
  it("denies double reversals, reversal chains, backdated corrections and foreign targets", async () => {
    const f = await ledgerFixture(),
      charge = await f.mine.mutation(api.rentals.recordLedgerEntry, f.args)
    const undo = {
      ...f.args,
      expectedLedgerRevision: 1,
      requestId: "reverse",
      sourceReference: "Correction",
      entry: {
        kind: "reversal" as const,
        reversesId: charge.recordId as Id<"rentLedgerEntries">,
      },
    }
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...undo,
        observedOn: "2026-09-30",
      })
    ).rejects.toThrow("precede")
    const reversed = await f.mine.mutation(api.rentals.recordLedgerEntry, undo)
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...undo,
        expectedLedgerRevision: 2,
        requestId: "twice",
        sourceReference: "Other correction",
      })
    ).rejects.toThrow("again")
    await expect(
      f.mine.mutation(api.rentals.recordLedgerEntry, {
        ...undo,
        expectedLedgerRevision: 2,
        requestId: "chain",
        sourceReference: "Chain",
        entry: {
          kind: "reversal",
          reversesId: reversed.recordId as Id<"rentLedgerEntries">,
        },
      })
    ).rejects.toThrow("again")
    expect((await f.ledger()).summary.recordedNetMinor).toBe(0)
    await f.mine.mutation(api.rentals.recordLedgerEntry, {
      ...f.args,
      expectedLedgerRevision: 2,
      requestId: "replacement",
      sourceReference: "Corrected October charge",
    })
    expect((await f.ledger()).revision).toBe(3)
  })
})

describe("authoritative rental foundation", () => {
  it("separates proposal, recorded execution and occupancy; preserves amendments and exact retries", async () => {
    const f = await fixture(),
      proposed = await f.read()
    expect(proposed).toMatchObject({
      state: "proposal_only",
      executed: null,
      executionSourceCurrent: false,
      occupancy: null,
    })
    expect(proposed.proposed!.rentMinor).toBe(245000)
    await expect(
      f.mine.mutation(api.rentals.recordMoveIn, {
        leaseId: f.leaseId,
        expectedRevision: 0,
        executedVersionId: proposed.proposed!.versionId,
        startsOn: "2026-10-01",
        sourceNote: "Synthetic check-in",
        requestId: "premature",
      })
    ).rejects.toThrow("executed version")
    const e = await f.execute()
    expect(e.current).toMatchObject({
      state: "human_recorded_execution",
      executionSourceCurrent: true,
      proposed: null,
      occupancy: null,
    })
    expect(await f.mine.mutation(api.rentals.recordExecution, e.args)).toEqual(
      e.result
    )
    const move = {
      leaseId: f.leaseId,
      expectedRevision: 1,
      executedVersionId: e.current.executed!.versionId,
      startsOn: "2026-10-01",
      sourceNote: "Fictional keys handover recorded",
      requestId: "move-in",
    }
    const occupied = await f.mine.mutation(api.rentals.recordMoveIn, move)
    expect(await f.mine.mutation(api.rentals.recordMoveIn, move)).toEqual(
      occupied
    )
    const amend = {
      leaseId: f.leaseId,
      expectedRevision: 1,
      terms: { ...f.terms, rentMinor: 250000 },
      requestId: "amend-one",
    }
    await f.mine.mutation(api.rentals.amendProposal, amend)
    const changed = await f.read()
    expect(changed.executed!.rentMinor).toBe(245000)
    expect(changed.proposed!.rentMinor).toBe(250000)
    expect(changed.occupancy!.versionId).toBe(e.current.executed!.versionId)
    await expect(
      f.mine.mutation(api.rentals.amendProposal, {
        ...amend,
        requestId: "stale-amend",
      })
    ).rejects.toThrow("record changed")
    const end = {
      occupancyId: occupied.recordId as Id<"occupancies">,
      expectedRevision: 0,
      endsOn: "2026-10-02",
      sourceNote: "Fictional keys returned; no deduction decided",
      requestId: "move-out",
    }
    const ended = await f.mine.mutation(api.rentals.recordMoveOut, end)
    expect(await f.mine.mutation(api.rentals.recordMoveOut, end)).toEqual(ended)
    expect((await f.read()).occupancy).toBeNull()
    const evidence = await f.t.run(async (ctx) => ({
      occupancy: await ctx.db.get(end.occupancyId),
      versions: await ctx.db.query("leaseVersions").collect(),
      events: await ctx.db.query("rentalEvents").collect(),
      outbox: await ctx.db.query("emailOutbox").collect(),
      jobs: await ctx.db.query("workforceEvents").collect(),
    }))
    expect(evidence.occupancy).toMatchObject({
      status: "recorded_ended",
      endsOn: "2026-10-02",
      moveOutSourceNote: end.sourceNote,
    })
    expect(evidence.versions).toHaveLength(2)
    expect(evidence.events).toHaveLength(6)
    expect(evidence.outbox).toEqual([])
    expect(evidence.jobs).toEqual([])
    expect(JSON.stringify(changed)).not.toContain("not-a-live-object")
  })

  it("blocks duplicate unit identity and changed retry payloads", async () => {
    const f = await fixture()
    expect(
      await f.mine.mutation(api.rentals.createUnit, {
        propertyId: f.a.propertyId,
        label: "Unit 1",
        timeZone: "America/New_York",
        requestId: "unit-one",
      })
    ).toEqual(f.unit)
    await expect(
      f.mine.mutation(api.rentals.createUnit, {
        propertyId: f.a.propertyId,
        label: "UNIT 1",
        timeZone: "America/New_York",
        requestId: "unit-two",
      })
    ).rejects.toThrow("already recorded")
    await expect(
      f.mine.mutation(api.rentals.createUnit, {
        propertyId: f.a.propertyId,
        label: "Unit 2",
        timeZone: "America/New_York",
        requestId: "unit-one",
      })
    ).rejects.toThrow("different work")
  })

  it.each([
    { rentMinor: 0.1 },
    { depositMinor: -1 },
    { rentMinor: Number.MAX_SAFE_INTEGER + 1 },
    { currency: "usd" },
    { startsOn: "2026-02-30" },
    { endsOn: "2025-01-01" },
    { tenantContactIds: [] },
    { paymentTerms: " " },
    { sourceNote: "" },
  ])("rejects invalid terms $currency/$startsOn/$rentMinor", async (patch) => {
    const f = await fixture()
    await expect(
      f.mine.mutation(api.rentals.amendProposal, {
        leaseId: f.leaseId,
        expectedRevision: 0,
        terms: { ...f.terms, ...patch },
        requestId: "invalid",
      })
    ).rejects.toThrow()
    expect((await f.read()).revision).toBe(0)
    expect(
      await f.t.run((ctx) => ctx.db.query("leaseVersions").collect())
    ).toHaveLength(1)
  })

  it("refuses cross-tenant properties, parties, units and records without revealing them", async () => {
    const f = await fixture()
    await expect(
      f.theirs.query(api.rentals.list, { recordId: f.leaseId })
    ).rejects.toThrow("Not found")
    await expect(
      f.mine.mutation(api.rentals.createUnit, {
        propertyId: f.b.propertyId,
        label: "Foreign",
        timeZone: "America/New_York",
        requestId: "foreign",
      })
    ).rejects.toThrow("Not found")
    await expect(
      f.mine.mutation(api.rentals.amendProposal, {
        leaseId: f.leaseId,
        expectedRevision: 0,
        terms: { ...f.terms, tenantContactIds: [f.b.tenant] },
        requestId: "foreign-party",
      })
    ).rejects.toThrow("Not found")
    await expect(
      f.theirs.mutation(api.rentals.proposeLease, {
        unitId: f.unit.recordId as Id<"rentalUnits">,
        terms: f.terms,
        requestId: "foreign-unit",
      })
    ).rejects.toThrow("Not found")
    await expect(f.t.query(api.rentals.list, {})).rejects.toThrow(
      "Not signed in"
    )
  })

  it.each(["scan", "digest", "revision", "request", "tenant"])(
    "requires consistent execution document %s",
    async (fault) => {
      const f = await fixture(),
        current = await f.read(),
        doc = await f.document(fault === "tenant" ? f.a.landlord : f.a.tenant)
      await f.t.run(async (ctx) => {
        if (fault === "scan")
          await ctx.db.patch(doc.fileId, { scanStatus: "infected" })
        if (fault === "digest")
          await ctx.db.patch(doc.fileId, { digest: "b".repeat(64) })
        if (fault === "revision")
          await ctx.db.patch(doc.fileId, { revision: 2 })
        if (fault === "request")
          await ctx.db.patch(doc.requestId, { status: "needs_changes" })
      })
      await expect(
        f.mine.mutation(api.rentals.recordExecution, {
          leaseId: f.leaseId,
          expectedRevision: 0,
          proposedVersionId: current.proposed!.versionId,
          fileId: doc.fileId,
          signedOn: "2026-09-30",
          confirmation,
          requestId: "bad-execution",
        })
      ).rejects.toThrow("document")
      expect((await f.read()).state).toBe("proposal_only")
    }
  )

  it("holds occupancy when previously accepted execution evidence changes", async () => {
    const f = await fixture(),
      e = await f.execute()
    await f.t.run((ctx) =>
      ctx.db.patch(e.requestId, { revision: 2, status: "submitted" })
    )
    const current = await f.read()
    expect(current.executionSourceCurrent).toBe(false)
    expect(current.state).toBe("human_recorded_execution")
    await expect(
      f.mine.mutation(api.rentals.recordMoveIn, {
        leaseId: f.leaseId,
        expectedRevision: 1,
        executedVersionId: e.current.executed!.versionId,
        startsOn: "2026-10-01",
        sourceNote: "Synthetic",
        requestId: "stale-source",
      })
    ).rejects.toThrow("document")
  })

  it("allows one concurrent amendment and requires the loser to reread", async () => {
    const f = await fixture()
    const results = await Promise.allSettled(
      [1, 2].map((n) =>
        f.mine.mutation(api.rentals.amendProposal, {
          leaseId: f.leaseId,
          expectedRevision: 0,
          terms: { ...f.terms, rentMinor: 245000 + n },
          requestId: `race-${n}`,
        })
      )
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
    expect((await f.read()).revision).toBe(1)
  })

  it("bounds and paginates actual stored leases", async () => {
    const f = await fixture()
    for (let i = 0; i < 2; i++)
      await f.mine.mutation(api.rentals.proposeLease, {
        unitId: f.unit.recordId as Id<"rentalUnits">,
        terms: f.terms,
        requestId: `extra-${i}`,
      })
    const first = await f.mine.query(api.rentals.list, {
      pagination: { numItems: 1, cursor: null },
    })
    expect(first.records).toHaveLength(1)
    expect(first.isDone).toBe(false)
    const second = await f.mine.query(api.rentals.list, {
      pagination: { numItems: 1, cursor: first.continuationCursor! },
    })
    expect(second.records[0]!.recordId).not.toBe(first.records[0]!.recordId)
    await expect(
      f.mine.query(api.rentals.list, {
        pagination: { numItems: 21, cursor: null },
      })
    ).rejects.toThrow("pagination")
    await expect(
      f.mine.query(api.rentals.list, { workspaceId: f.b.spaceId })
    ).rejects.toThrow("authorized workspace")
  })
})

it("surfaces conflicting recorded term dates and holds new occupancy", async () => {
  const f = await fixture(),
    first = await f.execute()
  const extra = await f.mine.mutation(api.rentals.proposeLease, {
    unitId: f.unit.recordId as Id<"rentalUnits">,
    terms: { ...f.terms, startsOn: "2027-01-01" },
    requestId: "overlap",
  })
  const leaseId = extra.recordId as Id<"leases">
  const current = (await f.mine.query(api.rentals.list, { recordId: leaseId }))
    .records[0]!
  const doc = await f.document()
  await f.mine.mutation(api.rentals.recordExecution, {
    leaseId,
    expectedRevision: 0,
    proposedVersionId: current.proposed!.versionId,
    fileId: doc.fileId,
    signedOn: "2026-09-30",
    confirmation,
    requestId: "execute-overlap",
  })
  expect((await f.read()).recordedTermsOverlap).toBe(true)
  await expect(
    f.mine.mutation(api.rentals.recordMoveIn, {
      leaseId: f.leaseId,
      expectedRevision: 1,
      executedVersionId: first.current.executed!.versionId,
      startsOn: "2026-10-01",
      sourceNote: "Synthetic",
      requestId: "conflicted",
    })
  ).rejects.toThrow("human reconciliation")
})
it("blocks concurrent move-ins and stale or backdated move-out edits", async () => {
  const f = await fixture(),
    e = await f.execute()
  const move = {
    leaseId: f.leaseId,
    expectedRevision: 1,
    executedVersionId: e.current.executed!.versionId,
    startsOn: "2026-10-01",
    sourceNote: "Synthetic keys handover",
  }
  const results = await Promise.allSettled(
    [1, 2].map((n) =>
      f.mine.mutation(api.rentals.recordMoveIn, {
        ...move,
        requestId: `move-${n}`,
      })
    )
  )
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  const occupied = (await f.read()).occupancy!
  await expect(
    f.mine.mutation(api.rentals.recordMoveOut, {
      occupancyId: occupied.recordId,
      expectedRevision: 0,
      endsOn: "2026-09-30",
      sourceNote: "Synthetic",
      requestId: "bad-date",
    })
  ).rejects.toThrow("dates")
  await expect(
    f.mine.mutation(api.rentals.recordMoveOut, {
      occupancyId: occupied.recordId,
      expectedRevision: 3,
      endsOn: "2026-10-02",
      sourceNote: "Synthetic",
      requestId: "bad-revision",
    })
  ).rejects.toThrow("record changed")
})
it("does not leak foreign version or occupancy references after corrupted persistence", async () => {
  const f = await fixture(),
    e = await f.execute()
  const foreignUnit = await f.theirs.mutation(api.rentals.createUnit, {
    propertyId: f.b.propertyId,
    label: "Other",
    timeZone: "America/New_York",
    requestId: "foreign-unit",
  })
  const foreignLease = await f.theirs.mutation(api.rentals.proposeLease, {
    unitId: foreignUnit.recordId as Id<"rentalUnits">,
    terms: {
      ...f.terms,
      tenantContactIds: [f.b.tenant],
      landlordContactIds: [f.b.landlord],
    },
    requestId: "foreign-lease",
  })
  const foreign = (
    await f.theirs.query(api.rentals.list, {
      recordId: foreignLease.recordId as Id<"leases">,
    })
  ).records[0]!
  await f.t.run((ctx) =>
    ctx.db.insert("occupancies", {
      spaceId: f.a.spaceId,
      unitId: f.unit.recordId as Id<"rentalUnits">,
      leaseId: f.leaseId,
      versionId: foreign.proposed!.versionId,
      startsOn: "2026-10-01",
      status: "recorded_current",
      revision: 0,
      sourceNote: "Corrupt synthetic fixture",
      recordedBy: f.owner,
      recordedAt: Date.now(),
    })
  )
  await expect(f.read()).rejects.toThrow("Not found")
  expect(e.current.executionSourceCurrent).toBe(true)
})
it.each(["team", "brokerage"] as const)(
  "keeps %s records separate and revalidates member access in the signed gateway",
  async (kind) => {
    const f = await fixture()
    const org = await f.t.run(async (ctx) => {
      const brokerage = await ctx.db.insert("brokerages", {
        name: "Fictional office",
        slug: "synthetic-office",
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
        name: "Fictional team",
        slug: "synthetic-team",
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
      await ctx.db.patch(f.a.spaceId, { brokerageId: brokerage, teamId: team })
      const spaceId = await ctx.db.insert("spaces", {
        name: "Shared office records",
        slug: "rental-shared",
        emoji: "",
        ownerId: f.owner,
        organizationOwned: true,
        brokerageId: brokerage,
        teamId: team,
      })
      const propertyId = await ctx.db.insert("properties", {
        spaceId,
        address: "200 Fictional Avenue",
        photos: [],
        listingStatus: "owned",
      })
      const tenant = await ctx.db.insert("contacts", {
        spaceId,
        name: "Shared Fictional Client",
        leadType: "rental",
        tags: [],
      })
      const landlord = await ctx.db.insert("contacts", {
        spaceId,
        name: "Shared Fictional Owner",
        leadType: "seller",
        tags: [],
      })
      return { brokerage, team, bm, tm, spaceId, propertyId, tenant, landlord }
    })
    const scope = { kind, id: kind === "team" ? org.team : org.brokerage }
    await expect(
      f.mine.query(api.rentals.list, { scope, recordId: f.leaseId })
    ).rejects.toThrow("Not found")
    await expect(
      f.mine.mutation(api.rentals.createUnit, {
        scope,
        propertyId: f.a.propertyId,
        label: "Private",
        timeZone: "America/New_York",
        requestId: "mis-scoped",
      })
    ).rejects.toThrow("Not found")
    const unit = await f.mine.mutation(api.rentals.createUnit, {
      scope,
      propertyId: org.propertyId,
      label: "Shared Unit",
      timeZone: "America/New_York",
      requestId: "shared-unit",
    })
    const lease = await f.mine.mutation(api.rentals.proposeLease, {
      scope,
      unitId: unit.recordId as Id<"rentalUnits">,
      terms: {
        ...f.terms,
        tenantContactIds: [org.tenant],
        landlordContactIds: [org.landlord],
      },
      requestId: "shared-lease",
    })
    const secret = "synthetic-only-workforce-secret-".repeat(3)
    vi.stubEnv("CHIPPI_WORKFORCE_SECRET", secret)
    const principal = {
      actorId: f.owner,
      kind,
      scopeId: scope.id,
      name: kind === "team" ? "Fictional team" : "Fictional office",
      routeId: scope.id,
      role: kind === "team" ? ("admin" as const) : ("owner" as const),
    }
    const args = {
      secret,
      principal,
      nonce: `rental-${kind}-one`,
      expiresAt: Date.now() + 10000,
      operation: "query",
      input: { operation: "leases", recordId: lease.recordId },
    }
    const context = await f.t.mutation(api.workforce.bridge, args)
    if (
      !context ||
      typeof context !== "object" ||
      !("records" in context) ||
      !Array.isArray(context.records)
    )
      throw new Error("Expected scoped rental context")
    expect(context.records[0]).toMatchObject({
      address: "200 Fictional Avenue",
      state: "proposal_only",
    })
    expect(JSON.stringify(context)).not.toContain("Taylor Fictional")
    await expect(
      f.mine.query(api.rentals.ledger, { scope, recordId: f.leaseId })
    ).rejects.toThrow("Not found")
    expect(
      await f.t.mutation(api.workforce.bridge, {
        ...args,
        nonce: `ledger-${kind}-read`,
        input: { operation: "rentLedger", recordId: lease.recordId },
      })
    ).toMatchObject({
      records: [],
      summary: { completeness: "unknown", authoritativeBalanceMinor: null },
    })

    await expect(
      f.mine.query(api.rentals.list, {
        recordId: lease.recordId as Id<"leases">,
      })
    ).rejects.toThrow("Not found")
    await f.t.run(async (ctx) => {
      await ctx.db.delete(org.bm)
      await ctx.db.delete(org.tm)
    })
    await expect(
      f.t.mutation(api.workforce.bridge, {
        ...args,
        nonce: `rental-${kind}-revoked`,
      })
    ).rejects.toThrow("Not allowed")
    await expect(f.mine.query(api.rentals.list, { scope })).rejects.toThrow(
      "Not allowed"
    )
    await expect(
      f.mine.query(api.rentals.ledger, {
        scope,
        recordId: lease.recordId as Id<"leases">,
      })
    ).rejects.toThrow("Not allowed")
  }
)

it("reads immutable history with exact pagination and denies foreign history", async () => {
  const f = await fixture()
  await f.mine.mutation(api.rentals.amendProposal, {
    leaseId: f.leaseId,
    expectedRevision: 0,
    terms: { ...f.terms, rentMinor: 260000 },
    requestId: "history-amend",
  })
  const recent = await f.mine.query(api.rentals.history, {
    recordId: f.leaseId,
    pagination: { cursor: null, numItems: 1 },
  })
  expect(recent.records[0]!.rentMinor).toBe(260000)
  expect(recent.isDone).toBe(false)
  const original = await f.mine.query(api.rentals.history, {
    recordId: f.leaseId,
    pagination: { cursor: recent.continuationCursor, numItems: 1 },
  })
  expect(original.records[0]!.rentMinor).toBe(245000)
  expect(original.isDone).toBe(true)
  await expect(
    f.theirs.query(api.rentals.history, { recordId: f.leaseId })
  ).rejects.toThrow("Not found")
})
it("requires explicit human execution attestation and current personal membership", async () => {
  const f = await fixture(),
    current = await f.read(),
    doc = await f.document()
  await expect(
    f.mine.mutation(api.rentals.recordExecution, {
      leaseId: f.leaseId,
      expectedRevision: 0,
      proposedVersionId: current.proposed!.versionId,
      fileId: doc.fileId,
      signedOn: "2026-09-30",
      confirmation: "Approved by an AI" as typeof confirmation,
      requestId: "ai-claim",
    })
  ).rejects.toThrow()
  await f.t.run(async (ctx) => {
    const member = await ctx.db
      .query("spaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", f.owner))
      .first()
    await ctx.db.delete(member!._id)
  })
  await expect(
    f.mine.query(api.rentals.list, { recordId: f.leaseId })
  ).rejects.toThrow("No workspace")
  await expect(
    f.mine.mutation(api.rentals.amendProposal, {
      leaseId: f.leaseId,
      expectedRevision: 0,
      terms: f.terms,
      requestId: "revoked-write",
    })
  ).rejects.toThrow("No workspace")
})
it("publishes the bounded lease catalog but does not widen an inquiry-only agent grant", async () => {
  const f = await fixture(),
    doc = await f.document()
  const secret = "synthetic-only-rental-gateway-".repeat(3)
  vi.stubEnv("CHIPPI_WORKFORCE_SECRET", secret)
  vi.stubEnv("CHIPPI_AUTOMATION_ENABLED", "true")
  const principal = {
    actorId: f.owner,
    kind: "personal" as const,
    scopeId: f.owner,
    name: "Fictional desk",
    role: "owner" as const,
  }
  const base = {
    secret,
    principal,
    expiresAt: Date.now() + 10000,
    operation: "query",
  }
  const catalog = await f.t.mutation(api.workforce.bridge, {
    ...base,
    nonce: "rental-catalog",
    input: {
      operation: "catalog",
      operations: ["leases", "leaseHistory", "rentLedger", "maintenanceCases"],
    },
  })
  expect(catalog).toMatchObject({
    operations: [
      { operation: "leases", pagination: expect.stringContaining("1–20") },
      {
        operation: "leaseHistory",
        pagination: expect.stringContaining("1–20"),
      },
      { operation: "rentLedger", pagination: expect.stringContaining("1–20") },
      {
        operation: "maintenanceCases",
        pagination: expect.stringContaining("1–20"),
      },
    ],
  })
  const job = await f.t.run(async (ctx) => {
    const request = (await ctx.db.get(doc.requestId))!
    const expiresAt = Date.now() + 60000
    const eventId = await ctx.db.insert("workforceEvents", {
      spaceId: f.a.spaceId,
      kind: "intake.received",
      applicationId: request.applicationId,
      contactId: f.a.tenant,
      status: "processing",
      attempts: 1,
      createdAt: Date.now(),
      initiatingActorId: f.owner,
      deadlineAt: expiresAt,
    })
    return {
      eventId,
      applicationId: request.applicationId,
      contactId: f.a.tenant,
      expiresAt,
    }
  })
  for (const operation of [
    "leases",
    "leaseHistory",
    "rentLedger",
    "maintenanceCases",
    "leaseCases",
  ]) {
    await expect(
      f.t.mutation(api.workforce.bridge, {
        ...base,
        nonce: `rental-job-${operation}`,
        principal: { ...principal, businessJob: job },
        input: { operation, recordId: f.leaseId },
      })
    ).rejects.toThrow("Query outside this business job")
  }
})
it("returns an actionable source exception instead of all clear", async () => {
  const f = await fixture(),
    e = await f.execute()
  await f.t.run((ctx) => ctx.db.patch(e.fileId, { scanStatus: "failed" }))
  expect(await f.read()).toMatchObject({
    executionEvidenceState: "needs_review",
    executionSourceCurrent: false,
    nextStep:
      "Review the current accepted document and recorded lease version before occupancy work.",
  })
})
it.each(["execution", "move-in", "move-out"])(
  "refuses a future observed %s",
  async (action) => {
    const f = await fixture()
    if (action === "execution") {
      const current = await f.read(),
        doc = await f.document()
      await expect(
        f.mine.mutation(api.rentals.recordExecution, {
          leaseId: f.leaseId,
          expectedRevision: 0,
          proposedVersionId: current.proposed!.versionId,
          fileId: doc.fileId,
          signedOn: "2050-01-01",
          confirmation,
          requestId: "future-execution",
        })
      ).rejects.toThrow("observed date")
    } else {
      const e = await f.execute(),
        input = {
          leaseId: f.leaseId,
          expectedRevision: 1,
          executedVersionId: e.current.executed!.versionId,
          startsOn: "2026-10-01",
          sourceNote: "Synthetic keys handover",
          requestId: "observed",
        }
      if (action === "move-in") {
        await expect(
          f.mine.mutation(api.rentals.recordMoveIn, {
            ...input,
            startsOn: "2050-01-01",
          })
        ).rejects.toThrow("observed date")
      } else {
        const occupied = await f.mine.mutation(api.rentals.recordMoveIn, input)
        await expect(
          f.mine.mutation(api.rentals.recordMoveOut, {
            occupancyId: occupied.recordId as Id<"occupancies">,
            expectedRevision: 0,
            endsOn: "2050-01-01",
            sourceNote: "Synthetic planned move-out",
            requestId: "future-out",
          })
        ).rejects.toThrow("observed date")
      }
    }
  }
)

it("uses the configured unit day at a UTC boundary", async () => {
  const f = await fixture(),
    e = await f.execute()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-03T01:00:00Z"))
  // New York is still October 2. A UTC-only guard would falsely accept this October 3 observation.
  await expect(
    f.mine.mutation(api.rentals.recordMoveIn, {
      leaseId: f.leaseId,
      expectedRevision: 1,
      executedVersionId: e.current.executed!.versionId,
      startsOn: "2026-10-03",
      sourceNote: "Synthetic planned handover",
      requestId: "utc-boundary",
    })
  ).rejects.toThrow("observed date")
  const result = await f.mine.mutation(api.rentals.recordMoveIn, {
    leaseId: f.leaseId,
    expectedRevision: 1,
    executedVersionId: e.current.executed!.versionId,
    startsOn: "2026-10-02",
    sourceNote: "Synthetic observed handover",
    requestId: "local-day",
  })
  expect(result.revision).toBe(0)
})
it("requires an explicit valid unit time zone without changing a prior retry", async () => {
  const f = await fixture()
  await expect(
    f.mine.mutation(api.rentals.createUnit, {
      propertyId: f.a.propertyId,
      label: "Unit 2",
      timeZone: "Not/AZone",
      requestId: "invalid-zone",
    })
  ).rejects.toThrow("unit time zone")
  await expect(
    f.mine.mutation(api.rentals.createUnit, {
      propertyId: f.a.propertyId,
      label: "Unit 1",
      timeZone: "Asia/Tokyo",
      requestId: "unit-one",
    })
  ).rejects.toThrow("different work")
})
it("does not expose execution writes through the agent gateway", async () => {
  const f = await fixture()
  const secret = "synthetic-rental-write-refusal-".repeat(3)
  vi.stubEnv("CHIPPI_WORKFORCE_SECRET", secret)
  await expect(
    f.t.mutation(api.workforce.bridge, {
      secret,
      principal: {
        actorId: f.owner,
        kind: "personal",
        scopeId: f.owner,
        name: "Fictional desk",
        role: "owner",
      },
      nonce: "lease-write-attempt",
      expiresAt: Date.now() + 10000,
      operation: "action",
      input: { operation: "record_lease_execution", leaseId: f.leaseId },
    })
  ).rejects.toThrow()
  expect((await f.read()).state).toBe("proposal_only")
  expect(
    await f.t.run((ctx) => ctx.db.query("leaseExecutionEvidence").collect())
  ).toEqual([])
})
it("does not turn an invalid specific reference into a broader lease scan", async () => {
  const f = await fixture(),
    secret = "synthetic-rental-reference-refusal-".repeat(3)
  vi.stubEnv("CHIPPI_WORKFORCE_SECRET", secret)
  for (const recordId of ["", 123])
    await expect(
      f.t.mutation(api.workforce.bridge, {
        secret,
        principal: {
          actorId: f.owner,
          kind: "personal",
          scopeId: f.owner,
          name: "Fictional desk",
          role: "owner",
        },
        nonce: `invalid-rental-${String(recordId)}`,
        expiresAt: Date.now() + 10000,
        operation: "query",
        input: { operation: "leases", recordId },
      })
    ).rejects.toThrow("Not found")
})
it("holds a full unit history instead of admitting an uninspectable new proposal", async () => {
  const f = await fixture()
  await f.t.run(async (ctx) => {
    for (let index = 0; index < 99; index++)
      await ctx.db.insert("leases", {
        spaceId: f.a.spaceId,
        unitId: f.unit.recordId as Id<"rentalUnits">,
        revision: 0,
        createdBy: f.owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
  })
  await expect(
    f.mine.mutation(api.rentals.proposeLease, {
      unitId: f.unit.recordId as Id<"rentalUnits">,
      terms: f.terms,
      requestId: "overflow-history",
    })
  ).rejects.toThrow("history needs reconciliation")
  expect(await f.t.run((ctx) => ctx.db.query("leases").collect())).toHaveLength(
    100
  )
})
