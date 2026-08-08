import "server-only";
import { z } from "zod";
import { getPrisma, writeAuditLog } from "@/lib/server/db-pg";
import { getCodeOptions } from "@/lib/server/common-codes";
import { assertManager } from "@/lib/server/permissions";
import { buildRecurrenceRule, describeRecurrence, expandOccurrences, type RecurrenceInput } from "@/lib/domain/recurrence";
import type { EventException, Prisma } from "@/lib/generated/prisma/client";

export type EventPerson = { id: string; name: string };
export type EventGroupTagEntry = { id: string; label: string };
export type CalendarEvent = { id: string; masterId: string; source: "schedule" | "progress" | "next_plan" | "issue"; title: string; description: string; eventType: string; startAt: string; endAt: string; date: string; startTime: string; endTime: string; allDay: boolean; areaCodeId: string | null; areaLabel: string | null; location: string; priority: "HIGH" | "MEDIUM" | "LOW"; isMilestone: boolean; isRecurring: boolean; occurrenceDate: string | null; recurrenceSummary: string | null; assignees: EventPerson[]; groupTags: EventGroupTagEntry[]; editable: boolean; sourceUrl: string | null };
export type MilestoneEntry = { id: string; title: string; date: string; kind: "event" | "project"; daysUntil: number; sourceUrl: string | null };
export type CalendarSearchFilters = { q?: string; priority?: string; groupId?: string; assigneeId?: string; from?: string; to?: string };

const recurrenceSchema = z.object({ freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]), endType: z.enum(["never", "until", "count"]), until: z.string().date().optional(), count: z.number().int().min(1).max(365).optional() });
const eventSchema = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(10000), eventType: z.enum(["meeting", "milestone", "work", "other"]),
  startAt: z.string().datetime(), endAt: z.string().datetime(), allDay: z.boolean(), areaCodeId: z.string().uuid().nullable(), location: z.string().trim().max(200),
  priority: z.enum(["HIGH", "MEDIUM", "LOW"]).default("MEDIUM"), isMilestone: z.boolean().default(false), recurrence: recurrenceSchema.nullable().optional(),
  assigneeIds: z.array(z.string().uuid()).default([]), groupTagIds: z.array(z.string().uuid()).default([]),
}).superRefine((d, ctx) => {
  if (d.endAt < d.startAt) ctx.addIssue({ code: "custom", path: ["endAt"], message: "종료일시는 시작일시 이후여야 합니다." });
  for (const field of ["startAt", "endAt"] as const) { const date = new Date(d[field]); if (date.getUTCMinutes() % 10 !== 0 || date.getUTCSeconds() !== 0) ctx.addIssue({ code: "custom", path: [field], message: "시간은 10분 단위로 입력해 주세요." }); }
});

function parts(value: string) { const formatted = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value)); const part = (type: string) => formatted.find((v) => v.type === type)?.value ?? ""; return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` }; }
function inRange(date: string, from: string, to: string) { return date >= from && date <= to; }
function parseCompositeId(id: string): { masterId: string; occurrenceDate: string | null } { const [masterId, occurrenceDate] = id.split("::"); return { masterId, occurrenceDate: occurrenceDate ?? null }; }
type OverrideData = { title?: string; description?: string; eventType?: string; startAt?: string; endAt?: string; allDay?: boolean; groupId?: string | null; location?: string; priority?: "HIGH" | "MEDIUM" | "LOW"; isMilestone?: boolean };

const isPriority = (value?: string): value is "HIGH" | "MEDIUM" | "LOW" => value === "HIGH" || value === "MEDIUM" || value === "LOW";
const like = (query: string) => ({ contains: query, mode: "insensitive" }) as const;

export async function listCalendarEvents(projectId: string, from: string, to: string, filters: CalendarSearchFilters = {}) {
  const prisma = getPrisma();
  const rangeFrom = new Date(`${from}T00:00:00.000Z`), rangeTo = new Date(`${to}T23:59:59.999Z`);
  // KST 변환(parts) 때문에 UTC 경계에서 하루가 밀릴 수 있어 타임스탬프 조회는 ±1일 여유를 둔다.
  const paddedFrom = new Date(rangeFrom.getTime() - 86_400_000), paddedTo = new Date(rangeTo.getTime() + 86_400_000);
  const dateTo = new Date(`${to}T00:00:00.000Z`);
  const query = filters.q?.trim();
  const priority = isPriority(filters.priority) ? filters.priority : undefined;
  const { groupId, assigneeId } = filters;

  // 반복 일정은 회차별 예외(override)로 제목·우선순위·그룹이 달라질 수 있어 DB에서 좁히지 않고 전개 후 걸러낸다.
  const eventAnd: Prisma.CalendarEventWhereInput[] = [{ startAt: { lte: paddedTo } }, { endAt: { gte: paddedFrom } }];
  if (query) eventAnd.push({ OR: [{ title: like(query) }, { description: like(query) }, { location: like(query) }] });
  if (priority) eventAnd.push({ priority });
  if (groupId) eventAnd.push({ OR: [{ groupId }, { groupTags: { some: { groupId } } }] });
  if (assigneeId) eventAnd.push({ assignees: { some: { userId: assigneeId } } });

  // 주간실적·이슈 파생 일정은 담당자가 없고 우선순위가 고정(실적 MEDIUM/LOW, 이슈 LOW)이라 매칭 불가능하면 조회 자체를 생략한다.
  const progressAnd: Prisma.WeeklyProgressWhereInput[] = [{ OR: [{ planTargetDate: { gte: rangeFrom, lte: dateTo } }, { nextTargetDate: { gte: rangeFrom, lte: dateTo } }] }];
  if (query) progressAnd.push({ OR: [{ taskName: like(query) }, { planDetail: like(query) }, { nextPlan: like(query) }] });
  if (groupId) progressAnd.push({ groupId });
  const skipProgress = Boolean(assigneeId) || priority === "HIGH";
  const skipItems = Boolean(assigneeId) || (priority !== undefined && priority !== "LOW");

  const [events, progress, items, options] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: { projectId, OR: [{ recurrenceRule: { not: null } }, { AND: eventAnd }] },
      include: { assignees: { include: { user: true } }, groupTags: { include: { group: true } } },
    }),
    skipProgress ? [] : prisma.weeklyProgress.findMany({ where: { week: { projectId }, AND: progressAnd } }),
    skipItems ? [] : prisma.item.findMany({
      where: {
        projectId, archivedAt: null, createdAt: { gte: paddedFrom, lte: paddedTo },
        ...(groupId ? { groupId } : {}),
        ...(query ? { OR: [{ title: like(query) }, { description: like(query) }] } : {}),
      },
    }),
    getCodeOptions(projectId),
  ]);
  const labels = new Map(options.tracks.map((code) => [code.id, code.label]));
  const toAssignees = (event: (typeof events)[number]): EventPerson[] => event.assignees.map((a) => ({ id: a.user.id, name: a.user.name }));
  const toGroupTags = (event: (typeof events)[number]): EventGroupTagEntry[] => event.groupTags.map((t) => ({ id: t.group.id, label: t.group.label }));
  const recurringIds = events.filter((event) => event.recurrenceRule).map((event) => event.id);
  const exceptions = recurringIds.length ? await prisma.eventException.findMany({ where: { eventId: { in: recurringIds } } }) : [];
  const exceptionMap = new Map(exceptions.map((exception) => [`${exception.eventId}:${exception.exceptionDate.toISOString().slice(0, 10)}`, exception]));

  const rows: CalendarEvent[] = [];
  for (const event of events) {
    const areaLabel = event.groupId ? labels.get(event.groupId) ?? null : null;
    if (event.recurrenceRule) {
      const duration = event.endAt.getTime() - event.startAt.getTime();
      const occurrences = expandOccurrences(event.recurrenceRule, event.startAt, paddedFrom, paddedTo);
      for (const occStart of occurrences) {
        const occDateKey = occStart.toISOString().slice(0, 10);
        const exception = exceptionMap.get(`${event.id}:${occDateKey}`);
        if (exception?.type === "DELETED") continue;
        const override = (exception?.type === "MODIFIED" ? (exception.overrideData as OverrideData | null) : null) ?? {};
        const occStartAt = override.startAt ? new Date(override.startAt) : occStart;
        const occEndAt = override.endAt ? new Date(override.endAt) : new Date(occStart.getTime() + duration);
        const start = parts(occStartAt.toISOString()), end = parts(occEndAt.toISOString());
        if (!(start.date <= to && end.date >= from)) continue;
        const overrideAreaLabel = override.groupId !== undefined ? (override.groupId ? labels.get(override.groupId) ?? null : null) : areaLabel;
        rows.push({ id: `${event.id}::${occDateKey}`, masterId: event.id, source: "schedule", title: override.title ?? event.title, description: override.description ?? event.description, eventType: override.eventType ?? event.eventType, startAt: occStartAt.toISOString(), endAt: occEndAt.toISOString(), date: start.date, startTime: start.time, endTime: end.time, allDay: override.allDay ?? event.allDay, areaCodeId: override.groupId !== undefined ? override.groupId : event.groupId, areaLabel: overrideAreaLabel, location: override.location ?? event.location, priority: override.priority ?? event.priority, isMilestone: override.isMilestone ?? event.isMilestone, isRecurring: true, occurrenceDate: occDateKey, recurrenceSummary: describeRecurrence(event.recurrenceRule), assignees: toAssignees(event), groupTags: toGroupTags(event), editable: true, sourceUrl: null });
      }
    } else {
      const start = parts(event.startAt.toISOString()), end = parts(event.endAt.toISOString());
      if (start.date <= to && end.date >= from) rows.push({ id: event.id, masterId: event.id, source: "schedule", title: event.title, description: event.description, eventType: event.eventType, startAt: event.startAt.toISOString(), endAt: event.endAt.toISOString(), date: start.date, startTime: start.time, endTime: end.time, allDay: event.allDay, areaCodeId: event.groupId, areaLabel, location: event.location, priority: event.priority, isMilestone: event.isMilestone, isRecurring: false, occurrenceDate: null, recurrenceSummary: null, assignees: toAssignees(event), groupTags: toGroupTags(event), editable: true, sourceUrl: null });
    }
  }
  for (const row of progress) {
    const planTargetDate = row.planTargetDate?.toISOString().slice(0, 10) ?? null, nextTargetDate = row.nextTargetDate?.toISOString().slice(0, 10) ?? null;
    if (planTargetDate && inRange(planTargetDate, from, to)) rows.push({ id: row.id, masterId: row.id, source: "progress", title: row.taskName, description: row.planDetail, eventType: "milestone", startAt: `${planTargetDate}T00:00:00.000Z`, endAt: `${planTargetDate}T00:00:00.000Z`, date: planTargetDate, startTime: "", endTime: "", allDay: true, areaCodeId: row.groupId, areaLabel: labels.get(row.groupId) ?? null, location: "", priority: "MEDIUM", isMilestone: true, isRecurring: false, occurrenceDate: null, recurrenceSummary: null, assignees: [], groupTags: [], editable: false, sourceUrl: `/weekly-progress?edit=${row.id}` });
    if (nextTargetDate && inRange(nextTargetDate, from, to)) rows.push({ id: row.id, masterId: row.id, source: "next_plan", title: row.taskName, description: row.nextPlan, eventType: "work", startAt: `${nextTargetDate}T00:00:00.000Z`, endAt: `${nextTargetDate}T00:00:00.000Z`, date: nextTargetDate, startTime: "", endTime: "", allDay: true, areaCodeId: row.groupId, areaLabel: labels.get(row.groupId) ?? null, location: "", priority: "LOW", isMilestone: false, isRecurring: false, occurrenceDate: null, recurrenceSummary: null, assignees: [], groupTags: [], editable: false, sourceUrl: `/weekly-progress?edit=${row.id}` });
  }
  for (const item of items) {
    const date = parts(item.createdAt.toISOString());
    if (inRange(date.date, from, to)) rows.push({ id: item.id, masterId: item.id, source: "issue", title: item.title, description: item.description, eventType: "other", startAt: item.createdAt.toISOString(), endAt: item.createdAt.toISOString(), date: date.date, startTime: date.time, endTime: date.time, allDay: false, areaCodeId: item.groupId, areaLabel: labels.get(item.groupId) ?? null, location: "", priority: "LOW", isMilestone: false, isRecurring: false, occurrenceDate: null, recurrenceSummary: null, assignees: [], groupTags: [], editable: false, sourceUrl: `/items/${item.id}` });
  }
  return rows.sort((a, b) => a.startAt.localeCompare(b.startAt));
}

export async function getCalendarEvent(projectId: string, id: string) {
  const { masterId, occurrenceDate } = parseCompositeId(id);
  const prisma = getPrisma();
  const event = await prisma.calendarEvent.findUnique({ where: { id: masterId }, include: { assignees: { include: { user: true } }, groupTags: { include: { group: true } } } });
  if (!event || event.projectId !== projectId) return null;
  const options = await getCodeOptions(projectId), labels = new Map(options.tracks.map((code) => [code.id, code.label]));
  const assignees: EventPerson[] = event.assignees.map((a) => ({ id: a.user.id, name: a.user.name }));
  const groupTags: EventGroupTagEntry[] = event.groupTags.map((t) => ({ id: t.group.id, label: t.group.label }));

  if (occurrenceDate && event.recurrenceRule) {
    const exception = await prisma.eventException.findUnique({ where: { eventId_exceptionDate: { eventId: masterId, exceptionDate: new Date(occurrenceDate) } } });
    const override = (exception?.type === "MODIFIED" ? (exception.overrideData as OverrideData | null) : null) ?? {};
    const duration = event.endAt.getTime() - event.startAt.getTime();
    const timeOfDay = event.startAt.toISOString().slice(11);
    const naturalStart = new Date(`${occurrenceDate}T${timeOfDay}`);
    const startAt = override.startAt ? new Date(override.startAt) : naturalStart;
    const endAt = override.endAt ? new Date(override.endAt) : new Date(naturalStart.getTime() + duration);
    const start = parts(startAt.toISOString()), end = parts(endAt.toISOString());
    const groupId = override.groupId !== undefined ? override.groupId : event.groupId;
    return { id, masterId, source: "schedule", title: override.title ?? event.title, description: override.description ?? event.description, eventType: override.eventType ?? event.eventType, startAt: startAt.toISOString(), endAt: endAt.toISOString(), date: start.date, startTime: start.time, endTime: end.time, allDay: override.allDay ?? event.allDay, areaCodeId: groupId, areaLabel: groupId ? labels.get(groupId) ?? null : null, location: override.location ?? event.location, priority: override.priority ?? event.priority, isMilestone: override.isMilestone ?? event.isMilestone, isRecurring: true, occurrenceDate, recurrenceSummary: describeRecurrence(event.recurrenceRule), assignees, groupTags, editable: true, sourceUrl: null } satisfies CalendarEvent;
  }
  const start = parts(event.startAt.toISOString()), end = parts(event.endAt.toISOString());
  return { id: event.id, masterId: event.id, source: "schedule", title: event.title, description: event.description, eventType: event.eventType, startAt: event.startAt.toISOString(), endAt: event.endAt.toISOString(), date: start.date, startTime: start.time, endTime: end.time, allDay: event.allDay, areaCodeId: event.groupId, areaLabel: event.groupId ? labels.get(event.groupId) ?? null : null, location: event.location, priority: event.priority, isMilestone: event.isMilestone, isRecurring: Boolean(event.recurrenceRule), occurrenceDate: null, recurrenceSummary: event.recurrenceRule ? describeRecurrence(event.recurrenceRule) : null, assignees, groupTags, editable: true, sourceUrl: null } satisfies CalendarEvent;
}

export async function createCalendarEvent(projectId: string, userId: string, input: unknown) {
  await assertManager(projectId, userId);
  const data = eventSchema.parse(input);
  const recurrenceRule = data.recurrence ? buildRecurrenceRule(data.recurrence as RecurrenceInput) : null;
  const prisma = getPrisma();
  const event = await prisma.$transaction(async (tx) => {
    const event = await tx.calendarEvent.create({ data: { projectId, title: data.title, description: data.description, eventType: data.eventType, startAt: new Date(data.startAt), endAt: new Date(data.endAt), allDay: data.allDay, groupId: data.areaCodeId, location: data.location, priority: data.priority, isMilestone: data.isMilestone, recurrenceRule, createdBy: userId } });
    if (data.assigneeIds.length) await tx.eventAssignee.createMany({ data: data.assigneeIds.map((userId) => ({ eventId: event.id, userId })) });
    if (data.groupTagIds.length) await tx.eventGroupTag.createMany({ data: data.groupTagIds.map((groupId) => ({ eventId: event.id, groupId })) });
    return event;
  });
  await writeAuditLog(projectId, userId, "CALENDAR_EVENTS_INSERT", "calendar_events", event.id, null, event);
  return { id: event.id };
}

export async function updateCalendarEvent(projectId: string, id: string, userId: string, input: unknown, scope: "all" | "single" = "all") {
  await assertManager(projectId, userId);
  const data = eventSchema.parse(input);
  const { masterId, occurrenceDate } = parseCompositeId(id);
  const prisma = getPrisma();
  const before = await prisma.calendarEvent.findUnique({ where: { id: masterId } });
  if (!before || before.projectId !== projectId) return undefined;

  if (scope === "single" && occurrenceDate) {
    const overrideData: OverrideData = { title: data.title, description: data.description, eventType: data.eventType, startAt: data.startAt, endAt: data.endAt, allDay: data.allDay, groupId: data.areaCodeId, location: data.location, priority: data.priority, isMilestone: data.isMilestone };
    const exception = await prisma.eventException.upsert({
      where: { eventId_exceptionDate: { eventId: masterId, exceptionDate: new Date(occurrenceDate) } },
      create: { eventId: masterId, exceptionDate: new Date(occurrenceDate), type: "MODIFIED", overrideData: overrideData as Prisma.InputJsonValue },
      update: { type: "MODIFIED", overrideData: overrideData as Prisma.InputJsonValue },
    });
    await writeAuditLog(projectId, userId, "CALENDAR_EVENTS_EXCEPTION_UPSERT", "event_exceptions", exception.id, null, exception);
    return { id };
  }
  const recurrenceRule = data.recurrence ? buildRecurrenceRule(data.recurrence as RecurrenceInput) : null;
  const updated = await prisma.$transaction(async (tx) => {
    const updated = await tx.calendarEvent.update({ where: { id: masterId }, data: { title: data.title, description: data.description, eventType: data.eventType, startAt: new Date(data.startAt), endAt: new Date(data.endAt), allDay: data.allDay, groupId: data.areaCodeId, location: data.location, priority: data.priority, isMilestone: data.isMilestone, recurrenceRule, updatedBy: userId, version: { increment: 1 } } });
    await tx.eventAssignee.deleteMany({ where: { eventId: masterId } });
    if (data.assigneeIds.length) await tx.eventAssignee.createMany({ data: data.assigneeIds.map((userId) => ({ eventId: masterId, userId })) });
    await tx.eventGroupTag.deleteMany({ where: { eventId: masterId } });
    if (data.groupTagIds.length) await tx.eventGroupTag.createMany({ data: data.groupTagIds.map((groupId) => ({ eventId: masterId, groupId })) });
    return updated;
  });
  await writeAuditLog(projectId, userId, "CALENDAR_EVENTS_UPDATE", "calendar_events", masterId, before, updated);
  return { id: masterId };
}

export async function deleteCalendarEvent(projectId: string, id: string, userId: string, scope: "all" | "single" = "all") {
  await assertManager(projectId, userId);
  const { masterId, occurrenceDate } = parseCompositeId(id);
  const prisma = getPrisma();
  const before = await prisma.calendarEvent.findUnique({ where: { id: masterId } });
  if (!before || before.projectId !== projectId) return undefined;

  let exception: EventException | null = null;
  if (scope === "single" && occurrenceDate && before.recurrenceRule) {
    exception = await prisma.eventException.upsert({
      where: { eventId_exceptionDate: { eventId: masterId, exceptionDate: new Date(occurrenceDate) } },
      create: { eventId: masterId, exceptionDate: new Date(occurrenceDate), type: "DELETED" },
      update: { type: "DELETED", overrideData: undefined },
    });
    await writeAuditLog(projectId, userId, "CALENDAR_EVENTS_EXCEPTION_DELETE", "event_exceptions", exception.id, null, { occurrenceDate });
  } else {
    await prisma.calendarEvent.delete({ where: { id: masterId } });
    await writeAuditLog(projectId, userId, "CALENDAR_EVENTS_DELETE", "calendar_events", masterId, before, null);
  }
  return { id: masterId };
}

export async function searchCalendarEvents(projectId: string, filters: CalendarSearchFilters): Promise<CalendarEvent[]> {
  const from = filters.from ?? new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  const to = filters.to ?? new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
  const events = await listCalendarEvents(projectId, from, to, filters);
  // DB에서 좁히지 못하는 반복 일정 회차(예외 override 적용 후 값)를 최종적으로 걸러낸다.
  const query = filters.q?.trim().toLocaleLowerCase("ko");
  return events.filter((event) =>
    (!query || `${event.title} ${event.description} ${event.location}`.toLocaleLowerCase("ko").includes(query)) &&
    (!filters.priority || event.priority === filters.priority) &&
    (!filters.groupId || event.areaCodeId === filters.groupId || event.groupTags.some((tag) => tag.id === filters.groupId)) &&
    (!filters.assigneeId || event.assignees.some((assignee) => assignee.id === filters.assigneeId)),
  );
}

export async function listMilestones(projectId: string): Promise<MilestoneEntry[]> {
  const prisma = getPrisma();
  const [events, project] = await Promise.all([
    prisma.calendarEvent.findMany({ where: { projectId, OR: [{ isMilestone: true }, { priority: "HIGH" }] } }),
    prisma.project.findUnique({ where: { id: projectId } }),
  ]);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const dayDiff = (d: Date) => Math.round((d.getTime() - today.getTime()) / 86_400_000);
  const rows: MilestoneEntry[] = [];
  for (const event of events) {
    if (event.recurrenceRule) {
      const [next] = expandOccurrences(event.recurrenceRule, event.startAt, today, new Date(today.getTime() + 365 * 86_400_000));
      if (!next) continue;
      rows.push({ id: `${event.id}::${next.toISOString().slice(0, 10)}`, title: event.title, date: next.toISOString().slice(0, 10), kind: "event", daysUntil: dayDiff(next), sourceUrl: null });
    } else {
      rows.push({ id: event.id, title: event.title, date: event.startAt.toISOString().slice(0, 10), kind: "event", daysUntil: dayDiff(event.startAt), sourceUrl: null });
    }
  }
  if (project) {
    const openDates: [string, Date | null][] = project.openMethod === "phased" ? [["1차 오픈", project.firstOpenDate], ["2차 오픈", project.secondOpenDate]] : [["오픈일", project.goLiveDate]];
    for (const [label, date] of openDates) if (date) rows.push({ id: `project-${label}`, title: `${project.name} ${label}`, date: date.toISOString().slice(0, 10), kind: "project", daysUntil: dayDiff(date), sourceUrl: "/project-settings" });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
