# PortalPet

업무포털 원클릭 접속용 데스크톱 펫. UX는 [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)의
**미니 모드**(화면 가장자리에 숨었다가 커서를 올리면 튀어나오는 방식)와 **시스템 트레이** 동작을 참고했습니다.

## 왜 fork가 아니라 새로 작성했는가

- clawd-on-desk는 AGPL-3.0이며, 캐릭터 아트워크(Clawd/Calico/Cloudling)는 별도 저작권이 있어 그대로 재사용할 수 없습니다.
- 우리에게 필요한 건 UX 패턴(미니모드 edge-peek, 트레이, 클릭 펼침)뿐이고, 멀티 에이전트 훅·권한 말풍선·모바일 PWA 등
  나머지 기능은 우리 목적과 무관합니다.
- 그래서 필요한 동작만 최소 구현으로 새로 작성했습니다. 아이콘(`theme/idle.svg`)도 오리지널 디자인입니다.

## 구조

```
PortalPet/
  main.js         # Electron 메인 프로세스: 창 생성, 미니모드, 트레이, 서비스 실행 IPC
  preload.js       # 렌더러 <-> 메인 프로세스 브릿지
  renderer/         # 캐릭터 + 펼침 패널 UI
  theme/            # idle.svg, tray-icon.png (오리지널)
```

## 로그인 자동화: Playwright (C# 엔진에서 전환함)

Phase 0 실측 결과, 업무포털 인증서 로그인은 **네이티브 Win32 팝업이 아니라 페이지 DOM에 직접 렌더링되는
HTML 모달**로 확인됐습니다(iframe도 아님). 그래서 좌표 기반 SendKeys 방식(`PortalAutoLogin` C# 프로젝트,
`../PortalAutoLogin/`)은 보류하고, Playwright로 DOM 선택자 기반 자동입력을 구현했습니다.

- 인증서 비밀번호 입력창: `input[name="certPassword"]`
- 확인 버튼: 고유 id 없음 → 텍스트 매칭 `button:has-text("확인")`
- `certPassword`에는 `npkencrypt` 속성이 있어 자체 보안스크립트가 keydown을 가로챌 가능성 → `fill()` 대신
  `type()`으로 실제 타이핑 이벤트를 발생시킴 (`engine/loginEngine.js`)
- 비밀번호 저장은 C#의 DPAPI 대신 Electron `safeStorage`로 통일 (Windows에서는 내부적으로 동일한 DPAPI 사용)

`engine/loginEngine.js`의 `launchService(serviceKey, subdomain, password)`가 버튼 클릭 시 호출되는 진입점입니다.

## 실행 (개발)

```
npm install
npm start
```

## 남은 작업

- [ ] 캐릭터 상태 애니메이션(대기/연결중/완료/오류) — 지금은 정적 SVG + 상태 점(dot)만 있음
- [ ] 로그인 성공/실패 판정 로직 보강 (현재는 모달이 사라지는지로만 추정 — 에러 메시지 셀렉터 미확인)
- [ ] 서비스별 딥링크 확정 후 `engine/regionMap.js`의 `SERVICE_DEEP_LINKS` 채우기 (나이스/에듀파인/G-ONE 등)
- [ ] 인천 등 나머지 지역 서브도메인 확인 후 `REGIONS`에 추가
- [ ] `npkencrypt` 보안스크립트가 실제로 `type()` 입력을 정상 인식하는지 실사용 테스트 (틀리면 가상 키패드 클릭 방식으로 재작업 필요)
- [ ] `electron-builder`로 Windows 설치 파일 빌드 + Playwright 브라우저 바이너리 포함 여부 검토
