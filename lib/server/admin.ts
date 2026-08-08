import "server-only";
import { z } from "zod";
import { hash } from "bcryptjs";
import { getPrisma, writeAuditLog } from "@/lib/server/db-pg";
import { assertAdmin } from "@/lib/server/permissions";
import { DomainError } from "@/lib/server/errors";
import type { GroupType, UserRole, UserStatus } from "@/lib/generated/prisma/client";

export type AdminUserRow = { id: string; userId: string; name: string; email: string | null; department: string | null; role: UserRole; status: UserStatus; createdAt: string };
export type GroupRow = { id: string; groupType: GroupType; code: string; label: string; color: string | null; sortOrder: number; isActive: boolean };

export async function listUsers(projectId: string, adminUserId: string, q?: string): Promise<AdminUserRow[]> {
  await assertAdmin(projectId, adminUserId);
  const query = q?.trim();
  const members = await getPrisma().projectMember.findMany({
    where: {
      projectId,
      ...(query ? { user: { OR: [{ userId: { contains: query, mode: "insensitive" } }, { name: { contains: query, mode: "insensitive" } }] } } : {}),
    },
    include: { user: true },
    orderBy: { user: { userId: "asc" } },
  });
  return members.map((member) => ({ id: member.user.id, userId: member.user.userId, name: member.user.name, email: member.user.email, department: member.user.department, role: member.role, status: member.user.status, createdAt: member.user.createdAt.toISOString() }));
}

const roleSchema = z.object({ role: z.enum(["ADMIN", "OPERATOR", "MEMBER"]) });
export async function updateUserRole(projectId: string, adminUserId: string, targetUserId: string, input: unknown) {
  await assertAdmin(projectId, adminUserId);
  const data = roleSchema.parse(input);
  const prisma = getPrisma();
  const member = await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: targetUserId } } });
  if (!member) throw new DomainError("NOT_FOUND", "해당 프로젝트의 사용자를 찾을 수 없습니다.");
  if (member.role === "ADMIN" && data.role !== "ADMIN") {
    const adminCount = await prisma.projectMember.count({ where: { projectId, role: "ADMIN" } });
    if (adminCount <= 1) throw new DomainError("LAST_ACTIVE_CODE", "프로젝트에는 최소 한 명의 관리자가 필요합니다.");
  }
  const updated = await prisma.projectMember.update({ where: { id: member.id }, data: { role: data.role } });
  await writeAuditLog(projectId, adminUserId, "USER_ROLE_UPDATE", "project_members", member.id, member, updated);
  return { id: targetUserId, role: updated.role };
}

const statusSchema = z.object({ status: z.enum(["ACTIVE", "LOCKED"]) });
export async function updateUserStatus(projectId: string, adminUserId: string, targetUserId: string, input: unknown) {
  await assertAdmin(projectId, adminUserId);
  const data = statusSchema.parse(input);
  if (targetUserId === adminUserId && data.status === "LOCKED") throw new DomainError("FORBIDDEN", "본인 계정은 잠글 수 없습니다.");
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) throw new DomainError("NOT_FOUND", "사용자를 찾을 수 없습니다.");
  const updated = await prisma.user.update({ where: { id: targetUserId }, data: { status: data.status } });
  await writeAuditLog(projectId, adminUserId, "USER_STATUS_UPDATE", "users", targetUserId, { status: user.status }, { status: updated.status });
  return { id: targetUserId, status: updated.status };
}

function generateTempPassword() {
  return `Temp-${crypto.randomUUID().slice(0, 8)}!`;
}
export async function resetUserPassword(projectId: string, adminUserId: string, targetUserId: string) {
  await assertAdmin(projectId, adminUserId);
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) throw new DomainError("NOT_FOUND", "사용자를 찾을 수 없습니다.");
  const tempPassword = generateTempPassword();
  await prisma.user.update({ where: { id: targetUserId }, data: { passwordHash: await hash(tempPassword, 12) } });
  await writeAuditLog(projectId, adminUserId, "USER_PASSWORD_RESET", "users", targetUserId, null, null);
  return { id: targetUserId, tempPassword };
}

export async function listGroups(projectId: string, groupType?: GroupType): Promise<GroupRow[]> {
  const groups = await getPrisma().groups.findMany({ where: { projectId, ...(groupType ? { groupType } : {}) } });
  return groups.map((group) => ({ id: group.id, groupType: group.groupType, code: group.code, label: group.label, color: group.color, sortOrder: group.sortOrder, isActive: group.isActive })).sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, "ko"));
}

const codePattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const createGroupSchema = z.object({ groupType: z.enum(["WORK_MODULE", "COMPANY"]), code: z.string().trim().min(1).max(50).regex(codePattern), label: z.string().trim().min(1).max(100), color: z.string().trim().max(20).nullable().optional(), sortOrder: z.number().int().min(0).max(9999) });
export async function createGroup(projectId: string, adminUserId: string, input: unknown) {
  await assertAdmin(projectId, adminUserId);
  const data = createGroupSchema.parse(input);
  const prisma = getPrisma();
  const existing = await prisma.groups.findFirst({ where: { projectId, groupType: data.groupType, code: { equals: data.code, mode: "insensitive" } } });
  if (existing) throw new DomainError("DUPLICATE_CODE", "동일한 그룹 코드가 이미 존재합니다.");
  const group = await prisma.groups.create({ data: { projectId, groupType: data.groupType, code: data.code, label: data.label, color: data.color || null, sortOrder: data.sortOrder } });
  await writeAuditLog(projectId, adminUserId, "GROUPS_INSERT", "groups", group.id, null, group);
  return group;
}

const updateGroupSchema = z.object({ label: z.string().trim().min(1).max(100), color: z.string().trim().max(20).nullable().optional(), sortOrder: z.number().int().min(0).max(9999), isActive: z.boolean() });
export async function updateGroup(projectId: string, adminUserId: string, groupId: string, input: unknown) {
  await assertAdmin(projectId, adminUserId);
  const data = updateGroupSchema.parse(input);
  const prisma = getPrisma();
  const current = await prisma.groups.findUnique({ where: { id: groupId } });
  if (!current || current.projectId !== projectId) throw new DomainError("NOT_FOUND", "그룹을 찾을 수 없습니다.");
  const updated = await prisma.groups.update({ where: { id: groupId }, data: { label: data.label, color: data.color || null, sortOrder: data.sortOrder, isActive: data.isActive } });
  await writeAuditLog(projectId, adminUserId, "GROUPS_UPDATE", "groups", groupId, current, updated);
  return updated;
}
