import { v, type Infer } from "convex/values"
import { requiredText } from "./record_validation"

export const rentalScope = v.object({
  kind: v.union(
    v.literal("personal"),
    v.literal("team"),
    v.literal("brokerage")
  ),
  id: v.string(),
})

export const conditionObservation = v.object({
  area: v.string(),
  before: v.string(),
  after: v.string(),
  comparison: v.union(v.literal("changed"),v.literal("unchanged"),v.literal("unknown")),
  sourceNote: v.string(),
})
export function validateConditionObservations(input:Infer<typeof conditionObservation>[]) {
  if(input.length<1 || input.length>30) throw new Error("Record 1–30 selected inspection areas")
  const seen=new Set<string>()
  return input.map(row=>{
    const area=requiredText(row.area,150,"inspection area"),key=area.normalize("NFKC").toLowerCase().replace(/\s+/g," ")
    if(seen.has(key)) throw new Error("Record distinct inspection areas")
    seen.add(key)
    return {...row,area,before:requiredText(row.before,2000,"before observation"),after:requiredText(row.after,2000,"after observation"),sourceNote:requiredText(row.sourceNote,2000,"condition source")}
  })
}
export const leaseTerms = v.object({
  tenantContactIds: v.array(v.id("contacts")),
  landlordContactIds: v.array(v.id("contacts")),
  startsOn: v.string(),
  endsOn: v.union(v.string(), v.null()),
  rentMinor: v.number(),
  currency: v.string(),
  frequency: v.union(
    v.literal("monthly"),
    v.literal("weekly"),
    v.literal("other")
  ),
  paymentTerms: v.string(),
  depositMinor: v.union(v.number(), v.null()),
  sourceNote: v.string(),
})

export function rentalDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < "1900-01-01" ||
    value > "2200-12-31" ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new Error("Enter a valid calendar date")
  return value
}

export function validateLeaseTerms(input: Infer<typeof leaseTerms>) {
  for (const ids of [input.tenantContactIds, input.landlordContactIds]) {
    if (ids.length < 1 || ids.length > 20 || new Set(ids).size !== ids.length)
      throw new Error("Enter distinct lease parties")
  }
  if (
    input.tenantContactIds.some((id) => input.landlordContactIds.includes(id))
  )
    throw new Error("A party cannot occupy both recorded roles")
  rentalDate(input.startsOn)
  if (input.endsOn !== null && rentalDate(input.endsOn) < input.startsOn)
    throw new Error("Lease end precedes its start")
  for (const amount of [input.rentMinor, input.depositMinor])
    if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0))
      throw new Error(
        "Enter an exact non-negative amount in minor currency units"
      )
  if (!/^[A-Z]{3}$/.test(input.currency))
    throw new Error("Enter a currency code")
  return {
    ...input,
    paymentTerms: requiredText(input.paymentTerms, 4000, "payment terms"),
    sourceNote: requiredText(input.sourceNote, 2000, "source note"),
  }
}
