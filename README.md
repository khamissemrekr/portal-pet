# PortalPet

업무포털(나이스 / K-에듀파인 / G-ONE) 원클릭 접속용 데스크톱 펫입니다. 인증서 비밀번호를 한 번 저장해두면,
화면 위 캐릭터를 클릭해서 나오는 메뉴 버튼만 누르면 인증서 로그인부터 원하는 화면까지 자동으로 이동합니다.

UX는 [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)의 **미니 모드**(화면 가장자리 대기)와
**시스템 트레이** 동작을 참고했고, 캐릭터 아트워크와 실제 코드는 전부 새로 작성했습니다(아래 "왜 fork가 아니라
새로 작성했는가" 참고).

## 주요 기능

- **인증서 자동 로그인** — 비밀번호를 암호화 저장해두면(Electron `safeStorage`, Windows에서는 DPAPI 사용)
  인증서 모달이 뜰 때마다 자동으로 입력합니다. 원하지 않으면 설정에서 "자동 로그인"을 꺼서 인증서 창이 뜰 때
  직접 입력하는 방식으로도 쓸 수 있습니다.
- **원클릭 메뉴 이동** — 실제 크롬 브라우저(Playwright가 시스템에 설치된 Chrome을 구동)로 포털에 들어가서
  버튼 하나로 목적 화면까지 자동으로 클릭해 이동합니다.
  - 나이스: 복무 신청, 출장 신청, 나이스 결재(미결/협조함)
  - K-에듀파인: 기안문 작성, 품의 작성, 공문 결재(결재대기)
  - G-ONE: 메신저, AI 대화·초안, 일정
- **자주 가는 사이트** — 메뉴명과 주소를 등록해두면 캐릭터 메뉴에 버튼으로 떠서 클릭 한 번에 기본
  브라우저로 열립니다.
- **시작 시 자동 실행** — 프로그램을 켤 때 G-ONE 메신저 로그인, 일정 화면 띄우기를 자동으로 하도록 켜둘 수
  있습니다.
- **공지 팝업 자동 처리** — 나이스/포털홈/G-ONE에서 뜨는 공지사항 팝업(여러 개가 겹쳐 떠도)을 자동으로
  닫아서 메뉴 클릭을 방해하지 않게 합니다.
- **캐릭터 연출** — 대기/드래그/작업 중/성공/실패/장시간 미사용(수면) 포즈가 있고, 드래그로 화면 어디든
  옮길 수 있습니다. 트레이 아이콘 클릭으로 패널을 여닫습니다.
- **기존 크롬 프로필 재사용** — 이미 로그인·보안프로그램 설정이 끝난 크롬 프로필을 그대로 쓸 수도 있고,
  PortalPet 전용 프로필을 새로 써도 됩니다.

## 동작 방식

포털의 인증서 로그인은 네이티브 Win32 팝업이 아니라 **페이지 DOM에 직접 렌더링되는 HTML 모달**입니다.
그래서 좌표 기반 SendKeys 방식이 아니라 Playwright로 DOM 선택자를 찾아 자동입력합니다.

- 인증서 비밀번호 입력창: `input[name="certPassword"]`
- 확인 버튼: 고유 id가 없어 텍스트 매칭(`button:has-text("확인")`)으로 클릭
- `certPassword`는 자체 보안스크립트가 keydown을 가로챌 수 있어 `fill()` 대신 실제 타이핑 이벤트를 내는
  `type()`을 사용
- 나이스/K-에듀파인/G-ONE 모두 "cl-" 접두사가 붙은 커스텀 UI 컴포넌트라 `element.click()` 같은 합성 클릭에
  반응하지 않는 경우가 있어, 위치만 DOM에서 찾고 실제 클릭은 Playwright의 진짜 마우스 이벤트로 수행합니다.
- K-에듀파인의 표준서식 편집기(WXSClient)는 완전히 별도의 네이티브 Windows 앱이라 그 안의 확인창은
  Playwright로 손댈 수 없어, PowerShell로 창 제목을 감시하다 자동으로 닫는 방식(`engine/dialogSuppressor.js`)을
  따로 씁니다.

진입점은 `engine/loginEngine.js`의 `launchService(serviceKey, subdomain, password, browserProfile)`이며,
메뉴 버튼 클릭 시 이 함수가 호출됩니다.

## 요구 사항

- Windows
- **Google Chrome이 설치돼 있어야 합니다** (Playwright가 번들 Chromium이 아니라 시스템 Chrome을 구동합니다)
- 개발용으로 실행하려면 Node.js

## 실행 (개발)

```
npm install
npm start
```

## 배포용 설치 파일 만들기

```
npm run dist
```

`electron-builder`로 Windows NSIS 설치 파일을 만듭니다(`dist/` 폴더에 생성, git에는 포함하지 않음).
Playwright가 별도 드라이버 프로세스를 실행해야 해서 `asar: false`로 빌드합니다. 설치해서 쓰는 사람의 PC에도
Chrome이 설치돼 있어야 합니다.

## 설정

캐릭터를 클릭해서 나오는 패널의 톱니 아이콘(또는 트레이 메뉴)에서 설정 창을 엽니다.

- 인증서 비밀번호 저장/삭제, 자동 로그인 켜고 끄기
- 사용할 크롬 프로필 선택
- 자주 가는 사이트 추가/삭제
- 프로그램 실행 시 메신저/일정 자동 실행 여부

설정은 Electron `userData` 경로(`%APPDATA%/PortalPet/config.json`)에 저장되며, 비밀번호는 평문이 아니라
`safeStorage`로 암호화된 상태로만 저장됩니다.

## 프로젝트 구조

```
PortalPet/
  main.js                    # Electron 메인 프로세스: 창 생성, 트레이, IPC, 시작 시 자동 실행
  preload.js                 # 렌더러 <-> 메인 프로세스 브릿지 (contextBridge)
  renderer/
    index.html, renderer.js  # 캐릭터 + 서비스 버튼 패널 UI
    setup.html                # 설정 창
  engine/
    loginEngine.js            # Playwright 기반 로그인/메뉴 자동화 핵심 로직
    credentialStore.js         # 설정 저장/로드, safeStorage 암복호화
    regionMap.js                # 시도교육청 서브도메인/URL 매핑
    chromeProfiles.js           # 설치된 크롬 프로필 목록 읽기
    dialogSuppressor.js         # WXSClient 네이티브 확인창 자동 닫기(PowerShell)
  theme/
    tiger_actions/               # 캐릭터 포즈 이미지(오리지널)
    tray-icon.png                # 트레이 아이콘
```

## 지원 지역

현재는 **경기(GOE)** 만 정식 지원합니다. `engine/regionMap.js`에 다른 시도교육청 서브도메인도 등록돼 있어
확장 여지는 있지만, 실사용 검증은 경기만 이뤄졌습니다.

## 왜 fork가 아니라 새로 작성했는가

- clawd-on-desk는 AGPL-3.0이며, 캐릭터 아트워크(Clawd/Calico/Cloudling)는 별도 저작권이 있어 그대로
  재사용할 수 없습니다.
- 필요한 건 UX 패턴(미니모드 edge-peek, 트레이, 클릭 펼침)뿐이고, 멀티 에이전트 훅·권한 말풍선·모바일 PWA
  등 나머지 기능은 이 프로젝트 목적과 무관합니다.
- 그래서 필요한 동작만 최소 구현으로 새로 작성했습니다. 캐릭터 이미지(`theme/tiger_actions/`)와 트레이
  아이콘도 오리지널입니다.

지역별 서브도메인/딥링크 데이터는 [OneClickPortal](https://github.com/zeroboom92/OneClickPortal)의 실측
데이터를 참고했습니다.

## 알려진 제한사항

- 사용자의 PC에 Google Chrome이 설치돼 있어야 합니다(번들 브라우저 아님).
- 경기 외 지역은 서브도메인 매핑만 있고 실사용 검증이 안 돼 있습니다.
- 나이스/K-에듀파인/G-ONE의 화면 구조가 바뀌면(선택자·라벨 변경 등) 자동화가 깨질 수 있습니다.
