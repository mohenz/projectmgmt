// 영업일(주말 제외) 계산 — DB/런타임 의존이 없는 순수 함수라 도메인 계층에 둔다.

const isWeekend = (date: Date) => date.getUTCDay() === 0 || date.getUTCDay() === 6;

/** value(제외) ~ 오늘(포함) 사이의 영업일 수. */
export function businessDaysSince(value: string | Date) {
  const start = new Date(value);
  const end = new Date();
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);
  let count = 0;
  for (const cursor = new Date(start.getTime() + 86_400_000); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (!isWeekend(cursor)) count += 1;
  }
  return count;
}

/**
 * `businessDaysSince(updatedAt) >= days` 와 동치인 경계 시각.
 * stale 판정을 메모리가 아닌 SQL(`updatedAt < staleCutoff(days)`)로 내리기 위해 사용한다.
 */
export function staleCutoff(days: number) {
  const cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
  if (days <= 0) {
    // 영업일 0일이면 모든 항목이 stale — 오늘을 포함하도록 경계를 내일로 민다.
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    return cursor;
  }
  for (let counted = 0; ; cursor.setUTCDate(cursor.getUTCDate() - 1)) {
    if (!isWeekend(cursor) && ++counted === days) return cursor;
  }
}
