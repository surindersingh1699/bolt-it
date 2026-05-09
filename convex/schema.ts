import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tickets: defineTable({
    customerOrg: v.string(),
    channel: v.union(v.literal("slack"), v.literal("email"), v.literal("portal")),
    reporter: v.string(),
    reporterEmail: v.string(),
    subject: v.string(),
    body: v.string(),
    status: v.union(
      v.literal("new"),
      v.literal("drafting"),
      v.literal("awaiting_approval"),
      v.literal("executing"),
      v.literal("resolved"),
      v.literal("escalated"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
    draftResponse: v.optional(v.string()),
    plan: v.array(
      v.object({
        id: v.string(),
        kind: v.union(
          v.literal("insforge"),
          v.literal("aside"),
          v.literal("tensorlake"),
          v.literal("slack_reply"),
        ),
        description: v.string(),
        capability: v.optional(v.string()),
        params: v.optional(v.any()),
        status: v.union(
          v.literal("pending"),
          v.literal("running"),
          v.literal("succeeded"),
          v.literal("failed"),
          v.literal("skipped"),
        ),
        log: v.optional(v.array(v.string())),
        startedAt: v.optional(v.number()),
        finishedAt: v.optional(v.number()),
      }),
    ),
    citations: v.array(
      v.object({
        source: v.union(v.literal("nia"), v.literal("hyperspell")),
        title: v.string(),
        snippet: v.string(),
        ref: v.string(),
      }),
    ),
    confidence: v.number(),
    resolvedByAi: v.boolean(),
    runbookSourceId: v.optional(v.string()),
    resolutionTimeMs: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_org", ["customerOrg"])
    .index("by_created", ["createdAt"]),

  runbooks: defineTable({
    title: v.string(),
    tags: v.array(v.string()),
    body: v.string(),
    sourceTicketIds: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    successCount: v.number(),
    failureCount: v.number(),
  })
    .index("by_updated", ["updatedAt"])
    .searchIndex("search_body", {
      searchField: "body",
      filterFields: ["tags"],
    }),
});
