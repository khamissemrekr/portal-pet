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
const { app } = require('electron');
const { buildPortalUrl, buildNiceUrl, buildEdufineUrl, GONE_URL_BY_SUBDOMAIN } = require('./regionMap');

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
  if (sharedContext && lastBrowserProfileKey === profileKey) return sharedContext;

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
  return sharedContext;
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
  return sharedPage;
}

/** 지금 sharedPage가 이미(이전 클릭으로) 뭔가 실행된 상태인지 - blank면 "아직 실행 전"으로 본다. */
async function currentSharedPageHasContent() {
  if (!sharedPage || sharedPage.isClosed()) return false;
  try {
    const url = sharedPage.url();
    return !!url && url !== 'about:blank';
  } catch {
    return false;
  }
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
  console.log('[PortalPet] 기존 탭이 이미 사용 중 - 화면을 유지한 채 새 탭을 열어 실행');
  return page;
}

/**
 * 근무상황신청/출장신청 창이 지금 실제로 떠 있는지 즉시(타임아웃 없이) 확인한다. 별도 탭으로
 * 뜬 경우는 closeExtraPages 쪽에서 context.pages() 개수로 이미 판단하니, 여기서는 같은 탭
 * 안에 모달/서브윈도우로 떠 있는 경우만 DOM을 한 번 스캔해서 본다. page.evaluate 한 번이라
 * 없으면 거의 즉시(수 ms) false가 나온다 - 이걸로 불필요한 닫기 시도(수 초 낭비)를 건너뛴다.
 */
async function isNiceRequestPopupVisible(page) {
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
async function closeNiceRequestPopup(page) {
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
    await closeNiceRequestPopup(p).catch(() => {});
    if (!p.isClosed()) {
      await p.close().catch((e) => console.log('[PortalPet] closing leftover page failed (non-fatal):', e.message));
    }
  }
}

/**
 * 인증서 암호 입력이 필요한 상태인지 확인하고, 필요하면 자동 입력한다.
 * 이미 로그인돼 있으면(모달이 없으면) 그냥 통과한다.
 */
async function completeCertLoginIfNeeded(page, password) {
  // 로그인 페이지로 리다이렉트됐으면 "교육행정 전자서명 인증서 로그인" 버튼을 눌러야
  // 인증서 모달이 나타난다. 이미 로그인된 상태 등으로 버튼이 없으면 그냥 넘어간다.
  const loginBtn = page.locator('#btnLgn');
  const hasLoginBtn = await loginBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (hasLoginBtn) {
    console.log('[PortalPet] clicking #btnLgn (교육행정 전자서명 인증서 로그인)...');
    await loginBtn.click();
  } else {
    console.log('[PortalPet] #btnLgn not found/visible - assuming already past login screen');
  }

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
    await el.click();
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
// "오늘 하루 창 열지 않음" / "일주일 창 열지 않음" + "닫기"). 후보를 순서대로 시도한다.
const POPUP_SKIP_CHECKBOX_CANDIDATES = [
  '1주일동안 열지 않기', '오늘 하루 보지 않기', '오늘 하루 이상 열지 않기', '오늘 하루 열지 않기',
  '오늘 하루 창 열지 않음', '일주일 창 열지 않음',
];
const POPUP_CLOSE_BUTTON_CANDIDATES = ['닫기', '확인'];

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
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  for (const text of candidates) {
    const xs = [...document.querySelectorAll('*')]
      .filter((e) => (e.textContent || '').trim() === text && isVisible(e))
      .sort((a, b) => a.children.length - b.children.length);
    if (xs.length) {
      const target = xs[0].closest(closestSelector) || xs[0];
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
function findTopmostDialogCloseButtonInPage() {
  const isVisible = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const dialogs = [...document.querySelectorAll('.cl-dialog, [role="dialog"]')].filter(isVisible);
  if (!dialogs.length) return null;

  const zIndexOf = (e) => {
    const z = parseInt(getComputedStyle(e).zIndex, 10);
    return Number.isFinite(z) ? z : 0;
  };
  let topDialog = dialogs[0];
  let topZ = zIndexOf(topDialog);
  for (let i = 1; i < dialogs.length; i++) {
    const z = zIndexOf(dialogs[i]);
    // z-index가 더 크거나 같으면(동률이면 DOM상 나중에 뜬 쪽을 더 위로 취급) 갱신한다.
    if (z >= topZ) { topDialog = dialogs[i]; topZ = z; }
  }

  const closeIcon = topDialog.querySelector('.cl-dialog-close');
  if (closeIcon && isVisible(closeIcon)) {
    const r = closeIcon.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  const texts = ['닫기', '확인'];
  const candidates = [...topDialog.querySelectorAll('*')]
    .filter((e) => isVisible(e) && texts.includes((e.textContent || '').trim()))
    .sort((a, b) => a.children.length - b.children.length);
  const leaf = candidates[0];
  if (!leaf) return null;
  const target = leaf.closest('button,a,[role="button"]') || leaf;
  const r = target.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

async function closeAnyPopups(page, { maxAttempts = 8 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    // "다시 보지 않기"류 체크박스가 있으면 먼저 체크 - 실패해도(없어도) 무시하고 계속 진행.
    await findAndMouseClick(page, findVisibleLeafCenterInPage, {
      candidates: POPUP_SKIP_CHECKBOX_CANDIDATES,
      closestSelector: 'label,button,a,[role="checkbox"]',
    });

    // ".cl-dialog" 형태의 팝업(나이스 공지사항 등)은 여러 개 겹쳐 뜰 수 있어, 겹침 문제를
    // 피하기 위해 맨 위 다이얼로그 하나만 그 안에서 찾아 닫는다. 여러 개면 이 루프가 돌면서
    // 한 번에 하나씩 닫힌다.
    const closedDialog = await findAndMouseClick(page, findTopmostDialogCloseButtonInPage);
    if (closedDialog) {
      console.log('[PortalPet] closed a dialog popup (topmost, 겹친 다이얼로그 대응)');
      await page.waitForTimeout(200);
      continue;
    }

    // ".cl-dialog" 형태가 아닌 일반 팝업(포털 홈 등)은 기존 방식대로 텍스트로 찾아 닫는다.
    const closed = await findAndMouseClick(page, findVisibleLeafCenterInPage, {
      candidates: POPUP_CLOSE_BUTTON_CANDIDATES,
      closestSelector: 'button,a,[role="button"]',
    });

    if (!closed) break;
    console.log('[PortalPet] closed a popup');
    await page.waitForTimeout(200);
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
    // (수정) 이 함수는 나이스/K-에듀파인/G-ONE 진입 경로가 전부 거쳐가는 공통 관문인데, 예전엔
    // 여기서 공지 팝업을 안 닫아서 openNiceSubMenu/openNiceApproval처럼 "자기 안에서 따로
    // 챙겨준" 함수만 안전하고, 그 외 경로(예: 하위 메뉴 없이 시스템에 바로 들어가는 경우)는
    // 공지 팝업이 안 닫힌 채로 남을 수 있었다 - 어떤 경로로 들어오든 여기서 한 번 닫아준다.
    await closeAnyPopups(page);
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
    await closeAnyPopups(page); // 폴백 경로로 들어간 경우에도 공지 팝업이 뜰 수 있다.
  }
  return page;
}

async function ensureOnPortalHome(page, subdomain) {
  if (!page.url().includes('.eduptl.kr')) {
    await gotoWithRetry(page, buildPortalUrl(subdomain), { waitUntil: 'domcontentloaded' });
    await waitForPortalMenu(page);
    await closeAnyPopups(page);
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
  await closeAnyPopups(page); // 포털 홈 공지 팝업이 이후 메뉴 클릭을 가리지 않도록 먼저 닫는다
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
async function clickEdufineMegaMenu(page, menuName) {
  const handle = await page.evaluateHandle((n) => {
    const v = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.x >= 0; };
    const xs = [...document.querySelectorAll('[id*="pdvMegaMenu"]')]
      .filter((e) => (e.textContent || '').trim() === n && v(e));
    return xs.find((x) => x.id.endsWith(':text')) || xs.at(-1) || null;
  }, menuName);
  const el = handle.asElement();
  if (!el) {
    console.log(`[PortalPet] K-에듀파인 메뉴 "${menuName}"을 찾지 못함`);
    return false;
  }
  await el.click();
  console.log(`[PortalPet] clicked K-에듀파인 mega menu "${menuName}"`);
  return true;
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
    return [...document.querySelectorAll('[id*="pdvMegaMenu"]')].some((e) => {
      const r = e.getBoundingClientRect();
      return norm(e.textContent) === n && r.width > 0 && r.height > 0 && r.x >= 0;
    });
  }, leafLabel).catch(() => false);

  if (await isLeafVisible()) return true;

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
async function clickNiceTaskControl(page, tabName, controlText) {
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
  await el.click();
  console.log(`[PortalPet] clicked 나이스 "${tabName}" 탭의 "${controlText}" 버튼`);
  return true;
}

/**
 * 나이스 좌측 "복무" 메뉴는 클릭만으론 하위 항목(개인근무상황관리/개인출장관리 등)이
 * 안 펼쳐지고 별도의 펼침 아이콘을 눌러야 하는 경우가 있다. 하위 메뉴가 이미 보이면
 * 아무것도 안 하고, 안 보이면 "복무" 항목의 펼침 아이콘을 찾아 누른다.
 */
async function ensureNiceDutyMenuExpanded(page, subMenuLabel) {
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
  await el.click();
  console.log('[PortalPet] clicked 나이스 복무 메뉴 펼침 아이콘');
  await page.waitForTimeout(750);
  return isSubMenuVisible();
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
  if (system === 'nice') return host === `${subdomain}.neis.go.kr`;
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
async function openNiceSubMenu(page, subdomain, taskTabName, password, alreadyOnNice = false) {
  let target = page;
  if (alreadyOnNice) {
    console.log('[PortalPet] 이미 나이스에 있음 - 포털 홈 재방문 생략');
  } else {
    await ensureOnPortalHome(page, subdomain);
    target = await goToPortalMenu(page, '나이스', { fallbackUrl: buildNiceUrl(subdomain), password });
    await target.waitForTimeout(1500);
  }
  // (수정) 공지사항 팝업은 나이스에 "처음" 들어갈 때만 뜨는 게 아니라, 이미 나이스에 있는
  // 상태(alreadyOnNice)에서도(예: 다른 메뉴를 갔다가 다시 나이스 결재/복무 등을 누를 때)
  // 다시 뜨는 경우가 실측 확인됨 - 이전엔 alreadyOnNice일 때 이 호출이 아예 생략돼서 공지
  // 팝업이 안 닫힌 채로 남아 있었다(사용자가 스크린샷으로 재현 확인). alreadyOnNice 여부와
  // 무관하게 매번 먼저 닫아준다 - 팝업이 없으면 closeAnyPopups는 거의 즉시 끝난다.
  await closeAnyPopups(target);
  // (수정) 근무상황신청 다이얼로그는 화면 전체를 덮지 않는 플로팅 창이라, 좌측 "복무" 메뉴가
  // 시각적으로 가려지지 않아 클릭 자체는 "성공"해버릴 수 있다(다이얼로그는 그대로 열린 채).
  // 그래서 클릭 실패 여부와 무관하게, 먼저 열려 있는지부터 확인해서 선제적으로 닫는다.
  if (alreadyOnNice && (await isNiceRequestPopupVisible(target))) {
    console.log('[PortalPet] "복무" 클릭 전 신청서 창이 열려 있음 확인 - 먼저 닫기');
    await closeNiceRequestPopup(target);
  }
  let dutyClicked = await clickText(target, '복무');
  if (!dutyClicked && alreadyOnNice) {
    // 이전 화면(예: 신청서 작성 폼)이 같은 탭에서 좌측 메뉴 자체를 가리고 있을 수 있다.
    // 먼저 실제로 그 창이 떠 있는지 즉시 확인(수 ms)한 뒤 - 떠 있을 때만 닫기 절차를 시도해서
    // 괜히 없는 창을 찾느라 시간을 낭비하지 않는다. 그래도 안 되면 나이스 기본 화면으로 재이동.
    const popupVisible = await isNiceRequestPopupVisible(target);
    if (popupVisible) {
      console.log('[PortalPet] "복무" 클릭 실패 - 신청서 창이 떠 있음, 닫기 시도');
      await closeNiceRequestPopup(target);
      dutyClicked = await clickText(target, '복무');
    } else {
      console.log('[PortalPet] "복무" 클릭 실패 - 신청서 창은 안 보임, 바로 기본 화면으로 재이동');
    }
    if (!dutyClicked) {
      console.log('[PortalPet] 여전히 실패 - 나이스 기본 화면으로 재이동해서 복구 시도');
      await target.goto(buildNiceUrl(subdomain), { waitUntil: 'domcontentloaded' }).catch((e) =>
        console.log('[PortalPet] 나이스 기본 화면 재이동 실패:', e.message)
      );
      await target.waitForTimeout(1200);
      await closeAnyPopups(target); // 재이동한 화면에도 공지 팝업이 새로 뜰 수 있다.
      dutyClicked = await clickText(target, '복무');
    }
  }
  await target.waitForTimeout(500);
  await ensureNiceDutyMenuExpanded(target, taskTabName);
  await clickText(target, taskTabName);
  await target.waitForTimeout(800);
  const clicked = await clickNiceTaskControl(target, taskTabName, '신청');
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
async function openNiceApproval(page, subdomain, password, alreadyOnNice = false) {
  let target = page;
  if (alreadyOnNice) {
    console.log('[PortalPet] 이미 나이스에 있음 - 포털 홈 재방문 생략');
  } else {
    await ensureOnPortalHome(page, subdomain);
    target = await goToPortalMenu(page, '나이스', { fallbackUrl: buildNiceUrl(subdomain), password });
    await target.waitForTimeout(1500);
  }
  // (수정) alreadyOnNice일 때도(이미 나이스에 있다가 "나이스 결재"를 다시 누르는 경우 등)
  // 공지사항 팝업이 다시 뜰 수 있는데, 예전엔 이 호출이 fresh-navigation 분기 안에만 있어서
  // alreadyOnNice면 아예 건너뛰었다 - 그래서 "미결/협조함" 클릭 전에 팝업이 안 닫힌 채로
  // 남는 문제가 있었다(스크린샷으로 재현 확인). 매번 먼저 닫아준다.
  await closeAnyPopups(target);
  // 근무상황신청 등 신청서 창이 좌측 메뉴를 가리고 있을 수 있으니 먼저 확인 후 닫는다
  // (openNiceSubMenu와 동일한 이유 - 다이얼로그가 화면 전체를 덮지 않아 클릭이 조용히 씹힐 수 있음).
  if (alreadyOnNice && (await isNiceRequestPopupVisible(target))) {
    await closeNiceRequestPopup(target);
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

async function clickFirstMatchFollowingPopup(context, page, candidates, { timeout = 6000, exact = false } = {}) {
  for (const text of candidates) {
    let el;
    try {
      el = page.getByText(text, { exact }).first();
      await el.waitFor({ state: 'visible', timeout });
    } catch (e) {
      console.log(`[PortalPet] could not find "${text}" (exact:${exact}):`, e.message);
      continue;
    }

    const popupPromise = context.waitForEvent('page', { timeout: 2000 }).catch(() => null);
    await el.click();
    console.log(`[PortalPet] clicked "${text}" (exact:${exact}), watching for a new tab...`);

    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      if (await isBrityMessengerLauncherPage(popup)) {
        console.log(`[PortalPet] "${text}" opened a Brity Messenger native-launch bridge tab (not a real screen) - keeping the original G-ONE tab, giving the native app time to launch before closing the bridge`);
        // (수정) 0.6초는 너무 짧아서 brityaltsso://가 실제로 크롬 -> OS -> Brity 메신저 앱으로
        // 넘어갈 시간이 부족했을 수 있다(실측 확인: 로그상 정상 동작했는데도 메신저가 안 뜸) -
        // 넉넉히 3초 기다린 뒤 닫는다.
        await popup.waitForTimeout(3000).catch(() => {});
        await popup.close().catch((e) => console.log('[PortalPet] closing messenger bridge tab failed (non-fatal):', e.message));
        return { page, found: true };
      }
      console.log(`[PortalPet] "${text}" click opened a new tab - switching to it and closing the old tab`);
      if (sharedPage === page) sharedPage = popup;
      mainServiceTabs.add(popup);
      mainServiceTabs.delete(page);
      popup.on('close', () => {
        mainServiceTabs.delete(popup);
        if (sharedPage === popup) sharedPage = null;
      });
      await page.close().catch((e) => console.log('[PortalPet] closing old tab failed (non-fatal):', e.message));
      return { page: popup, found: true };
    }
    return { page, found: true };
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
  if (alreadyOnGone) {
    console.log('[PortalPet] 이미 G-ONE에 있음 - 포털 홈 재방문 생략');
  } else {
    await ensureOnPortalHome(page, subdomain);
    target = await goToPortalMenu(page, 'G-ONE', { fallbackUrl: GONE_URL_BY_SUBDOMAIN[subdomain] || null, password });
    await target.waitForTimeout(900);
  }
  // G-ONE 기본 진입 화면(AI 대화·초안 탭)에 공지 팝업이 뜨는 경우가 있다(실측 확인:
  // "오늘 하루 보지 않기" + "확인"). 하위 메뉴를 클릭하기 전에 먼저 치워야 클릭이 안 막힌다.
  await closeAnyPopups(target);
  const result = await clickFirstMatchFollowingPopup(context, target, candidates);
  target = result.page;
  if (!result.found) {
    console.log(`[PortalPet] G-ONE sub-menu not found among candidates [${candidates.join(', ')}] - staying on G-ONE home`);
  } else {
    await refocusIgnoringLatecomers(context, target);
    await closeAnyPopups(target); // 이동한 화면에도 팝업이 뜰 수 있으니 한 번 더
  }
  return target;
}

// 서비스 버튼 키 -> 어느 시스템에 속하는지. 이미 그 시스템 안에 있으면 포털 홈을 다시
// 거칠 필요가 없다(사용자 제안: "나이스에 있는지 에듀파인에 있는지 G-ONE에 있는지에 따라
// 다시 포털 화면으로 나가지 않고 바로 다른 메뉴로 이동").
const SERVICE_SYSTEM = {
  nice: 'nice', bokmu: 'nice', trip: 'nice', nice_approval: 'nice',
  edufine: 'edufine', giahn: 'edufine', pumui: 'edufine', edufine_approval: 'edufine',
  gone: 'gone', gone_msg: 'gone', gone_ai: 'gone', gone_schedule: 'gone',
};

/**
 * PortalPet에서 서비스 버튼 클릭 시 호출되는 진입점.
 */
async function launchService(serviceKey, subdomain, password, browserProfile = null, browserChannel = 'chrome') {
  console.log(`[PortalPet] launchService(${serviceKey}, ${subdomain}, ${browserChannel})`);
  const context = await getContext(browserProfile, subdomain, browserChannel);
  // (수정) 이미 다른 화면이 떠서 사용 중이면(사용자가 방금 전 메뉴로 연 화면이 아직 열려 있으면)
  // 그 화면을 그대로 두고 이번 클릭은 새 탭에서 실행한다 - 예전엔 항상 같은 탭을 재사용해서
  // 이미 열어둔 작업 화면이 새 메뉴 클릭에 밀려 사라지는 문제가 있었다(사용자 요청으로 확인).
  const openNewTab = await currentSharedPageHasContent();
  const page = openNewTab ? await openFreshTab(context) : await getPage(context);
  await closeExtraPages(context, page); // 이전 클릭이 남겨둔 신청서 작성 창 등 정리 (다른 탭/창)
  // (수정) 근무상황신청/출장신청 창은 새 탭이 아니라 같은 페이지 안의 오버레이 다이얼로그로
  // 뜬다는 게 실측으로 확인됨 - closeExtraPages는 "다른" 페이지만 검사하므로 이 경우를
  // 놓친다. keep하는 page 자기 자신도 검사해서 열려 있으면 닫는다.
  // (성능 수정) 이 검사는 NICE 전용(.cl-dialog-close 등)인데, 이전엔 K-에듀파인/G-ONE으로
  // 갈 때도 매번 돌고 있었다 - document.querySelectorAll('*') 전체 스캔이라 무거운 화면에서는
  // 불필요한 지연이 된다. 현재 탭이 NICE에 있을 때만 검사하도록 제한한다(URL만 보는 가벼운
  // 체크라 비용이 거의 없다).
  if ((await isOnSystem(page, 'nice', subdomain)) && (await isNiceRequestPopupVisible(page))) {
    console.log('[PortalPet] 현재 탭에 신청서 창(오버레이)이 열려 있음 - 닫기 시도');
    await closeNiceRequestPopup(page);
  }

  const targetSystem = SERVICE_SYSTEM[serviceKey] || null;
  const alreadyInTargetSystem = targetSystem ? await isOnSystem(page, targetSystem, subdomain) : false;

  let loggedIn = true;

  if (alreadyInTargetSystem) {
    console.log(`[PortalPet] 이미 ${targetSystem}에 있음 - 포털 홈 재방문 없이 바로 하위 메뉴로 이동`);
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
      throw new Error(
        '인증서 로그인이 완료되지 않은 것 같습니다 (로그인 페이지에 머물러 있음). ' +
        '비밀번호나 인증서 상태를 확인한 뒤 다시 시도해 주세요.'
      );
    }
  }

  // 폴백(직접 URL)으로 빠졌을 때 그 시스템 자체 인증서 로그인 창이 다시 뜨면 같은 비밀번호로
  // 한 번 더 자동 로그인하도록 password를 넘긴다.
  let targetPage = page;
  switch (serviceKey) {
    case 'portal_home':
      // 위의 공통 진입 절차(포털 홈 이동 + 로그인 + closeAnyPopups)만으로 이미 목적지에 도착한
      // 상태라 추가로 할 일이 없다 - 그대로 머무른다.
      console.log('[PortalPet] 업무포털 메인 화면에 머무름');
      targetPage = page;
      break;
    case 'nice':
      if (alreadyInTargetSystem) {
        // (수정) 이미 나이스에 있는 상태에서 "나이스" 헤더 버튼을 다시 눌렀을 때는 goToPortalMenu를
        // 아예 안 거쳐서 공지 팝업을 안 닫아주고 있었다(실측 확인) - 여기서도 닫아준다.
        await closeAnyPopups(page);
        targetPage = page;
      } else {
        targetPage = await goToPortalMenu(page, '나이스', { fallbackUrl: buildNiceUrl(subdomain), password });
      }
      break;
    case 'edufine':
      if (alreadyInTargetSystem) {
        await closeAnyPopups(page); // 나이스와 동일한 이유
        targetPage = page;
      } else {
        targetPage = await goToPortalMenu(page, 'K-에듀파인', { fallbackUrl: buildEdufineUrl(subdomain), password });
      }
      break;
    case 'gone':
      // 포털 메뉴 실측 라벨: "업무협업G-ONE"
      if (alreadyInTargetSystem) {
        await closeAnyPopups(page); // 나이스와 동일한 이유
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
      targetPage = await openNiceSubMenu(page, subdomain, '개인근무상황관리', password, alreadyInTargetSystem);
      break;
    case 'trip':
      targetPage = await openNiceSubMenu(page, subdomain, '개인출장관리', password, alreadyInTargetSystem);
      break;
    case 'nice_approval':
      targetPage = await openNiceApproval(page, subdomain, password, alreadyInTargetSystem);
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
    default:
      console.log(`[PortalPet] unknown serviceKey "${serviceKey}" - staying on portal home`);
  }

  await targetPage.bringToFront();
  console.log('[PortalPet] launchService done, loggedIn:', loggedIn);
  return { ok: true, loggedIn };
}

/**
 * K-에듀파인 화면 상단 상태바에는 "결재(긴급) N(N)" 형태의 배지가 있다(실측 확인: 스크린샷).
 * WebDRM이 우클릭/개발자도구(F12) UI는 막아도, Playwright는 CDP를 통해 페이지 컨텍스트에서
 * 직접 JS를 실행하므로(page.evaluate) DOM 텍스트를 읽는 것 자체는 막히지 않는다 - 기존의
 * 모든 자동 클릭(findAndMouseClick 등)도 같은 방식으로 이미 동작하고 있다. 정확한 선택자를
 * 알아내지 못했으므로, 화면에 보이는 요소 중 이 패턴과 정확히 일치하는(자식 요소가 가장 적은
 * = 가장 구체적인) 요소를 찾는 텍스트 기반 방식을 쓴다.
 */
function findEdufineApprovalCountInPage() {
  const isVisible = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const regex = /결재\s*\(\s*긴급\s*\)\s*([0-9]+)\s*\(\s*([0-9]+)\s*\)/;
  const matches = [...document.querySelectorAll('*')]
    .filter(isVisible)
    .map((e) => ({ e, text: (e.textContent || '').replace(/\s+/g, ' ').trim() }))
    .filter(({ text }) => regex.test(text))
    .sort((a, b) => a.e.children.length - b.e.children.length);
  if (!matches.length) return null;
  const m = matches[0].text.match(regex);
  return { total: parseInt(m[1], 10), urgent: parseInt(m[2], 10) };
}

/**
 * 결재 대기 문서 건수를 확인한다(캐릭터에 배지로 표시하기 위한 용도). launchService와 달리
 * 화면 전환 없이(이미 K-에듀파인에 있으면 그 화면 그대로) 상태바 배지만 읽고 끝낸다.
 */
async function checkEdufineApprovalCount(subdomain, password, browserProfile = null, browserChannel = 'chrome') {
  console.log(`[PortalPet] checkEdufineApprovalCount(${subdomain}, ${browserChannel})`);
  const context = await getContext(browserProfile, subdomain, browserChannel);
  const page = await getPage(context);
  await closeExtraPages(context, page);

  const alreadyOnEdufine = await isOnSystem(page, 'edufine', subdomain);
  let target = page;
  if (alreadyOnEdufine) {
    console.log('[PortalPet] 이미 K-에듀파인에 있음 - 포털 홈 재방문 생략');
    await closeAnyPopups(target);
  } else {
    const portalUrl = buildPortalUrl(subdomain);
    console.log('[PortalPet] navigating to', portalUrl);
    await gotoWithRetry(page, portalUrl, { waitUntil: 'domcontentloaded' });
    const loginResult = await completeCertLoginIfNeeded(page, password);
    console.log('[PortalPet] login result:', loginResult);
    const reachedHome = await ensureLoggedInOnPortalHome(page, portalUrl);
    if (!reachedHome) {
      throw new Error(
        '인증서 로그인이 완료되지 않은 것 같습니다 (로그인 페이지에 머물러 있음). ' +
        '비밀번호나 인증서 상태를 확인한 뒤 다시 시도해 주세요.'
      );
    }
    target = await goToPortalMenu(page, 'K-에듀파인', { fallbackUrl: buildEdufineUrl(subdomain), password });
  }

  await waitForEdufineReady(target);
  await target.waitForTimeout(500); // 상단 상태바 렌더링 여유
  const result = await target.evaluate(findEdufineApprovalCountInPage).catch((e) => {
    console.log('[PortalPet] 결재 건수 배지 읽기 실패:', e.message);
    return null;
  });

  await target.bringToFront();

  if (!result) {
    throw new Error('결재 건수 배지를 화면에서 찾지 못했습니다. K-에듀파인 화면 구성이 바뀌었을 수 있습니다.');
  }
  console.log('[PortalPet] 결재 건수:', result);
  return { ok: true, total: result.total, urgent: result.urgent };
}

module.exports = { launchService, checkEdufineApprovalCount };
