import { describe, expect, it } from "vitest";
import { itemWhere } from "./items";

const PROJECT = "p1";
const conditions = (filters: Parameters<typeof itemWhere>[1]) => (itemWhere(PROJECT, filters, 3).AND ?? []) as Record<string, unknown>[];

describe("itemWhere", () => {
  it("always scopes to the project and excludes archived items", () => {
    const where = itemWhere(PROJECT, {}, 3);
    expect(where.projectId).toBe(PROJECT);
    expect(where.archivedAt).toBeNull();
    expect(where.AND).toBeUndefined();
  });

  it("ignores values that are not valid enum members", () => {
    expect(conditions({ kind: "nope", status: "nope", probability: "nope", impact: "nope" })).toHaveLength(0);
  });

  it("passes through valid enum filters", () => {
    expect(conditions({ kind: "risk", status: "resolved", impact: "low" })).toEqual([
      { kind: "risk" },
      { status: "resolved" },
      { impact: "low" },
    ]);
  });

  it("matches the category by code, not by id", () => {
    expect(conditions({ category: " quality " })).toEqual([{ category: { code: "quality" } }]);
  });

  // 이슈는 확률을 항상 high로 노출하므로(toRow) 필터도 같은 규칙을 따라야 한다.
  it("includes every issue when filtering by high probability", () => {
    expect(conditions({ probability: "high" })).toEqual([{ OR: [{ kind: "issue" }, { probability: "high" }] }]);
  });

  it("excludes issues when filtering by a non-high probability", () => {
    expect(conditions({ probability: "medium" })).toEqual([{ kind: "risk", probability: "medium" }]);
  });

  it("restricts the open filter to unresolved statuses", () => {
    expect(conditions({ open: true })).toEqual([{ status: { in: ["registered", "in_progress"] } }]);
  });

  it("turns the stale filter into an updatedAt bound", () => {
    const [stale] = conditions({ stale: true }) as [{ status: unknown; updatedAt: { lt: Date } }];
    expect(stale.status).toEqual({ in: ["registered", "in_progress"] });
    expect(stale.updatedAt.lt).toBeInstanceOf(Date);
  });

  it("searches title, description and owner case-insensitively", () => {
    expect(conditions({ q: "  결제  " })).toEqual([
      {
        OR: [
          { title: { contains: "결제", mode: "insensitive" } },
          { description: { contains: "결제", mode: "insensitive" } },
          { ownerText: { contains: "결제", mode: "insensitive" } },
        ],
      },
    ]);
  });

  it("combines multiple filters with AND", () => {
    expect(conditions({ kind: "issue", open: true, q: "배포" })).toHaveLength(3);
  });
});
