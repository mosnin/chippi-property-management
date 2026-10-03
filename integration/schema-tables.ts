import { defineTable } from "convex/server"
import { v } from "convex/values"
import { leaseTerms, conditionObservation } from "../convex/rental_model"

export const verticalTables = {
  rentalUnits: defineTable({
    spaceId: v.id("spaces"), propertyId: v.id("properties"),
    label: v.string(), key: v.string(), timeZone: v.string(), createdBy: v.id("users"), createdAt: v.number(),
  }).index("by_space_property_key", ["spaceId", "propertyId", "key"])
    .index("by_space", ["spaceId"]),
  leases: defineTable({
    spaceId: v.id("spaces"), unitId: v.id("rentalUnits"), revision: v.number(),
    proposedVersionId: v.optional(v.id("leaseVersions")),
    executedVersionId: v.optional(v.id("leaseVersions")),
    executionEvidenceId: v.optional(v.id("leaseExecutionEvidence")),
    createdBy: v.id("users"), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_space", ["spaceId"]).index("by_space_unit", ["spaceId", "unitId"]),
  leaseVersions: defineTable({
    spaceId: v.id("spaces"), leaseId: v.id("leases"), number: v.number(),
    terms: leaseTerms, recordedBy: v.id("users"), recordedAt: v.number(),
  }).index("by_space_lease", ["spaceId", "leaseId"]),
  leaseExecutionEvidence: defineTable({
    spaceId: v.id("spaces"), leaseId: v.id("leases"), versionId: v.id("leaseVersions"),
    fileId: v.id("documentFiles"), fileDigest: v.string(), fileRevision: v.number(),
    requestRevision: v.number(), signedOn: v.string(), termsDigest: v.string(),
    recordedBy: v.id("users"), recordedAt: v.number(),
  }).index("by_space_lease", ["spaceId", "leaseId"]),
  occupancies: defineTable({
    spaceId: v.id("spaces"), unitId: v.id("rentalUnits"), leaseId: v.id("leases"),
    versionId: v.id("leaseVersions"), startsOn: v.string(), endsOn: v.optional(v.string()),
    status: v.union(v.literal("recorded_current"), v.literal("recorded_ended")),
    revision: v.number(), sourceNote: v.string(), moveOutSourceNote: v.optional(v.string()),
    recordedBy: v.id("users"), recordedAt: v.number(),
  }).index("by_space_unit_status", ["spaceId", "unitId", "status"])
    .index("by_space", ["spaceId"]),
  leaseCases: defineTable({
    spaceId: v.id("spaces"), leaseId: v.id("leases"), unitId: v.id("rentalUnits"), baseVersionId: v.id("leaseVersions"),
    leaseSourceVersion: v.string(), occupancyId: v.optional(v.id("occupancies")), occupancySourceVersion: v.optional(v.string()),
    kind: v.union(v.literal("renewal"),v.literal("move_out")),
    status: v.union(v.literal("collecting"),v.literal("held"),v.literal("awaiting_review"),v.literal("review_recorded"),v.literal("cancelled")),
    title: v.string(), sourceNote: v.string(), targetOn: v.union(v.string(),v.null()), timelineSourceNote: v.string(),
    administrativeDueAt: v.optional(v.number()), assignedTo: v.optional(v.id("users")),
    packetId: v.optional(v.id("leaseCasePackets")), reviewId: v.optional(v.id("leaseCaseReviews")),
    holdReason: v.optional(v.string()), nextAction: v.optional(v.string()), followUpAt: v.optional(v.number()),
    cancellationNote: v.optional(v.string()), revision: v.number(), createdBy: v.id("users"), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_space",["spaceId"]).index("by_space_lease_kind",["spaceId","leaseId","kind"]),
  leaseCasePackets: defineTable({
    spaceId: v.id("spaces"), caseId: v.id("leaseCases"), reviewRevision: v.number(), sourceVersion: v.string(),
    proposalVersionId: v.optional(v.id("leaseVersions")), proposalSourceVersion: v.optional(v.string()), beforeOn: v.optional(v.string()), afterOn: v.optional(v.string()),
    conditions: v.optional(v.array(conditionObservation)), summary: v.string(),
    documents: v.array(v.object({fileId:v.id("documentFiles"),digest:v.string(),fileRevision:v.number(),requestRevision:v.number()})),
    recordedBy: v.id("users"), recordedAt: v.number(),
  }).index("by_space_case",["spaceId","caseId"]),
  leaseCaseReviews: defineTable({
    spaceId: v.id("spaces"), caseId: v.id("leaseCases"), packetId: v.id("leaseCasePackets"), sourceVersion: v.string(),
    packetVersion: v.string(), approved: v.boolean(), note: v.string(), recordedBy: v.id("users"), recordedAt: v.number(),
  }).index("by_space_case",["spaceId","caseId"]),
  maintenanceCases: defineTable({
    spaceId: v.id("spaces"), propertyId: v.id("properties"), unitId: v.optional(v.id("rentalUnits")),
    occupancyId: v.optional(v.id("occupancies")), reporterId: v.optional(v.id("contacts")),
    title: v.string(), problem: v.string(), sourceNote: v.string(), reportedOn: v.string(), timeZone: v.string(),
    priority: v.union(v.literal("routine"),v.literal("urgent"),v.literal("emergency")),
    status: v.union(v.literal("open"),v.literal("assigned"),v.literal("in_progress"),v.literal("held"),v.literal("awaiting_review"),v.literal("review_recorded"),v.literal("cancelled")),
    dueAt: v.optional(v.number()), assignedTo: v.optional(v.id("users")), vendorContactId: v.optional(v.id("contacts")),
    startedOn: v.optional(v.string()), startedSourceNote: v.optional(v.string()),
    holdReason: v.optional(v.string()), nextAction: v.optional(v.string()), followUpAt: v.optional(v.number()),
    emergencyResponseNote: v.optional(v.string()), completionEvidenceId: v.optional(v.id("maintenanceEvidence")),
    completionReviewId: v.optional(v.id("maintenanceReviews")), cancellationNote: v.optional(v.string()),
    revision: v.number(), createdBy: v.id("users"), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_space",["spaceId"]).index("by_space_property",["spaceId","propertyId"]),
  maintenanceEvidence: defineTable({
    spaceId: v.id("spaces"), caseId: v.id("maintenanceCases"), reviewRevision: v.number(), contentVersion: v.string(),
    completedOn: v.string(), summary: v.string(), fileId: v.id("documentFiles"),
    fileDigest: v.string(), fileRevision: v.number(), requestRevision: v.number(),
    recordedBy: v.id("users"), recordedAt: v.number(),
  }).index("by_space_case",["spaceId","caseId"]),
  maintenanceReviews: defineTable({
    spaceId: v.id("spaces"), caseId: v.id("maintenanceCases"), evidenceId: v.id("maintenanceEvidence"),
    contentVersion: v.string(), evidenceVersion: v.string(), approved: v.boolean(), note: v.string(), recordedBy: v.id("users"), recordedAt: v.number(),
  }).index("by_space_case",["spaceId","caseId"]),
  rentLedgerEntries: defineTable({
    spaceId: v.id("spaces"), leaseId: v.id("leases"), versionId: v.id("leaseVersions"),
    executionEvidenceId: v.id("leaseExecutionEvidence"), sequence: v.number(),
    kind: v.union(v.literal("rent_charge"), v.literal("payment_record"), v.literal("credit_record"), v.literal("reversal")),
    amountMinor: v.number(), deltaMinor: v.number(), currency: v.string(), observedOn: v.string(),
    periodStartsOn: v.optional(v.string()), periodEndsOn: v.optional(v.string()), dueOn: v.optional(v.string()),
    reversesId: v.optional(v.id("rentLedgerEntries")), sourceReference: v.string(), sourceKey: v.string(), sourceNote: v.string(),
    fileId: v.id("documentFiles"), fileDigest: v.string(), fileRevision: v.number(), requestRevision: v.number(),
    recordedBy: v.id("users"), recordedAt: v.number(),
  }).index("by_space_lease", ["spaceId", "leaseId"]),
  rentalCommands: defineTable({
    spaceId: v.id("spaces"), actorId: v.id("users"), requestId: v.string(),
    fingerprint: v.string(), result: v.object({ recordId: v.string(), revision: v.number() }),
    createdAt: v.number(),
  }).index("by_space_actor_request", ["spaceId", "actorId", "requestId"]),
  rentalEvents: defineTable({
    spaceId: v.id("spaces"), actorId: v.id("users"), recordId: v.string(),
    kind: v.string(), revision: v.number(), evidence: v.string(), createdAt: v.number(),
  }).index("by_space", ["spaceId"]),

}
