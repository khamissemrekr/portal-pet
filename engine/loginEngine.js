// loginEngine.js
// 업무포털 로그인은 (2026-07-27 실측 확인):
//   1. bpm_man_mn00_001.do 접속 -> 미로그인 상태면 bpm_lgn_lg00_001.do로 리다이렉트
//   2. 그 페이지의 "교육행정 전자서명 인증서 로그인" 버튼(id="btnLgn")을 눌러야
//      인증서 모달이 나타남 (모달의 input 자체는 DOM에 항상 있지만 hidden 상태였음)
//   3. 인증서 비밀번호 입력창: input[name="certPassword"]  (class="kc-pw-box")
//   4. 확인 버튼: 고유 id 없음 → 텍스트로 탐색 ("확인", class="kc-btn-blue")
// certPassword 필드는 npkencrypt 속성이 붙어 있어 자체 보안 스크립트가 실제 keydown 이벤트를
// 가로챌 가능성이 있다 → page.fill() 대신 page.type()으로 실제 타이핑을 흉내낸다.

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { app, shell } = require('electron');
const { buildPortalUrl, buildNeisUrl, buildEdufineUrl, buildEdmgrUrl, GONE_URL_BY_SUBDOMAIN } = require('./regionMap');

// (수정) 엣지 지원 추가 - "PortalPet 전용 프로필"은 어떤 브라우저(channel)를 쓰느냐에 따라
// 폴더를 분리한다. 크롬은 기존 사용자들의 이미 마쳐둔 보안프로그램/인증서 설정이 담긴 폴더명을
// 그대로 유지해 재설정을 요구하지 않고, 엣지만 새 폴더를 쓴다(크로미움이라도 서로 다른 제품이라
// 같은 user-data-dir을 공유하면 문제가 생길 수 있어 분리).
const USER_DATA_DIR = (browserChannel = 'chrome') => path.join(
  app.getPath('userData'), 'PortalPet',
  browserChannel === 'chrome' ? 'browser-profile' : `browser-profile-${browserChannel}`
);

/**
 * launchPersistentContext 직후 첫 페이지 이동은 가끔 net::ERR_ABORTED로 실패한다(실측 확인:
 * "부팅 직후 자동 실행"으로 새 프로필/새 크롬 프로세스를 막 띄웠을 때 재현됨) - 크롬이 첫 탭을
 * 자체적으로 초기화(세션 복원/새 탭 페이지 로드 등)하는 도중에 우리 goto가 끼어들면서 취소되는
 * 것으로 보인다. 한 번 취소돼도 크롬 자체는 멀쩡하므로, 잠깐 기다렸다가 한 번 더 시도하면 된다.
 */
async function gotoWithRetry(page, url, opts = {}) {
  try {
    return await page.goto(url, opts);
  } catch (e) {
    if (!/ERR_ABORTED/.test(e.message || '')) throw e;
    console.log(`[PortalPet] goto(${url}) aborted (cold browser start로 보임) - 1초 뒤 재시도`);
    await page.waitForTimeout(1000);
    return page.goto(url, opts);
  }
}

/**
 * (엣지 지원 정리) 엣지에서 인증서 로그인이 안 되는 경우, 실측으로 확인된 원인은 크롬과 달리
 * 이 PC의 엣지에 인증서(NPKI) 관련 보안프로그램이 아직 설치/등록돼 있지 않은 경우가 많다는
 * 것이었다(로딩 오버레이가 안 사라지고 인증서 모달 자체가 안 뜸) - 이건 PortalPet 코드가
 * 고칠 수 있는 문제가 아니라 그 PC의 엣지에 보안프로그램이 설정돼 있는지의 문제라, 여기서는
 * 원인을 짐작할 수 있는 안내 문구만 덧붙인다(크롬은 기존 메시지 그대로).
 */
function buildLoginFailureMessage(browserChannel) {
  const base = '인증서 로그인이 완료되지 않은 것 같습니다 (로그인 페이지에 머물러 있음). 비밀번호나 인증서 상태를 확인한 뒤 다시 시도해 주세요.';
  if (browserChannel === 'msedge') {
    return base + ' (엣지 사용 시 자주 발생) 이 PC의 엣지에 인증서 관련 보안프로그램이 아직 설치돼 있지 않을 수 있습니다 - ' +
      '엣지를 직접 열어 나이스나 K-에듀파인에 한 번 수동으로 로그인해 필요한 프로그램 설치를 마친 뒤 다시 시도해 주세요.';
  }
  return base;
}

let sharedContext = null;
// (수정) 예전엔 클릭마다 무조건 같은 탭 하나만 재사용했다 - 그런데 이미 한 화면(예: 기안문
// 작성 중)이 떠 있는 상태에서 다른 메뉴(예: 품의 작성)를 누르면 그 화면을 밀어내고 사라지게
// 만들어, 작업 중이던 내용을 잃을 수 있었다(사용자 요청으로 확인). 그래서 지금은 "현재 탭에
// 이미 뭔가 열려 있으면(=이미 실행 중이면) 새 탭을 연다"로 바꿨다 - sharedPage는 여전히
// "다음 클릭이 우선 사용할 탭"을 가리키는 포인터로 쓰되, 실행 중이면 매번 새로 갈아끼운다.
let sharedPage = null;
let lastBrowserProfileKey = null; // 프로필을 바꾸면 기존 컨텍스트를 버리고 새로 띄워야 한다.
// launchService/checkEdufineApprovalCount가 각자 열어둔 "정상적인" 서비스 탭들의 집합.
// closeExtraPages는 이 목록에 있는 탭은 leftover 팝업으로 오인해 닫지 않는다 - 그래야 사용자가
// 다른 메뉴로 새로 연 탭이 다음 클릭 때 자동으로 닫혀버리는 일이 없다.
const mainServiceTabs = new Set();
// (신규, 사용자 요청: "메신저 실행 시 최소화하기를 설정 옵션으로 넣어줘") launchService 호출
// 체인이 꽤 깊어서(openGoneSubMenu -> clickFirstMatchFollowingPopup -> clickAndFollowPopup)
// 매개변수로 계속 넘기는 대신, sharedPage/mainServiceTabs와 같은 방식으로 모듈 전역 상태로
// 관리한다 - launchService 시작 시 매번 사용자 설정값으로 갱신된다. 기본값은 true(켬).
let minimizeMessengerOnLaunchEnabled = true;
// (신규, 사용자 요청: "인증서가 여러 개인 경우 사용자 이름으로 구분") completeCertLoginIfNeeded는
// goToPortalMenu/openNeisRoleMenu 등 여러 함수를 거쳐 호출 체인이 깊어서(위 이유와 동일)
// 매개변수로 계속 넘기는 대신 모듈 전역으로 관리한다. 빈 문자열이면(설정 안 함, 또는 인증서가
// 하나뿐인 대부분의 경우) 아무것도 하지 않고 예전 동작(비밀번호 입력창에 바로 타이핑) 그대로다.
let certUserNameToSelect = '';

/**
 * 새 프로필 특유의 "비밀번호를 저장하시겠습니까?" 팝업을 프로필 설정 파일에서 직접 꺼둔다.
 * Playwright/Chrome에는 이걸 끄는 launch 옵션이 따로 없어서 Preferences 파일을 직접 건드려야 한다.
 * launchPersistentContext가 처음 만드는 'Default' 프로필 폴더에 미리 심어둔다.
 */
function disablePasswordManagerPrompt(browserChannel = 'chrome') {
  const prefsPath = path.join(USER_DATA_DIR(browserChannel), 'Default', 'Preferences');
  try {
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    let prefs = {};
    if (fs.existsSync(prefsPath)) {
      prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    }
    prefs.credentials_enable_service = false;
    prefs.profile = {
      ...(prefs.profile || {}),
      password_manager_enabled: false,
      // 강제 종료(우리 코드가 taskkill로 죽이는 경우 등) 뒤에 뜨는 "Chrome이 제대로
      // 종료되지 않았습니다 - 페이지를 복원하시겠습니까?" 경고를 애초에 안 뜨게 만든다.
      // exit_type이 'Crashed'로 남아있으면 다음 실행 때 그 경고가 뜬다.
      exit_type: 'Normal',
      exited_cleanly: true,
    };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch (e) {
    console.log('[PortalPet] could not pre-set Chrome Preferences (non-fatal):', e.message);
  }
}

/**
 * K-에듀파인의 "표준서식" 편집기는 WXSClient라는 외부 프로그램을 커스텀 프로토콜
 * (wxsclient://)로 띄운다. 이때 크롬이 "WXSClient MFC 응용 프로그램을 여시겠습니까?"라는
 * 네이티브 확인창을 띄우는데, 이건 페이지 DOM이 아니라 크롬 자체 UI라서 Playwright로는
 * 클릭할 수 없다(실측 확인). 원클릭 업무포털(OneClickPortal) 소스코드의
 * EdgeIntegrationPolicy.cs 참고 - 그 확인창에서 "항상 허용"을 체크한 것과 동일한 효과를
 * 프로필의 Preferences 파일에 미리 심어서 아예 안 뜨게 만든다. WXSClient가 로컬 서버로
 * 붙는 것으로 보이는 로컬 네트워크 접근 권한도 같이 허용해둔다.
 */
function authorizeWxsClientForEdufine(userDataDir, profileFolder, edufineOrigin) {
  authorizeCustomProtocolForOrigin(userDataDir, profileFolder, edufineOrigin, 'wxsclient', {
    allowLocalNetwork: true,
    label: 'K-에듀파인 WXSClient',
  });
}

/**
 * G-ONE '메신저' 클릭은 실제 화면이 아니라 Brity 메신저(데스크톱 앱)를 커스텀 프로토콜
 * (brityaltsso://)로 띄우는 브리지 페이지(gdp-accounts.*.go.kr/loginapp/messenger/login)를
 * 새 탭으로 연다(실측 확인). WXSClient와 마찬가지로 크롬이 "Brity 메신저를 여시겠습니까?"
 * 같은 네이티브 확인창을 띄울 수 있어 미리 허용해둔다.
 */
function authorizeBrityMessengerProtocol(userDataDir, profileFolder, bridgeOrigin) {
  authorizeCustomProtocolForOrigin(userDataDir, profileFolder, bridgeOrigin, 'brityaltsso', {
    allowLocalNetwork: false,
    label: 'G-ONE Brity 메신저',
  });
}

/**
 * 커스텀 URL 프로토콜(wxsclient://, brityaltsso:// 등)을 여시겠습니까 하는 크롬 네이티브
 * 확인창은 페이지 DOM이 아니라 크롬 자체 UI라서 Playwright로는 클릭할 수 없다(실측 확인).
 * 원클릭 업무포털(OneClickPortal) 소스코드의 EdgeIntegrationPolicy.cs 참고 - 그 확인창에서
 * "항상 허용"을 체크한 것과 동일한 효과를 프로필의 Preferences 파일에 미리 심어서 아예
 * 안 뜨게 만든다.
 */
function authorizeCustomProtocolForOrigin(userDataDir, profileFolder, origin, protocolName, { allowLocalNetwork = false, label = protocolName } = {}) {
  const prefsPath = path.join(userDataDir, profileFolder, 'Preferences');
  try {
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    let prefs = {};
    if (fs.existsSync(prefsPath)) {
      prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    }

    prefs.protocol_handler = prefs.protocol_handler || {};
    prefs.protocol_handler.allowed_origin_protocol_pairs = prefs.protocol_handler.allowed_origin_protocol_pairs || {};
    prefs.protocol_handler.allowed_origin_protocol_pairs[origin] = {
      ...(prefs.protocol_handler.allowed_origin_protocol_pairs[origin] || {}),
      [protocolName]: true,
    };

    if (allowLocalNetwork) {
      prefs.profile = prefs.profile || {};
      prefs.profile.content_settings = prefs.profile.content_settings || {};
      prefs.profile.content_settings.exceptions = prefs.profile.content_settings.exceptions || {};
      const pattern = `${origin}:443,*`;
      // Chrome 내부 타임스탬프 형식(1601-01-01 기준 마이크로초)으로 맞춰준다.
      const lastModified = String(Date.now() * 1000 + 11644473600000000);
      for (const permissionName of ['local_network', 'loopback_network', 'local_network_access']) {
        prefs.profile.content_settings.exceptions[permissionName] = prefs.profile.content_settings.exceptions[permissionName] || {};
        prefs.profile.content_settings.exceptions[permissionName][pattern] = { setting: 1, last_modified: lastModified };
      }
    }

    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    console.log(`[PortalPet] ${label} 자동 허용 설정 완료: ${origin} (${protocolName})`);
  } catch (e) {
    console.log(`[PortalPet] ${label} 허용 설정 실패 (non-fatal, 수동으로 "항상 허용" 체크 필요할 수 있음):`, e.message);
  }
}

/**
 * GONE_URL_BY_SUBDOMAIN의 SSO 진입 호스트(예: gdp.goe.go.kr)에서 메신저 브리지 호스트
 * (gdp-accounts.goe.go.kr)를 유도한다. G-ONE은 경기도(goe) 전용으로 확인된 플랫폼이라
 * 이 패턴이 다른 지역까지 검증된 건 아니지만, 항목이 없는 지역은 그냥 null을 반환해
 * 아무 영향도 주지 않는다.
 */
function buildGoneMessengerBridgeOrigin(subdomain) {
  const goneUrl = GONE_URL_BY_SUBDOMAIN[subdomain];
  if (!goneUrl) return null;
  try {
    const host = new URL(goneUrl).hostname; // 예: gdp.goe.go.kr
    if (!host.startsWith('gdp.')) return null;
    return `https://gdp-accounts.${host.slice('gdp.'.length)}`;
  } catch {
    return null;
  }
}

/**
 * browserProfile이 없으면 PortalPet 전용 프로필(기본, 안전한 선택)을 새로 만든다.
 * browserProfile = { root, folder }가 있으면 그 브라우저 프로필(사용자가 이미 쓰던 것)을 그대로 켠다 -
 * 단, 그 프로필로 해당 브라우저가 이미 켜져 있으면 브라우저가 폴더를 잠그고 있어서 실행에 실패한다
 * (크로미움 프로필은 동시에 두 프로세스가 못 쓴다). 이 경우 사용자에게 그 브라우저를 먼저 끄라고 안내해야 한다.
 * browserChannel('chrome' | 'msedge')로 실제 실행할 설치된 브라우저를 고른다 - Playwright가
 * 둘 다 channel 옵션으로 그대로 지원한다(번들 Chromium이 아니라 설치된 실제 브라우저를 씀).
 */
async function getContext(browserProfile, subdomain, browserChannel = 'chrome') {
  const profileKey = browserProfile
    ? `${browserProfile.root}::${browserProfile.folder}`
    : `portalpet-dedicated::${browserChannel}`;
  // (수정) isNew를 같이 반환한다 - checkPortalDashboard가 "이번에 내가 방금 새로 띄운 브라우저인지"를
  // 알아야, 그 경우에만 창을 최소화해서(백그라운드 확인용 창이 화면에 계속 떠 있지 않도록) 사용자
  // 작업을 방해하지 않을 수 있다(사용자 요청: "일정/메신저 자동 실행을 껐는데도 업무포털 메인
  // 화면이 무조건 뜬다"). 이미 떠 있던 브라우저를 재사용하는 경우(isNew:false)는 사용자가 이미
  // 보고 있었을 수 있으니 건드리지 않는다.
  if (sharedContext && lastBrowserProfileKey === profileKey) return { context: sharedContext, isNew: false };

  if (sharedContext && lastBrowserProfileKey !== profileKey) {
    console.log('[PortalPet] browser profile/channel selection changed - closing previous browser...');
    await sharedContext.close().catch(() => {});
    sharedContext = null;
    sharedPage = null;
  }

  console.log('[PortalPet] launching browser context... profile:', profileKey, 'channel:', browserChannel);

  const userDataDir = browserProfile ? browserProfile.root : USER_DATA_DIR(browserChannel);
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    // "브라우저가 제대로 종료되지 않았습니다" 복원 경고창/말풍선을 아예 안 띄운다.
    // 실제 사용자 프로필이든 전용 프로필이든 파일을 건드리지 않고 안전하게 적용 가능.
    '--disable-session-crashed-bubble',
  ];
  if (browserProfile) {
    args.push(`--profile-directory=${browserProfile.folder}`);
  } else {
    disablePasswordManagerPrompt(browserChannel); // 전용 프로필일 때만 - 실제 프로필의 설정은 건드리지 않는다
  }

  // K-에듀파인 WXSClient / G-ONE Brity 메신저 확인창을 미리 허용해둔다. Preferences는
  // 크롬이 뜰 때 한 번만 읽으므로 반드시 launchPersistentContext 호출 전에 써야 한다.
  if (subdomain) {
    const profileFolder = browserProfile ? browserProfile.folder : 'Default';
    try {
      const edufineOrigin = new URL(buildEdufineUrl(subdomain)).origin;
      authorizeWxsClientForEdufine(userDataDir, profileFolder, edufineOrigin);
    } catch (e) {
      console.log('[PortalPet] WXSClient 허용 설정 준비 실패 (non-fatal):', e.message);
    }
    try {
      const messengerBridgeOrigin = buildGoneMessengerBridgeOrigin(subdomain);
      if (messengerBridgeOrigin) {
        authorizeBrityMessengerProtocol(userDataDir, profileFolder, messengerBridgeOrigin);
      }
    } catch (e) {
      console.log('[PortalPet] Brity 메신저 허용 설정 준비 실패 (non-fatal):', e.message);
    }
  }

  try {
    sharedContext = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: browserChannel, // 'chrome' | 'msedge' - 설치된 실제 브라우저를 사용. 없으면 Playwright 번들 Chromium으로 폴백 필요(TODO).
      viewport: null,
      args,
      // Playwright가 chrome/msedge 채널에 기본으로 붙이는 --no-sandbox 때문에 "지원되지 않는
      // 명령줄 플래그" 경고 배너가 떴다. 실제로 제거해도 되는 기본 인자라 무시 목록에 넣는다.
      ignoreDefaultArgs: ['--no-sandbox'],
    });
  } catch (err) {
    const browserLabel = browserChannel === 'msedge' ? '엣지' : '크롬';
    if (browserProfile) {
      throw new Error(
        `선택한 ${browserLabel} 프로필("${browserProfile.folder}")을 열 수 없습니다. 그 프로필로 ${browserLabel}가 이미 실행 중이면 ` +
        `먼저 ${browserLabel}를 완전히 종료한 뒤 다시 시도해 주세요. (원인: ${err.message})`
      );
    }
    throw new Error(
      `${browserLabel} 브라우저를 실행할 수 없습니다. 이 PC에 ${browserLabel}가 설치돼 있는지 확인해 주세요. (원인: ${err.message})`
    );
  }

  lastBrowserProfileKey = profileKey;
  // 사용자가 브라우저 창을 직접 닫으면 컨텍스트가 죽는다. 죽은 참조를 계속 쓰면
  // 다음 클릭이 조용히 실패하므로, 닫히는 즉시 캐시를 비워 다음 호출에서 새로 띄우게 한다.
  sharedContext.on('close', () => {
    console.log('[PortalPet] browser context closed by user; will relaunch next time.');
    sharedContext = null;
    sharedPage = null;
    mainServiceTabs.clear();
  });

  // (버그 수정 - 사용자 재현: K-에듀파인 "공람대기"에서 항목 선택 후 "일괄처리"를 눌러도
  // "선택하신 공람문서를 일괄처리하시겠습니까?" 같은 확인창이 뜨자마자 사라짐) Playwright가
  // CDP로 이 브라우저를 붙잡고 있는 동안은, 어떤 페이지든 'dialog' 리스너가 하나도 없으면
  // 그 페이지에서 뜨는 네이티브 confirm()/alert()/prompt() 창을 Playwright가 자동으로
  // 취소(dismiss)해버린다 - 우리가 뭘 클릭해서가 아니라 리스너 부재 자체가 원인이다. 이건
  // 사용자가 직접 마우스로 누른 화면에서도 똑같이 적용돼서, K-에듀파인 화면을 사용자가
  // 스스로 조작할 때도 확인창이 즉시 사라져버렸다. 컨텍스트의 모든 탭(현재 탭 + 앞으로 새로
  // 열리는 탭)에 아무 것도 안 하고 로그만 남기는 리스너를 붙여 이 자동 취소를 막는다 - 그러면
  // 창이 화면에 그대로 남아 사용자가 직접 확인/취소를 누를 수 있다. (closeNeisRequestPopup처럼
  // 우리가 의도적으로 자동 수락해야 하는 곳은 자체적으로 dialog.accept()를 부르는 리스너를
  // 따로 붙이므로 이 패시브 리스너와 충돌하지 않는다.)
  const attachDialogPassthrough = (p) => {
    p.on('dialog', (dialog) => {
      console.log(
        '[PortalPet] native dialog appeared (자동으로 처리하지 않음 - 사용자가 직접 확인/취소해야 함):',
        dialog.type(), dialog.message()
      );
    });
  };
  sharedContext.on('page', attachDialogPassthrough);
  sharedContext.pages().forEach(attachDialogPassthrough);

  return { context: sharedContext, isNew: true };
}

/**
 * checkPortalDashboard가 이번 호출에서 브라우저를 방금 새로 띄웠을 때만 그 창을 최소화한다.
 * (배경) launchPersistentContext는 headless:false라 브라우저 창이 실제로 화면에 뜨는데, 새로
 * 만들어진 최상위 창은 OS가 보통 포커스를 주면서 화면 앞으로 가져온다 - 우리가 bringToFront를
 * 안 불러도 "그냥 새로 뜬 창이라서" 사용자 눈에 보이게 된다(사용자 재현: 메신저/일정 자동 실행을
 * 꺼놨는데도 결재 현황 자동 확인 때문에 처음 뜨는 브라우저가 업무포털 메인 화면인 채로 눈에
 * 보임). 사용자가 명시적으로 누른 메뉴(launchService)는 여전히 끝에서 bringToFront로 보여주고,
 * 오직 백그라운드 전용인 checkPortalDashboard의 "방금 새로 띄운 경우"만 최소화해 방해하지 않는다.
 * Playwright에는 창을 최소화하는 API가 따로 없어 CDP(Browser.setWindowBounds)를 직접 호출한다.
 */
async function minimizeContextWindow(context, page) {
  try {
    const client = await context.newCDPSession(page);
    const { windowId } = await client.send('Browser.getWindowForTarget');
    await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await client.detach().catch(() => {});
    console.log('[PortalPet] 백그라운드 확인용으로 새로 띄운 브라우저 창을 최소화함');
  } catch (e) {
    console.log('[PortalPet] 브라우저 창 최소화 실패(non-fatal, 그냥 화면에 보이는 채로 진행):', e.message);
  }
}

/**
 * 아직 아무 것도 실행한 적 없을 때(또는 이전 탭이 닫혔을 때)만 탭을 재사용한다.
 * launchPersistentContext는 시작할 때 빈 탭을 하나 기본으로 만들어두므로, 우리가 또 새 탭을
 * 만들면 about:blank 탭이 하나 남는다 - 그 기존 탭을 먼저 재사용한다.
 */
async function getPage(context) {
  if (sharedPage && !sharedPage.isClosed()) {
    mainServiceTabs.add(sharedPage);
    return sharedPage;
  }
  const existing = context.pages().find((p) => !p.isClosed());
  const page = existing || (await context.newPage());
  sharedPage = page;
  mainServiceTabs.add(page);
  page.on('close', () => {
    mainServiceTabs.delete(page);
    if (sharedPage === page) sharedPage = null; // 그 사이 새 탭이 만들어졌으면 그건 건드리지 않음
  });
  await installPopupWatcher(page);
  return sharedPage;
}

/**
 * 지금 sharedPage가 나이스/K-에듀파인/G-ONE/포털 홈 중 어디에 가 있는지 판별한다. 판별이 안 되는
 * 화면(사용자가 직접 다른 사이트로 이동했거나 판별 실패)이면 null - 이 경우 호출 쪽에서 안전하게
 * "다른 시스템"으로 취급한다(새 탭을 여는 쪽으로).
 */
async function currentTabSystemGroup(page, subdomain) {
  if (await isOnSystem(page, 'neis', subdomain)) return 'neis';
  if (await isOnSystem(page, 'edufine', subdomain)) return 'edufine';
  if (await isOnSystem(page, 'gone', subdomain)) return 'gone';
  if (await isOnSystem(page, 'edmgr', subdomain)) return 'edmgr';
  try {
    if (currentHostname(page).endsWith('.eduptl.kr')) return 'portal_home';
  } catch { /* ignore */ }
  return null;
}

/**
 * (수정) 처음엔 "탭에 이미 뭔가 열려 있으면 무조건 새 탭"이었는데, 그러면 나이스 안에서 복무
 * 신청 -> 출장 신청처럼 "같은 시스템 안에서" 메뉴만 바꿀 때도 매번 새 탭이 열려서, 매번 포털
 * 홈부터 다시 로그인/이동하느라 느려지고 공지 팝업 닫기 타이밍도 꼬였다(사용자 재현 확인: 엣지
 * 에서 복무 신청 시 공지사항이 안 닫힘 - 원인은 매번 새 탭이 열려서 팝업이 뜨는 타이밍과
 * closeAnyPopups 호출 시점이 어긋난 것). 그래서 "업무포털 메인/나이스/K-에듀파인/G-ONE 이 네
 * 그룹 사이를 넘나들 때만" 새 탭을 열고, 같은 그룹 안에서의 메뉴 이동은 기존 탭을 그대로
 * 재사용하도록 바꿨다(사용자 요청).
 */
async function shouldOpenNewTabFor(serviceKey, subdomain) {
  if (!sharedPage || sharedPage.isClosed()) return false; // 첫 실행 - 그대로 사용
  let url;
  try { url = sharedPage.url(); } catch { return false; }
  if (!url || url === 'about:blank') return false; // 아직 아무 것도 안 띄운 탭

  const targetGroup = TAB_GROUP[serviceKey] || null;
  const currentGroup = await currentTabSystemGroup(sharedPage, subdomain);
  if (currentGroup === null || targetGroup === null) return true; // 판별 안 되면 안전하게 새 탭
  return currentGroup !== targetGroup;
}

/**
 * 이미 다른 화면이 열려서 사용 중일 때 새 메뉴를 누르면, 그 화면을 밀어내지 않고 새 탭을 열어
 * 그 안에서 실행한다(사용자 요청: "이미 실행되어 있는 중에는 새로운 탭으로 열도록"). 이전 탭은
 * 그대로 남겨두고(닫지 않음) 건드리지 않는다 - 이 새 탭이 다음 클릭까지 sharedPage가 된다.
 */
async function openFreshTab(context) {
  const page = await context.newPage();
  sharedPage = page;
  mainServiceTabs.add(page);
  page.on('close', () => {
    mainServiceTabs.delete(page);
    if (sharedPage === page) sharedPage = null;
  });
  await installPopupWatcher(page);
  console.log('[PortalPet] 기존 탭이 이미 사용 중 - 화면을 유지한 채 새 탭을 열어 실행');
  return page;
}

/**
 * 근무상황신청/출장신청 창이 지금 실제로 떠 있는지 즉시(타임아웃 없이) 확인한다. 별도 탭으로
 * 뜬 경우는 closeExtraPages 쪽에서 context.pages() 개수로 이미 판단하니, 여기서는 같은 탭
 * 안에 모달/서브윈도우로 떠 있는 경우만 DOM을 한 번 스캔해서 본다. page.evaluate 한 번이라
 * 없으면 거의 즉시(수 ms) false가 나온다 - 이걸로 불필요한 닫기 시도(수 초 낭비)를 건너뛴다.
 */
async function isNeisRequestPopupVisible(page) {
  return page.evaluate(() => {
    const isVisible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    // 실측 확인: 신청서 다이얼로그에는 항상 .cl-dialog-close(우측 상단 닫기)가 붙어 있다.
    // 이게 보이면 다른 판단 없이 바로 "열려 있음"으로 확정 - 가장 빠르고 정확한 신호.
    const hasCloseIcon = [...document.querySelectorAll('.cl-dialog-close')].some(isVisible);
    if (hasCloseIcon) return true;
    const keywords = ['근무상황', '출장신청', '신청서'];
    return [...document.querySelectorAll('*')].some((e) => {
      if (e.children.length > 3) return false; // 제목처럼 짧고 구체적인 요소만 본다
      const t = (e.textContent || '').trim();
      return t && keywords.some((k) => t.includes(k)) && isVisible(e);
    });
  }).catch(() => false);
}

/**
 * page.evaluate 안에서 target을 찾아 뷰포트 기준 중심 좌표를 반환하는 finderFnBody(문자열이
 * 아니라 브라우저 컨텍스트에서 실행될 함수)를 실행하고, 찾으면 Playwright의 실제 마우스
 * 이벤트(page.mouse.click)로 그 좌표를 클릭한다.
 *
 * (중요) 이 "cl-" 커스텀 UI 프레임워크는 element.click()으로 쏘는 합성 클릭 이벤트에 반응하지
 * 않는 것으로 보인다(실측: X버튼/"닫기" 버튼 둘 다 evaluate 안에서 .click()을 호출했는데도
 * 다이얼로그가 안 닫힘) - mousedown/mouseup 같은 실제 포인터 이벤트 시퀀스만 듣고 있을
 * 가능성이 높다. 그래서 요소를 evaluate로 "찾기"만 하고, 실제 클릭은 Playwright가 OS 수준
 * 입력으로 내보내는 page.mouse.click()으로 수행하도록 분리했다.
 */
async function findAndMouseClick(page, findElementFn, arg) {
  const rect = await page.evaluate(findElementFn, arg).catch(() => null);
  if (!rect) return false;
  await page.mouse.move(rect.x, rect.y).catch(() => {});
  await page.mouse.click(rect.x, rect.y).catch(() => {});
  return true;
}

/**
 * 창 우측 상단의 "X" 닫기 아이콘을 찾아 클릭한다. 정확한 선택자를 실측하지 못해 흔한 패턴
 * (class/aria-label/title에 close 계열 키워드, 또는 텍스트가 정확히 × 기호인 작은 아이콘)을
 * 후보로 모아 화면 우측 상단에 가장 가까운 것을 고른다. page.evaluate로 위치만 찾고, 실제
 * 클릭은 findAndMouseClick이 진짜 마우스 이벤트로 수행한다.
 */
async function tryCloseByXButton(page) {
  const clicked = await findAndMouseClick(page, () => {
    const isVisible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    // 실제 확인된 마크업(근무상황신청 다이얼로그):
    // <div class="cl-dialog-close" role="button" aria-label="닫기" tabindex="0"></div>
    // 이 정확한 선택자를 최우선으로 시도하고, 못 찾으면 일반 휴리스틱으로 폴백한다.
    const exact = [...document.querySelectorAll('.cl-dialog-close[role="button"], .cl-dialog-close')]
      .filter(isVisible);
    let target = exact[0];
    if (!target) {
      const bySelector = [...document.querySelectorAll(
        '[class*="close" i],[aria-label*="닫기"],[title*="닫기"],[aria-label*="close" i],[title*="close" i],.cl-window-closebutton,.win-close,.modal-close,.cl-closebutton'
      )].filter(isVisible);
      const byText = [...document.querySelectorAll('button,a,span,div,i')]
        .filter((e) => isVisible(e) && e.children.length === 0 && ['×', 'X', 'x', '✕'].includes((e.textContent || '').trim()));
      const candidates = [...bySelector, ...byText];
      if (!candidates.length) return null;
      // 뷰포트 우측 끝까지 거리 + 위쪽 거리가 가장 작은(=우측 상단에 가장 가까운) 후보를 고른다.
      candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
        return (ra.top + (window.innerWidth - ra.right)) - (rb.top + (window.innerWidth - rb.right));
      });
      target = candidates[0].closest('button,a,[role="button"]') || candidates[0];
    }
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (clicked) console.log('[PortalPet] clicked X close button via real mouse click (cl-dialog-close 우선 / 휴리스틱 폴백)');
  return clicked;
}

/**
 * 다이얼로그 하단의 "닫기" 버튼(예: btn-outline-secondary cl-button, aria-label 없음, 텍스트만
 * "닫기")을 찾아 클릭한다. Playwright의 clickText(getByText)는 페이지 어딘가에 화면에 안 보이는
 * 다른 "닫기" 텍스트 요소가 DOM상 먼저 있으면 그걸 먼저 집어버려 실패할 수 있다(실측 확인) -
 * 그래서 X버튼과 같은 방식으로 위치만 evaluate로 찾고, 실제 클릭은 진짜 마우스 이벤트로 한다.
 */
async function tryClickCloseButtonByText(page) {
  const clicked = await findAndMouseClick(page, () => {
    const isVisible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const buttons = [...document.querySelectorAll('[role="button"]')].filter((e) => {
      if (!isVisible(e)) return false;
      return (e.textContent || '').trim() === '닫기';
    });
    if (!buttons.length) return null;
    // 다이얼로그 푸터는 보통 화면 아래쪽에 있으니, 더 아래에 있는 버튼을 우선한다.
    buttons.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    const r = buttons[0].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (clicked) console.log('[PortalPet] clicked "닫기" button via real mouse click (role=button 텍스트 정확 매칭)');
  return clicked;
}

/**
 * 근무상황신청/출장신청 같은 신청서 작성 창은 그냥 탭을 강제로 닫아버리면(page.close())
 * "변경사항을 저장하지 않고 닫으시겠습니까?" 류의 확인창에 걸려 제대로 안 닫히거나 오류가
 * 날 수 있다. 우측 상단 X 버튼 -> 하단 "닫기" 버튼 -> Escape 순으로 시도하고, 닫힌 뒤
 * 저장 여부를 묻는 확인창이 뜨면 "확인"까지 눌러 완전히 닫는다. confirm() 같은 크롬 네이티브
 * JS 다이얼로그가 뜨는 경우도 있어 그 순간만 자동으로 수락하도록 리스너를 잠깐 붙인다.
 */
async function closeNeisRequestPopup(page) {
  const onDialog = async (dialog) => {
    console.log('[PortalPet] 신청서 창 닫기 중 뜬 대화상자 자동 확인:', dialog.message());
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', onDialog);
  try {
    // 우선순위: ① 우측 상단 X 버튼 -> ② 하단 "닫기" 버튼 -> ③ Escape -> ④ (Escape 후에도
    // 남아있을 수 있으니) "닫기" 버튼 재시도. "확인"은 저장 여부를 묻는 후속 확인창에서만
    // 쓰는 마지막 수단이지, 다이얼로그 자체를 닫는 버튼이 아니다 - 먼저 찾아버리면 안 된다.
    let closed = await tryCloseByXButton(page);
    if (!closed) {
      closed = await tryClickCloseButtonByText(page);
    }
    if (!closed) {
      console.log('[PortalPet] X 버튼/"닫기" 버튼 모두 못 찾음 - Escape 후 "닫기" 재시도');
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
      closed = await tryCloseByXButton(page);
      if (!closed) {
        closed = await tryClickCloseButtonByText(page);
      }
    }
    // 닫힌 뒤(또는 마지막 시도로) 저장 여부를 묻는 확인창이 뜰 수 있어 "확인"까지 눌러 완전히
    // 닫는다 - 이건 다이얼로그를 닫는 버튼이 아니라 그 후속 확인창 전용이라 항상 마지막에만 시도.
    await page.waitForTimeout(250);
    await clickText(page, '확인', { timeout: 600 });
    await page.waitForTimeout(250);
  } catch (e) {
    console.log('[PortalPet] 신청서 창 닫기 절차 중 오류(non-fatal):', e.message);
  } finally {
    page.off('dialog', onDialog);
  }
}

/**
 * 나이스의 "신청" 버튼 등은 새 창/탭으로 신청서 작성 폼을 띄우는 경우가 있다(실측 확인: 근무상황
 * 신청을 띄운 채로 출장신청을 누르니 그 창이 남아 있어서 다음 메뉴 이동 자체가 막힘). 그 창을
 * 그대로 두면 화면을 가리거나 포커스를 뺏어서 다음 자동화 단계가 실패한다. 다음 버튼 클릭마다
 * 우리가 계속 재사용하는 탭(keepPage) 말고 남아있는 다른 탭/창은 전부 정리한다 - 어차피
 * 저장하지 않은 신청서 초안이라 실행 취소해도 문제없다(사용자가 직접 제출 버튼은 안 눌렀을
 * 상태이므로 데이터 손실 없음). 강제로 닫기 전에 위의 ESC+확인 절차를 먼저 시도한다.
 */
async function closeExtraPages(context, keepPage) {
  for (const p of context.pages()) {
    if (p === keepPage || p.isClosed()) continue;
    // (수정) 이제 사용자가 다른 메뉴를 눌러 의도적으로 새 탭을 열어둘 수 있다(openFreshTab) -
    // mainServiceTabs에 있는 탭은 leftover 팝업이 아니라 "다른 메뉴가 열어둔 정상 화면"이므로
    // 자동으로 닫지 않는다. 여기서 정리 대상은 그 목록에 없는, 진짜 leftover 팝업/서브윈도우뿐이다.
    if (mainServiceTabs.has(p)) continue;
    console.log('[PortalPet] closing leftover page:', p.url());
    await closeNeisRequestPopup(p).catch(() => {});
    if (!p.isClosed()) {
      await p.close().catch((e) => console.log('[PortalPet] closing leftover page failed (non-fatal):', e.message));
    }
  }
}

/**
 * "교육행정 전자서명 인증서 로그인" 버튼(#btnLgn, 로그인 필요), 인증서 비밀번호 입력창
 * (input[name="certPassword"], 이미 모달이 떠 있음), 포털 홈 메뉴(a.menuBtn, 이미 로그인
 * 완료돼 메뉴까지 보임) 셋 중 뭐가 먼저 나타나는지 "경쟁"시킨다. 셋 다 같은 timeout을 걸고
 * Promise.race로 묶으면, 실제로 먼저 나타나는 신호가 있는 즉시(다른 것들의 자체 타임아웃을
 * 기다리지 않고) 바로 반환된다 - 셋 다 안 나타나면(드묾) null.
 */
async function raceLoginSignals(page, timeout) {
  try {
    return await Promise.race([
      page.locator('#btnLgn').waitFor({ state: 'visible', timeout }).then(() => 'login-btn'),
      page.locator('input[name="certPassword"]').waitFor({ state: 'visible', timeout }).then(() => 'cert-modal'),
      page.locator('a.menuBtn').first().waitFor({ state: 'visible', timeout }).then(() => 'portal-home'),
    ]);
  } catch {
    return null;
  }
}

/**
 * 인증서 암호 입력이 필요한 상태인지 확인하고, 필요하면 자동 입력한다.
 * 이미 로그인돼 있으면(모달이 없으면) 그냥 통과한다.
 */
async function completeCertLoginIfNeeded(page, password) {
  // (버그 수정) 예전엔 "#btnLgn이 보이는지"(최대 5초)와 "certPassword가 보이는지"(최대 15초)를
  // 순서대로 각각 끝까지 기다렸다 - 이미 로그인된 세션(인증서 모달 자체가 안 뜨는 경우)에서도
  // 매번 이 두 대기를 합쳐 최대 20초를 그냥 허비하고 있었다(사용자가 배포판에서 재현: "복무
  // 신청"으로 나이스 넘어가는 게 느림 - 콘솔 로그로 확인: certPassword 15초 타임아웃이 매번
  // 그대로 찍힘). 이미 로그인돼 포털 홈 메뉴(a.menuBtn)가 바로 보이는 경우를 "로그인 버튼
  // 등장"/"모달 등장"과 함께 경쟁시켜서, 셋 중 뭐든 먼저 나타나는 즉시 판정한다 - 이미 로그인된
  // 경우 메뉴가 거의 바로 보이므로 대기가 사실상 없어진다.
  const signal = await raceLoginSignals(page, 15000);
  console.log('[PortalPet] 로그인 상태 판별 신호:', signal, '| url:', page.url());

  if (signal === 'portal-home' || signal === null) {
    // 이미 로그인돼 메뉴가 보이거나, 셋 다 못 잡았으면(판단 불가) 로그인 절차 없이 통과 -
    // 예전에도 "모달 못 찾음 = 이미 로그인 또는 필요 없음"으로 동일하게 처리했다.
    console.log('[PortalPet] 로그인 절차 불필요로 판단');
    return { loggedIn: 'already-or-not-required' };
  }

  if (signal === 'login-btn') {
    console.log('[PortalPet] clicking #btnLgn (교육행정 전자서명 인증서 로그인)...');
    await page.locator('#btnLgn').click().catch((e) => console.log('[PortalPet] #btnLgn 클릭 실패(non-fatal):', e.message));
  }
  // signal === 'cert-modal'이면 이미 모달이 떠 있으니 버튼 클릭 없이 바로 아래로 진행.

  console.log('[PortalPet] waiting for certPassword field... current url:', page.url());
  const passwordField = page.locator('input[name="certPassword"]');
  const appeared = await passwordField.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch((e) => {
    console.log('[PortalPet] certPassword field did not appear within timeout:', e.message);
    return false;
  });

  if (!appeared) {
    console.log('[PortalPet] no cert modal found - page title:', await page.title().catch(() => '?'), 'url:', page.url());
    return { loggedIn: 'already-or-not-required' };
  }

  if (certUserNameToSelect) {
    // (신규, 사용자 요청: "인증서가 여러 개인 경우 사용자 이름으로 구분") 이 PC에 인증서가
    // 여러 개 등록돼 있으면 목록 중 어떤 게 기본 선택돼 있을지 보장이 안 돼 엉뚱한 인증서로
    // 로그인 시도할 위험이 있다 - 설정에 저장된 사용자 이름이 적힌 행을 먼저 찾아 클릭해
    // 그 인증서를 선택한다. 정확한 목록 마크업은 몰라도 clickText(텍스트 기반 클릭)로 충분하고,
    // 인증서가 하나뿐이면 못 찾아도(또는 이미 선택돼 있어도) 무해하므로 실패는 무시한다.
    await clickText(page, certUserNameToSelect, { exact: false, timeout: 3000 });
  }

  if (!password) {
    // "자동 로그인"을 꺼뒀거나(수동 입력 원함) 저장된 비밀번호가 없는 경우 - 자동으로 채워 넣지
    // 않고, 사용자가 직접 인증서 창에 비밀번호를 입력하고 "확인"을 누를 때까지 기다린다.
    // 사람이 직접 타이핑하는 시간이 필요하므로 훨씬 넉넉한 타임아웃을 주고, 창을 앞으로
    // 가져와서 입력이 필요하다는 걸 바로 알아챌 수 있게 한다.
    console.log('[PortalPet] 자동 로그인 꺼짐(또는 비밀번호 미저장) - 사용자의 수동 입력 대기 중...');
    await page.bringToFront().catch(() => {});
    const closed = await passwordField.waitFor({ state: 'hidden', timeout: 120000 }).then(() => true).catch(() => false);
    console.log('[PortalPet] modal closed (수동 입력):', closed);
    return { loggedIn: closed };
  }

  console.log('[PortalPet] cert modal found, typing password...');
  await passwordField.click();
  await passwordField.type(password, { delay: 40 }); // 실제 keydown 이벤트 발생시켜 보안스크립트 호환

  // 같은 클래스의 "확인" 버튼이 페이지에 여러 개 있어서 .last()가 숨겨진 걸 집을 수 있다.
  // :visible로 실제 화면에 보이는 버튼만 골라낸다.
  const confirmBtn = page.locator('button.kc-btn-blue:has-text("확인"):visible').first();
  await confirmBtn.click();
  console.log('[PortalPet] clicked 확인, waiting for modal to close...');

  // 로그인 성공/실패 판정은 아직 TODO: 에러 메시지 셀렉터를 확인 못 함.
  // 일단 모달(certPassword 입력창)이 사라지는지로 성공 여부를 추정한다.
  const closed = await passwordField.waitFor({ state: 'hidden', timeout: 8000 }).then(() => true).catch(() => false);
  console.log('[PortalPet] modal closed:', closed);
  return { loggedIn: closed };
}

/**
 * 화면에 보이는 텍스트를 가진 요소를 찾아 클릭한다 (실패해도 던지지 않고 false 반환).
 * Nexacro/웹DRM 화면은 CSS 선택자가 불안정하거나 아예 확인이 안 되는 경우가 많아서,
 * OneClickPortal(zeroboom92/OneClickPortal) 참고 - 눈에 보이는 한글 라벨 텍스트로 찾는 방식을 쓴다.
 */
/**
 * exact:false(기본)면 부분 일치라서 "신청" 같은 짧은 라벨은 "권한 신청" 등 다른 곳의 텍스트를
 * 먼저 집어버릴 수 있다(실측 확인). 그런 경우 exact:true로 정확히 그 텍스트뿐인 요소만 찾는다.
 */
async function clickText(page, text, { timeout = 6000, exact = false } = {}) {
  try {
    const el = page.getByText(text, { exact }).first();
    await el.waitFor({ state: 'visible', timeout });
    // (버그 수정) el.click()에 timeout을 안 넘기면 Playwright 기본값(30초)이 적용된다 - 요소가
    // DOM상 "visible"이어도(waitFor는 통과) 다른 무언가(예: 늦게 뜬 공지 팝업)에 가려 실제
    // 클릭 가능(actionable) 상태가 아니면 30초를 꽉 채워 기다리다 "Timeout 30000ms exceeded"로
    // 실패한다(사용자 재현: 배포판에서 나이스 복무 신청 진입이 느려지고 공지사항도 안 닫힘 -
    // 콘솔 로그로 이 정확한 오류 확인). waitFor와 같은 timeout을 줘서 막혀 있으면 훨씬 빨리
    // 포기하고 위쪽 재시도/복구 로직(popup 닫기 재시도 등)으로 넘어가게 한다.
    await el.click({ timeout });
    console.log(`[PortalPet] clicked text "${text}" (exact:${exact})`);
    return true;
  } catch (e) {
    console.log(`[PortalPet] could not click text "${text}" (exact:${exact}):`, e.message);
    return false;
  }
}

/** candidates를 순서대로 시도해서 처음 성공하는 텍스트를 클릭한다 (새 탭 추적이 필요 없는 일반적인 경우). */
async function clickFirstMatch(page, candidates, opts) {
  for (const c of candidates) {
    const ok = await clickText(page, c, opts);
    if (ok) return true;
  }
  return false;
}

// 팝업마다 "다시 보지 않기" 체크박스 문구와 닫기 버튼 문구가 다르다(실측 확인: 포털 홈은
// "1주일동안 열지 않기" + "닫기", G-ONE은 "오늘 하루 보지 않기" + "확인", 나이스 공지사항은
// "오늘 하루 창 열지 않음" / "일주일 창 열지 않음" + "닫기", K-에듀파인(Nexacro)은 "오늘 하루
// 이창을 열지 않음" / "일주일동안 열지 않음" + "확인"/"닫기"). 후보를 순서대로 시도한다.
const POPUP_SKIP_CHECKBOX_CANDIDATES = [
  '1주일동안 열지 않기', '오늘 하루 보지 않기', '오늘 하루 이상 열지 않기', '오늘 하루 열지 않기',
  '오늘 하루 창 열지 않음', '일주일 창 열지 않음',
  '오늘 하루 이창을 열지 않음', '일주일동안 열지 않음',
];
// (수정) POPUP_CLOSE_BUTTON_CANDIDATES(페이지 전체에서 "닫기"/"확인" 텍스트를 찾아 닫던 목록
// 화면용 안전망)는 closeAnyPopupsCore에서 실제 결재 목록의 정상 버튼을 잘못 클릭하는 사고가
// 재현돼 제거했다 - 아래 findTopmostDialogCloseButtonInPage 설명 참고.

/**
 * 로그인 직후 포털 홈이나 G-ONE 등에 공지 팝업이 뜨는 경우가 있다(실측 확인).
 * 방치하면 화면을 가려서 이후 메뉴 클릭(기안/품의 등)이 막힐 수 있어 자동으로 닫는다.
 * 닫기 전에 "다시 보지 않기"류 체크박스를 먼저 체크해서, 같은 공지가 한동안 다시 뜨지
 * 않게 한다(체크박스가 없는 팝업이면 그냥 넘어가고 닫기만 한다).
 * 팝업이 여러 개 겹쳐 뜨는 경우도 있어 닫기 버튼이 더는 안 보일 때까지 반복 시도한다.
 * 못 찾아도(팝업이 없는 정상 상황) 그냥 조용히 넘어간다.
 *
 * (성능 수정) 예전 버전은 Playwright locator.waitFor()를 후보 문구 개수만큼(체크박스 4개 +
 * 닫기버튼 2개) 순차적으로 돌려서, 팝업이 아예 없는 흔한 경우에도 매번 몇 초씩 그냥 날아갔다
 * (버튼 자체는 DOM에 항상 있고 hidden 상태라 매번 타임아웃까지 기다려야 했음). 이제 한 번의
 * page.evaluate()로 DOM을 즉시 스캔해서 실제로 "보이는" 팝업이 있을 때만 클릭하므로,
 * 팝업이 없으면 거의 즉시(수 ms) 끝난다.
 */
// page.evaluate로 브라우저에 보내지는 함수라 바깥(Node.js) 스코프의 함수/변수를 참조할 수
// 없다 - 그래서 findAndMouseClick에 넘길 때마다 이 로직을 그대로 문자열처럼 통째로 넘긴다
// (evaluate(fn, arg) 형태로 arg만 별도 전달, fn 안에서 필요한 건 전부 자체 완결적으로 정의).
function findVisibleLeafCenterInPage({ candidates, closestSelector }) {
  const isVisible = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  // (버그 수정) 인증서 로그인 화면(#btnLgn/certPassword)이 실제로 보이는 상태면 절대 아무 것도
  // 건드리지 않는다 - completeCertLoginIfNeeded가 그 화면을 전담해서 처리 중이며, 여기서
  // "확인" 텍스트만 보고 로그인 모달의 확인 버튼을 팝업 닫기로 오인해 클릭하면(실측 확인:
  // 비밀번호 타이핑 도중에 이 로직이 끼어들어 로그인 제출을 오염시킴) 로그인이 깨지고 심하면
  // 사이트 자체의 반복 시도 제한(보안 잠금)까지 유발할 수 있다.
  if (isVisible(document.querySelector('#btnLgn')) || isVisible(document.querySelector('input[name="certPassword"]'))) {
    return null;
  }
  // (버그 수정) 근무상황신청/출장신청/기안문 작성 같은 실제 업무 화면의 버튼("확인"/"닫기" 등)도
  // 이 텍스트 매칭에 그대로 걸린다(실측 확인) - 그 요소가 다이얼로그/폼 안에 있고 그 안에 실제
  // 입력 요소(input/select/textarea)가 있으면 공지 팝업이 아니라 작업 중인 화면으로 보고
  // 건드리지 않는다(다이얼로그/폼에 안 속한 요소는 기존대로 그대로 둔다).
  // (버그 수정 2) 이 규칙이 너무 넓어서 실제 공지 팝업까지 안 닫히는 역효과가 났다(사용자
  // 재현: 나이스 복무 신청 진입 시 공지 팝업이 안 닫혀 실패) - "cl-" 컴포넌트는 화면에 안
  // 보이는 입력 요소(숨겨진 검색창/선택창 등)를 템플릿에 같이 들고 있는 경우가 흔해서, DOM에
  // 있기만 하면 무조건 "업무 화면"으로 오판했던 것. 실제로 화면에 "보이는" 입력 요소가 있을
  // 때만 업무 화면으로 판단하도록 좁힌다.
  // (버그 수정 3) 공지사항 팝업 자체도 내용을 보여주는 스크롤 가능한 textarea(readonly)를 쓰고
  // 있어서(실측 확인: 스크린샷으로 확인된 "전달사항내용조회" 팝업의 "내용" 칸이 readonly
  // textarea) 바로 위 수정으로도 여전히 공지 팝업을 업무 화면으로 오판했다 - 읽기 전용/비활성
  // 입력 요소는 사용자가 실제로 입력하는 게 아니라 내용을 보여주기만 하는 것이므로 제외한다.
  const hasFormInputs = (el) => [...el.querySelectorAll(
    'input:not([type="checkbox"]):not([readonly]):not([disabled]), select:not([disabled]), textarea:not([readonly]):not([disabled])'
  )].some(isVisible);
  // (버그 수정 4) 실측 확인: 결재(승인) 화면처럼 "확인"/"닫기" 텍스트를 가진, 팝업이 아니라
  // 항상 떠 있는 정상 버튼이 있으면 이 함수가 매번 그 버튼을 다시 찾아내 무한히 반복 클릭했다
  // ("closed a popup" 로그가 수백 번 연속 - 실제 결재/승인 화면의 버튼을 계속 눌러버릴 수
  // 있는 위험한 상황). 한 번 클릭 시도한 노드에는 표식을 남겨 같은 노드를 다시는 클릭하지
  // 않는다 - 진짜 팝업이면 클릭 후 사라지므로 표식이 남을 일이 없고, 팝업이 아닌 상시 버튼이면
  // 표식 덕분에 더는 안 건드린다.
  const TRIED_ATTR = 'data-pp-tried';
  for (const text of candidates) {
    const xs = [...document.querySelectorAll('*')]
      .filter((e) => (e.textContent || '').trim() === text && isVisible(e) && !e.hasAttribute(TRIED_ATTR))
      .sort((a, b) => a.children.length - b.children.length);
    if (xs.length) {
      const target = xs[0].closest(closestSelector) || xs[0];
      const container = target.closest('.cl-dialog, [role="dialog"], form');
      if (container && hasFormInputs(container)) continue;
      target.setAttribute(TRIED_ATTR, '1');
      const r = target.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
}

/**
 * 포털 홈/나이스/G-ONE 등에서 뜨는 공지·안내 팝업을 닫는다. (수정) 예전엔 page.evaluate 안에서
 * 합성 .click()을 바로 호출했는데, "cl-" 커스텀 UI는 합성 클릭에 반응 안 하는 경우가 있다고
 * 실측 확인됨(신청서 X버튼/닫기 버튼과 동일한 문제) - 나이스 공지 팝업도 같은 프레임워크라
 * findAndMouseClick으로 진짜 마우스 클릭을 쏘도록 통일했다.
 * (주의) findAndMouseClick에 넘기는 함수는 page.evaluate로 직렬화돼 브라우저에서 실행되므로,
 * findVisibleLeafCenterInPage처럼 함수 "전체"를 그대로 넘겨야 한다 - 화살표 함수로 감싸서
 * Node쪽 함수를 "참조"만 하면 브라우저에는 그 함수가 없어 아무 것도 못 찾는다.
 */
// page.evaluate로 브라우저에 보내지는 함수라 자체 완결적으로 정의한다(위 findVisibleLeafCenterInPage와 동일한 이유).
//
// (실측 확인) 나이스는 진입 시 "공지사항" .cl-dialog가 여러 개 겹쳐서 뜰 수 있다(예: 시스템
// 점검 안내 + 공모전 안내가 동시에). 이전 로직은 페이지 전체에서 텍스트("닫기")가 일치하는
// "첫 번째" 요소의 좌표를 계산해 클릭했는데, 뒤에 깔린 다이얼로그의 버튼 좌표를 계산해도
// 실제 그 좌표엔 "위에 겹쳐 있는" 다른 다이얼로그가 있어서(포인터 이벤트는 항상 그 좌표의
// 맨 위 요소로 감) 클릭이 아무 데도 안 먹히는 것처럼 보이는 문제가 있었다 - 그래서 진행이
// "멈춘" 것처럼 보였음. 이를 피하기 위해 매번 화면에서 "가장 위(z-index가 가장 큰)"
// 다이얼로그 단 하나만 고르고, 그 다이얼로그 "안"에서만 닫기 버튼을 찾는다(다른 다이얼로그의
// 동일 텍스트 버튼을 잘못 집지 않도록 querySelector의 검색 범위 자체를 좁힌다). 우선순위는
// 헤더의 X 아이콘(.cl-dialog-close, 텍스트 없이 항상 존재)을 먼저 쓰고, 없으면 하단의
// "닫기"/"확인" 텍스트 버튼을 쓴다.
/**
 * (신규, 사용자 제공 나이스 "웹접근성 사용법 및 단축키" 안내) findTopmostDialogCloseButtonInPage
 * 와 완전히 동일한 안전 조건(인증서 로그인 화면이 아님, 맨 위 다이얼로그가 실제 입력 요소를
 * 가진 업무 화면이 아님)만 재확인하고, 실제로 닫을 버튼은 찾지 않는다 - closeAnyPopupsCore가
 * Esc 키를 눌러도 되는 상황인지, 그리고 Esc를 누른 뒤 다이얼로그가 실제로 사라졌는지를
 * 판단하는 용도로 쓴다.
 */
function isTopmostClosableDialogPresentInPage() {
  const isVisible = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  if (isVisible(document.querySelector('#btnLgn')) || isVisible(document.querySelector('input[name="certPassword"]'))) {
    return false;
  }
  const dialogs = [...document.querySelectorAll('.cl-dialog, [role="dialog"]')].filter(isVisible);
  if (!dialogs.length) return false;

  // (버그 수정, 사용자 재현: "공지 창을 닫는 기능이 작동하지 않는다") "윈도우창을 닫으시겠습니까?"
  // 같은 확인 다이얼로그(aria-modal="true")는 자기 자신에 z-index 인라인 스타일을 안 붙이는
  // 경우가 있어(실측 확인), 그 뒤에 있는 공지 팝업이 명시적 z-index:1을 갖고 있으면 z-index만
  // 비교했을 때 오히려 공지 팝업이 "가장 위"로 잘못 뽑힌다 - 실제로는 확인 다이얼로그가 화면
  // 맨 위에 떠서 다른 모든 조작을 막고 있는데도 그 밑의 이미 닫기 시도가 끝난(TRIED_ATTR)
  // 공지 팝업만 계속 다시 보게 되어 영원히 안 닫히는 것처럼 보였다. aria-modal="true"인
  // 다이얼로그가 있으면 그게 진짜로 화면을 막고 있는 것이므로 z-index와 무관하게 최우선한다.
  const modalDialogs = dialogs.filter((d) => d.getAttribute('aria-modal') === 'true');
  const candidates = modalDialogs.length ? modalDialogs : dialogs;

  const zIndexOf = (e) => {
    const z = parseInt(getComputedStyle(e).zIndex, 10);
    return Number.isFinite(z) ? z : 0;
  };
  let topDialog = candidates[0];
  let topZ = zIndexOf(topDialog);
  for (let i = 1; i < candidates.length; i++) {
    const z = zIndexOf(candidates[i]);
    if (z >= topZ) { topDialog = candidates[i]; topZ = z; }
  }

  const hasFormInputs = (el) => [...el.querySelectorAll(
    'input:not([type="checkbox"]):not([readonly]):not([disabled]), select:not([disabled]), textarea:not([readonly]):not([disabled])'
  )].some(isVisible);
  return !hasFormInputs(topDialog);
}

function findTopmostDialogCloseButtonInPage() {
  const isVisible = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  // (버그 수정) 인증서 로그인 모달도 role="dialog" 래퍼를 쓰는 경우가 있어(실측: 비밀번호
  // 타이핑 도중 이 함수가 그 모달을 "가장 위 다이얼로그"로 집어 안의 확인 버튼을 클릭해버림)
  // completeCertLoginIfNeeded가 처리 중인 로그인 화면이면 여기서 완전히 손을 뗀다.
  if (isVisible(document.querySelector('#btnLgn')) || isVisible(document.querySelector('input[name="certPassword"]'))) {
    return null;
  }
  const dialogs = [...document.querySelectorAll('.cl-dialog, [role="dialog"]')].filter(isVisible);
  if (!dialogs.length) return null;

  // (버그 수정, 사용자 재현: "공지 창을 닫는 기능이 작동하지 않는다") isTopmostClosableDialogPresentInPage
  // 와 동일한 이유 - "윈도우창을 닫으시겠습니까?" 확인창(aria-modal="true")은 z-index 인라인
  // 스타일이 없어서, 명시적 z-index:1을 가진 그 밑의 공지 팝업이 z-index 비교에서 잘못
  // "가장 위"로 뽑혀 이미 닫기 시도가 끝난(TRIED_ATTR) 그 팝업만 계속 다시 보게 되고, 정작
  // 화면을 막고 있는 확인창의 "확인" 버튼은 영영 못 찾았다. aria-modal="true" 다이얼로그가
  // 있으면 z-index와 무관하게 그것부터 본다.
  const modalDialogs = dialogs.filter((d) => d.getAttribute('aria-modal') === 'true');
  const candidates = modalDialogs.length ? modalDialogs : dialogs;

  const zIndexOf = (e) => {
    const z = parseInt(getComputedStyle(e).zIndex, 10);
    return Number.isFinite(z) ? z : 0;
  };
  let topDialog = candidates[0];
  let topZ = zIndexOf(topDialog);
  for (let i = 1; i < candidates.length; i++) {
    const z = zIndexOf(candidates[i]);
    // z-index가 더 크거나 같으면(동률이면 DOM상 나중에 뜬 쪽을 더 위로 취급) 갱신한다.
    if (z >= topZ) { topDialog = candidates[i]; topZ = z; }
  }

  // (버그 수정) 근무상황신청/출장신청/기안문 작성 같은 실제 업무 화면도 같은 "cl-dialog"/
  // role="dialog" 래퍼를 쓴다(실측 확인: "신청" 버튼으로 막 연 신청서 창이 이 함수에 "가장 위
  // 다이얼로그"로 잡혀 곧바로 닫혀버림). 순수 안내 팝업은 텍스트/체크박스뿐이라 입력 요소가
  // 없지만, 실제 업무 화면은 반드시 input/select/textarea 같은 입력 요소를 포함하므로 이를
  // 기준으로 구분한다 - 입력 요소가 있으면 절대 자동으로 닫지 않는다.
  // (버그 수정 2) DOM에 존재하기만 해도(화면에 안 보이는 숨겨진 입력 요소 포함) "업무 화면"으로
  // 오판해 실제 공지 팝업까지 못 닫는 역효과가 있었다(사용자 재현: 나이스 복무 신청 진입 시
  // 공지 팝업 안 닫힘) - 실제로 화면에 "보이는" 입력 요소가 있을 때만 업무 화면으로 판단한다.
  // (버그 수정 3) 공지사항 팝업 자체도 내용을 보여주는 스크롤 가능한 textarea(readonly)를 쓰고
  // 있어서(실측 확인: 스크린샷으로 확인된 "전달사항내용조회" 팝업의 "내용" 칸이 readonly
  // textarea) 바로 위 수정으로도 여전히 공지 팝업을 업무 화면으로 오판했다 - 읽기 전용/비활성
  // 입력 요소는 사용자가 실제로 입력하는 게 아니라 내용을 보여주기만 하는 것이므로 제외한다.
  const hasFormInputs = (el) => [...el.querySelectorAll(
    'input:not([type="checkbox"]):not([readonly]):not([disabled]), select:not([disabled]), textarea:not([readonly]):not([disabled])'
  )].some(isVisible);
  if (hasFormInputs(topDialog)) return null;

  // (버그 수정 4) 같은 다이얼로그의 닫기 아이콘/버튼을 계속 다시 찾아 무한 반복 클릭하는 것을
  // 막기 위해, 한 번 클릭 시도한 노드에는 표식을 남기고 다음부터는 건너뛴다(진짜 팝업이면
  // 클릭 후 사라지므로 표식이 남을 일이 없다).
  const TRIED_ATTR = 'data-pp-tried';

  const closeIcon = topDialog.querySelector('.cl-dialog-close');
  if (closeIcon && isVisible(closeIcon) && !closeIcon.hasAttribute(TRIED_ATTR)) {
    closeIcon.setAttribute(TRIED_ATTR, '1');
    const r = closeIcon.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  const texts = ['닫기', '확인'];
  const closeButtonCandidates = [...topDialog.querySelectorAll('*')]
    .filter((e) => isVisible(e) && texts.includes((e.textContent || '').trim()) && !e.hasAttribute(TRIED_ATTR))
    .sort((a, b) => a.children.length - b.children.length);
  const leaf = closeButtonCandidates[0];
  if (!leaf) return null;
  const target = leaf.closest('button,a,[role="button"]') || leaf;
  target.setAttribute(TRIED_ATTR, '1');
  const r = target.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * K-에듀파인은 나이스/G-ONE의 "cl-" 프레임워크가 아니라 Nexacro라는 완전히 다른 UI 프레임워크를
 * 쓴다(사용자가 실제 DOM을 직접 확인해줌 - 실측 확인). 공지사항 팝업은
 * id="...noticePopup0..."인 창(class="ChildFrame") 안에 닫기 버튼(role="button",
 * class="Button btn_POP_Close")과 확인 버튼(role="button", class="Button btn_POP_Confirm")이
 * 있다. "btn_POP_" 접두사는 Nexacro가 팝업 전용 버튼에 붙이는 명명 규칙으로 보인다.
 * (안전장치) 나이스 결재 화면에서 페이지 전체의 막연한 "확인"/"닫기" 텍스트로 진짜 업무 버튼을
 * 잘못 눌렀던 사고가 있었다(POPUP_CLOSE_BUTTON_CANDIDATES 제거 사유) - 그 재발을 막기 위해
 * "id에 noticePopup이 포함된 컨테이너 안"으로만 검색 범위를 엄격히 좁힌다. "결재 승인하시겠습니까"
 * 같은 실제 업무 확인창도 같은 ChildFrame/btn_POP_* 구조를 재사용할 가능성이 있는데, 그런
 * 확인창은 id가 noticePopup 패턴을 안 쓸 것이므로(추정) 이 좁은 범위에 걸리지 않는다.
 */
/**
 * (신규, 사용자 제공 K-에듀파인 "웹접근성 안내" - X-internet 화면 키보드 이용 안내) Alt+End를
 * 누르면 팝업을 닫을 수 있다고 안내돼 있다. findNexacroNoticePopupCloseButtonInPage와 동일한
 * 안전 조건(인증서 로그인 화면이 아님, id에 "noticePopup"이 포함된 컨테이너가 실제로 화면에
 * 보임)만 재확인하고, 실제로 닫을 버튼은 찾지 않는다 - closeAnyPopupsCore가 Alt+End를 눌러도
 * 되는 상황인지, 누른 뒤 팝업이 실제로 사라졌는지 판단하는 용도.
 */
function isNexacroNoticePopupPresentInPage() {
  const isVisible = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  if (isVisible(document.querySelector('#btnLgn')) || isVisible(document.querySelector('input[name="certPassword"]'))) {
    return false;
  }
  return [...document.querySelectorAll('[id*="noticePopup"]')].some(isVisible);
}

function findNexacroNoticePopupCloseButtonInPage() {
  const isVisible = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const TRIED_ATTR = 'data-pp-tried';
  const noticeContainers = [...document.querySelectorAll('[id*="noticePopup"]')].filter(isVisible);
  for (const container of noticeContainers) {
    const btn = [...container.querySelectorAll(
      '[role="button"][class*="btn_POP_Close"], [role="button"][class*="btn_POP_Confirm"]'
    )].find((e) => isVisible(e) && !e.hasAttribute(TRIED_ATTR));
    if (btn) {
      btn.setAttribute(TRIED_ATTR, '1');
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
}

async function closeAnyPopupsCore(page, { maxAttempts = 8 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    // "다시 보지 않기"류 체크박스가 있으면 먼저 체크 - 실패해도(없어도) 무시하고 계속 진행.
    await findAndMouseClick(page, findVisibleLeafCenterInPage, {
      candidates: POPUP_SKIP_CHECKBOX_CANDIDATES,
      closestSelector: 'label,button,a,[role="checkbox"]',
    });

    // (신규, 사용자 제공 나이스 "웹접근성 사용법 및 단축키" 안내) 나이스 계열 다이얼로그
    // (.cl-dialog/role="dialog")는 공식적으로 Esc(알림 팝업 닫기, 확인 팝업은 취소)로도
    // 닫힌다고 안내돼 있다. DOM에서 닫기/확인 버튼을 찾아 좌표를 계산해 마우스로 클릭하는
    // 아래 기존 방식보다 훨씬 단순하고, 엉뚱한 요소를 잘못 클릭할 위험이 없다 - 안전 조건
    // (인증서 로그인 화면이 아님, 맨 위 다이얼로그가 입력 요소를 가진 업무 화면이 아님)은
    // findTopmostDialogCloseButtonInPage와 완전히 동일하게 재사용한다. Esc를 눌러도 그
    // 다이얼로그가 그대로 남아 있으면(예: 이 특정 팝업이 Esc를 안 듣는 경우) 곧바로 아래
    // 기존 클릭 경로로 폴백한다. K-에듀파인(Nexacro) 쪽은 이 안내 대상이 아니라서 손대지
    // 않는다.
    const canTryEscape = await page.evaluate(isTopmostClosableDialogPresentInPage).catch(() => false);
    if (canTryEscape) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(150);
      const stillThere = await page.evaluate(isTopmostClosableDialogPresentInPage).catch(() => false);
      if (!stillThere) {
        console.log('[PortalPet] closed a dialog popup via Escape key (나이스 웹접근성 단축키)');
        await page.waitForTimeout(150);
        continue;
      }
    }

    // ".cl-dialog" 형태의 팝업(나이스/G-ONE 공지사항 등)은 여러 개 겹쳐 뜰 수 있어, 겹침 문제를
    // 피하기 위해 맨 위 다이얼로그 하나만 그 안에서 찾아 닫는다. 여러 개면 이 루프가 돌면서
    // 한 번에 하나씩 닫힌다.
    const closedDialog = await findAndMouseClick(page, findTopmostDialogCloseButtonInPage);
    if (closedDialog) {
      console.log('[PortalPet] closed a dialog popup (topmost, 겹친 다이얼로그 대응)');
      await page.waitForTimeout(200);
      continue;
    }

    // K-에듀파인(Nexacro 프레임워크)의 공지사항 팝업은 ".cl-dialog"를 안 써서 위 경로로는 못
    // 잡는다(사용자가 실제 DOM을 확인해준 결과 확인 - id에 "noticePopup"이 포함된 별개의 창
    // 구조). id=noticePopup* 범위로 엄격히 좁혀서 찾는다(아래 함수 설명 참고).

    // (신규, 사용자 제공 K-에듀파인 "웹접근성 안내" - X-internet 키보드 이용 안내) Alt+End를
    // 누르면 팝업을 닫을 수 있다고 안내돼 있다. DOM에서 btn_POP_Close/btn_POP_Confirm 버튼을
    // 찾아 좌표를 클릭하는 아래 기존 방식보다 단순하고 안전하다 - 안전 조건은
    // findNexacroNoticePopupCloseButtonInPage와 동일(id에 "noticePopup"이 포함된 컨테이너로만
    // 판단 범위를 좁혀, 같은 구조를 재사용할 수 있는 실제 업무 확인창은 건드리지 않음)하게
    // 재사용한다. Alt+End를 눌러도 팝업이 그대로 남아 있으면 곧바로 아래 기존 클릭 경로로
    // 폴백한다.
    const canTryAltEnd = await page.evaluate(isNexacroNoticePopupPresentInPage).catch(() => false);
    if (canTryAltEnd) {
      await page.keyboard.press('Alt+End').catch(() => {});
      await page.waitForTimeout(150);
      const stillThereNexacro = await page.evaluate(isNexacroNoticePopupPresentInPage).catch(() => false);
      if (!stillThereNexacro) {
        console.log('[PortalPet] closed a Nexacro notice popup via Alt+End key (K-에듀파인 웹접근성 단축키)');
        await page.waitForTimeout(150);
        continue;
      }
    }

    const closedNexacroNotice = await findAndMouseClick(page, findNexacroNoticePopupCloseButtonInPage);
    if (closedNexacroNotice) {
      console.log('[PortalPet] closed a Nexacro notice popup (K-에듀파인 등)');
      await page.waitForTimeout(200);
      continue;
    }

    // (버그 수정 5 - 실측 확인) ".cl-dialog"가 아닌 일반 팝업 대응으로 페이지 전체에서 "확인"/
    // "닫기" 텍스트를 무조건 찾아 클릭하던 경로는 완전히 껐다. 나이스 결재(미결/협조함) 같은
    // 목록 화면에는 행마다 "확인"/"닫기" 라벨의 정상 동작 버튼이 여러 개 있을 수 있는데,
    // data-pp-tried 표식으로 무한 재클릭은 막았어도 이 경로가 그 버튼들을 하나씩 순서대로
    // 전부(사용자 재현: 로그에 "closed a popup"이 19번 연속, 서로 다른 버튼을 하나씩 클릭한
    // 것으로 추정) 실제로 클릭해버렸다 - 실제 결재/승인 목록의 버튼을 잘못 눌러버릴 수 있는
    // 위험한 동작이라 더는 감수할 수 없다고 판단. 지금까지 확인된 실제 공지 팝업은 전부
    // .cl-dialog/role="dialog"(나이스/G-ONE) 또는 id=noticePopup*(K-에듀파인/Nexacro) 중
    // 하나로 특정 가능했으므로, 그 특정 없이 페이지 전체를 훑던 이 마지막 안전망은 득보다
    // 실이 커서 제거했다.
    break;
  }
}

/**
 * (개선) 팝업 지속 감시(installPopupWatcher, 아래)를 붙이면서, 백그라운드 감시가 알림을 받는
 * 순간과 launchService 흐름이 명시적으로 closeAnyPopups를 호출하는 순간이 겹쳐 같은 페이지에서
 * 동시에 실제 마우스 클릭 두 개가 경쟁할 위험이 생겼다(둘 다 findAndMouseClick으로 진짜 좌표를
 * 클릭하므로, 겹치면 화면이 바뀌는 도중에 좌표가 어긋난 클릭이 나갈 수 있다). 페이지별로 호출을
 * 줄 세워서(이전 호출이 끝난 뒤에만 다음 호출이 시작되도록) 이 경쟁을 없앤다 - launchService의
 * runQueued/taskQueue와 동일한 패턴을 페이지 단위로 축소한 것.
 */
const popupCloseQueues = new WeakMap();
function closeAnyPopups(page, opts) {
  const prev = popupCloseQueues.get(page) || Promise.resolve();
  const run = () => closeAnyPopupsCore(page, opts);
  const result = prev.then(run, run);
  popupCloseQueues.set(page, result.then(() => {}, () => {}));
  return result;
}

/**
 * "cl-" 커스텀 UI는 팝업이 여러 화면에서, 화면 전환 애니메이션 도중이나 로그인 직후처럼
 * 예측하기 어려운 시점에 뜬다 - 예전에는 launchService 흐름 중 몇몇 지점에서만 "몇 초간
 * 폴링"(closeAnyPopupsForAWhile)하는 식으로 대응했는데, 그 창을 벗어난 타이밍에 뜨는 팝업은
 * 여전히 놓쳐서 같은 종류의 버그가 화면을 옮길 때마다 계속 재발했다(실측 재현 여러 건). 이제
 * MutationObserver로 페이지가 살아있는 동안 계속 감시하다가, 팝업으로 보이는 요소가 DOM에
 * 나타나는 즉시(폴링 간격을 기다릴 필요 없이) Node 쪽에 알려서 바로 닫는다.
 * (주의) "cl-" 프레임워크는 합성 클릭(.click())에 반응하지 않는 것으로 실측 확인돼 있다 - 그래서
 * 페이지 안 스크립트는 "떴다는 것을 감지해서 알리기"까지만 하고, 실제 클릭은 항상 Node 쪽
 * closeAnyPopups(findAndMouseClick, 진짜 마우스 이벤트)가 수행한다.
 */
const popupWatcherInstalled = new WeakSet();

function popupWatcherInitScript() {
  const isVisible = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const isLoginOverlayVisible = () => isVisible(document.querySelector('#btnLgn'))
    || isVisible(document.querySelector('input[name="certPassword"]'));
  // (버그 수정) 근무상황신청/출장신청/기안문 작성 같은 실제 업무 화면도 안내 팝업과 같은
  // cl-dialog/role="dialog" 래퍼를 쓴다(실측 확인: "신청" 버튼으로 막 연 신청서 창이 launchService
  // 완료 직후 이 감시에 의해 곧바로 닫혀버림). 순수 안내 팝업은 텍스트/체크박스뿐이지만 실제
  // 업무 화면은 반드시 input/select/textarea를 포함하므로, 이를 가진 다이얼로그는 팝업으로
  // 취급하지 않는다.
  // (버그 수정 2) DOM에 존재하기만 해도(화면에 안 보이는 숨겨진 입력 요소 포함) "업무 화면"으로
  // 오판해 실제 공지 팝업까지 못 닫는 역효과가 있었다(사용자 재현: 나이스 복무 신청 진입 시
  // 공지 팝업 안 닫힘) - 실제로 화면에 "보이는" 입력 요소가 있을 때만 업무 화면으로 판단한다.
  // (버그 수정 3) 공지사항 팝업 자체도 내용을 보여주는 스크롤 가능한 textarea(readonly)를 쓰고
  // 있어서(실측 확인: 스크린샷으로 확인된 "전달사항내용조회" 팝업의 "내용" 칸이 readonly
  // textarea) 바로 위 수정으로도 여전히 공지 팝업을 업무 화면으로 오판했다 - 읽기 전용/비활성
  // 입력 요소는 사용자가 실제로 입력하는 게 아니라 내용을 보여주기만 하는 것이므로 제외한다.
  const hasFormInputs = (el) => [...el.querySelectorAll(
    'input:not([type="checkbox"]):not([readonly]):not([disabled]), select:not([disabled]), textarea:not([readonly]):not([disabled])'
  )].some(isVisible);
  const looksLikePopup = () => {
    // (버그 수정) 인증서 로그인 화면(#btnLgn/certPassword)이 떠 있는 동안은 절대 팝업으로
    // 취급하지 않는다 - 실측 확인: 비밀번호 타이핑 도중 이 감시가 로그인 모달의 "확인" 버튼을
    // 공지 팝업 닫기로 오인해 반복 클릭했고, 이게 로그인 제출을 오염시켜 로그인이 깨지고
    // 사이트의 반복 시도 제한(보안 잠금) 경고까지 유발한 것으로 보인다. completeCertLoginIfNeeded가
    // 이 화면을 전담해서 처리하므로 여기서는 완전히 손을 뗀다.
    if (isLoginOverlayVisible()) return false;
    const dialogs = [...document.querySelectorAll('.cl-dialog, [role="dialog"]')].filter(isVisible);
    if (dialogs.some((d) => !hasFormInputs(d))) return true;
    // (버그 수정 4 - 실측 확인) K-에듀파인은 나이스/G-ONE의 cl-dialog 프레임워크가 아니라
    // Nexacro 프레임워크를 쓴다. 공지사항 팝업은 id에 "noticePopup"이 포함된 ChildFrame으로
    // 렌더링되며(예: mainframe.MainVFrameSet.SubHFrameSet.MainFrame.noticePopup0), 사용자가
    // 실제 outerHTML을 확인해줘서 알아냈다. 실제 업무 확인창과 구조가 겹칠 위험을 줄이기 위해
    // "noticePopup" id 패턴을 가진 컨테이너만 팝업으로 인식한다(findNexacroNoticePopupCloseButtonInPage와
    // 동일한 스코프 제한).
    const nexacroNotices = [...document.querySelectorAll('[id*="noticePopup"]')].filter(isVisible);
    if (nexacroNotices.length > 0) return true;
    const texts = ['닫기', '확인', '1주일동안 열지 않기', '오늘 하루 보지 않기', '오늘 하루 이상 열지 않기'];
    return [...document.querySelectorAll('*')].some((e) => {
      if (e.children.length > 2) return false; // 버튼/라벨처럼 짧고 구체적인 요소만
      const t = (e.textContent || '').trim();
      if (!t || !texts.includes(t) || !isVisible(e)) return false;
      const container = e.closest('.cl-dialog, [role="dialog"], form');
      if (container && hasFormInputs(container)) return false; // 업무 화면 안의 버튼은 건드리지 않는다
      return true;
    });
  };
  // 뮤테이션이 짧은 시간에 여러 번 몰려와도(예: 화면 전체가 다시 그려질 때) 한 번만 알리도록
  // 디바운스한다 - Node 쪽 window.__portalPetNotifyPopup 호출 자체가 비용이 크지 않지만,
  // 너무 자주 부르면 closeAnyPopups 큐가 필요 이상으로 밀린다.
  let notifyTimer = null;
  const scheduleCheck = () => {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      if (looksLikePopup() && window.__portalPetNotifyPopup) {
        window.__portalPetNotifyPopup();
      }
    }, 300);
  };
  const observer = new MutationObserver(scheduleCheck);
  const start = () => {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      scheduleCheck(); // 감시를 시작하는 시점에 이미 팝업이 떠 있을 수도 있으니 한 번 즉시 확인
    } else {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    }
  };
  start();
}

/**
 * 이 page가 살아있는 동안 팝업을 지속 감시하도록 설치한다. page.addInitScript는 그 page의
 * 이후 모든 내비게이션(새 문서 로드)마다 매번 다시 실행되므로, 한 번만 등록해두면 나이스/
 * K-에듀파인/G-ONE/교데통 등 어떤 화면으로 이동하든 감시가 계속 이어진다. getPage/openFreshTab
 * (탭이 새로 만들어지는 두 지점)에서 한 번씩 호출한다 - 이미 설치된 page에는 다시 설치하지
 * 않는다(WeakSet으로 추적, page.exposeFunction을 같은 이름으로 중복 등록하면 에러가 난다).
 */
async function installPopupWatcher(page) {
  if (popupWatcherInstalled.has(page)) return;
  popupWatcherInstalled.add(page);
  try {
    await page.exposeFunction('__portalPetNotifyPopup', () => {
      closeAnyPopups(page).catch((e) => console.log('[PortalPet] 팝업 지속 감시 - 닫기 실패(non-fatal):', e.message));
    });
    await page.addInitScript(popupWatcherInitScript);
    // addInitScript는 "다음" 내비게이션부터 적용되므로, 이미 로드돼 있는 현재 문서에도 즉시 적용한다.
    await page.evaluate(popupWatcherInitScript).catch(() => {});
  } catch (e) {
    popupWatcherInstalled.delete(page);
    console.log('[PortalPet] 팝업 지속 감시 설치 실패(non-fatal):', e.message);
  }
}

/**
 * (버그 대응) closeAnyPopups는 "호출된 그 순간" 화면에 있는 팝업만 처리한다 - 나이스 진입 직후
 * 공지 팝업이 고정 대기 시간(예: 1.5초)보다 늦게 렌더링되면, 그 시점엔 아직 팝업이 없어서
 * closeAnyPopups가 "닫을 게 없다"며 곧바로 끝나버리고, 그 뒤늦게 뜬 팝업이 이어지는 클릭
 * (예: "복무" 메뉴)을 가리게 된다. 실제로 사용자가 배포판에서 재현한 콘솔 로그에
 * "elementHandle.click: Timeout 30000ms exceeded"가 찍혀 이 시나리오임을 확인했다 - 요소
 * 자체는 DOM상 보이는데(waitFor 통과) 그 위에 팝업이 덮고 있어 실제 클릭(actionable 상태)이
 * 안 되고 있었던 것. 한 번만 확인하고 끝내는 대신, 지정한 시간 동안 주기적으로 다시 확인해서
 * 늦게 뜨는 팝업도 잡아낸다. 팝업이 없으면(가장 흔한 경우) 매 폴링이 거의 즉시 끝나므로
 * 체감 지연은 크지 않다.
 */
async function closeAnyPopupsForAWhile(page, { totalWaitMs = 4000, pollMs = 500 } = {}) {
  await closeAnyPopups(page); // 이미 떠 있는 팝업은 바로 처리
  const deadline = Date.now() + totalWaitMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    await closeAnyPopups(page);
  }
}

/**
 * 나이스/K-에듀파인/G-ONE은 주소를 직접 입력해서 들어가면 그 시스템 자체 로그인을 다시 요구한다
 * (실측 확인: goe.neis.go.kr에 바로 갔더니 인증서 로그인 화면이 다시 떴음).
 *
 * 실측 확인된 포털 홈 메뉴 구조(2026-07-27):
 *   <ul class="main-menu"><li><a class="menuBtn" href="javascript:void(0)" id="실제이동할URL">라벨</a></li>...</ul>
 * href가 아니라 id 속성에 실제 목적지 URL이 들어있고, 나이스처럼 세션마다 바뀌는 SSO 토큰이
 * URL 쿼리에 박혀 있는 경우도 있다. 그래서 "클릭"이 아니라 이 URL을 DOM에서 직접 읽어
 * 같은 탭에서 goto하는 방식이 텍스트 클릭보다 훨씬 정확하다 (여러 후보 중 엉뚱한 걸
 * 클릭해버리는 문제, 새 탭이 계속 늘어나는 문제를 둘 다 피할 수 있다).
 */
async function readPortalMenuUrl(page, labelSubstring) {
  return page.evaluate((label) => {
    const links = Array.from(document.querySelectorAll('a.menuBtn'));
    const match = links.find((a) => a.textContent.trim().includes(label));
    return match ? match.id : null;
  }, labelSubstring).catch(() => null);
}

/**
 * 인증서 모달이 닫힌 직후에는 아직 업무포털 홈(메뉴 목록)이 렌더링되지 않은 상태일 수 있다.
 * 이 상태에서 바로 a.menuBtn을 읽으면 하나도 못 찾아서 (SSO 토큰 없는) 폴백 URL로
 * 빠지는 레이스 컨디션이 생긴다 - 그래서 메뉴가 DOM에 나타날 때까지 먼저 기다린다.
 */
async function waitForPortalMenu(page, { timeout = 20000 } = {}) {
  const ok = await page.waitForSelector('a.menuBtn', { timeout }).then(() => true).catch((e) => {
    console.log('[PortalPet] a.menuBtn not found before reading menu:', e.message, 'url:', page.url());
    return false;
  });
  return ok;
}

/**
 * label에 해당하는 메뉴가 포털 홈에서 안 잡힐 때 쓰는 폴백. 직접 URL로 들어가면(SSO 토큰이
 * 없으므로) 그 시스템 자체의 인증서 로그인 창이 다시 뜨는 경우가 있다(나이스에서 실측 확인).
 * password를 넘겨주면 그 로그인 창도 completeCertLoginIfNeeded로 한 번 더 자동 처리한다.
 */
async function goToPortalMenu(page, label, { fallbackUrl = null, password = null } = {}) {
  await waitForPortalMenu(page);
  const url = await readPortalMenuUrl(page, label);
  if (url) {
    console.log(`[PortalPet] portal menu "${label}" -> ${url}`);
    await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('[PortalPet] goto failed:', e.message));
    // (수정) 이 함수는 나이스/K-에듀파인/G-ONE/교데통 진입 경로가 전부 거쳐가는 공통 관문인데,
    // 예전엔 여기서 공지 팝업을 안 닫아서 openNeisSubMenu/openNeisApproval처럼 "자기 안에서
    // 따로 챙겨준" 함수만 안전하고, 그 외 경로(예: 하위 메뉴 없이 시스템 헤더 버튼으로 바로
    // 들어가는 경우)는 공지 팝업이 안 닫힌 채로 남을 수 있었다 - 어떤 경로로 들어오든 여기서
    // 한 번 닫아준다. (버그 수정) 한 번만 확인하고 끝내는 closeAnyPopups로는 "창이 모두 닫힌
    // 상태(콜드 스타트)에서 나이스 헤더 버튼을 눌러 들어갈 때" 공지가 늦게 뜨는 경우를 놓쳤다
    // (사용자 재현: 이 정확한 시나리오로 공지사항이 안 닫힘) - 브라우저를 막 새로 띄운 직후라
    // 첫 페이지 로드가 평소보다 느려서 이 레이스가 더 잘 드러난 것으로 보인다. 몇 초간
    // 지켜보는 closeAnyPopupsForAWhile로 바꿔 늦게 뜨는 팝업도 잡는다.
    await closeAnyPopupsForAWhile(page);
    return page;
  }
  console.log(`[PortalPet] portal menu "${label}" not found in .main-menu`);
  if (fallbackUrl) {
    console.log(`[PortalPet] falling back to direct URL (may require its own login):`, fallbackUrl);
    await gotoWithRetry(page, fallbackUrl, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('[PortalPet] fallback goto failed:', e.message));
    // (수정) password가 null이어도(자동 로그인 꺼짐/비밀번호 미저장) completeCertLoginIfNeeded를
    // 호출한다 - 그 함수가 이제 null이면 자동입력 대신 사용자가 직접 입력할 때까지 기다려준다.
    const loginResult = await completeCertLoginIfNeeded(page, password);
    console.log(`[PortalPet] fallback page ("${label}") login result:`, loginResult);
    await closeAnyPopupsForAWhile(page); // 폴백 경로로 들어간 경우에도 공지 팝업이 늦게 뜰 수 있다.
  }
  return page;
}

async function ensureOnPortalHome(page, subdomain) {
  if (!page.url().includes('.eduptl.kr')) {
    await gotoWithRetry(page, buildPortalUrl(subdomain), { waitUntil: 'domcontentloaded' });
    await waitForPortalMenu(page);
    // (버그 수정) 콜드 스타트(브라우저를 막 새로 띄운 직후) 직후의 첫 페이지 로드는 평소보다
    // 느릴 수 있어, 공지 팝업이 고정 시점보다 늦게 뜨는 경우를 여기서도 놓치지 않게 한다.
    await closeAnyPopupsForAWhile(page);
  }
}

/**
 * 인증서 모달이 "닫힘"으로 판정된 시점과 서버 쪽 로그인 세션이 실제로 확립되는 시점 사이에
 * 약간의 지연이 있을 수 있다(인증서 검증 왕복 등). 이 틈에 곧바로 포털 홈으로 강제 이동시키면
 * 서버가 아직 미인증 상태로 보고 로그인 페이지(bpm_lgn_lg00_001.do)로 다시 튕겨내는
 * 레이스 컨디션이 생긴다 - 실제로 이 문제가 발생해 로그인 페이지에 계속 머무는 증상으로 나타났다.
 * 그래서 곧바로 재이동하지 않고, 먼저 "로그인 페이지를 자연스럽게 벗어나는지"를 잠깐 기다린 뒤,
 * 그래도 안 되면 한 번만 재시도하고, 그마저 실패하면 실제 로그인 실패로 간주해 명확히 알린다.
 */
async function ensureLoggedInOnPortalHome(page, portalUrl) {
  const isOnLoginPage = () => page.url().includes('bpm_lgn_lg00_001');

  if (isOnLoginPage()) {
    console.log('[PortalPet] still on login page right after cert modal closed - waiting for natural redirect...');
    await page.waitForURL((url) => !url.href.includes('bpm_lgn_lg00_001'), { timeout: 8000 }).catch(() => {
      console.log('[PortalPet] no natural redirect away from login page within 8s');
    });
  }

  if (isOnLoginPage()) {
    console.log('[PortalPet] retrying navigation to portal home (session may have just landed)...');
    await page.waitForTimeout(1500); // 세션 반영 유예
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded' }).catch((e) =>
      console.log('[PortalPet] retry navigate to portal home failed:', e.message)
    );
  }

  if (isOnLoginPage()) {
    console.log('[PortalPet] still on login page after retry - treating as login failure. url:', page.url());
    return false;
  }

  await waitForPortalMenu(page);
  // 로그인 직후(콜드 스타트 포함) 첫 도착 시점이라 공지 팝업이 늦게 뜨는 레이스가 가장 흔하게
  // 나타나는 지점 중 하나 - 이후 메뉴 클릭을 가리지 않도록 몇 초간 지켜보며 닫는다.
  await closeAnyPopupsForAWhile(page);
  return true;
}

// ===== K-에듀파인/나이스 정밀 선택자 (원클릭업무포털 OneClickPortal의 PortalWorkflowController.cs
// 참고, 2026-07-27) =====
// 이 도구는 우리와 같은 문제(나이스·K-에듀파인 자동화)를 이미 실사용 수준으로 풀어낸 참고
// 소스가 있어, 텍스트 아무거나 클릭하는 것보다 훨씬 정확한 방식들을 그대로 이식했다.

/**
 * 고정된 waitForTimeout 대신, K-에듀파인 업무 콤보(또는 "업무관리"/"학교회계" 텍스트)가
 * 실제로 DOM에 나타날 때까지 기다린다 - Nexacro 렌더링 속도가 매번 달라서 고정 대기보다 안정적.
 */
async function waitForEdufineReady(page, { timeout = 30000 } = {}) {
  return page.waitForFunction(() => {
    if (document.readyState !== 'complete') return false;
    return !!document.querySelector("[id$='cboJobList.comboedit:input']")
      || /(업무관리|학교회계)/.test(document.body?.innerText || '');
  }, { timeout }).then(() => true).catch((e) => {
    console.log('[PortalPet] K-에듀파인 준비 대기 실패(계속 진행):', e.message);
    return false;
  });
}

/**
 * K-에듀파인 좌측 상단의 "업무" 콤보(업무관리/학교회계/지식관리/서비스공통)는 텍스트를
 * 클릭하는 게 아니라 Nexacro 컴포넌트 내부 API(_on_value_change)를 직접 호출해야 확실하게
 * 바뀐다 - 커스텀 콤보 위젯이라 일반 클릭이 안 먹거나 목록이 안 열려 있을 수 있기 때문이다.
 */
async function selectEdufineJob(page, jobName) {
  const inputSelector = "[id$='cboJobList.comboedit:input']";
  await page.waitForSelector(inputSelector, { timeout: 20000 }).catch((e) => {
    console.log('[PortalPet] K-에듀파인 업무 콤보를 찾지 못함:', e.message);
  });

  const current = await page.evaluate((sel) => document.querySelector(sel)?.value ?? '', inputSelector).catch(() => '');
  if (current === jobName) return true;

  const changed = await page.evaluate((wanted) => {
    const application = globalThis.nexacro?.getApplication?.() || globalThis.application;
    const combo = application?.mainframe?.MainVFrameSet?.TopFrame?.form?.cboJobList;
    const dataset = combo?.getInnerDataset?.() || combo?._innerdataset;
    if (!combo || !dataset || typeof combo._on_value_change !== 'function') return false;
    const dataColumn = combo.datacolumn || 'menuNm';
    const codeColumn = combo.codecolumn || 'menuId';
    let targetIndex = -1;
    for (let row = 0; row < dataset.getRowCount(); row++) {
      const name = ((dataset.getColumn(row, dataColumn) || '') + '').replace(/\s+/g, ' ').trim();
      if (name === wanted) { targetIndex = row; break; }
    }
    if (targetIndex < 0) return false;
    const postText = ((dataset.getColumn(targetIndex, dataColumn) || '') + '').replace(/\s+/g, ' ').trim();
    const postValue = dataset.getColumn(targetIndex, codeColumn);
    const result = combo._on_value_change(combo.index, combo.text, combo.value, targetIndex, postText, postValue);
    combo.redraw?.();
    return result !== false;
  }, jobName).catch((e) => {
    console.log('[PortalPet] K-에듀파인 업무 선택 API 호출 실패:', e.message);
    return false;
  });

  if (!changed) {
    console.log(`[PortalPet] K-에듀파인 업무 "${jobName}" 선택 실패`);
    return false;
  }

  await page.waitForFunction(
    ({ sel, wanted }) => document.querySelector(sel)?.value === wanted,
    { sel: inputSelector, wanted: jobName },
    { timeout: 25000 }
  ).catch((e) => console.log('[PortalPet] 업무 선택 반영 대기 실패:', e.message));
  await page.waitForTimeout(800);
  console.log(`[PortalPet] K-에듀파인 업무를 "${jobName}"(으)로 전환함`);
  return true;
}

/**
 * K-에듀파인 상단 메뉴(문서관리/사업관리 등)는 Nexacro가 만드는 실제 DOM 요소로,
 * id에 "TopFrame"과 "btnMenu_"가 포함된다. 텍스트로 아무 요소나 찾는 것보다 정확하다.
 */
async function clickEdufineTopMenu(page, menuName) {
  const handle = await page.evaluateHandle((n) => {
    const v = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.x >= 0; };
    const xs = [...document.querySelectorAll('[id*="TopFrame"][id*="btnMenu_"]')]
      .filter((e) => (e.textContent || '').trim() === n && v(e));
    return xs.find((x) => x.id.endsWith(':icontext')) || xs[0] || null;
  }, menuName);
  const el = handle.asElement();
  if (!el) {
    console.log(`[PortalPet] K-에듀파인 상단 메뉴 "${menuName}"을 찾지 못함`);
    return false;
  }
  await el.click();
  console.log(`[PortalPet] clicked K-에듀파인 top menu "${menuName}"`);
  await page.waitForTimeout(800);
  return true;
}

/** K-에듀파인 메가메뉴(공용서식/품의등록 등)의 id에는 "pdvMegaMenu"가 포함된다. */
async function clickEdufineMegaMenuPopup(page, menuName) {
  const handle = await page.evaluateHandle((n) => {
    const v = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.x >= 0; };
    const xs = [...document.querySelectorAll('[id*="pdvMegaMenu"]')]
      .filter((e) => (e.textContent || '').trim() === n && v(e));
    return xs.find((x) => x.id.endsWith(':text')) || xs.at(-1) || null;
  }, menuName);
  const el = handle.asElement();
  if (!el) {
    console.log(`[PortalPet] K-에듀파인 메가메뉴 "${menuName}"을 찾지 못함`);
    return false;
  }
  await el.click();
  console.log(`[PortalPet] clicked K-에듀파인 mega menu "${menuName}"`);
  return true;
}

/**
 * (2026-08-02 실측 확인) 사용자가 K-에듀파인 메인화면 전체 페이지 소스를 확인해줘서 좌측
 * 메뉴(LNB)의 정확한 마크업을 알게 됐다: mainframe...LeftFrame.form.divLnb.form.gridMenu
 * 안에 "기안"/"결재"/"공람"/"발송함"/"접수함"/"내문서함"/"문서함"/"문서현황" 같은 카테고리가
 * Grid 행(gridrow_N)으로 렌더링되고, 클릭 가능한 영역은
 * class="CellTreeItemControl celltreeitem"(id가 ".celltreeitem"으로 끝남, aria-label에
 * 텍스트 + 끝에 공백 하나, 예: "결재 ")이다. 이 selector는 pdvMegaMenu 팝업보다 실측으로
 * 직접 확인된 만큼 더 안정적이라, 카테고리/리프 이름으로 좌측 메뉴에서 먼저 찾아 클릭을
 * 시도하고, 못 찾으면 기존 pdvMegaMenu 경로로 폴백한다.
 */
function findEdufineLnbMenuItemInPage(label) {
  const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
  const isVisible = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const items = [...document.querySelectorAll('[id*="LeftFrame"][id*="gridMenu"] [id$=".celltreeitem"]')];
  const match = items.find((e) => norm(e.getAttribute('aria-label')) === label && isVisible(e));
  if (!match) return null;
  const r = match.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

async function clickEdufineLnbMenuItem(page, label) {
  const clicked = await findAndMouseClick(page, findEdufineLnbMenuItemInPage, label);
  if (clicked) {
    console.log(`[PortalPet] clicked K-에듀파인 좌측메뉴(LNB) "${label}"`);
    await page.waitForTimeout(600);
  }
  return clicked;
}

/** 좌측 메뉴(LNB)를 먼저 시도하고, 못 찾으면 기존 pdvMegaMenu 팝업 방식으로 폴백한다. */
async function clickEdufineMegaMenu(page, menuName) {
  if (await clickEdufineLnbMenuItem(page, menuName)) return true;
  return clickEdufineMegaMenuPopup(page, menuName);
}

/**
 * K-에듀파인 문서관리 좌측 메뉴는 "기안"/"결재"/"공람"/... 같은 상위 카테고리가 접혀 있으면
 * 그 안의 리프(예: "결재대기")가 화면에 안 보인다(실측 확인: 결재대기는 "결재" 카테고리를
 * 펼쳐야 보임 - 공용서식이 속한 "기안"은 기본으로 펼쳐져 있어서 지금까지는 필요 없었다).
 * 리프가 이미 보이면 그대로 두고, 안 보이면 상위 카테고리를 한 번 클릭해서 펼친다.
 */
async function ensureEdufineMegaMenuExpanded(page, leafLabel, categoryLabel) {
  const isLeafVisible = () => page.evaluate((n) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const inLnb = [...document.querySelectorAll('[id*="LeftFrame"][id*="gridMenu"] [id$=".celltreeitem"]')]
      .some((e) => { const r = e.getBoundingClientRect(); return norm(e.getAttribute('aria-label')) === n && r.width > 0 && r.height > 0; });
    if (inLnb) return true;
    return [...document.querySelectorAll('[id*="pdvMegaMenu"]')].some((e) => {
      const r = e.getBoundingClientRect();
      return norm(e.textContent) === n && r.width > 0 && r.height > 0 && r.x >= 0;
    });
  }, leafLabel).catch(() => false);

  if (await isLeafVisible()) return true;

  // (신규, 2026-08-02 실측 확인) 좌측 메뉴(LNB)에서 카테고리를 먼저 클릭해본다 - pdvMegaMenu
  // 팝업보다 안정적으로 실측된 구조라 우선 시도한다.
  if (await clickEdufineLnbMenuItem(page, categoryLabel)) {
    if (await isLeafVisible()) return true;
  }

  const handle = await page.evaluateHandle((n) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.x >= 0; };
    const xs = [...document.querySelectorAll('[id*="pdvMegaMenu"]')].filter((e) => norm(e.textContent) === n && visible(e));
    return xs.find((x) => x.id.endsWith(':text')) || xs.at(-1) || null;
  }, categoryLabel).catch(() => null);
  const el = handle && handle.asElement ? handle.asElement() : null;
  if (!el) {
    console.log(`[PortalPet] K-에듀파인 "${categoryLabel}" 카테고리를 못 찾음`);
    return isLeafVisible();
  }
  await el.click();
  console.log(`[PortalPet] clicked K-에듀파인 category "${categoryLabel}" to reveal "${leafLabel}"`);
  await page.waitForTimeout(600);
  return isLeafVisible();
}

/**
 * 나이스에서 "신청" 같은 버튼은 현재 선택된 탭(.cl-tabfolder-item.cl-selected)의
 * aria-controls 패널 안에서만 찾아야 좌측 메뉴의 "권한 신청" 등 다른 동명 요소와 절대
 * 헷갈리지 않는다. 전역에서 exact 텍스트로 찾는 것보다 훨씬 안전하다.
 */
async function clickNeisTaskControl(page, tabName, controlText) {
  const handle = await page.evaluateHandle(({ tabName, controlText }) => {
    const visible = (e) => {
      if (!e) return false;
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const item = [...document.querySelectorAll('.cl-tabfolder-item')].find((e) =>
      (e.innerText || e.textContent || '').trim() === tabName && e.classList.contains('cl-selected') && visible(e));
    const tab = item?.querySelector('[role="tab"][aria-controls]');
    const panel = tab ? document.getElementById(tab.getAttribute('aria-controls')) : null;
    if (!panel) return null;
    const xs = [...panel.querySelectorAll('.cl-button,button,a')].filter((e) =>
      (e.textContent || '').trim() === controlText && visible(e));
    return xs.find((e) => e.classList.contains('btn-primary') && e.classList.contains('cl-button'))
      || xs.find((e) => e.classList.contains('cl-button')) || xs[0] || null;
  }, { tabName, controlText });
  const el = handle.asElement();
  if (!el) {
    console.log(`[PortalPet] 나이스 "${tabName}" 탭에서 "${controlText}" 버튼을 못 찾음`);
    return false;
  }
  // (버그 수정) 기본 타임아웃(30초)이 적용되면 늦게 뜬 공지 팝업 등에 가려 클릭이 막혔을 때
  // 30초를 꽉 채워 기다린 뒤에야 실패한다(사용자 재현: 배포판에서 복무 신청 진입이 느려짐).
  await el.click({ timeout: 5000 });
  console.log(`[PortalPet] clicked 나이스 "${tabName}" 탭의 "${controlText}" 버튼`);
  return true;
}

/**
 * 나이스 좌측 "복무" 메뉴는 클릭만으론 하위 항목(개인근무상황관리/개인출장관리 등)이
 * 안 펼쳐지고 별도의 펼침 아이콘을 눌러야 하는 경우가 있다. 하위 메뉴가 이미 보이면
 * 아무것도 안 하고, 안 보이면 "복무" 항목의 펼침 아이콘을 찾아 누른다.
 */
async function ensureNeisDutyMenuExpanded(page, subMenuLabel) {
  const isSubMenuVisible = () => page.evaluate((n) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('.cl-text,a.cl-sidenavigation-item,a[title]')].some((e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      const text = e.matches('a[title]') ? e.getAttribute('title') : e.textContent;
      return norm(text) === n && r.width > 0 && r.height > 0 && r.x >= 0 && s.display !== 'none' && s.visibility !== 'hidden';
    });
  }, subMenuLabel).catch(() => false);

  if (await isSubMenuVisible()) return true;

  const handle = await page.evaluateHandle(() => {
    const n = '복무';
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const visible = (e) => {
      if (!e) return false;
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && r.x >= 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const links = [...document.querySelectorAll('a.cl-sidenavigation-item,a[title]')].filter(visible);
    const item = links.find((e) => norm(e.getAttribute('title')) === n)
      || links.find((e) => [...e.querySelectorAll('.cl-text')].some((t) => norm(t.textContent) === n && visible(t)))
      || [...document.querySelectorAll('.cl-text')].find((t) => norm(t.textContent) === n && visible(t))?.closest('a.cl-sidenavigation-item,a');
    return item?.querySelector('.cl-expand-icon,[class*="expand"]') || item || null;
  }).catch(() => null);
  const el = handle && handle.asElement ? handle.asElement() : null;
  if (!el) {
    console.log('[PortalPet] 나이스 복무 메뉴 펼침 아이콘을 못 찾음');
    return isSubMenuVisible();
  }
  await el.click({ timeout: 5000 }); // (버그 수정) clickNeisTaskControl과 동일한 이유로 짧은 타임아웃 적용
  console.log('[PortalPet] clicked 나이스 복무 메뉴 펼침 아이콘');
  await page.waitForTimeout(750);
  return isSubMenuVisible();
}

/**
 * (신규, 사용자 요청) 나이스 상단 "역할" 탭(예: 부서장(교무기획부)/교과담임/업무분장설정업무)을
 * 라벨 텍스트로 찾아 전환한다. 실측 확인된 마크업(2026-08-03, 사용자가 붙여준 전체 페이지
 * 소스): <li class="cl-navigationbar-item cl-selected"><a class="cl-navigationbar-content">
 * <div class="cl-navigationbar-text cl-text">라벨<span class="text-transparent fs-zero"> 0단계
 * 메뉴항목</span></div></a></li> - 화면에는 안 보이지만 DOM엔 있는 접미사(span)가 라벨
 * 뒤에 그대로 이어붙어 textContent에 포함되므로, 정확히 일치 대신 접두(startsWith)로 비교한다.
 * 역할 이름은 학교/선생님마다 다를 수 있어(사용자 확인) 항상 호출 쪽에서 라벨을 넘겨받는다.
 * 이미 그 역할이 선택돼 있으면(cl-selected) 클릭하지 않고 그대로 둔다.
 */
async function switchNeisRole(page, roleLabel) {
  // (수정, 사용자 요청) 설정에서 고른/입력한 역할이 그 계정의 상단 탭에 그대로 없을 수 있다
  // (학교마다 역할 탭 구성이 다름 - 실측 확인: 은애님 계정엔 "학급담임"이 없고 "교과담임"/
  // "부서장(교무기획부)"만 있음). 정확히 일치하는 탭이 없으면 순서대로 대체 탐색한다: 1차
  // "학급"/"담임"이 들어간 탭(담임 업무가 출결관리와 가장 관련 깊음), 2차 "부서장"/"부장"이
  // 들어간 관리자급 탭(권한이 넓어 대부분의 메뉴에 접근 가능한 경우가 많음).
  // (수정, 사용자 요청) "담임"만 보고 매칭하면 "교과담임"(교과 전담이라 학급 출결 담당이
  // 아님)까지 걸려버린다(실측 확인: 대체 탐색 1차가 "교과담임"을 집어버림) - 동아리담임과
  // 마찬가지로 교과담임/교과전담/전담은 1차 탐색에서 제외한다.
  const handle = await page.evaluateHandle((label) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const items = [...document.querySelectorAll('.cl-navigationbar-item')];
    const textOf = (e) => {
      const textEl = e.querySelector('.cl-navigationbar-text');
      return textEl ? norm(textEl.textContent) : '';
    };
    const EXCLUDED_KEYWORDS = ['동아리담임', '교과담임', '교과전담', '전담'];
    const isExcluded = (t) => EXCLUDED_KEYWORDS.some((k) => t.includes(k));
    return items.find((e) => textOf(e).startsWith(label))
      || items.find((e) => { const t = textOf(e); return !isExcluded(t) && (t.includes('학급') || t.includes('담임')); })
      || items.find((e) => { const t = textOf(e); return t.includes('부서장') || t.includes('부장'); })
      || null;
  }, roleLabel).catch(() => null);
  const item = handle && handle.asElement ? handle.asElement() : null;
  if (!item) {
    console.log(`[PortalPet] 나이스 역할 탭 "${roleLabel}"을 못 찾음(학급/담임, 부서장/부장 대체 탐색도 실패)`);
    return false;
  }
  const matchedLabel = await item.evaluate((e) => {
    // 라벨 뒤에 안 보이는 접미사(예: "0단계 메뉴항목")가 textContent에 그대로 붙어 나오므로
    // 로그가 지저분해지지 않도록 잘라낸다(매칭 자체는 이미 끝났으니 표시용일 뿐).
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim().replace(/\s*\d+단계(\s*메뉴항목)?$/, '');
    const textEl = e.querySelector('.cl-navigationbar-text');
    return textEl ? norm(textEl.textContent) : '';
  }).catch(() => '');
  const displayLabel = matchedLabel || roleLabel;
  if (matchedLabel && !matchedLabel.startsWith(roleLabel)) {
    console.log(`[PortalPet] 나이스 역할 탭 "${roleLabel}"을 못 찾아 비슷한 역할 "${matchedLabel}"로 대체`);
  }
  const alreadySelected = await item.evaluate((e) => e.classList.contains('cl-selected')).catch(() => false);
  if (alreadySelected) {
    console.log(`[PortalPet] 나이스 역할이 이미 "${displayLabel}"임 - 전환 생략`);
    return true;
  }
  const link = (await item.$('a.cl-navigationbar-content')) || item;
  await link.click({ timeout: 5000 }).catch((e) =>
    console.log(`[PortalPet] 나이스 역할 탭 "${displayLabel}" 클릭 실패:`, e.message)
  );
  console.log(`[PortalPet] clicked 나이스 역할 탭 "${displayLabel}"`);
  await page.waitForTimeout(1000); // 역할 전환 시 좌측 메뉴가 다시 그려지는 시간
  return true;
}

/**
 * (신규, 사용자 요청) 나이스 좌측 메뉴에서 카테고리(cl-level-1, 접혀 있으면 펼침 필요)를
 * 펼치고 그 안의 리프(cl-level-2)를 클릭한다. ensureNeisDutyMenuExpanded와 달리 특정 이름
 * ("복무")에 고정돼 있지 않고 카테고리/리프 라벨을 파라미터로 받는다 - 학교/선생님마다
 * 메뉴 이름이 다를 수 있어(사용자 확인) 하드코딩하지 않기 위함. 카테고리와 리프 이름이
 * 같은 경우(실측 확인: "출결관리" 카테고리 안에 동명의 "출결관리" 리프)가 있어 title
 * 속성만으로는 구분이 안 되므로, DOM 구조상 카테고리는 cl-level-1, 리프는 cl-level-2라는
 * 점으로 구분한다(실측 확인된 마크업 - a.cl-sidenavigation-item.cl-level-1[title=...],
 * a.cl-sidenavigation-item.cl-level-2[title=...]).
 */
async function clickNeisSidebarLeaf(page, categoryLabel, leafLabel) {
  const isLeafVisible = () => page.evaluate((label) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const el = [...document.querySelectorAll('a.cl-sidenavigation-item.cl-level-2')]
      .find((e) => norm(e.getAttribute('title')) === label);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }, leafLabel).catch(() => false);

  if (!(await isLeafVisible())) {
    const catHandle = await page.evaluateHandle((label) => {
      const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('a.cl-sidenavigation-item.cl-level-1')]
        .find((e) => norm(e.getAttribute('title')) === label) || null;
    }, categoryLabel).catch(() => null);
    const catEl = catHandle && catHandle.asElement ? catHandle.asElement() : null;
    if (!catEl) {
      console.log(`[PortalPet] 나이스 좌측메뉴 카테고리 "${categoryLabel}"을 못 찾음`);
      return false;
    }
    let categoryClicked = true;
    await catEl.click({ timeout: 5000 }).catch((e) => {
      categoryClicked = false;
      console.log(`[PortalPet] 나이스 좌측메뉴 카테고리 "${categoryLabel}" 클릭 실패:`, e.message);
    });
    if (categoryClicked) {
      console.log(`[PortalPet] clicked 나이스 좌측메뉴 카테고리 "${categoryLabel}"`);
    }
    await page.waitForTimeout(600);
  }

  const leafHandle = await page.evaluateHandle((label) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    return [...document.querySelectorAll('a.cl-sidenavigation-item.cl-level-2')]
      .find((e) => norm(e.getAttribute('title')) === label && visible(e)) || null;
  }, leafLabel).catch(() => null);
  const leafEl = leafHandle && leafHandle.asElement ? leafHandle.asElement() : null;
  if (!leafEl) {
    console.log(`[PortalPet] 나이스 좌측메뉴 리프 "${leafLabel}"을 못 찾음`);
    return false;
  }
  await leafEl.click({ timeout: 5000 }).catch((e) =>
    console.log(`[PortalPet] 나이스 좌측메뉴 리프 "${leafLabel}" 클릭 실패:`, e.message)
  );
  console.log(`[PortalPet] clicked 나이스 좌측메뉴 리프 "${leafLabel}"`);
  await page.waitForTimeout(800);
  return true;
}

/**
 * 표준서식 목록 같은 K-에듀파인 일부 화면은 iframe 안에 렌더링된다(참고소스 OneClickPortal도
 * 이 요소만큼은 반드시 iframe까지 재귀 탐색해서 찾는다 - searchFrames: true). page.getByText()는
 * 메인 프레임만 보기 때문에 이런 요소는 타임아웃 전엔 절대 못 찾는다. 그래서 모든 iframe까지
 * 재귀적으로 뒤져서 정확히 그 텍스트뿐인(자식이 가장 적은=가장 구체적인) 요소를 찾아 클릭한다.
 */
async function clickExactTextInFrames(page, text, { timeout = 15000, pollMs = 400 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((target) => {
      const visit = (doc) => {
        const xs = [...doc.querySelectorAll('*')].filter((e) => (e.textContent || '').trim() === target);
        const el = xs.sort((a, b) => a.children.length - b.children.length)[0];
        if (el) {
          (el.closest('a,button') || el).click();
          return true;
        }
        for (const f of doc.querySelectorAll('iframe,frame')) {
          try {
            if (f.contentDocument && visit(f.contentDocument)) return true;
          } catch (e) { /* cross-origin iframe - 접근 불가, 건너뜀 */ }
        }
        return false;
      };
      return visit(document);
    }, text).catch(() => false);
    if (clicked) {
      console.log(`[PortalPet] clicked "${text}" (iframe 탐색 포함)`);
      return true;
    }
    await page.waitForTimeout(pollMs);
  }
  console.log(`[PortalPet] could not find "${text}" even searching iframes`);
  return false;
}

/**
 * 지금 이 탭이 나이스/K-에듀파인/G-ONE 중 어디에 이미 가 있는지 URL 호스트로 판별한다.
 * 이미 목표 시스템 안에 있으면 포털 홈을 다시 거쳐 SSO 링크를 새로 읽을 필요가 없다 -
 * 시스템 전환이 아니라 같은 시스템 안에서의 이동이기 때문이다.
 */
function currentHostname(page) {
  try { return new URL(page.url()).hostname; } catch { return ''; }
}

async function isOnSystem(page, system, subdomain) {
  const host = currentHostname(page);
  if (system === 'neis') return host === `${subdomain}.neis.go.kr`;
  if (system === 'edufine') return host.startsWith('klef.');
  if (system === 'gone') {
    const goneUrl = GONE_URL_BY_SUBDOMAIN[subdomain];
    if (goneUrl) {
      try {
        if (host === new URL(goneUrl).hostname) return true;
      } catch { /* ignore */ }
    }
    // (수정) G-ONE 하위 메뉴(일정 등)는 같은 탭 안에서도 완전히 다른 호스트로 옮겨간다
    // (실측 확인: 일정 -> gdp-copilot.goe.go.kr/portalapp/home). "gdp."만 보던 기존 검사로는
    // "이미 G-ONE인지" 판별을 못 해서 매번 포털로 도로 나갔다 들어오는 문제가 있었다 -
    // "gdp"로 시작하는 goe.go.kr 계열 호스트는 전부 G-ONE 생태계로 간주한다.
    if (/^gdp[-.].*\.go\.kr$/.test(host)) return true;
    // 그래도 못 잡는 경우를 대비해, G-ONE 특유의 상단 네비게이션 바(메신저/AI 대화·초안/일정
    // 등 라벨)가 화면에 있으면 호스트와 무관하게 "이미 G-ONE 안"으로 간주한다.
    const hasGoneNav = await page.evaluate(() => {
      const labels = ['메신저', 'AI 대화·초안', '일정', '메일', '할 일', 'Meeting', 'Drive'];
      return [...document.querySelectorAll('.cl-navigationbar-text')]
        .some((e) => labels.includes((e.textContent || '').trim()));
    }).catch(() => false);
    return hasGoneNav;
  }
  if (system === 'edmgr') return host === `${subdomain}.edmgr.kr`;
  return false;
}

/**
 * 기안: 포털 -> 에듀파인(SSO) -> (업무 콤보) 업무관리 -> (상단 탭) 문서관리 -> (메가메뉴) 공용서식
 * -> 표준서식(결재4인,협조4인). "업무관리"로 먼저 전환하지 않으면 문서관리 탭 자체가 없다.
 * alreadyOnEdufine이면 이미 K-에듀파인에 있다는 뜻이라 포털 홈 재방문을 건너뛴다.
 */
async function openGiahn(page, subdomain, password, alreadyOnEdufine = false) {
  let target = page;
  if (alreadyOnEdufine) {
    console.log('[PortalPet] 이미 K-에듀파인에 있음 - 포털 홈 재방문 생략');
  } else {
    await ensureOnPortalHome(page, subdomain);
    target = await goToPortalMenu(page, 'K-에듀파인', { fallbackUrl: buildEdufineUrl(subdomain), password });
  }
  await waitForEdufineReady(target);
  await selectEdufineJob(target, '업무관리');
  const topOk = await clickEdufineTopMenu(target, '문서관리');
  if (!topOk) await clickText(target, '문서관리'); // 정밀 선택자 실패 시 텍스트 클릭으로 재시도
  const megaOk = await clickEdufineMegaMenu(target, '공용서식');
  if (!megaOk) await clickText(target, '공용서식');
  await target.waitForTimeout(1000); // 서식 목록 렌더링 대기
  // 표준서식 목록은 iframe 안에 있어서 page.getByText()로는 못 찾는다 - iframe까지 뒤지는 버전으로.
  await clickExactTextInFrames(target, '표준서식(결재4인,협조4인)');
  return target;
}

/**
 * 품의: 포털 -> 에듀파인(SSO) -> (업무 콤보) 학교회계 -> (상단 탭) 사업관리 -> (메가메뉴) 품의등록.
 */
async function openPumui(page, subdomain, password, alreadyOnEdufine = false) {
  let target = page;
  if (alreadyOnEdufine) {
    console.log('[PortalPet] 이미 K-에듀파인에 있음 - 포털 홈 재방문 생략');
  } else {
    await ensureOnPortalHome(page, subdomain);
    target = await goToPortalMenu(page, 'K-에듀파인', { fallbackUrl: buildEdufineUrl(subdomain), password });
  }
  await waitForEdufineReady(target);
  await selectEdufineJob(target, '학교회계');
  const topOk = await clickEdufineTopMenu(target, '사업관리');
  if (!topOk) await clickText(target, '사업관리');
  const megaOk = await clickEdufineMegaMenu(target, '품의등록');
  if (!megaOk) await clickText(target, '품의등록');
  return target;
}

/**
 * 공문 결재: 포털 -> 에듀파인(SSO) -> (업무 콤보) 업무관리 -> (상단 탭) 문서관리 -> (좌측 메뉴)
 * 결재 카테고리를 펼쳐서 -> 결재대기. "결재" 카테고리는 기본으로 접혀 있어서(실측 확인:
 * 공용서식이 속한 "기안"과 달리) ensureEdufineMegaMenuExpanded로 먼저 펼친다.
 */
async function openEdufineApproval(page, subdomain, password, alreadyOnEdufine = false) {
  let target = page;
  if (alreadyOnEdufine) {
    console.log('[PortalPet] 이미 K-에듀파인에 있음 - 포털 홈 재방문 생략');
  } else {
    await ensureOnPortalHome(page, subdomain);
    target = await goToPortalMenu(page, 'K-에듀파인', { fallbackUrl: buildEdufineUrl(subdomain), password });
  }
  // (버그 수정) openNeisSubMenu는 나이스 진입 직후 매번 closeAnyPopupsForAWhile을 불러 공지
  // 팝업을 닫아주는데, 이 함수는 그 대응이 빠져 있었다(사용자 재현: K-에듀파인 진입 시 공지
  // 팝업 - 예: "국세청 소득자료 제출 안내" - 을 못 닫아서 그 아래 메뉴(업무관리/문서관리/
  // 결재대기) 클릭이 전부 막힘, 스크린샷으로 확인됨). goToPortalMenu 자체도 한 번 닫아주긴
  // 하지만 그 시점 이후에 늦게 뜨는 팝업은 못 잡는다(나이스에서 이미 확인된 것과 동일한 레이스) -
  // alreadyOnEdufine 여부와 무관하게(이미 K-에듀파인에 있다가 다시 결재대기로 오는 경우도
  // 포함) 몇 초간 지켜보며 닫는다.
  await closeAnyPopupsForAWhile(target);
  await waitForEdufineReady(target);
  await selectEdufineJob(target, '업무관리');
  const topOk = await clickEdufineTopMenu(target, '문서관리');
  if (!topOk) await clickText(target, '문서관리');
  await ensureEdufineMegaMenuExpanded(target, '결재대기', '결재');
  const megaOk = await clickEdufineMegaMenu(target, '결재대기');
  if (!megaOk) {
    console.log('[PortalPet] K-에듀파인 "결재대기" 메뉴 탐색 실패 - 일반 텍스트 클릭으로 재시도');
    await clickText(target, '결재대기');
  }
  await target.waitForTimeout(1000);
  return target;
}

/**
 * 복무/출장: 포털 -> 나이스(SSO) -> 복무 메뉴(필요시 펼침) -> 개인근무상황관리/개인출장관리
 * -> 신청 버튼. "신청"은 현재 탭 패널 안에서만 찾아 좌측 메뉴의 "권한 신청" 등과 헷갈리지 않는다.
 */
async function openNeisSubMenu(page, subdomain, taskTabName, password, alreadyOnNeis = false) {
  let target = page;
  if (alreadyOnNeis) {
    console.log('[PortalPet] 이미 나이스에 있음 - 포털 홈 재방문 생략');
  } else {
    await ensureOnPortalHome(page, subdomain);
    target = await goToPortalMenu(page, '나이스', { fallbackUrl: buildNeisUrl(subdomain), password });
    await target.waitForTimeout(1500);
  }
  // (수정) 공지사항 팝업은 나이스에 "처음" 들어갈 때만 뜨는 게 아니라, 이미 나이스에 있는
  // 상태(alreadyOnNeis)에서도(예: 다른 메뉴를 갔다가 다시 나이스 결재/복무 등을 누를 때)
  // 다시 뜨는 경우가 실측 확인됨 - 이전엔 alreadyOnNeis일 때 이 호출이 아예 생략돼서 공지
  // 팝업이 안 닫힌 채로 남아 있었다(사용자가 스크린샷으로 재현 확인). alreadyOnNeis 여부와
  // 무관하게 매번 먼저 닫아준다. (버그 수정) 한 번만 확인하고 끝내면 늦게 뜨는 팝업을
  // 놓친다(사용자 재현: 배포판에서 복무 신청 진입이 느려지고 공지가 안 닫힘 - 늦게 뜬 팝업이
  // 아래 "복무" 클릭을 가려서 기본 30초 타임아웃까지 걸림) - 팝업이 없으면 거의 즉시 끝나는
  // closeAnyPopupsForAWhile로 몇 초간 지켜본다.
  await closeAnyPopupsForAWhile(target);
  // (수정) 근무상황신청 다이얼로그는 화면 전체를 덮지 않는 플로팅 창이라, 좌측 "복무" 메뉴가
  // 시각적으로 가려지지 않아 클릭 자체는 "성공"해버릴 수 있다(다이얼로그는 그대로 열린 채).
  // 그래서 클릭 실패 여부와 무관하게, 먼저 열려 있는지부터 확인해서 선제적으로 닫는다.
  if (alreadyOnNeis && (await isNeisRequestPopupVisible(target))) {
    console.log('[PortalPet] "복무" 클릭 전 신청서 창이 열려 있음 확인 - 먼저 닫기');
    await closeNeisRequestPopup(target);
  }
  let dutyClicked = await clickText(target, '복무');
  if (!dutyClicked && alreadyOnNeis) {
    // 이전 화면(예: 신청서 작성 폼)이 같은 탭에서 좌측 메뉴 자체를 가리고 있을 수 있다.
    // 먼저 실제로 그 창이 떠 있는지 즉시 확인(수 ms)한 뒤 - 떠 있을 때만 닫기 절차를 시도해서
    // 괜히 없는 창을 찾느라 시간을 낭비하지 않는다. 그래도 안 되면 나이스 기본 화면으로 재이동.
    const popupVisible = await isNeisRequestPopupVisible(target);
    if (popupVisible) {
      console.log('[PortalPet] "복무" 클릭 실패 - 신청서 창이 떠 있음, 닫기 시도');
      await closeNeisRequestPopup(target);
      dutyClicked = await clickText(target, '복무');
    } else {
      console.log('[PortalPet] "복무" 클릭 실패 - 신청서 창은 안 보임, 바로 기본 화면으로 재이동');
    }
    if (!dutyClicked) {
      console.log('[PortalPet] 여전히 실패 - 나이스 기본 화면으로 재이동해서 복구 시도');
      await target.goto(buildNeisUrl(subdomain), { waitUntil: 'domcontentloaded' }).catch((e) =>
        console.log('[PortalPet] 나이스 기본 화면 재이동 실패:', e.message)
      );
      await target.waitForTimeout(1200);
      await closeAnyPopups(target); // 재이동한 화면에도 공지 팝업이 새로 뜰 수 있다.
      dutyClicked = await clickText(target, '복무');
    }
  }
  await target.waitForTimeout(500);
  await ensureNeisDutyMenuExpanded(target, taskTabName);
  await clickText(target, taskTabName);
  await target.waitForTimeout(800);
  const clicked = await clickNeisTaskControl(target, taskTabName, '신청');
  if (!clicked) {
    console.log('[PortalPet] 탭 스코프 "신청" 버튼 탐색 실패 - 일반 텍스트 클릭으로 재시도');
    await clickText(target, '신청', { exact: true });
  }
  return target;
}

/**
 * 나이스 결재: 포털 -> 나이스(SSO) -> 좌측 "미결/협조함". 실측 확인된 DOM(2026-07-27):
 * <a class="cl-leaf cl-level-1 cl-sidenavigation-item" title="미결/협조함" data-role="menuitem">
 * cl-level-1(최상위 항목)이라 "복무"처럼 상위 메뉴를 펼칠 필요 없이 바로 클릭 가능하다.
 */
async function openNeisApproval(page, subdomain, password, alreadyOnNeis = false) {
  let target = page;
  if (alreadyOnNeis) {
    console.log('[PortalPet] 이미 나이스에 있음 - 포털 홈 재방문 생략');
  } else {
    await ensureOnPortalHome(page, subdomain);
    target = await goToPortalMenu(page, '나이스', { fallbackUrl: buildNeisUrl(subdomain), password });
    await target.waitForTimeout(1500);
  }
  // (수정) alreadyOnNeis일 때도(이미 나이스에 있다가 "나이스 결재"를 다시 누르는 경우 등)
  // 공지사항 팝업이 다시 뜰 수 있는데, 예전엔 이 호출이 fresh-navigation 분기 안에만 있어서
  // alreadyOnNeis면 아예 건너뛰었다 - 그래서 "미결/협조함" 클릭 전에 팝업이 안 닫힌 채로
  // 남는 문제가 있었다(스크린샷으로 재현 확인). 매번 먼저 닫아준다. (버그 수정) openNeisSubMenu와
  // 동일한 이유로 늦게 뜨는 팝업까지 잡도록 closeAnyPopupsForAWhile을 쓴다.
  await closeAnyPopupsForAWhile(target);
  // 근무상황신청 등 신청서 창이 좌측 메뉴를 가리고 있을 수 있으니 먼저 확인 후 닫는다
  // (openNeisSubMenu와 동일한 이유 - 다이얼로그가 화면 전체를 덮지 않아 클릭이 조용히 씹힐 수 있음).
  if (alreadyOnNeis && (await isNeisRequestPopupVisible(target))) {
    await closeNeisRequestPopup(target);
  }
  let clicked = await clickText(target, '미결/협조함');
  if (!clicked) {
    // (수정) "미결/협조함" 클릭 시도 자체가 공지사항 팝업에 가려 실패하는 경우가 실측 확인됨
    // (위에서 닫은 뒤에도 또 다른/새 팝업이 그 사이에 뜬 경우 포함) - 한 번 더 닫고 재시도한다.
    console.log('[PortalPet] "미결/협조함" 클릭 실패 - 팝업이 남아있을 수 있어 한 번 더 닫고 재시도');
    await closeAnyPopups(target);
    clicked = await clickText(target, '미결/협조함');
  }
  if (!clicked) {
    console.log('[PortalPet] 나이스 "미결/협조함" 메뉴 탐색 실패');
  }
  await target.waitForTimeout(800);
  // (수정) 클릭 자체는 됐지만 그 직후(화면 전환 애니메이션 중 등)에 새 공지 팝업이 뜨는
  // 경우도 있어(사용자 재현 확인: "복무신청은 닫혔는데 나이스 결재는 안 닫힘") 마지막으로
  // 한 번 더 확인해서 닫아준다.
  await closeAnyPopups(target);
  return target;
}

/**
 * (신규, 사용자 요청, 진단 4회차로 확인) "출결관리" 접근 실패의 진짜 원인: 나이스 좌측
 * "aside" 영역은 화면 맨 왼쪽 세로 아이콘 바(기본메뉴 및 승인사항/화면 메뉴/나의 할일/
 * 메뉴 검색/즐겨찾기/개인설정/민원 현황 알림, data-usr-grpmenu 속성으로 구분됨)로 전환되는
 * 여러 패널 중 하나이며, 기본으로 활성화된 건 "기본메뉴 및 승인사항"(승인 현황 대시보드)
 * 이지 실제 카테고리 트리("화면 메뉴", data-usr-grpmenu="grpMn")가 아니다(실측 확인:
 * 사용자가 붙여준 전체 페이지 소스 - "화면 메뉴" 버튼은 안 보이는 패널을, "기본메뉴 및
 * 승인사항" 버튼(class에 selected 포함)은 현재 켜진 패널을 가리켰다). 3차 진단에서 발견한
 * 역할 탭 안의 "학적" 드롭다운은 착각이었다 - "화면 메뉴" 패널 안의 카테고리 트리는 역할별로
 * 이미 모든 도메인(학적/취학관리/공시항목관리/통계 등)이 하나로 합쳐진 전체 목록이라 별도
 * 도메인 선택이 필요 없다. 그래서 카테고리를 찾기 전에 "화면 메뉴" 아이콘을 한 번 클릭해
 * aside를 카테고리 트리로 전환하기만 하면 된다.
 */
/**
 * (신규, 사용자 제공 스크린샷으로 확인, 2026-08-03) 역할 탭(예: "부서장(교무기획부)")에
 * 마우스를 올리면 그 아래 전체 화면 너비의 메가메뉴가 펼쳐지는데, 도메인별 컬럼(경영지원/
 * 학교정보/교육과정/학적/학생생활/성적/학생부/개별화교육계획/보건/입학 등)로 나뉘어 각
 * cl-level-1 카테고리가 바로 클릭 가능한 링크로 나열돼 있다(실측 확인: "학적" 컬럼 안에
 * "출결관리"가 있음). 이 링크를 클릭하면 좌측 aside가 "화면 메뉴"로 전환되면서 해당
 * 카테고리가 자동으로 펼쳐지는 것으로 보인다 - ensureNeisScreenMenuAsideActive +
 * clickNeisSidebarLeaf의 카테고리 클릭 단계를 대신할 수 있는 더 직접적인 경로라 먼저
 * 시도한다(실패해도 그 두 함수가 안전망으로 뒤에 남아 있어 무해하다).
 */
async function clickNeisRoleMegaMenuCategory(page, roleLabel, categoryLabel) {
  const isVisible = () => page.evaluate((label) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const el = [...document.querySelectorAll('.cl-navigationbar-listitem')]
      .find((e) => norm(e.textContent).startsWith(label) && norm(e.textContent).length < 30);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }, categoryLabel).catch(() => false);

  if (!(await isVisible())) {
    const roleHandle = await page.evaluateHandle((label) => {
      const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
      const items = [...document.querySelectorAll('.cl-navigationbar-item')];
      return items.find((e) => {
        const textEl = e.querySelector('.cl-navigationbar-text');
        return textEl && norm(textEl.textContent).startsWith(label);
      }) || null;
    }, roleLabel).catch(() => null);
    const roleEl = roleHandle && roleHandle.asElement ? roleHandle.asElement() : null;
    if (roleEl) {
      await roleEl.hover().catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  const linkHandle = await page.evaluateHandle((label) => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    return [...document.querySelectorAll('.cl-navigationbar-listitem')]
      .find((e) => norm(e.textContent).startsWith(label) && norm(e.textContent).length < 30 && visible(e)) || null;
  }, categoryLabel).catch(() => null);
  const linkEl = linkHandle && linkHandle.asElement ? linkHandle.asElement() : null;
  if (!linkEl) {
    console.log(`[PortalPet] 나이스 메가메뉴에서 "${categoryLabel}"을 못 찾음(호버 후에도 안 보임)`);
    return false;
  }
  await linkEl.click({ timeout: 5000 }).catch((e) =>
    console.log(`[PortalPet] 나이스 메가메뉴 "${categoryLabel}" 클릭 실패:`, e.message)
  );
  console.log(`[PortalPet] clicked 나이스 메가메뉴 "${categoryLabel}"`);
  await page.waitForTimeout(800);
  return true;
}

async function ensureNeisScreenMenuAsideActive(page) {
  const isActive = () => page.evaluate(() => {
    const btn = document.querySelector('[data-usr-grpmenu="grpMn"]');
    return !!btn && btn.classList.contains('selected');
  }).catch(() => false);

  if (await isActive()) return true;

  const handle = await page.evaluateHandle(
    () => document.querySelector('[data-usr-grpmenu="grpMn"]')
  ).catch(() => null);
  const el = handle && handle.asElement ? handle.asElement() : null;
  if (!el) {
    console.log('[PortalPet] 나이스 좌측 "화면 메뉴" 토글 버튼을 못 찾음');
    return false;
  }
  await el.click({ timeout: 5000 }).catch((e) =>
    console.log('[PortalPet] 나이스 "화면 메뉴" 토글 클릭 실패:', e.message)
  );
  console.log('[PortalPet] clicked 나이스 좌측 "화면 메뉴" 토글 (aside를 카테고리 트리로 전환)');
  await page.waitForTimeout(500);
  return true;
}

/**
 * (신규, 사용자 요청) 출결관리: 포털 -> 나이스(SSO) -> 상단 역할 탭을 roleLabel로 전환
 * -> 좌측 aside를 "화면 메뉴"(카테고리 트리)로 전환 -> categoryLabel 카테고리를 펼쳐
 * leafLabel 리프 클릭. 실측 확인된 경로(2026-08-03, 사용자가 붙여준 전체 페이지 소스):
 * "부서장(교무기획부)" 역할 -> 좌측 "출결관리"(cl-level-1) 카테고리를 펼치면 그 안에 동명의
 * "출결관리"(cl-level-2) 리프가 있다(breadcrumb: 부서장(교무기획부) > 학적 > 출결관리 >
 * 출결관리). 역할/카테고리/리프 이름은 학교·선생님마다 다를 수 있다고 사용자가 확인해줬기
 * 때문에 하드코딩하지 않고 모두 파라미터로 받는다 - 실제 값은 호출부(launchService)에서
 * 지정한다.
 */
async function openNeisRoleMenu(page, subdomain, password, alreadyOnNeis = false, { roleLabel, categoryLabel, leafLabel }) {
  let target = page;
  if (alreadyOnNeis) {
    console.log('[PortalPet] 이미 나이스에 있음 - 포털 홈 재방문 생략');
  } else {
    await ensureOnPortalHome(page, subdomain);
    target = await goToPortalMenu(page, '나이스', { fallbackUrl: buildNeisUrl(subdomain), password });
    await target.waitForTimeout(1500);
  }
  // openNeisSubMenu/openNeisApproval과 동일한 이유 - alreadyOnNeis 여부와 무관하게 매번
  // 공지 팝업을 닫고, 신청서 창이 좌측 메뉴를 가리고 있으면 먼저 닫는다.
  await closeAnyPopupsForAWhile(target);
  if (alreadyOnNeis && (await isNeisRequestPopupVisible(target))) {
    await closeNeisRequestPopup(target);
  }
  await switchNeisRole(target, roleLabel);
  // 역할 전환 직후에도 공지 팝업이 새로 뜰 수 있어(다른 메뉴 진입 때와 동일한 레이스) 한 번 더 지켜본다.
  await closeAnyPopupsForAWhile(target);
  // (신규, 사용자 재현: "부서장(교무기획부) 메뉴를 눌러서 펼쳐지는 메뉴에서 학적 아래 출결관리를
  // 눌러야 좌측에 메뉴가 보인다") 역할 탭 호버로 펼쳐지는 메가메뉴에서 카테고리를 직접 클릭하는
  // 경로를 먼저 시도한다 - 실패하거나 이미 다른 방법으로 aside가 전환돼 있어도 무해하므로
  // ensureNeisScreenMenuAsideActive를 안전망으로 그대로 뒤에 남겨둔다.
  await clickNeisRoleMegaMenuCategory(target, roleLabel, categoryLabel);
  await ensureNeisScreenMenuAsideActive(target);
  const clicked = await clickNeisSidebarLeaf(target, categoryLabel, leafLabel);
  if (!clicked) {
    console.log(`[PortalPet] 나이스 좌측메뉴 "${categoryLabel} > ${leafLabel}" 탐색 실패`);
  }
  await target.waitForTimeout(500);
  // (신규, 사용자 제공 실측 화면) 화면 상단 브레드크럼(.breadcrumb-item)이 실제 도착한 경로를
  // "역할 > 카테고리 > 리프"로 정확히 보여준다 - 클릭 자체는 "성공"했지만 타이밍 이슈 등으로
  // 엉뚱한 화면에 도착하는 경우를 잡아낼 수 있는 좋은 검증 신호라 매번 로그에 남긴다.
  await logNeisBreadcrumbPath(target);
  await closeAnyPopups(target);
  return target;
}

/**
 * (신규, 사용자 제공 실측 화면, 2026-08-03) 출결관리 화면 상단에 "부서장(교무기획부) > 학적 >
 * 출결관리 > 출결관리"처럼 현재 위치를 보여주는 브레드크럼이 있다(.breadcrumb-item .cl-text).
 * 클릭 성공 여부만으론 실제로 올바른 화면에 도착했는지 확신할 수 없어(요소를 찾아 클릭은 됐지만
 * 클릭 직후 타이밍에 다른 화면으로 넘어가 있는 경우 등), 이 브레드크럼을 읽어 실제 도착 경로를
 * 로그로 남긴다 - 나이스 홈처럼 브레드크럼 자체가 없는 화면도 있으니 없으면 조용히 넘어간다.
 */
async function logNeisBreadcrumbPath(page) {
  const path = await page.evaluate(() => {
    const norm = (v) => (v || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('.breadcrumb-item .cl-text')]
      .map((e) => norm(e.textContent))
      .filter(Boolean)
      .join(' > ');
  }).catch(() => '');
  if (path) console.log(`[PortalPet] 나이스 현재 경로(breadcrumb): ${path}`);
  return path;
}

/**
 * candidates를 순서대로 시도해서 처음 성공하는 텍스트를 클릭한다 (라벨 표기가 불확실할 때 사용).
 * G-ONE 상단 네비게이션 탭은 클릭하면 새 탭/창을 여는 경우가 있다(실측 확인) - 그러면 계속
 * 붙들고 있던 기존 page는 더 이상 목적지가 아니게 된다. 그래서 클릭 직후 새 탭이 뜨는지 짧게
 * 감시하다가, 뜨면 그 새 탭으로 갈아타고(이후 재사용할 sharedPage도 교체) 기존 탭은 닫는다 -
 * 그래야 다음 클릭들이 계속 올바른(현재) 탭에서 이어진다.
 *
 * (수정) 이전 버전은 popup 감시 타이머를 clickText 호출 전체(=요소가 보일 때까지 기다리는 시간
 * 포함, 최대 수 초)보다 먼저 시작해서, 실제 클릭이 일어나기 전에 감시 타임아웃이 먼저
 * 끝나버리는 레이스 컨디션이 있었다. 요소가 "보일 때까지" 먼저 기다린 뒤, 진짜 클릭 직전에만
 * popup 감시를 시작하도록 순서를 바꿨다.
 *
 * (성능 수정) 새 탭이 열릴 거면 클릭 핸들러의 window.open()이 거의 즉시 실행되므로, 감시
 * 시간을 6초씩 기다릴 필요가 없다. 새 탭이 안 열리는 흔한 경우(같은 탭에서 이동)에 매번
 * 6초를 그냥 날리고 있었던 게 체감 속도 저하의 큰 원인이라 2초로 줄였다.
 */
/**
 * G-ONE '메신저' 클릭이 여는 새 탭이 실제 화면이 아니라 Brity 메신저(데스크톱 앱)를 커스텀
 * 프로토콜(brityaltsso://)로 띄우는 임시 브리지 페이지인지 판별한다. 실측 확인된 특징:
 * URL이 gdp-accounts.*.go.kr/loginapp/messenger/login, 제목 "메신저 실행 중", 화면엔
 * "메신저를 불러오고 있습니다" 스피너, 안 보이는 iframe에 brityaltsso:// 링크가 박혀 있고
 * 스스로 "이 화면은 자동으로 60초 후에 닫힙니다"라고 안내한다. 이건 새 "화면"이 아니라
 * 네이티브 앱을 띄우는 다리일 뿐이라, 이걸 sharedPage로 갈아타거나 원래 G-ONE 탭을 닫아버리면
 * G-ONE 자체를 잃어버려서 다음 메뉴 이동이 실패하고 포털로 도로 나가게 된다(실측으로 확인된
 * 버그) - 그래서 별도로 감지해서 원래 탭을 그대로 지킨다.
 */
async function isBrityMessengerLauncherPage(page) {
  return page.evaluate(() => {
    if (location.pathname.includes('/loginapp/messenger/login')) return true;
    if ((document.title || '').includes('메신저 실행 중')) return true;
    return [...document.querySelectorAll('iframe')]
      .some((f) => (f.getAttribute('src') || '').startsWith('brityaltsso://'));
  }).catch(() => false);
}

/**
 * (개선) 브리지 페이지는 로드된 뒤 서버에서 세션에 묶인 1회용 티켓(JWT)을 받아와 안 보이는
 * iframe의 src를 "brityaltsso://imjwt=...&domain=...&id=...&type=1&browser=CHROME"로 채운다
 * (실측 확인: 사용자가 페이지 소스를 직접 확인해줌) - 크롬이 이 iframe 탐색을 감지해서 OS에
 * 등록된 brityaltsso:// 핸들러(Brity 메신저 데스크톱 앱)로 넘겨주는 방식. 이 티켓은 만료 시간
 * (exp 클레임)이 있고 서버가 그 순간의 로그인 세션에 묶어서 새로 발급하는 것이라, 페이지를 아예
 * 안 들르고 미리 만들어 둘 수는 없다 - 하지만 그 iframe이 뜨는 순간 값을 직접 읽어서, 크롬의
 * iframe 탐색(및 authorizeCustomProtocolForOrigin으로 미리 허용해 둔 "외부 앱을 여시겠습니까"
 * 확인창) 경로를 거치지 않고 Electron의 shell.openExternal로 우리가 직접 OS에 그 URL을 넘겨
 * 실행할 수 있다. 이러면 브리지 탭을 "몇 초 기다렸다가 닫기"(고정 대기, 실측상 3초) 하는 대신
 * 티켓이 실제로 나오는 즉시(보통 훨씬 빠름) 처리할 수 있고, 크롬의 커스텀 프로토콜 처리에
 * 기대지 않아도 되니 더 확실하다.
 */
/**
 * (신규, 사용자 요청: "메신저가 실행될 때 최소화를 하도록 할 수 있을까?") Brity 메신저는
 * shell.openExternal로 우리가 직접 켜든, 크롬의 커스텀 프로토콜 처리에 맡기든 완전히 별개의
 * 네이티브 Windows 프로세스라 Playwright/CDP로는 그 창을 건드릴 수 없다(기존
 * minimizeContextWindow는 CDP 기반이라 우리가 띄운 크롬/엣지 창에만 통함). Windows의
 * user32.dll ShowWindow API를 PowerShell로 호출해, 메신저를 실행한 직후 "새로 전면에 뜨는
 * 창"을 잠깐 감시하다가 우리 자신의 창(크롬/엣지/PortalPet 등)이 아니면 최소화한다 - 메신저의
 * 정확한 프로세스명을 몰라도 되고, 못 찾아도(예: 이미 실행 중이라 전면 전환이 안 일어나는 경우)
 * 조용히 타임아웃으로 끝나 메신저 실행 자체에는 영향이 없다.
 */
function minimizeNewlyOpenedNativeWindow({ timeoutMs = 20000 } = {}) {
  if (process.platform !== 'win32') return;
  // (수정, 사용자 재현: "[minimize-watch] 로그가 아예 안 보임", 종료 이벤트는 code=0으로 즉시
  // 찍힘) 스크립트가 아무 출력도 없이 code=0으로 곧바로 끝났다는 건 우리가 넘긴 -Command 문자열
  // 자체가 제대로 실행되지 못했다는 뜻에 가깝다 - 이 스크립트는 여러 줄, 중첩된 따옴표, 여기
  // 문자열(@"..."@)까지 섞인 꽤 복잡한 내용인데, Node의 spawn은 셸을 거치지 않고 Win32
  // CreateProcess에 바로 넘길 명령줄 문자열을 조립하다 보니 이렇게 복잡한 내용을 인자 하나로
  // 넘기면 인용부호 처리가 깨지기 쉽다. 그래서 -Command로 즉석 전달하는 대신, 스크립트를 임시
  // .ps1 파일로 저장한 뒤 -File로 그 경로만 넘긴다 - 인자가 파일 경로 하나뿐이라 인용부호 문제가
  // 생길 여지가 없다. 진단 메시지도 전부 ASCII로 바꿔서 파일 인코딩 문제 가능성도 없앴다.
  // (수정, 사용자 확인: 실제 실행 파일 경로가 C:\BrityWorks\BrityMessenger\BrityMessenger.exe
  // 라는 것을 알려줌) "새로 나타나는 아무 창이나 잡는" 범용 방식은 먼저 뜨는 "brity.launcher"
  // (로그인용 부트스트랩 창, 이제는 제외 대상)만 계속 걸리고, 정작 최소화해야 할 진짜 메신저
  // 창은 20초 안에 못 잡고 타임아웃났다(실측 확인) - 창이 늦게 뜨는 건지, EnumWindows 스냅샷
  // 비교 방식이 놓치는 건지 확실치 않았다. 이제 실제 프로세스 이름(BrityMessenger)을 정확히
  // 알았으니, EnumWindows로 아무 창이나 뒤지는 대신 Get-Process로 그 이름의 프로세스를 직접
  // 찾아 MainWindowHandle(그 프로세스의 메인 창 핸들, .NET이 알아서 찾아줌)을 최소화한다 -
  // 훨씬 더 정확하고 단순하며, 로그인용 브리지/런처 창과 섞일 여지도 없다.
  // (수정, 사용자 재현: "최소화는 실패한 것 같아" - 로그에는 "minimized: BrityMessenger"가
  // 정상적으로 찍혔는데도 실제로는 창이 그대로 보임) ShowWindow 호출 자체는 성공했지만 화면엔
  // 반영이 안 된 것으로 보아, 앱이 자기 초기화 과정 중에 스스로 창을 다시 활성화/복원하면서
  // 우리가 최소화한 걸 덮어썼을 가능성이 크다(런처 -> 로그인 -> 메인 창 전환 과정에서 흔한
  // 패턴). 그래서 한 번 최소화하고 끝내는 대신, ShowWindow와 함께 WM_SYSCOMMAND/SC_MINIMIZE
  // 메시지도 같이 보내고(앱이 자체적으로 처리하는 "최소화 버튼 눌림" 이벤트와 동일), 몇 초간
  // 계속 최소화 상태(IsIconic)인지 확인해서 다시 복원되면 즉시 재최소화한다.
  const targetProcessName = 'BrityMessenger';
  const holdMs = 8000;
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PortalPetWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@

function Minimize-TargetWindow($hwnd) {
  [PortalPetWin32]::PostMessage($hwnd, 0x0112, [IntPtr]0xF020, [IntPtr]::Zero) | Out-Null
  [PortalPetWin32]::ShowWindow($hwnd, 6) | Out-Null
}

Write-Output "[minimize-watch] started, target process: ${targetProcessName}"
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
$foundHandle = [IntPtr]::Zero
while ($foundHandle -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  $procs = Get-Process -Name '${targetProcessName}' -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
      $foundHandle = $p.MainWindowHandle
      Write-Output "[minimize-watch] found window: $($p.MainWindowTitle)"
      break
    }
  }
}
if ($foundHandle -ne [IntPtr]::Zero) {
  Minimize-TargetWindow $foundHandle
  Write-Output "[minimize-watch] minimized: ${targetProcessName}"
  $holdDeadline = (Get-Date).AddMilliseconds(${holdMs})
  while ((Get-Date) -lt $holdDeadline) {
    Start-Sleep -Milliseconds 400
    if (-not ([PortalPetWin32]::IsIconic($foundHandle))) {
      Minimize-TargetWindow $foundHandle
      Write-Output "[minimize-watch] re-minimized (was restored by the app itself)"
    }
  }
  Write-Output "[minimize-watch] done"
} else {
  Write-Output "[minimize-watch] timeout, ${targetProcessName} window not found"
}
`;
  let scriptPath = null;
  try {
    scriptPath = path.join(os.tmpdir(), `portalpet-minimize-${Date.now()}.ps1`);
    fs.writeFileSync(scriptPath, script, 'utf8');

    // (실측 확인) detached:true + -WindowStyle Hidden 조합이 powershell.exe 실행 자체를 조용히
    // 막았다(code=0, 출력 없이 즉시 종료) - 그래서 둘 다 뺐다. windowsHide:true만으로도 창은
    // 안 뜨고, 우리 Electron 메인 프로세스는 이 몇 초 동안 계속 살아있으므로 detached가 굳이
    // 필요하지 않다.
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const logLine = (buf) => {
      String(buf).split(/\r?\n/).filter(Boolean).forEach((line) => console.log('[PortalPet]', line));
    };
    child.stdout.on('data', logLine);
    child.stderr.on('data', logLine);
    child.on('error', (e) => console.log('[PortalPet] 메신저 최소화 스크립트 프로세스 시작 실패:', e.message));
    child.on('exit', (code, signal) => {
      console.log(`[PortalPet] 메신저 최소화 스크립트 종료: code=${code} signal=${signal}`);
      fs.unlink(scriptPath, () => {}); // 임시 파일 정리 (실패해도 무시)
    });
    console.log('[PortalPet] 메신저 실행 후 새로 뜨는 창 최소화 감시 시작:', scriptPath);
  } catch (e) {
    console.log('[PortalPet] 새 창 최소화 스크립트 실행 실패(non-fatal):', e.message);
    if (scriptPath) fs.unlink(scriptPath, () => {});
  }
}

async function tryLaunchBrityMessengerDirectly(popup) {
  try {
    // (버그 수정) waitForSelector 기본값은 state:'visible'인데, 이 iframe은 페이지 자체가
    // style="display: none;"으로 처음부터 숨겨서 쓰는 것(사용자가 확인해준 페이지 소스)이라
    // 절대 "보이는" 상태가 될 수 없다 - 매번 5초 타임아웃으로 실패하고 있었다(사용자 재현
    // 로그: "5 × locator resolved to hidden <iframe ...>"). DOM에 존재하기만 하면(attached)
    // src 속성은 읽을 수 있으니 visible 요구를 없앤다.
    const handle = await popup.waitForSelector('iframe[src^="brityaltsso://"]', { timeout: 5000, state: 'attached' });
    const href = await handle.getAttribute('src');
    if (!href) return false;
    await shell.openExternal(href);
    console.log('[PortalPet] brityaltsso:// 링크를 페이지에서 직접 추출해 메신저 실행 (고정 대기 없이)');
    return true;
  } catch (e) {
    console.log('[PortalPet] brityaltsso:// 링크 직접 추출 실패(non-fatal, 기존 방식으로 대체):', e.message);
    return false;
  }
}

// G-ONE 좌측 GNB(협업포탈 아이콘 바) - 사용자가 실측 HTML로 제공: 화면이 일정/메일 등으로
// 바뀌어도 항상 떠 있는 <div class="nav"><ul><li><button aria-label="...">...</button> 목록.
// 상단 공용 네비게이션 바(.cl-navigationbar-text)는 화면에 따라 없을 수 있지만(실측 확인:
// "일정" 화면) 이 좌측 GNB는 항상 있어서 더 안정적이다.
// (수정, 사용자 확인) "AI 대화·초안"은 이 GNB에 전용 버튼이 없다 - "Home" 버튼을 누르면
// 도착하는 G-ONE 홈 화면의 상단 네비게이션 바(.cl-navigationbar-text)에만 있는 탭이다.
// 그래서 여기 매핑에는 포함하지 않고, openGoneSubMenu에서 "Home"으로 먼저 이동한 뒤
// 상단 바에서 텍스트로 찾아 클릭한다.
const GONE_GNB_ARIA_LABEL_BY_TEXT = {
  메신저: '메신저',
  일정: '일정',
  메일: '메일',
  '할 일': '할 일',
  Meeting: '미팅',
  Drive: '드라이브',
};

function locateGoneGnbButton(page, text) {
  const ariaLabel = GONE_GNB_ARIA_LABEL_BY_TEXT[text];
  if (!ariaLabel) return null;
  return page.locator(`.nav button[aria-label="${ariaLabel}"]`).first();
}

/**
 * 요소 하나를 클릭하고, 그 결과로 새 탭이 뜨는지(또는 Brity 메신저 네이티브 브리지 탭인지)
 * 지켜본 뒤 최종적으로 사용해야 할 page를 돌려준다. clickFirstMatchFollowingPopup과
 * openGoneSubMenu의 "Home으로 먼저 이동" 단계가 동일한 로직을 공유하기 위해 추출했다.
 */
async function clickAndFollowPopup(context, page, el, label) {
  const popupPromise = context.waitForEvent('page', { timeout: 2000 }).catch(() => null);
  await el.click();
  console.log(`[PortalPet] clicked "${label}", watching for a new tab...`);

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    if (await isBrityMessengerLauncherPage(popup)) {
      console.log(`[PortalPet] "${label}" opened a Brity Messenger native-launch bridge tab (not a real screen) - keeping the original G-ONE tab, giving the native app time to launch before closing the bridge`);
      // (신규, 사용자 요청) 메신저가 전면에 튀어나와 방해된다는 피드백 - 실행을 트리거하기 전에
      // 미리 감시를 시작해서, 실제로 새 창이 전면에 뜨는 순간을 놓치지 않는다. 설정에서 끄면
      // (minimizeMessengerOnLaunchEnabled) 감시 자체를 시작하지 않는다.
      if (minimizeMessengerOnLaunchEnabled) minimizeNewlyOpenedNativeWindow();
      // (개선) brityaltsso:// 링크를 직접 뽑아 shell.openExternal로 우리가 바로 실행할 수
      // 있으면(tryLaunchBrityMessengerDirectly), 크롬의 커스텀 프로토콜 처리에 기대는 고정
      // 대기가 필요 없다. 실패하면(화면 구성이 바뀌었을 가능성 등) 기존 방식대로 넉넉히
      // 3초 기다린 뒤 닫는다 - 크롬 -> OS -> Brity 메신저 앱으로 넘어갈 시간이 부족하면
      // (실측 확인: 로그상 정상 동작했는데도 메신저가 안 뜬 적 있음) 메신저가 안 뜰 수 있다.
      const launchedDirectly = await tryLaunchBrityMessengerDirectly(popup);
      // (버그 수정, 사용자 재현: 메신저 창에 "네트워크 연결이 불안정하여 로그아웃 되었습니다"
      // 뜨며 로그인 실패) 다이렉트 실행(브리지 탭에서 brityaltsso:// 링크를 직접 추출해
      // shell.openExternal로 여는 방식)이 성공하면 대기 없이 곧바로 브리지 탭을 닫았는데,
      // 브리티 메신저의 로그인 핸드오프가 이 브리지 탭이 들고 있던 세션/쿠키가 살아있는 상태를
      // 필요로 하는 것으로 보인다 - 탭을 너무 빨리 닫으면 핸드오프가 끝나기 전에 세션이 끊겨
      // 메신저가 로그아웃 상태로 뜬다. 다이렉트로 열었을 때도 폴백 경로와 동일하게 잠시
      // 기다렸다가 닫는다(속도보다 로그인 성공이 우선).
      await popup.waitForTimeout(3000).catch(() => {});
      await popup.close().catch((e) => console.log('[PortalPet] closing messenger bridge tab failed (non-fatal):', e.message));
      return page;
    }
    console.log(`[PortalPet] "${label}" click opened a new tab - switching to it and closing the old tab`);
    if (sharedPage === page) sharedPage = popup;
    mainServiceTabs.add(popup);
    mainServiceTabs.delete(page);
    popup.on('close', () => {
      mainServiceTabs.delete(popup);
      if (sharedPage === popup) sharedPage = null;
    });
    await page.close().catch((e) => console.log('[PortalPet] closing old tab failed (non-fatal):', e.message));
    return popup;
  }
  return page;
}

async function clickFirstMatchFollowingPopup(context, page, candidates, { timeout = 6000, exact = false, preferGnb = false } = {}) {
  for (const text of candidates) {
    let el;
    // (수정, 사용자 요청) 이미 G-ONE 안에 있을 때는(preferGnb) 포털 홈을 거치지 않고 항상
    // 떠 있는 좌측 GNB부터 시도한다 - 화면에 따라 없을 수 있는 상단 텍스트 라벨보다 안정적.
    if (preferGnb) {
      const gnbBtn = locateGoneGnbButton(page, text);
      const gnbVisible = gnbBtn ? await gnbBtn.isVisible().catch(() => false) : false;
      if (gnbVisible) {
        console.log(`[PortalPet] "${text}" -> 좌측 GNB 버튼으로 클릭 시도`);
        el = gnbBtn;
      }
    }
    if (!el) {
      try {
        el = page.getByText(text, { exact }).first();
        await el.waitFor({ state: 'visible', timeout });
      } catch (e) {
        console.log(`[PortalPet] could not find "${text}" (exact:${exact}):`, e.message);
        continue;
      }
    }

    const resultPage = await clickAndFollowPopup(context, page, el, `${text} (exact:${exact})`);
    return { page: resultPage, found: true };
  }
  return { page, found: false };
}

/**
 * G-ONE 등 로그인/화면 전환 직후 별개의 위젯(예: 메신저)이 뒤늦게 자체적으로 새 팝업을 띄우면서
 * 방금 연 화면 위로 포커스를 가져가는 경우가 있다(실측 확인: G-ONE '일정' 클릭 시 일정 창 위로
 * 메신저 창이 뜸). 우리가 연 target과 무관하게 벌어지는 일이라 막을 수는 없지만, 잠깐 그런
 * 지각생 팝업들이 다 뜨도록 기다린 뒤 우리 target을 한 번 더 앞으로 가져와서 최종적으로는
 * 원하는 화면이 보이게 한다. 그 사이 새로 뜨는 페이지가 있으면 진단용으로 로그만 남긴다.
 */
async function refocusIgnoringLatecomers(context, target, { wait = 900 } = {}) {
  const onPage = (p) => console.log('[PortalPet] another page appeared while settling (e.g. G-ONE messenger widget?):', p.url());
  context.on('page', onPage);
  await target.waitForTimeout(wait).catch(() => {});
  context.off('page', onPage);
  await target.bringToFront().catch(() => {});
}

/**
 * G-ONE 내부 메뉴로 이동. 실측 확인된 DOM(2026-07-27): 상단 네비게이션 바의
 * <div class="cl-navigationbar-text cl-text">라벨</div> 형태 탭들 - "AI 대화·초안",
 * "메일", "일정", "할 일", "메신저", "Meeting", "Drive" 등. 텍스트로 클릭하면 된다.
 */
async function openGoneSubMenu(context, page, subdomain, candidates, password, alreadyOnGone = false) {
  let target = page;
  // (수정, 사용자 요청: "포털 홈으로 가지 말고... 협업포탈로 이동해서 가는 것이 좋을 것 같아")
  // 이미 G-ONE 안이면(예: "일정" 탭에서 "AI 대화·초안"으로 갈아타는 경우) 포털 홈을 다시
  // 거치지 않고, 화면이 바뀌어도 항상 떠 있는 좌측 GNB(협업포탈 아이콘 바)로 바로 전환한다
  // - clickFirstMatchFollowingPopup에 preferGnb:true로 넘겨 처리(아래).
  if (alreadyOnGone) {
    console.log('[PortalPet] 이미 G-ONE에 있음 - 포털 홈 재방문 없이 좌측 GNB로 바로 전환');
    // (수정, 사용자 확인: "일정에서 AI 대화·초안으로 가려고 하는데... 이동하지 못했어") "AI
    // 대화·초안"은 좌측 GNB에 전용 버튼이 없고, 좌측 GNB의 "Home" 버튼을 눌러야 도착하는
    // G-ONE 홈 화면의 상단 네비게이션 바(.cl-navigationbar-text)에만 있다. 지금 화면에 그
    // 상단 바가 없으면(예: "일정" 화면) "AI 대화·초안"을 아무리 찾아도 없으니, 좌측 GNB
    // "Home" 버튼을 먼저 눌러 상단 바가 있는 화면으로 이동한 뒤 계속 진행한다.
    if (candidates.includes('AI 대화·초안')) {
      const hasTopNavBar = await target
        .evaluate(() => document.querySelectorAll('.cl-navigationbar-text').length > 0)
        .catch(() => false);
      if (!hasTopNavBar) {
        const homeBtn = target.locator('.nav button[aria-label="Home"]').first();
        const homeVisible = await homeBtn.isVisible().catch(() => false);
        if (homeVisible) {
          console.log('[PortalPet] "AI 대화·초안"은 상단 네비게이션 바가 있는 화면에서만 찾을 수 있음 - 좌측 GNB "Home"으로 먼저 이동');
          target = await clickAndFollowPopup(context, target, homeBtn, 'Home(GNB)');
          await target.waitForTimeout(600).catch(() => {});
        } else {
          console.log('[PortalPet] 좌측 GNB "Home" 버튼도 못 찾음 - 그대로 진행(아래에서 못 찾으면 실패 로그)');
        }
      }
    }
  } else {
    await ensureOnPortalHome(page, subdomain);
    // (수정, 사용자 요청: "일정 자동 실행할 때... 업무포털에 로그인한 다음에 새 탭을 열어서
    // 일정을 열어야 좋을 것 같아") 원래는 로그인한 이 탭(포털 홈)을 그대로 G-ONE으로 밀어버리고,
    // 그 안에서 "일정"을 누르면 또 새 탭이 열리면서 포털 홈이었던 이 탭은 닫혔다 - 그래서 나중에
    // 결재 현황 자동 확인(checkPortalDashboard)이 포털 홈 탭을 못 찾아 새로 하나 더 열어야
    // 했다. 포털 홈 탭(page)은 그대로 두고, G-ONE은 처음부터 새 탭에서 연다 - 그러면 포털 홈
    // 탭이 계속 남아있어서 나중에 결재 현황 확인이 새 탭을 열 필요가 없다.
    const goneUrl = await readPortalMenuUrl(page, 'G-ONE');
    if (goneUrl) {
      target = await openFreshTab(context);
      console.log(`[PortalPet] portal menu "G-ONE" -> ${goneUrl} (포털 홈 탭은 유지하고 새 탭에서 진입)`);
      await gotoWithRetry(target, goneUrl, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('[PortalPet] goto failed:', e.message));
      await closeAnyPopupsForAWhile(target);
    } else {
      // SSO 링크를 못 읽었으면(드묾) 기존 방식대로 안전하게 폴백 - 이 탭에서 그대로 이동.
      target = await goToPortalMenu(page, 'G-ONE', { fallbackUrl: GONE_URL_BY_SUBDOMAIN[subdomain] || null, password });
    }
    await target.waitForTimeout(900);
  }
  // G-ONE 기본 진입 화면(AI 대화·초안 탭)에 공지 팝업이 뜨는 경우가 있다(실측 확인:
  // "오늘 하루 보지 않기" + "확인"). 하위 메뉴를 클릭하기 전에 먼저 치워야 클릭이 안 막힌다.
  await closeAnyPopups(target);
  const result = await clickFirstMatchFollowingPopup(context, target, candidates, { preferGnb: alreadyOnGone });
  target = result.page;
  if (!result.found) {
    console.log(`[PortalPet] G-ONE sub-menu not found among candidates [${candidates.join(', ')}] - staying on G-ONE home`);
  } else {
    await refocusIgnoringLatecomers(context, target);
    await closeAnyPopups(target); // 이동한 화면에도 팝업이 뜰 수 있으니 한 번 더
  }
  return target;
}

/**
 * 교데통(교육행정데이터통합관리) 내부승인처리: 포털 -> 교육데이터포털(SSO, 포털 홈 .main-menu에
 * "교육데이터포털" 라벨로 존재 - 실측 확인: 사용자가 제공한 포털 메인 HTML 소스) -> 내부승인처리
 * 화면(taskPotlMain). SSO 진입점(main)과 내부승인처리 화면(taskPotlMain)이 서로 다른 경로라,
 * SSO가 끝난 뒤 같은 탭에서 한 번 더 이동한다(같은 origin이라 세션 쿠키가 유지됨).
 * G-ONE과는 도메인 자체가 달라(gdp.*.go.kr vs *.edmgr.kr) 완전히 별개 시스템으로 취급한다
 * (SERVICE_SYSTEM/TAB_GROUP에서도 'gone'이 아니라 'edmgr').
 */
async function openEdmgrApproval(page, subdomain, password, alreadyOnEdmgr = false) {
  let target = page;
  if (alreadyOnEdmgr) {
    console.log('[PortalPet] 이미 교데통에 있음 - 포털 홈 재방문 생략');
  } else {
    await ensureOnPortalHome(page, subdomain);
    target = await goToPortalMenu(page, '교육데이터포털', { fallbackUrl: buildEdmgrUrl(subdomain, 'main'), password });
  }
  await gotoWithRetry(target, buildEdmgrUrl(subdomain, 'taskPotlMain'), { waitUntil: 'domcontentloaded' }).catch((e) =>
    console.log('[PortalPet] 교데통 내부승인처리 이동 실패:', e.message)
  );
  await closeAnyPopups(target);
  return target;
}

// 서비스 버튼 키 -> 어느 시스템에 속하는지. 이미 그 시스템 안에 있으면 포털 홈을 다시
// 거칠 필요가 없다(사용자 제안: "나이스에 있는지 에듀파인에 있는지 G-ONE에 있는지에 따라
// 다시 포털 화면으로 나가지 않고 바로 다른 메뉴로 이동").
const SERVICE_SYSTEM = {
  neis: 'neis', bokmu: 'neis', trip: 'neis', neis_approval: 'neis', neis_attendance: 'neis',
  neis_field_trip_apply: 'neis', neis_field_trip_report: 'neis',
  edufine: 'edufine', giahn: 'edufine', pumui: 'edufine', edufine_approval: 'edufine',
  gone: 'gone', gone_msg: 'gone', gone_ai: 'gone', gone_schedule: 'gone',
  edmgr_approval: 'edmgr',
};

// 탭 재사용 여부 판단 전용 - "업무포털 메인"도 하나의 그룹으로 취급해서, 나이스/K-에듀파인/
// G-ONE과 서로 넘나들 때만 새 탭을 연다(사용자 요청: 같은 시스템 안에서는 새 탭 대신 현재 탭).
const TAB_GROUP = { ...SERVICE_SYSTEM, portal_home: 'portal_home' };

// 업무포털 메인의 a.menuBtn 텍스트에 포함된 시스템별 라벨 (goToPortalMenu가 쓰는 것과 동일).
const PORTAL_MENU_LABEL_BY_SYSTEM = { neis: '나이스', edufine: 'K-에듀파인', gone: 'G-ONE', edmgr: '교육데이터포털' };

/**
 * (신규, 사용자 요청) 이 브라우저 컨텍스트 안에 이미 로그인된 채로 열려 있는 "업무포털 메인"
 * 탭이 있으면 찾아 돌려준다(없으면 null). launchService가 새 탭을 열 때 또 업무포털 메인부터
 * 방문하는 대신 이 탭을 재사용/참조하기 위한 공용 헬퍼 - excludePage로 지금 막 새로 연(아직
 * 빈) 탭 자신은 후보에서 제외한다.
 */
async function findExistingPortalHomePage(context, subdomain, excludePage = null) {
  for (const p of context.pages()) {
    if (p.isClosed() || p === excludePage) continue;
    let host = '';
    try { host = currentHostname(p); } catch { continue; }
    if (!host.endsWith('.eduptl.kr')) continue;
    const menuReady = await p.waitForSelector('a.menuBtn', { timeout: 1500 }).then(() => true).catch(() => false);
    if (menuReady) return p;
    // (버그 수정, 사용자 재현: "업무포털 메인이 두 번 뜨고 있어") 결재 현황 자동 확인은 기본
    // 30분마다 실행되는데, 그 사이 백그라운드에 오래 방치된 포털 홈 탭은 idle 세션 만료 등으로
    // a.menuBtn이 당장 안 보일 수 있다. 예전엔 여기서 바로 포기하고 다음 탭을 봤는데, eduptl.kr
    // 탭이 이거 하나뿐이면 결국 못 찾은 것으로 처리돼 호출 쪽이 새 탭을 하나 더 열었다 - 그래서
    // 방치됐던 탭(로그인 화면 등으로 밀려나 있음) + 새로 연 탭, 둘 다 살아남아 포털 홈이 2개가
    // 됐다. 호스트가 맞으면 포기하지 않고 그 탭에서 포털 홈으로 다시 이동시켜(필요하면 재로그인
    // 포함, launchService의 로그인 로직과 별개로 이미 로그인된 세션이면 SSO로 바로 통과됨)
    // 되살려본다 - 그래도 안 되면 이 탭은 넘기고 계속 다음 탭을 찾는다.
    console.log('[PortalPet] eduptl.kr 탭을 찾았지만 a.menuBtn이 바로 안 보임(idle 세션 만료 추정) - 포털 홈으로 다시 이동해 되살려봄:', p.url());
    const revived = await gotoWithRetry(p, buildPortalUrl(subdomain), { waitUntil: 'domcontentloaded' })
      .then(() => true)
      .catch((e) => {
        console.log('[PortalPet] 방치된 포털 홈 탭 되살리기 실패 - 이 탭은 포기하고 계속 찾음:', e.message);
        return false;
      });
    if (!revived) continue;
    const menuReadyAfterRevive = await p.waitForSelector('a.menuBtn', { timeout: 5000 }).then(() => true).catch(() => false);
    if (menuReadyAfterRevive) {
      console.log('[PortalPet] 방치된 포털 홈 탭을 되살림 - 재사용');
      return p;
    }
  }
  return null;
}

/**
 * (신규, 사용자 요청) "프로그램 시작 시 자동 실행해둔 '일정' 탭이 있는데, 메뉴에서 '일정'을
 * 다시 누르면 그 탭을 쓰지 않고 새 탭을 연다"는 피드백 - 컨텍스트 안의 모든 탭을 훑어 이미
 * targetSystem(neis/edufine/gone/edmgr)에 가 있는 탭이 있으면 찾아 돌려준다. launchService가
 * sharedPage(마지막으로 쓴 탭)만 보고 새 탭 여부를 정하던 것을, 열려 있는 모든 탭을 대상으로
 * 확장한다.
 */
async function findExistingSystemTabPage(context, subdomain, targetSystem, excludePage = null) {
  for (const p of context.pages()) {
    if (p.isClosed() || p === excludePage) continue;
    if (await isOnSystem(p, targetSystem, subdomain).catch(() => false)) return p;
  }
  return null;
}

/**
 * (신규, 사용자 요청) "공문 결재"를 누르면 새 탭이 업무포털 메인을 먼저 보여줬다가 K-에듀파인
 * 으로 넘어가는 게 불필요한 중간 화면으로 보인다는 피드백 - 처음 프로그램을 실행할 때부터
 * 이미 열려 있는 "업무포털 메인" 탭이 따로 있는데도, 새로 여는 탭이 그걸 무시하고 자기 안에서
 * 또 한 번 업무포털 메인을 거쳐갔기 때문이다. findExistingPortalHomePage로 찾은 탭에서 목적
 * 시스템의 SSO 링크(a.menuBtn)만 읽어와 이번에 새로 연 targetPage에 곧바로 적용한다 -
 * 쿠키/세션은 탭과 무관하게 브라우저 컨텍스트 전체가 공유하므로 안전하다. 성공하면 targetPage가
 * 이미 목적 시스템에 도착한 상태가 되므로, 호출 쪽에서 alreadyInTargetSystem을 true로 바꿔
 * 이후 로직이 기존 "이미 그 시스템에 있음" 경로를 그대로 타게 한다. 적당한 탭을 못 찾거나
 * 실패하면 false를 돌려줘 기존 방식(포털 홈부터 재방문)으로 안전하게 폴백한다.
 */
async function tryEnterSystemFromExistingPortalHome(context, targetPage, subdomain, targetSystem) {
  const label = PORTAL_MENU_LABEL_BY_SYSTEM[targetSystem];
  if (!label) return false;
  const source = await findExistingPortalHomePage(context, subdomain, targetPage);
  if (source) {
    const url = await readPortalMenuUrl(source, label);
    if (url) {
      console.log(`[PortalPet] 이미 열려 있는 업무포털 메인 탭에서 "${label}" SSO 링크를 읽음 -> 새 탭에 바로 적용`);
      const navigated = await gotoWithRetry(targetPage, url, { waitUntil: 'domcontentloaded' })
        .then(() => true)
        .catch((e) => {
          console.log('[PortalPet] SSO 링크로 새 탭 이동 실패 - 기존 방식(포털 홈 재방문)으로 폴백:', e.message);
          return false;
        });
      if (navigated) {
        await closeAnyPopupsForAWhile(targetPage);
        return isOnSystem(targetPage, targetSystem, subdomain);
      }
    }
  }
  return false;
}

/**
 * PortalPet에서 서비스 버튼 클릭 시 호출되는 진입점.
 */
async function launchService(serviceKey, subdomain, password, browserProfile = null, browserChannel = 'chrome', options = {}) {
  console.log(`[PortalPet] launchService(${serviceKey}, ${subdomain}, ${browserChannel})`);
  // (신규, 사용자 요청) 설정 옵션("메신저 실행 시 최소화하기")을 이번 호출 동안 쓸 모듈 전역
  // 플래그에 반영한다 - 기본값 true(켬), 명시적으로 false를 넘겼을 때만 끈다.
  minimizeMessengerOnLaunchEnabled = options.minimizeMessengerOnLaunch !== false;
  certUserNameToSelect = (options.certUserName || '').trim();
  const { context } = await getContext(browserProfile, subdomain, browserChannel); // 사용자 클릭 결과는 항상 bringToFront로 보여주므로 isNew 여부와 무관

  const targetSystem = SERVICE_SYSTEM[serviceKey] || null;

  // (신규, 사용자 요청) 예를 들어 프로그램 시작 시 자동 실행해둔 "일정"(G-ONE) 탭이 다른 곳에
  // 열려 있는데, 그 뒤 다른 메뉴를 눌렀다가(sharedPage가 그 시스템으로 바뀜) 다시 메뉴에서
  // "일정"을 누르면 shouldOpenNewTabFor는 sharedPage만 보고 판단하기 때문에 이미 열려 있는
  // "일정" 탭의 존재를 몰라 또 새 탭을 열었다. 새 탭/기존 탭 재사용 여부를 정하기 전에, 이
  // 컨텍스트의 모든 탭을 훑어 목적 시스템에 이미 가 있는 탭이 있으면 새 탭을 열지 않고 그
  // 탭을 그대로 재사용한다(같은 시스템 안에서 하위 메뉴만 바뀌는 건 기존 로직과 동일하게
  // 그 탭 안에서 처리됨 - 나이스 복무/출장 신청과 같은 방식).
  const existingSystemTab = targetSystem ? await findExistingSystemTabPage(context, subdomain, targetSystem) : null;

  // (버그 수정, 사용자 재현: "업무포털 메인이 두 번 뜨고 있어") "포털 홈 탭은 그대로 두고
  // G-ONE은 새 탭에서 연다"로 바꾼 뒤(일정 자동 실행 등), 로그인했던 원래 포털 홈 탭이 계속
  // 남아있게 됐다 - 그런데 sharedPage는 그사이 G-ONE/일정 탭으로 바뀌어 있어서, 이후 메뉴에서
  // "업무포털 메인"을 누르면 shouldOpenNewTabFor가 sharedPage(=일정 탭)만 보고 "그룹이 다르니
  // 새 탭"으로 판단해 또 다른 포털 홈 탭을 새로 열었다 - 결과적으로 포털 홈 탭이 두 개가 됐다.
  // portal_home은 targetSystem이 없어(SERVICE_SYSTEM에 없음) existingSystemTab 검사를 안
  // 타므로, 여기서 따로 findExistingPortalHomePage로 이미 열려 있는 포털 홈 탭을 찾아 재사용한다
  // (checkPortalDashboard가 쓰는 것과 동일한 헬퍼).
  const existingPortalHomeTab =
    serviceKey === 'portal_home' ? await findExistingPortalHomePage(context, subdomain) : null;

  let page;
  if (existingSystemTab) {
    console.log(`[PortalPet] 이미 ${targetSystem} 탭이 열려 있음 - 새 탭을 열지 않고 그 탭을 재사용`);
    page = existingSystemTab;
    sharedPage = page;
    mainServiceTabs.add(page);
    await installPopupWatcher(page);
  } else if (existingPortalHomeTab) {
    console.log('[PortalPet] 이미 열려 있는 업무포털 메인 탭을 찾음 - 새 탭을 열지 않고 재사용');
    page = existingPortalHomeTab;
    sharedPage = page;
    mainServiceTabs.add(page);
    await installPopupWatcher(page);
  } else {
    // (수정) 이미 다른 화면이 떠서 사용 중이면(사용자가 방금 전 메뉴로 연 화면이 아직 열려 있으면)
    // 그 화면을 그대로 두고 이번 클릭은 새 탭에서 실행한다 - 예전엔 항상 같은 탭을 재사용해서
    // 이미 열어둔 작업 화면이 새 메뉴 클릭에 밀려 사라지는 문제가 있었다(사용자 요청으로 확인).
    const openNewTab = await shouldOpenNewTabFor(serviceKey, subdomain);
    page = openNewTab ? await openFreshTab(context) : await getPage(context);
  }
  await closeExtraPages(context, page); // 이전 클릭이 남겨둔 신청서 작성 창 등 정리 (다른 탭/창)
  // (수정) 근무상황신청/출장신청 창은 새 탭이 아니라 같은 페이지 안의 오버레이 다이얼로그로
  // 뜬다는 게 실측으로 확인됨 - closeExtraPages는 "다른" 페이지만 검사하므로 이 경우를
  // 놓친다. keep하는 page 자기 자신도 검사해서 열려 있으면 닫는다.
  // (성능 수정) 이 검사는 NEIS 전용(.cl-dialog-close 등)인데, 이전엔 K-에듀파인/G-ONE으로
  // 갈 때도 매번 돌고 있었다 - document.querySelectorAll('*') 전체 스캔이라 무거운 화면에서는
  // 불필요한 지연이 된다. 현재 탭이 NEIS에 있을 때만 검사하도록 제한한다(URL만 보는 가벼운
  // 체크라 비용이 거의 없다).
  if ((await isOnSystem(page, 'neis', subdomain)) && (await isNeisRequestPopupVisible(page))) {
    console.log('[PortalPet] 현재 탭에 신청서 창(오버레이)이 열려 있음 - 닫기 시도');
    await closeNeisRequestPopup(page);
  }

  // (수정) existingPortalHomeTab을 재사용하는 경우(위) 이미 그 탭이 포털 홈 메뉴까지 로드된
  // 상태임이 findExistingPortalHomePage에서 이미 확인됐다 - portal_home은 targetSystem이 없어
  // isOnSystem 검사 대상이 아니므로, 여기서 따로 true로 잡아줘야 아래에서 불필요하게 포털
  // URL로 다시 이동(재로딩)하지 않는다.
  let alreadyInTargetSystem = targetSystem
    ? await isOnSystem(page, targetSystem, subdomain)
    : !!existingPortalHomeTab;

  let loggedIn = true;

  if (alreadyInTargetSystem) {
    console.log(`[PortalPet] 이미 ${targetSystem}에 있음 - 포털 홈 재방문 없이 바로 하위 메뉴로 이동`);
  } else if (targetSystem && await tryEnterSystemFromExistingPortalHome(context, page, subdomain, targetSystem)) {
    // (신규, 사용자 요청) 다른 탭에 이미 열려 있던 업무포털 메인에서 SSO 링크를 읽어 이 탭에
    // 바로 적용했다 - 포털 홈을 다시 거치지 않았으니 이후 로직도 "이미 목적 시스템에 있음"
    // 경로를 그대로 탄다(각 open* 함수의 alreadyOn* 분기 재사용).
    console.log(`[PortalPet] 다른 탭의 업무포털 메인에서 바로 ${targetSystem}(으)로 진입함 - 이 탭에서는 포털 홈 재방문 생략`);
    alreadyInTargetSystem = true;
  } else {
    const portalUrl = buildPortalUrl(subdomain);
    console.log('[PortalPet] navigating to', portalUrl);
    await gotoWithRetry(page, portalUrl, { waitUntil: 'domcontentloaded' });

    const result = await completeCertLoginIfNeeded(page, password);
    console.log('[PortalPet] login result:', result);
    loggedIn = result.loggedIn;

    // 방금 인증서 로그인을 마쳤든, 이미 로그인돼 있던 세션/프로필이라 모달 자체가 안 떴든,
    // 다음 메뉴 이동 전에 포털 홈에 확실히 도착했다는 걸 보장한다 (로그인 페이지에 갇힌
    // 상태로 넘어가지 않도록).
    const reachedHome = await ensureLoggedInOnPortalHome(page, portalUrl);
    if (!reachedHome) {
      throw new Error(buildLoginFailureMessage(browserChannel));
    }
  }

  // 폴백(직접 URL)으로 빠졌을 때 그 시스템 자체 인증서 로그인 창이 다시 뜨면 같은 비밀번호로
  // 한 번 더 자동 로그인하도록 password를 넘긴다.
  let targetPage = page;
  switch (serviceKey) {
    case 'portal_home':
      // (수정) 포털 홈의 공지 팝업(예: "나이스시스템 점검 안내")은 메뉴(a.menuBtn)보다 늦게
      // 비동기로 뜨는 경우가 있다(실측 확인: 스크린샷 - 위 ensureLoggedInOnPortalHome의
      // closeAnyPopups가 지나간 뒤에야 나타남). 다른 메뉴(나이스/K-에듀파인/G-ONE)는 포털 홈에
      // 도착하자마자 바로 다른 화면으로 넘어가버려서 이 팝업이 뜨기 전에 화면이 바뀌지만,
      // "업무포털 메인"은 그 자리에 계속 머무르기 때문에 뒤늦게 뜨는 팝업이 그대로 남는다 -
      // 잠깐 더 기다렸다가 한 번 더 닫기를 시도한다.
      await targetPage.waitForTimeout(1500);
      await closeAnyPopupsForAWhile(targetPage);
      console.log('[PortalPet] 업무포털 메인 화면에 머무름');
      targetPage = page;
      break;
    case 'neis':
      if (alreadyInTargetSystem) {
        // (수정) 이미 나이스에 있는 상태에서 "나이스" 헤더 버튼을 다시 눌렀을 때는 goToPortalMenu를
        // 아예 안 거쳐서 공지 팝업을 안 닫아주고 있었다(실측 확인) - 여기서도 닫아준다.
        await closeAnyPopupsForAWhile(page);
        targetPage = page;
      } else {
        targetPage = await goToPortalMenu(page, '나이스', { fallbackUrl: buildNeisUrl(subdomain), password });
      }
      break;
    case 'edufine':
      if (alreadyInTargetSystem) {
        await closeAnyPopupsForAWhile(page); // 나이스와 동일한 이유
        targetPage = page;
      } else {
        targetPage = await goToPortalMenu(page, 'K-에듀파인', { fallbackUrl: buildEdufineUrl(subdomain), password });
      }
      break;
    case 'gone':
      // 포털 메뉴 실측 라벨: "업무협업G-ONE"
      if (alreadyInTargetSystem) {
        await closeAnyPopupsForAWhile(page); // 나이스와 동일한 이유
        targetPage = page;
      } else {
        targetPage = await goToPortalMenu(page, 'G-ONE', { fallbackUrl: GONE_URL_BY_SUBDOMAIN[subdomain] || null, password });
      }
      break;
    case 'giahn':
      targetPage = await openGiahn(page, subdomain, password, alreadyInTargetSystem);
      break;
    case 'pumui':
      targetPage = await openPumui(page, subdomain, password, alreadyInTargetSystem);
      break;
    case 'edufine_approval':
      targetPage = await openEdufineApproval(page, subdomain, password, alreadyInTargetSystem);
      break;
    case 'bokmu':
      targetPage = await openNeisSubMenu(page, subdomain, '개인근무상황관리', password, alreadyInTargetSystem);
      break;
    case 'trip':
      targetPage = await openNeisSubMenu(page, subdomain, '개인출장관리', password, alreadyInTargetSystem);
      break;
    case 'neis_approval':
      targetPage = await openNeisApproval(page, subdomain, password, alreadyInTargetSystem);
      break;
    case 'neis_attendance':
      // (수정, 사용자 요청) 역할 이름은 학교·선생님마다 다를 수 있어 설정 창에서 고른 값
      // (options.neisRoleLabel - 학급담임/교과담임/부서장/직접입력)을 그대로 쓴다. 학적 >
      // 출결관리 > 출결관리 경로 자체(카테고리/리프 이름)는 나이스 전국 공통이라 고정.
      targetPage = await openNeisRoleMenu(page, subdomain, password, alreadyInTargetSystem, {
        roleLabel: options.neisRoleLabel || '학급담임', categoryLabel: '출결관리', leafLabel: '출결관리',
      });
      break;
    case 'neis_field_trip_apply':
      // (신규, 사용자 요청, 실측 확인) 출결관리와 같은 방식 - 교외체험학습관리 카테고리 안의
      // "교외체험학습신청서관리" 리프(카테고리와 리프 이름이 다른 경우).
      targetPage = await openNeisRoleMenu(page, subdomain, password, alreadyInTargetSystem, {
        roleLabel: options.neisRoleLabel || '학급담임', categoryLabel: '교외체험학습관리', leafLabel: '교외체험학습신청서관리',
      });
      break;
    case 'neis_field_trip_report':
      targetPage = await openNeisRoleMenu(page, subdomain, password, alreadyInTargetSystem, {
        roleLabel: options.neisRoleLabel || '학급담임', categoryLabel: '교외체험학습관리', leafLabel: '교외체험학습보고서관리',
      });
      break;
    case 'gone_msg':
      targetPage = await openGoneSubMenu(context, page, subdomain, ['메신저'], password, alreadyInTargetSystem);
      break;
    case 'gone_ai':
      targetPage = await openGoneSubMenu(context, page, subdomain, ['AI 대화·초안'], password, alreadyInTargetSystem);
      break;
    case 'gone_schedule':
      targetPage = await openGoneSubMenu(context, page, subdomain, ['일정'], password, alreadyInTargetSystem);
      break;
    case 'edmgr_approval':
      targetPage = await openEdmgrApproval(page, subdomain, password, alreadyInTargetSystem);
      break;
    default:
      console.log(`[PortalPet] unknown serviceKey "${serviceKey}" - staying on portal home`);
  }

  await targetPage.bringToFront();
  console.log('[PortalPet] launchService done, loggedIn:', loggedIn);
  return { ok: true, loggedIn };
}

/**
 * 업무포털 메인 화면에는 "나이스 승인사항"(.aprvWork1/.aprvWork2), "K-에듀파인 전자결재 현황"
 * (.keduBox1/.keduBox2), "교육행정데이터통합관리 알림 현황"(.edmgrBox1/.edmgrBox2) 위젯이 전부
 * 같은 구조로 렌더링된다(실측 확인: 사용자가 제공한 포털 메인 HTML 소스) -
 *   <ul class="XXX"><li><span class="num neisNum"><a>라벨</a></span><span class="num neisNum"><a>값</a></span></li>...</ul>
 * 첫 번째 <a>가 라벨(예: "미결/협조함"), 두 번째 <a>가 값(예: "0" 또는 "0(0)")이다. 셋 다 같은
 * 패턴이라 컨테이너 클래스만 바꿔가며 재사용할 수 있는 범용 파서로 만든다. K-에듀파인 결재
 * 항목만 별도로 페이지를 옮겨다니지 않아도(예전 checkEdufineApprovalCount처럼 K-에듀파인 안까지
 * 들어갈 필요 없이) 포털 메인 한 화면에서 나이스/K-에듀파인 수치를 동시에 읽을 수 있다.
 */
/**
 * 업무포털 메인의 "나이스 승인사항"/"K-에듀파인 전자결재 현황"/"교육행정데이터통합관리 알림
 * 현황" 박스는 각각 제목 옆에 그 박스만 새로고침하는 아이콘(⟳)을 갖고 있다. 탭을 재사용해서
 * 페이지 전체를 다시 불러오지 않는 경우(checkPortalDashboard의 alreadyOnPortalHome 분기)에도,
 * 이 아이콘을 눌러 그 박스만 새로고침하면 전체 페이지 리로드 없이도 최신 값을 받아올 수 있다 -
 * 페이지를 안 새로고침하면 이전에 읽은 값을 그대로 다시 읽어올 뿐이라는 사용자 지적으로 추가.
 * (수정) 처음엔 정확한 선택자를 실측하지 못해 "박스 근처의 작은 아이콘류 요소"를 찾는 넓은
 * 휴리스틱을 썼는데, 사용자가 실제 마크업을 확인해준 결과 나이스 쪽은
 * <button class="return" id="btnRefreshNeisAprvWork"></button>로 정확한 id를 알 수 있었고,
 * 그 넓은 휴리스틱은 실측 확인대로 엉뚱한 버튼을 잘못 누르고 있었다(사용자 재현). 이제 이
 * 프레임워크의 일관된 명명 규칙(id가 "btnRefresh"로 시작, class="return")을 정확히 노려서
 * 찾는다 - 나이스 외 두 박스의 정확한 id는 아직 실측하지 못했지만, 같은 규칙을 따를 가능성이
 * 높아 id 접두사 매칭으로 셋 다 한 번에 찾는다.
 */
function findDashboardRefreshIconsInPage() {
  const isVisible = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const buttons = [...document.querySelectorAll('button.return[id^="btnRefresh"]')].filter(isVisible);
  return buttons.map((btn) => {
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

/** findDashboardRefreshIconsInPage로 찾은 좌표들을 실제 마우스 클릭으로 하나씩 눌러준다. */
async function clickDashboardRefreshIcons(page) {
  const points = await page.evaluate(findDashboardRefreshIconsInPage).catch(() => []);
  for (const { x, y } of points) {
    await page.mouse.move(x, y).catch(() => {});
    await page.mouse.click(x, y).catch(() => {});
  }
  if (points.length) {
    console.log(`[PortalPet] 대시보드 박스 새로고침 아이콘 ${points.length}개 클릭`);
  } else {
    console.log('[PortalPet] 대시보드 새로고침 아이콘을 못 찾음 - 페이지 새로고침으로 대체');
  }
  return points.length > 0;
}

function extractPortalDashboardCounts() {
  const readSection = (selector) => {
    const container = document.querySelector(selector);
    if (!container) return {};
    const map = {};
    container.querySelectorAll('li').forEach((li) => {
      const links = li.querySelectorAll('a');
      if (links.length < 2) return;
      const label = (links[0].textContent || '').trim();
      const value = (links[1].textContent || '').trim();
      if (label) map[label] = value;
    });
    return map;
  };
  return {
    neis: { ...readSection('.aprvWork1'), ...readSection('.aprvWork2') },
    edufine: { ...readSection('.keduBox1'), ...readSection('.keduBox2') },
    edmgr: { ...readSection('.edmgrBox1'), ...readSection('.edmgrBox2') },
  };
}

/**
 * 포털 메인의 나이스 승인사항(미결/협조함) / K-에듀파인 결재(긴급) 현황을 읽어온다. 캐릭터
 * 배지 표시용으로, 사용자가 지정한 주기(기본 5분)마다 백그라운드에서 자동 호출된다 - 그래서
 * launchService/checkEdufineApprovalCount(수동 버튼용)와 달리 끝나고 나서 창을 사용자 앞으로
 * 가져오지 않는다(bringToFront 호출 안 함 - 작업 중인 화면을 방해하지 않기 위함).
 */
async function checkPortalDashboard(subdomain, password, browserProfile = null, browserChannel = 'chrome', options = {}) {
  console.log(`[PortalPet] checkPortalDashboard(${subdomain}, ${browserChannel})`);
  certUserNameToSelect = (options.certUserName || '').trim();
  const { context, isNew } = await getContext(browserProfile, subdomain, browserChannel);

  // (신규, 사용자 요청) shouldOpenNewTabFor는 "마지막으로 쓴 탭"(sharedPage)만 보고 판단하는데,
  // 결재 현황 자동 확인 시점에 sharedPage가 마침 다른 시스템(K-에듀파인 등)에 가 있으면 이미
  // 다른 탭에 "업무포털 메인"이 열려 있는데도 무시하고 또 새 탭을 열어 업무포털 메인을 다시
  // 방문했다. 컨텍스트 전체에서 이미 로그인된 업무포털 메인 탭을 먼저 찾아보고, 있으면 새 탭을
  // 열지 않고 그 탭을 그대로 재사용한다.
  const existingPortalHome = await findExistingPortalHomePage(context, subdomain);
  let page;
  if (existingPortalHome) {
    console.log('[PortalPet] 이미 열려 있는 업무포털 메인 탭을 찾음 - 새 탭을 열지 않고 재사용');
    page = existingPortalHome;
    sharedPage = page;
    mainServiceTabs.add(page);
    await installPopupWatcher(page);
  } else {
    const openNewTab = await shouldOpenNewTabFor('portal_home', subdomain);
    page = openNewTab ? await openFreshTab(context) : await getPage(context);
  }
  await closeExtraPages(context, page);

  // (수정) 사용자 요청 - 메신저/일정 자동 실행을 꺼놔도 결재 현황 자동 확인 때문에 브라우저가
  // 새로 뜨면서 업무포털 메인 화면이 눈에 보이는 문제. 이번 호출에서 브라우저를 방금 새로
  // 띄웠을 때만(재사용이 아니라 콜드 스타트일 때만) 창을 최소화한다 - 이미 떠 있던 창이면
  // 사용자가 보고 있었을 수 있으니 건드리지 않는다.
  if (isNew) {
    await minimizeContextWindow(context, page);
  }

  const alreadyOnPortalHome = (await currentTabSystemGroup(page, subdomain)) === 'portal_home';
  if (alreadyOnPortalHome) {
    console.log('[PortalPet] 이미 포털 홈에 있음 - 재방문 생략');
    await closeAnyPopups(page);
    // (수정) 페이지를 다시 안 불러오면 예전에 읽었던 값을 그대로 다시 읽어올 뿐이라는 사용자
    // 지적으로 추가 - 각 박스의 새로고침 아이콘을 눌러 최신 값을 받아온다. 아이콘을 못 찾으면
    // (화면 구성이 바뀌었을 가능성) 안전하게 페이지 전체를 새로고침해서라도 최신 값을 보장한다.
    const clickedIcons = await clickDashboardRefreshIcons(page);
    if (!clickedIcons) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch((e) =>
        console.log('[PortalPet] 대시보드 새로고침(페이지 리로드) 실패(non-fatal):', e.message)
      );
      await closeAnyPopups(page);
    } else {
      await page.waitForTimeout(500); // 새로고침 아이콘 클릭 후 값이 갱신될 시간을 조금 준다
    }
  } else {
    const portalUrl = buildPortalUrl(subdomain);
    console.log('[PortalPet] navigating to', portalUrl);
    await gotoWithRetry(page, portalUrl, { waitUntil: 'domcontentloaded' });
    const loginResult = await completeCertLoginIfNeeded(page, password);
    console.log('[PortalPet] login result:', loginResult);
    const reachedHome = await ensureLoggedInOnPortalHome(page, portalUrl);
    if (!reachedHome) {
      throw new Error(buildLoginFailureMessage(browserChannel));
    }
  }

  // 나이스 승인사항은 neisLoader()가 페이지 로드 후 별도 AJAX(/bpm_man_mn00_003.do)로 채우는
  // 방식이라(실측 확인) 곧바로 읽으면 빈 목록일 수 있다. K-에듀파인 결재 현황(.keduBox1)도
  // 나이스보다 늦게 DOM에 나타나는 것으로 실측 확인됨(사용자 콘솔 로그: 첫 번째 checkPortalDashboard
  // 호출에서 edufine이 통째로 {}로 찍힘 - 그 직후 두 번째 호출에선 정상 값이 나옴, 즉 그 사이에
  // .keduBox1이 DOM에 생긴 것). (수정) 예전엔 "셀렉터가 DOM에 없으면 통과"로 처리했는데, 이게
  // 문제였다 - .keduBox1이 아직 안 생겼을 때 첫 폴링에서 곧장 "없으니 통과"로 오판해버려서
  // 실제로 나타날 때까지 기다리지 못했다. 이제 "없으면 통과"를 없애고 두 섹션 다 실제로
  // 나타나서 li가 채워질 때까지 기다린다(그래도 못 나타나면 타임아웃 후 있는 데이터로 진행).
  await page.waitForFunction(() => {
    const hasItems = (sel) => {
      const el = document.querySelector(sel);
      return !!el && el.querySelectorAll('li').length > 0;
    };
    return hasItems('.aprvWork1') && hasItems('.keduBox1');
  }, { timeout: 15000 }).catch(() => {
    console.log('[PortalPet] 포털 현황(나이스/K-에듀파인) 로딩 대기 타임아웃(계속 진행) - 일부 데이터가 비어있을 수 있음');
  });

  const result = await page.evaluate(extractPortalDashboardCounts).catch((e) => {
    console.log('[PortalPet] 포털 현황 읽기 실패:', e.message);
    return null;
  });

  if (!result) {
    throw new Error('포털 메인 화면에서 현황 데이터를 찾지 못했습니다. 화면 구성이 바뀌었을 수 있습니다.');
  }
  console.log('[PortalPet] 포털 현황:', result);
  return { ok: true, neis: result.neis, edufine: result.edufine, edmgr: result.edmgr };
}

/**
 * (버그 수정) launchService/checkEdufineApprovalCount는 sharedContext/sharedPage/mainServiceTabs
 * 같은 모듈 전역 상태를 공유한다. 그런데 "프로그램 실행 시 자동 실행(메신저/일정)"이 main.js에서
 * 백그라운드로 진행되는 동안 사용자가 다른 메뉴 버튼을 누르면, 두 launchService 호출이 동시에
 * 진행되면서 서로의 탭을 닫거나 서로 다른 흐름의 페이지 참조를 덮어써 "Target page, context or
 * browser has been closed" 같은 오류로 이어지고 심하면 브라우저 컨텍스트 자체가 죽었다(실측
 * 확인: 부팅 자동 실행의 gone_schedule이 끝나기 전에 "업무포털 메인"을 눌렀더니 재현됨). 렌더러의
 * "launching" 플래그는 렌더러가 직접 시작한 클릭끼리만 막아주고, 백그라운드 자동 실행까지는
 * 못 막는다 - 그래서 엔진 쪽에서 호출을 한 번에 하나씩만 실행되도록 순서를 강제한다.
 */
let taskQueue = Promise.resolve();
function runQueued(fn) {
  const result = taskQueue.then(fn, fn); // 이전 작업이 성공하든 실패하든 다음 작업은 실행돼야 함
  taskQueue = result.then(() => {}, () => {}); // 큐 자체는 실패해도 끊기지 않고 계속 이어짐
  return result;
}

module.exports = {
  launchService: (...args) => runQueued(() => launchService(...args)),
  checkPortalDashboard: (...args) => runQueued(() => checkPortalDashboard(...args)),
};
