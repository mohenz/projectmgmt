// vitest는 RSC 런타임이 아니라 `server-only` 임포트가 곧바로 throw한다.
// 서버 계층의 순수 함수를 테스트하기 위한 빈 스텁 (vitest.config.ts의 alias에서 연결).
export {};
