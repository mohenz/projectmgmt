import { afterEach, describe, expect, it, vi } from "vitest";
import { businessDaysSince, staleCutoff } from "./business-days";

// 2026-08-12는 수요일 — 요일 의존 로직을 고정 시각 위에서 검증한다.
const freeze = (isoDate: string) => vi.setSystemTime(new Date(`${isoDate}T09:00:00.000Z`));
const iso = (date: Date) => date.toISOString().slice(0, 10);

afterEach(() => {
  vi.useRealTimers();
});

describe("businessDaysSince", () => {
  it("counts weekdays after the given date up to today", () => {
    vi.useFakeTimers();
    freeze("2026-08-12"); // 수
    expect(businessDaysSince("2026-08-12")).toBe(0);
    expect(businessDaysSince("2026-08-11")).toBe(1);
    expect(businessDaysSince("2026-08-10")).toBe(2);
  });

  it("skips weekends", () => {
    vi.useFakeTimers();
    freeze("2026-08-10"); // 월
    // 금(7) 다음 영업일은 월(10) 하나뿐 — 토·일은 제외된다.
    expect(businessDaysSince("2026-08-07")).toBe(1);
  });
});

describe("staleCutoff", () => {
  it("matches businessDaysSince at the boundary", () => {
    vi.useFakeTimers();
    freeze("2026-08-12"); // 수
    const cutoff = staleCutoff(3);
    // 경계 바로 앞(= cutoff 이전)은 stale, 경계 당일은 아직 stale이 아니다.
    expect(businessDaysSince(new Date(cutoff.getTime() - 86_400_000))).toBeGreaterThanOrEqual(3);
    expect(businessDaysSince(cutoff)).toBeLessThan(3);
  });

  it("walks back over a weekend", () => {
    vi.useFakeTimers();
    freeze("2026-08-10"); // 월
    // 월에서 3영업일을 거슬러 올라가면 월-금-목 → 목요일(6일)
    expect(iso(staleCutoff(3))).toBe("2026-08-06");
  });

  it("lands on today when one business day is required", () => {
    vi.useFakeTimers();
    freeze("2026-08-12"); // 수
    expect(iso(staleCutoff(1))).toBe("2026-08-12");
  });

  it("skips back to the last weekday when today is a weekend", () => {
    vi.useFakeTimers();
    freeze("2026-08-15"); // 토
    expect(iso(staleCutoff(1))).toBe("2026-08-14"); // 금
  });

  it("treats every item as stale when the threshold is zero", () => {
    vi.useFakeTimers();
    freeze("2026-08-12");
    expect(staleCutoff(0).getTime()).toBeGreaterThan(new Date("2026-08-12T23:59:59.999Z").getTime());
  });
});
