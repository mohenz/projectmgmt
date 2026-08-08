import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/lib/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { pmoPrisma?: PrismaClient };

function createPrismaClient() {
  const raw = process.env.POSTGRES_PRISMA_URL;
  if (!raw) throw new Error("POSTGRES_PRISMA_URL is not set.");
  // Supabase pooler 인증서가 Node 기본 신뢰 저장소에서 검증되지 않아 sslmode를 no-verify로 낮춘다(전송은 여전히 암호화됨).
  const connectionString = raw.replace(/sslmode=require/, "sslmode=no-verify");
  const adapter = new PrismaPg({ connectionString });
  // Supabase PgBouncer(transaction pooling) 하에서 커넥션 확보가 지연될 때 기본값(2s/5s)보다 여유를 둔다.
  return new PrismaClient({ adapter, transactionOptions: { maxWait: 10_000, timeout: 15_000 } });
}

export function getPrisma() {
  globalForPrisma.pmoPrisma ??= createPrismaClient();
  return globalForPrisma.pmoPrisma;
}

export function nowIso() {
  return new Date().toISOString();
}


// 이벤트/감사로그의 actorName은 "사건 발생 시점의 이름" 스냅샷이므로 기록 시점에 조회해 함께 저장한다.
export async function actorNameOf(actorId: string | null) {
  if (!actorId) return null;
  const actor = await getPrisma().user.findUnique({ where: { id: actorId }, select: { name: true } });
  return actor?.name ?? null;
}

export async function writeAuditLog(
  projectId: string,
  actorId: string | null,
  action: string,
  targetTable: string | null,
  targetId: string | null,
  beforeData: Prisma.InputJsonValue | null,
  afterData: Prisma.InputJsonValue | null,
) {
  const prisma = getPrisma();
  return prisma.auditLog.create({
    data: {
      projectId,
      actorId,
      actorName: await actorNameOf(actorId),
      action,
      targetTable,
      targetId,
      beforeData: beforeData ?? undefined,
      afterData: afterData ?? undefined,
    },
  });
}
