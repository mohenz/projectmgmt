import "server-only";

import { z } from "zod";
import { riskScore } from "@/lib/domain/items";
import { businessDaysSince, staleCutoff } from "@/lib/domain/business-days";
import { actorNameOf, getPrisma, nowIso, writeAuditLog } from "@/lib/server/db-pg";
import { getMemberRole, isManagerRole } from "@/lib/server/permissions";
import type { Item as PrismaItem, Prisma } from "@/lib/generated/prisma/client";
import { DomainError } from "@/lib/server/errors";

export { DomainError };

const kindSchema = z.enum(["issue", "risk"]), probabilitySchema = z.enum(["low", "medium", "high"]), statusSchema = z.enum(["registered", "in_progress", "resolved", "on_hold"]);
export const createItemSchema = z.object({ kind: kindSchema, categoryCodeId: z.string().uuid(), trackCodeId: z.string().uuid(), title: z.string().trim().min(1).max(200), description: z.string().trim().max(10000).default(""), probability: probabilitySchema, impact: probabilitySchema, exposureText: z.string().trim().max(500).optional(), ownerText: z.string().trim().max(100).optional(), escalationCodeId: z.string().uuid().optional() });
export const updateItemSchema = createItemSchema.omit({ kind: true, escalationCodeId: true }).extend({ version: z.number().int().positive() });
export const statusUpdateSchema = z.object({ status: statusSchema, version: z.number().int().positive() });
export const escalationUpdateSchema = z.object({ escalationCodeId: z.string().uuid(), version: z.number().int().positive() });
export const commentSchema = z.object({ body: z.string().trim().min(1).max(5000), version: z.number().int().positive() });
export const archiveSchema = z.object({ version: z.number().int().positive() });

export type ItemRow = { id: string; displayId: string; projectId: string; trackCodeId: string; kind: "issue" | "risk"; categoryCodeId: string; categoryCode: string; categoryLabel: string; title: string; description: string; probability: "low" | "medium" | "high"; impact: "low" | "medium" | "high"; exposureText: string | null; ownerText: string | null; escalationCodeId: string; escalationCode: string; escalationLabel: string; status: "registered" | "in_progress" | "resolved" | "on_hold"; trackName: string; trackCode: string; ownerName: string | null; createdAt: string; updatedAt: string; resolvedAt: string | null; businessDaysIdle: number; isStale: boolean; version: number };
export type ItemEventRow = { id: string; eventType: "created" | "comment" | "status_changed" | "level_changed" | "edited" | "archived"; actorName: string; body: string | null; beforeData: Record<string, unknown> | null; afterData: Record<string, unknown> | null; createdAt: string };
export type ItemFilters = { q?: string; kind?: string; status?: string; category?: string; probability?: string; impact?: string; open?: boolean; stale?: boolean; page?: number; pageSize?: number };

const OPEN_STATUSES = ["registered", "in_progress"] as const;
const itemInclude = { category: true, group: true, escalation: true } as const;
type ItemWithRelations = Prisma.ItemGetPayload<{ include: typeof itemInclude }>;

async function getStaleBusinessDays(projectId: string) {
  const project = await getPrisma().project.findUnique({ where: { id: projectId }, select: { staleBusinessDays: true } });
  return project?.staleBusinessDays ?? 3;
}

function toRow(item: ItemWithRelations, staleBusinessDays: number): ItemRow {
  const idle = businessDaysSince(item.updatedAt);
  return {
    id: item.id, displayId: item.displayId, projectId: item.projectId, trackCodeId: item.groupId, kind: item.kind,
    categoryCodeId: item.categoryCodeId, categoryCode: item.category.code, categoryLabel: item.category.label,
    title: item.title, description: item.description, probability: item.kind === "issue" ? "high" : item.probability, impact: item.impact,
    exposureText: item.exposureText, ownerText: item.ownerText, escalationCodeId: item.escalationCodeId,
    escalationCode: item.escalation.code, escalationLabel: item.escalation.label,
    status: item.status, trackName: item.group.label, trackCode: item.group.code, ownerName: item.ownerText,
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(), resolvedAt: item.resolvedAt?.toISOString() ?? null,
    businessDaysIdle: idle, isStale: OPEN_STATUSES.includes(item.status as never) && idle >= staleBusinessDays, version: item.version,
  } satisfies ItemRow;
}

// 목록 필터를 SQL로 내린다 — 유효하지 않은 enum 값은 기존 동작대로 필터를 걸지 않는다.
export function itemWhere(projectId: string, filters: ItemFilters, staleBusinessDays: number): Prisma.ItemWhereInput {
  const and: Prisma.ItemWhereInput[] = [];
  const pick = <T extends string>(schema: { options: readonly string[] }, value?: string) => (value && schema.options.includes(value) ? (value as T) : undefined);
  const kind = pick<"issue" | "risk">(kindSchema, filters.kind);
  const status = pick<"registered" | "in_progress" | "resolved" | "on_hold">(statusSchema, filters.status);
  const probability = pick<"low" | "medium" | "high">(probabilitySchema, filters.probability);
  const impact = pick<"low" | "medium" | "high">(probabilitySchema, filters.impact);
  const category = filters.category?.trim();
  const query = filters.q?.trim();

  if (kind) and.push({ kind });
  if (status) and.push({ status });
  if (category) and.push({ category: { code: category } });
  if (impact) and.push({ impact });
  // 이슈는 확률을 항상 high로 노출하므로(toRow) 필터도 같은 규칙을 SQL로 표현한다.
  if (probability === "high") and.push({ OR: [{ kind: "issue" }, { probability: "high" }] });
  else if (probability) and.push({ kind: "risk", probability });
  if (filters.open) and.push({ status: { in: [...OPEN_STATUSES] } });
  if (filters.stale) and.push({ status: { in: [...OPEN_STATUSES] }, updatedAt: { lt: staleCutoff(staleBusinessDays) } });
  if (query) and.push({ OR: [{ title: { contains: query, mode: "insensitive" } }, { description: { contains: query, mode: "insensitive" } }, { ownerText: { contains: query, mode: "insensitive" } }] });

  return { projectId, archivedAt: null, ...(and.length ? { AND: and } : {}) };
}

export async function listItems(projectId: string, filters: ItemFilters = {}) {
  const prisma = getPrisma();
  const staleBusinessDays = await getStaleBusinessDays(projectId);
  const where = itemWhere(projectId, filters, staleBusinessDays);
  const pageSize = Math.min(100, Math.max(10, filters.pageSize ?? 30));
  const total = await prisma.item.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, filters.page ?? 1), totalPages);
  const rows = await prisma.item.findMany({ where, include: itemInclude, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize });
  return { items: rows.map((row) => toRow(row, staleBusinessDays)), total, page, pageSize, totalPages };
}
export async function listItemsForExport(projectId: string, filters: ItemFilters = {}) {
  const staleBusinessDays = await getStaleBusinessDays(projectId);
  const rows = await getPrisma().item.findMany({ where: itemWhere(projectId, filters, staleBusinessDays), include: itemInclude, orderBy: { updatedAt: "desc" }, take: 10000 });
  return rows.map((row) => toRow(row, staleBusinessDays));
}
export async function getItemDetail(projectId: string, itemId: string) {
  const prisma = getPrisma();
  const [item, staleBusinessDays] = await Promise.all([
    prisma.item.findUnique({ where: { id: itemId }, include: itemInclude }),
    getStaleBusinessDays(projectId),
  ]);
  if (!item || item.projectId !== projectId || item.archivedAt) return null;
  const events = await prisma.itemEvent.findMany({ where: { itemId }, orderBy: { createdAt: "desc" } });
  return {
    item: toRow(item, staleBusinessDays),
    events: events.map((event) => ({
      id: event.id, eventType: event.eventType, actorName: event.actorName ?? "-", body: event.body,
      beforeData: event.beforeData as Record<string, unknown> | null, afterData: event.afterData as Record<string, unknown> | null,
      createdAt: event.createdAt.toISOString(),
    } satisfies ItemEventRow)),
  };
}
export async function getDashboard(projectId: string) {
  const prisma = getPrisma();
  const staleBusinessDays = await getStaleBusinessDays(projectId);
  const openWhere: Prisma.ItemWhereInput = { projectId, archivedAt: null, status: { in: [...OPEN_STATUSES] } };
  const staleWhere: Prisma.ItemWhereInput = { ...openWhere, updatedAt: { lt: staleCutoff(staleBusinessDays) } };
  const [total, openIssues, openRisks, stale, byLevel, byCategory, categoryCodes, staleRows] = await Promise.all([
    prisma.item.count({ where: { projectId, archivedAt: null } }),
    prisma.item.count({ where: { ...openWhere, kind: "issue" } }),
    prisma.item.count({ where: { ...openWhere, kind: "risk" } }),
    prisma.item.count({ where: staleWhere }),
    prisma.item.groupBy({ by: ["kind", "probability", "impact"], where: openWhere, _count: { _all: true } }),
    prisma.item.groupBy({ by: ["categoryCodeId"], where: openWhere, _count: { _all: true } }),
    prisma.commonCode.findMany({ where: { projectId, groupCode: "category", isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.item.findMany({ where: staleWhere, include: itemInclude, orderBy: { updatedAt: "asc" }, take: 8 }),
  ]);
  // 이슈의 확률은 high로 노출되므로 집계 후 같은 칸으로 합친다.
  const matrix = Array.from(byLevel.reduce((map, row) => {
    const probability = row.kind === "issue" ? "high" : row.probability;
    const key = `${probability}:${row.impact}`;
    const current = map.get(key) ?? { probability, impact: row.impact as string, count: 0 };
    current.count += row._count._all;
    map.set(key, current);
    return map;
  }, new Map<string, { probability: string; impact: string; count: number }>()).values());
  const countByCategory = new Map(byCategory.map((row) => [row.categoryCodeId, row._count._all]));
  return {
    summary: { total, openIssues, openRisks, stale },
    matrix,
    categories: categoryCodes.map((code) => ({ category: code.code, label: code.label, count: countByCategory.get(code.id) ?? 0 })),
    staleItems: staleRows.map((row) => toRow(row, staleBusinessDays)),
  };
}

async function assertWritePermission(projectId: string, userId: string, itemId?: string, requirePm = false) {
  const prisma = getPrisma();
  const [role, item] = await Promise.all([getMemberRole(projectId, userId), itemId ? prisma.item.findUnique({ where: { id: itemId } }) : Promise.resolve(null)]);
  const isManager = isManagerRole(role), owns = item ? item.createdBy === userId || item.ownerUserId === userId : false;
  if (!role || (requirePm ? !isManager : !(isManager || (role === "MEMBER" && (!itemId || owns))))) throw new DomainError("FORBIDDEN", "이 작업을 수행할 권한이 없습니다.");
}
async function assertCommonCode(projectId: string, codeId: string, groupCode: string) {
  const code = await getPrisma().commonCode.findUnique({ where: { id: codeId } });
  if (!code || code.projectId !== projectId || code.groupCode !== groupCode || !code.isActive) throw new DomainError("INVALID_CODE", "선택한 공통코드를 사용할 수 없습니다.");
  return code;
}
async function assertWorkModuleGroup(projectId: string, groupId: string) {
  const group = await getPrisma().groups.findUnique({ where: { id: groupId } });
  if (!group || group.projectId !== projectId || group.groupType !== "WORK_MODULE" || !group.isActive) throw new DomainError("INVALID_CODE", "선택한 Track을 사용할 수 없습니다.");
  return group;
}
async function suggestedEscalationId(projectId: string, kind: "issue" | "risk", probability: "low" | "medium" | "high", impact: "low" | "medium" | "high") {
  const score = riskScore(kind, probability, impact);
  const codes = await getPrisma().commonCode.findMany({ where: { projectId, groupCode: "escalation_level", isActive: true } });
  const match = codes.filter((code) => (code.minScore ?? 1) <= score).sort((a, b) => (b.minScore ?? 1) - (a.minScore ?? 1) || b.sortOrder - a.sortOrder)[0];
  if (!match) throw new DomainError("INVALID_CODE", "적용 가능한 에스컬레이션 공통코드가 없습니다.");
  return match.id;
}
function mutationError(item: PrismaItem | null, version: number) {
  if (!item || item.archivedAt) throw new DomainError("NOT_FOUND", "항목을 찾을 수 없습니다.");
  if (item.version !== version) throw new DomainError("VERSION_CONFLICT", "다른 사용자가 먼저 수정했습니다. 최신 내용을 다시 확인해 주세요.");
}

export async function createItem(projectId: string, userId: string, input: unknown) {
  const data = createItemSchema.parse(input), probability = data.kind === "issue" ? "high" as const : data.probability, requestId = crypto.randomUUID();
  await assertWritePermission(projectId, userId);
  await Promise.all([assertCommonCode(projectId, data.categoryCodeId, "category"), assertWorkModuleGroup(projectId, data.trackCodeId)]);
  const escalationCodeId = data.escalationCodeId ?? await suggestedEscalationId(projectId, data.kind, probability, data.impact);
  await assertCommonCode(projectId, escalationCodeId, "escalation_level");
  const prisma = getPrisma();
  const actorName = await actorNameOf(userId);
  const { item, displayId } = await prisma.$transaction(async (tx) => {
    const sequence = await tx.itemSequence.upsert({ where: { projectId }, create: { projectId, value: 1 }, update: { value: { increment: 1 } } });
    const displayId = `IR-${new Date().getUTCFullYear()}-${String(sequence.value).padStart(6, "0")}`;
    const item = await tx.item.create({ data: { displayId, projectId, groupId: data.trackCodeId, kind: data.kind, categoryCodeId: data.categoryCodeId, title: data.title, description: data.description, probability, impact: data.impact, exposureText: data.exposureText || null, ownerText: data.ownerText || null, escalationCodeId, status: "registered", createdBy: userId } });
    await tx.itemEvent.create({ data: { itemId: item.id, eventType: "created", actorId: userId, actorName, body: "신규 등록" } });
    return { item, displayId };
  });
  await writeAuditLog(projectId, userId, "ITEM_INSERT", "items", item.id, null, { id: item.id, displayId, title: data.title });
  return { id: item.id, displayId, requestId };
}
export async function updateItem(projectId: string, userId: string, itemId: string, input: unknown) {
  const data = updateItemSchema.parse(input), requestId = crypto.randomUUID();
  await assertWritePermission(projectId, userId, itemId);
  await Promise.all([assertCommonCode(projectId, data.categoryCodeId, "category"), assertWorkModuleGroup(projectId, data.trackCodeId)]);
  const prisma = getPrisma();
  const actorName = await actorNameOf(userId);
  const { before, version } = await prisma.$transaction(async (tx) => {
    const before = await tx.item.findUnique({ where: { id: itemId } });
    mutationError(before, data.version);
    const version = data.version + 1;
    const update = { groupId: data.trackCodeId, categoryCodeId: data.categoryCodeId, title: data.title, description: data.description, probability: before!.kind === "issue" ? "high" as const : data.probability, impact: data.impact, exposureText: data.exposureText || null, ownerText: data.ownerText || null, version };
    await tx.item.update({ where: { id: itemId }, data: update });
    await tx.itemEvent.create({ data: { itemId, eventType: "edited", actorId: userId, actorName, body: "기본 정보 수정", beforeData: before as never, afterData: update as never } });
    return { before, version };
  });
  await writeAuditLog(projectId, userId, "ITEM_UPDATE", "items", itemId, before, { version });
  return { version, requestId };
}
export async function updateStatus(projectId: string, userId: string, itemId: string, input: unknown) {
  const data = statusUpdateSchema.parse(input);
  return updateSingleField(projectId, userId, itemId, data.version, data.status);
}
async function updateSingleField(projectId: string, userId: string, itemId: string, expectedVersion: number, status: "registered" | "in_progress" | "resolved" | "on_hold") {
  const requestId = crypto.randomUUID();
  await assertWritePermission(projectId, userId, itemId);
  const prisma = getPrisma();
  const actorName = await actorNameOf(userId);
  const { before, version } = await prisma.$transaction(async (tx) => {
    const before = await tx.item.findUnique({ where: { id: itemId } });
    mutationError(before, expectedVersion);
    const version = expectedVersion + 1;
    await tx.item.update({ where: { id: itemId }, data: { status, version, resolvedAt: status === "resolved" ? new Date() : null } });
    await tx.itemEvent.create({ data: { itemId, eventType: "status_changed", actorId: userId, actorName, body: "상태 변경", beforeData: { value: before!.status }, afterData: { value: status } } });
    return { before, version };
  });
  await writeAuditLog(projectId, userId, "ITEM_UPDATE", "items", itemId, before, { status, version });
  return { version, requestId };
}
export async function updateEscalation(projectId: string, userId: string, itemId: string, input: unknown) {
  const data = escalationUpdateSchema.parse(input), requestId = crypto.randomUUID();
  await assertWritePermission(projectId, userId, itemId, true);
  const nextCode = await assertCommonCode(projectId, data.escalationCodeId, "escalation_level");
  const prisma = getPrisma();
  const actorName = await actorNameOf(userId);
  const { before, version } = await prisma.$transaction(async (tx) => {
    const before = await tx.item.findUnique({ where: { id: itemId } });
    mutationError(before, data.version);
    const currentCode = await tx.commonCode.findUnique({ where: { id: before!.escalationCodeId } });
    const version = data.version + 1;
    await tx.item.update({ where: { id: itemId }, data: { escalationCodeId: data.escalationCodeId, version } });
    await tx.itemEvent.create({ data: { itemId, eventType: "level_changed", actorId: userId, actorName, body: "에스컬레이션 레벨 변경", beforeData: { value: currentCode?.label ?? "-" }, afterData: { value: nextCode.label } } });
    return { before, version };
  });
  await writeAuditLog(projectId, userId, "ITEM_UPDATE", "items", itemId, before, { escalationCodeId: data.escalationCodeId, version });
  return { version, requestId };
}
export async function addComment(projectId: string, userId: string, itemId: string, input: unknown) {
  const data = commentSchema.parse(input), requestId = crypto.randomUUID();
  await assertWritePermission(projectId, userId, itemId);
  const prisma = getPrisma();
  const actorName = await actorNameOf(userId);
  const { version } = await prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { id: itemId } });
    mutationError(item, data.version);
    const version = data.version + 1;
    await tx.item.update({ where: { id: itemId }, data: { version } });
    await tx.itemEvent.create({ data: { itemId, eventType: "comment", actorId: userId, actorName, body: data.body } });
    return { version };
  });
  return { version, requestId };
}
export async function archiveItem(projectId: string, userId: string, itemId: string, input: unknown) {
  const data = archiveSchema.parse(input), requestId = crypto.randomUUID();
  await assertWritePermission(projectId, userId, itemId, true);
  const prisma = getPrisma();
  const actorName = await actorNameOf(userId);
  const { before, version } = await prisma.$transaction(async (tx) => {
    const before = await tx.item.findUnique({ where: { id: itemId } });
    mutationError(before, data.version);
    const version = data.version + 1;
    await tx.item.update({ where: { id: itemId }, data: { archivedAt: new Date(), version } });
    await tx.itemEvent.create({ data: { itemId, eventType: "archived", actorId: userId, actorName, body: "항목 보관" } });
    return { before, version };
  });
  await writeAuditLog(projectId, userId, "ITEM_UPDATE", "items", itemId, before, { archivedAt: nowIso(), version });
  return { version, requestId };
}
