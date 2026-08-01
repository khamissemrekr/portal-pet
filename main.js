// PortalPet - main.js
// clawd-on-desk(https://github.com/rullerzhou-afk/clawd-on-desk)의 "미니 모드"(화면 가장자리에
// 숨어 있다가 마우스를 올리면 튀어나오는 방식)와 시스템 트레이 UX를 참고해 새로 구현.
// 코드/아트워크는 그대로 가져오지 않고, 우리 목적(원클릭 업무포털 접속)에 맞게 최소 구성으로 재작성.

const { app, BrowserWindow, Tray, Menu, screen, ipcMain, shell, Notification, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { autoUpdater } = require('electron-updater');
const credentialStore = require('./engine/credentialStore');
const loginEngine = require('./engine/loginEngine');
const { REGIONS } = require('./engine/regionMap');
const { listBrowserProfiles } = require('./engine/browserProfiles');
const { startDialogSuppressor, stopDialogSuppressor } = require('./engine/dialogSuppressor');
const { startFileLogger, getLogFilePath } = require('./engine/fileLogger');

// 배포판(패키지된 exe)은 콘솔 창이 없어서 console.log를 볼 방법이 없다 - 이번 세션에서 겪은
// 여러 버그가 전부 npm start(터미널 보이는 개발 모드)에서 붙여받은 로그로만 진단 가능했다.
// 트레이 메뉴의 "로그 폴더 열기"로 사용자가 이 파일을 쉽게 찾아 보내줄 수 있게 한다.
startFileLogger(app.getPath('userData'));

// Windows 알림에 "Electron" 대신 "PortalPet"으로 표시되도록 AppUserModelID를 지정한다
// (package.json build.appId와 동일한 값 - 나중에 배포판이 그 id로 시작 메뉴 바로가기를 만듦).
// (주의) app.setName()으로 앱 이름 자체를 바꾸는 방법도 있지만, app.getPath('userData')가
// 그 이름(package.json "name": "portal-pet")을 그대로 폴더명으로 쓰고 있어서 - loginEngine의
// browser-profile 폴더, credentialStore의 저장된 설정/비밀번호가 전부 그 경로 아래 있다 -
// 이름을 바꾸면 기존에 저장돼 있던 프로필/설정을 다른 폴더에서 찾게 돼 못 보게 되는 부작용이
// 있다. 그래서 저장 경로와 무관한 AppUserModelID만 따로 지정한다.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.portalpet.app');
}

// ===== 설정 =====
const PET_SIZE = 96;          // 대기 상태 캐릭터 크기(px)
const PANEL_WIDTH = 300;      // 펼침 패널 폭(px) - 3열 메뉴 구조라 기존보다 넓힘
const PANEL_HEIGHT = 360;     // 펼침 패널 높이(px)
const EDGE_MARGIN = 8;        // 화면 가장자리에서 살짝 보이는 여백(px), 미니모드일 때
const HOVER_POLL_MS = 150;
const RELEASES_URL = 'https://github.com/khamissemrekr/portal-pet/releases'; // 자동 확인 실패 시 안내용

let win;
let setupWin;
let aboutWin;
let tray;
let isExpanded = false;
let isMiniMode = false;
let hoverTimer = null;

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;

  win = new BrowserWindow({
    width: PET_SIZE,
    height: PET_SIZE,
    x: sw - PET_SIZE - 40,
    y: Math.round(sh / 2 - PET_SIZE / 2),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setAlwaysOnTop(true, 'screen-saver');

  win.on('closed', () => {
    win = null;
    stopHoverWatch();
  });

  // 클릭 스루는 쓰지 않음(캐릭터 자체가 클릭 대상이라). 필요 시 렌더러에서
  // -webkit-app-region 등으로 드래그 가능 영역만 분리.
}

// win이 죽어있으면(크래시/닫힘 등 어떤 이유로든) 다시 만든다. 트레이 클릭 등
// 언제 어디서 호출될지 모르는 진입점들은 전부 이걸 먼저 거치게 한다.
function ensureWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    isExpanded = false;
  }
}

// 메뉴(펼침 패널) 자동 닫힘 타이머 - 설정에서 켠 경우, 펼친 뒤 지정한 시간이 지나면 자동으로
// 접는다. 사용자가 그 전에 직접 접거나 다시 펼치면 이전 타이머는 지우고 새로 잡는다.
let panelAutoCloseTimer = null;
function clearPanelAutoCloseTimer() {
  if (panelAutoCloseTimer) clearTimeout(panelAutoCloseTimer);
  panelAutoCloseTimer = null;
}

function togglePanel() {
  ensureWindow();
  isExpanded = !isExpanded;
  const bounds = win.getBounds();
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;

  clearPanelAutoCloseTimer();

  if (isExpanded) {
    const newWidth = PET_SIZE + PANEL_WIDTH;
    const newHeight = Math.max(PET_SIZE, PANEL_HEIGHT);
    win.setBounds({
      x: Math.max(0, sw - newWidth - 40),
      y: Math.min(bounds.y, sh - newHeight - 20),
      width: newWidth,
      height: newHeight,
    });
    const config = credentialStore.loadConfig();
    if (config.panelAutoCloseEnabled) {
      const ms = Math.max(1, Number(config.panelAutoCloseSeconds) || 10) * 1000;
      panelAutoCloseTimer = setTimeout(() => {
        panelAutoCloseTimer = null;
        if (isExpanded) togglePanel(); // 그 사이 사용자가 직접 접었으면(isExpanded=false) 아무것도 안 함
      }, ms);
    }
  } else {
    win.setBounds({ ...bounds, width: PET_SIZE, height: PET_SIZE });
  }
  win.webContents.send('panel-state', isExpanded);
}

// ===== 미니 모드: 화면 오른쪽 가장자리에 숨었다가 커서를 올리면 튀어나옴 =====
function enterMiniMode() {
  ensureWindow();
  isMiniMode = true;
  const display = screen.getPrimaryDisplay();
  const { width: sw } = display.workAreaSize;
  const bounds = win.getBounds();
  win.setBounds({ ...bounds, x: sw - EDGE_MARGIN, width: PET_SIZE });
  startHoverWatch();
}

function exitMiniMode() {
  isMiniMode = false;
  stopHoverWatch();
}

function startHoverWatch() {
  stopHoverWatch();
  let peeking = false;
  hoverTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { stopHoverWatch(); return; }
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const nearEdge = cursor.x >= bounds.x - 20 &&
      cursor.y >= bounds.y - 20 && cursor.y <= bounds.y + bounds.height + 20;

    if (nearEdge && !peeking) {
      peeking = true;
      const display = screen.getPrimaryDisplay();
      win.setBounds({ ...bounds, x: display.workAreaSize.width - PET_SIZE - 10 });
    } else if (!nearEdge && peeking) {
      peeking = false;
      const display = screen.getPrimaryDisplay();
      win.setBounds({ ...bounds, x: display.workAreaSize.width - EDGE_MARGIN });
    }
  }, HOVER_POLL_MS);
}

function stopHoverWatch() {
  if (hoverTimer) clearInterval(hoverTimer);
  hoverTimer = null;
}

// Windows 시작 시 자동 실행 - 트레이 메뉴 체크박스와 설정 창 체크박스 둘 다 같은 OS 설정
// (app.getLoginItemSettings)을 그대로 읽고 쓴다. 함수로 묶어서 개발 모드(npm start) 우회
// 로직(아래 주석)을 한 곳에서만 관리한다.
function getAutoStartOnLogin() {
  return app.getLoginItemSettings().openAtLogin;
}
function setAutoStartOnLogin(enabled) {
  // 개발 모드(npm start)에서 이 옵션을 켜면 path가 electron.exe만 가리켜서(앱 경로 없이) 부팅 시
  // Electron 기본 화면만 뜨는 문제가 있었다. app.isPackaged일 때만 기본값(process.execPath)을
  // 쓰고, 개발 모드에서는 실제 앱 폴더를 args로 명시해 같은 문제가 재발하지 않게 한다.
  const settings = app.isPackaged
    ? { openAtLogin: enabled }
    : { openAtLogin: enabled, path: process.execPath, args: [path.resolve(process.argv[1] || '.')] };
  app.setLoginItemSettings(settings);
}

// ===== 트레이 =====
function createTray() {
  tray = new Tray(path.join(__dirname, 'theme', 'tray-icon.png'));
  // (수정) 구분선이 너무 많다는 사용자 지적으로 3그룹(핵심 조작 / 부가 기능·정보 / 종료)으로
  // 정리 - 구분선 4개(개발 모드 기준)에서 2개로 줄었다. '설정' 라벨도 예전엔 "설정 (지역/
  // 비밀번호)"였는데, 이제 메뉴 패널 하단 톱니 아이콘으로도 설정을 열 수 있어 괄호 설명이
  // 중복이라 단순화했다.
  const menu = Menu.buildFromTemplate([
    { label: '설정', click: openSetupWindow },
    { label: '펼치기/접기', click: togglePanel },
    // (수정) 사용자 요청으로 당장은 필요 없어서 숨김 - enterMiniMode/exitMiniMode 등 기능 코드는 그대로 둔다.
    // { label: '미니 모드', type: 'checkbox', checked: false, click: (item) => item.checked ? enterMiniMode() : exitMiniMode() },
    { type: 'separator' },
    { label: 'Windows 시작 시 자동 실행', type: 'checkbox', checked: getAutoStartOnLogin(),
      click: (item) => setAutoStartOnLogin(item.checked) },
    // (임시/테스트용) 실제 포털 로그인 없이도 알림+배지가 어떻게 보이는지 바로 확인할 수 있도록
    // 임의 값으로 "증가" 상황을 흉내낸다. main.js가 그대로 패키징되는 electron-builder 특성상
    // 수동으로 지우지 않으면 배포판에도 남으므로, app.isPackaged로 개발 모드(npm start)에서만
    // 보이도록 걸러서 npm run dist로 만든 배포판에는 자동으로 빠지게 한다.
    ...(app.isPackaged ? [] : [
      { label: '테스트: 결재/승인 알림 미리보기 (임의 값)', click: testDashboardNotification },
    ]),
    // 문제가 생겼을 때 사용자가 개발자 도구 없이도 로그 파일을 바로 찾아 보낼 수 있도록.
    { label: '로그 폴더 열기', click: () => {
      const logPath = getLogFilePath();
      if (logPath) shell.showItemInFolder(logPath);
      else console.error('[PortalPet] 로그 파일이 아직 준비되지 않음');
    } },
    // (수정) "버전 x.x.x" 표시 + "새 버전 확인" 링크 열기 두 항목을, 버전/새 버전 확인 버튼/문의를
    // 한 곳에 모은 "프로그램 정보" 창 하나로 통합(사용자 요청).
    { label: '프로그램 정보', click: openAboutWindow },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]);
  tray.setToolTip('PortalPet - 원클릭 업무포털');
  tray.setContextMenu(menu);
  tray.on('click', togglePanel);
}

// ===== 서비스 실행: 렌더러의 버튼 클릭 -> Playwright 엔진 호출 =====
ipcMain.handle('launch-service', async (_evt, serviceKey, regionInput) => {
  const config = credentialStore.loadConfig();
  const autoLogin = config.autoLogin !== false; // 기본값: 자동 로그인 켜짐
  if (autoLogin && !config.encryptedPasswordBase64) {
    return { ok: false, error: 'not-configured' };
  }
  const subdomain = REGIONS[regionInput] || regionInput; // 지역명(예: "경기") 또는 서브도메인 직접 입력 모두 허용
  // "자동 로그인"을 꺼둔 경우 password를 null로 넘긴다 - loginEngine이 자동 입력 없이 사용자가
  // 인증서 창에 직접 입력할 때까지 기다려준다.
  const password = (autoLogin && config.encryptedPasswordBase64)
    ? credentialStore.decryptPassword(config.encryptedPasswordBase64)
    : null;

  try {
    const result = await loginEngine.launchService(serviceKey, subdomain, password, config.browserProfile || null, config.browserChannel || 'chrome');
    return result;
  } catch (err) {
    console.error('[PortalPet] launch-service failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

// channel: 'chrome' | 'msedge' - 설정 창에서 브라우저를 바꾸면 그 브라우저의 프로필 목록을 다시 읽어온다.
ipcMain.handle('list-browser-profiles', (_evt, channel) => listBrowserProfiles(channel || 'chrome'));
// autoStartOnLogin은 config.json이 아니라 OS 자체 설정(app.getLoginItemSettings)이라 여기서
// 합쳐서 내려준다 - 설정 창이 매번 최신 상태를 그대로 보여줄 수 있도록.
ipcMain.handle('get-config', () => ({
  ...credentialStore.loadConfig(),
  autoStartOnLogin: getAutoStartOnLogin(),
}));

ipcMain.handle('toggle-panel', () => togglePanel());
// 메뉴 하단의 톱니 아이콘에서 설정 창을 바로 열 수 있도록(트레이 메뉴를 거치지 않고).
ipcMain.handle('open-setup-window', () => openSetupWindow());
ipcMain.handle('open-external', (_evt, url) => shell.openExternal(url));

// ===== 프로그램 정보 창용 =====
ipcMain.handle('get-app-version', () => app.getVersion());
// 정보 창에서 버튼을 눌러 확인하는 경우 - 사용자가 직접 누른 것이므로 결과(최신/오류)도 항상 알려준다.
ipcMain.handle('check-for-updates', (evt) => checkForUpdates(true, BrowserWindow.fromWebContents(evt.sender)));

// ===== 드래그로 펫 위치 이동 =====
// 렌더러가 mousemove마다 스크린 좌표 델타(dx, dy)를 보내면 그만큼 창을 옮긴다. frame:false라
// -webkit-app-region: drag를 못 쓰는(클릭 토글과 충돌) 대신 직접 구현. 드래그 중엔 미니모드의
// 가장자리 자동 이동과 겹치지 않도록 미니모드를 잠시 꺼둔다.
ipcMain.on('move-pet-by', (_evt, dx, dy) => {
  if (!win || win.isDestroyed()) return;
  if (isMiniMode) exitMiniMode();
  const b = win.getBounds();
  win.setBounds({ ...b, x: Math.round(b.x + dx), y: Math.round(b.y + dy) });
});

// ===== 최초 설정(지역 + 인증서 비밀번호) =====
function openSetupWindow() {
  if (setupWin) { setupWin.focus(); return; }
  // (수정) 항목이 많아서(브라우저/프로필/투명도/자동확인/자주 가는 사이트/자동 실행 등) 360x460으론
  // 좁고 잘려 보인다는 사용자 피드백 - 가로/세로를 넉넉하게 키움.
  setupWin = new BrowserWindow({
    width: 460, height: 720, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; });
}

// ===== 프로그램 정보(버전 / 새 버전 확인 / 문의) =====
function openAboutWindow() {
  if (aboutWin) { aboutWin.focus(); return; }
  aboutWin = new BrowserWindow({
    width: 360, height: 320, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  aboutWin.setMenuBarVisibility(false);
  aboutWin.loadFile(path.join(__dirname, 'renderer', 'about.html'));
  aboutWin.on('closed', () => { aboutWin = null; });
}

// 예전엔 GitHub Releases API로 최신 버전만 확인하고, 새 버전이 있으면 다운로드 링크를 열어준
// 뒤 설치는 사용자가 직접 했다(수동 다운로드+실행). electron-updater로 바꿔서 확인→다운로드→
// 설치까지 자동화한다 - package.json build.publish(GitHub, releaseType: 'release')를 그대로
// 재사용하므로 배포 설정은 추가로 손댈 게 없다.
autoUpdater.autoDownload = false; // 사용자에게 먼저 물어보고 다운로드(무단으로 큰 파일 받지 않도록)
autoUpdater.autoInstallOnAppQuit = true; // 다운로드는 해뒀는데 "나중에"를 고른 경우, 다음 종료 시 자동 설치

// 이벤트가 전역이라(체크할 때마다 리스너를 새로 달면 중복 호출됨) 마지막으로 확인을 요청한
// 컨텍스트만 기억해뒀다가 이벤트 핸들러에서 그 컨텍스트 기준으로 대화상자를 띄운다.
let updateCheckContext = { showResultDialog: false, parentWindow: null };
function showUpdateBox(opts) {
  const { parentWindow } = updateCheckContext;
  return (parentWindow && !parentWindow.isDestroyed())
    ? dialog.showMessageBox(parentWindow, opts)
    : dialog.showMessageBox(opts);
}

autoUpdater.on('error', (err) => {
  console.error('[PortalPet] 새 버전 확인/다운로드 오류:', err);
  if (updateCheckContext.showResultDialog) {
    showUpdateBox({
      type: 'error',
      title: '새 버전 확인 실패',
      message: '새 버전을 확인하거나 내려받지 못했습니다. 인터넷 연결을 확인해 주세요.',
      detail: err.message || String(err),
      buttons: ['릴리즈 페이지 열기', '닫기'],
      defaultId: 1,
      cancelId: 1,
    }).then(({ response }) => { if (response === 0) shell.openExternal(RELEASES_URL); });
  }
});

autoUpdater.on('update-not-available', () => {
  console.log('[PortalPet] 최신 버전 사용 중 (현재:', app.getVersion(), ')');
  if (updateCheckContext.showResultDialog) {
    showUpdateBox({
      type: 'info',
      title: '최신 버전입니다',
      message: `현재 최신 버전(v${app.getVersion()})을 사용 중입니다.`,
    });
  }
});

autoUpdater.on('update-available', (info) => {
  console.log('[PortalPet] 새 버전 발견:', info.version);
  showUpdateBox({
    type: 'info',
    title: '새 버전이 있습니다',
    message: `새 버전 v${info.version}이(가) 있습니다 (현재: v${app.getVersion()}).`,
    detail: '지금 내려받으시겠습니까? 완료되면 설치 시점을 다시 물어봅니다.',
    buttons: ['다운로드', '나중에'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) autoUpdater.downloadUpdate();
  });
});

autoUpdater.on('download-progress', (progress) => {
  console.log(`[PortalPet] 새 버전 다운로드 중... ${Math.round(progress.percent)}%`);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[PortalPet] 새 버전 다운로드 완료:', info.version);
  showUpdateBox({
    type: 'info',
    title: '설치 준비 완료',
    message: `새 버전 v${info.version} 설치 준비가 끝났습니다. 지금 재시작해서 설치할까요?`,
    detail: '"나중에"를 고르면 다음에 프로그램을 종료할 때 자동으로 설치됩니다.',
    buttons: ['지금 재시작', '나중에'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) autoUpdater.quitAndInstall();
  });
});

/**
 * 새 버전 확인. showResultDialog가 true면(사용자가 직접 버튼/메뉴를 눌러서 확인한 경우)
 * "최신 버전입니다"/오류도 대화상자로 알려주고, false면(추후 자동 백그라운드 확인용) 새
 * 버전이 있을 때만 알린다. 개발 모드(npm start)는 배포 채널 메타파일(app-update.yml)이 없어
 * electron-updater가 항상 오류를 내므로, 그 경우엔 확인 자체를 건너뛰고 안내만 한다.
 */
async function checkForUpdates(showResultDialog = false, parentWindow = null) {
  updateCheckContext = { showResultDialog, parentWindow };
  if (!app.isPackaged) {
    console.log('[PortalPet] 개발 모드에서는 새 버전 확인을 건너뜀(배포판에서만 동작)');
    if (showResultDialog) {
      await showUpdateBox({
        type: 'info',
        title: '개발 모드',
        message: '개발 모드(npm start)에서는 새 버전 확인을 지원하지 않습니다. 배포판(설치된 exe)에서 확인해 주세요.',
      });
    }
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // 대부분의 오류는 위 'error' 이벤트로 이미 처리되지만, checkForUpdates() 자체가 던지는
    // 경우(네트워크 즉시 실패 등)를 대비해 한 번 더 잡아둔다.
    console.error('[PortalPet] 새 버전 확인 실패:', err);
  }
}

// 사용자가 입력한 자주 가는 사이트 목록을 정리한다: 이름/주소 둘 다 있는 항목만, 앞뒤 공백
// 제거, 프로토콜 없이 입력했으면(예: "naver.com") https://를 붙여준다.
function sanitizeCustomLinks(customLinks) {
  if (!Array.isArray(customLinks)) return [];
  return customLinks
    .map((l) => ({ label: String(l?.label || '').trim(), url: String(l?.url || '').trim() }))
    .filter((l) => l.label && l.url)
    .map((l) => ({ label: l.label, url: /^https?:\/\//i.test(l.url) ? l.url : `https://${l.url}` }));
}

ipcMain.handle('save-setup', (_evt, {
  region, subdomain, password, browserProfile, browserChannel, autoLaunchMessenger, autoLaunchSchedule,
  customLinks, autoLogin, panelOpacity, dashboardAutoRefresh, dashboardRefreshMinutes,
  panelAutoCloseEnabled, panelAutoCloseSeconds, autoStartOnLogin,
}) => {
  // config.json이 아니라 OS 자체 설정이라 별도로 처리(트레이 메뉴 체크박스와 동일한 함수 재사용).
  setAutoStartOnLogin(!!autoStartOnLogin);

  const previous = credentialStore.loadConfig();
  // 비밀번호 칸을 비워두고 저장하면(지역/프로필만 바꾸는 경우) 기존 저장값을 그대로 둔다.
  const encryptedPasswordBase64 = password
    ? credentialStore.encryptPassword(password)
    : previous.encryptedPasswordBase64 || '';

  // 슬라이더 값(숫자)이 아니거나 범위를 벗어나면 기존 값(또는 기본값)으로 되돌린다.
  const parsedOpacity = Number(panelOpacity);
  const safeOpacity = Number.isFinite(parsedOpacity)
    ? Math.min(1, Math.max(0.2, parsedOpacity))
    : (previous.panelOpacity ?? 0.92);

  // 확인 주기(분) - 너무 짧으면(예: 0, 음수) 매크로처럼 계속 브라우저를 띄우게 되니 최소 1분으로 막는다.
  const parsedMinutes = Number(dashboardRefreshMinutes);
  const safeMinutes = Number.isFinite(parsedMinutes)
    ? Math.max(1, Math.min(120, Math.round(parsedMinutes)))
    : (previous.dashboardRefreshMinutes ?? 5);

  // 메뉴 자동 닫힘 시간(초) - 너무 짧으면(예: 0, 음수) 펼치자마자 닫혀버리니 최소 1초로 막는다.
  const parsedAutoCloseSeconds = Number(panelAutoCloseSeconds);
  const safeAutoCloseSeconds = Number.isFinite(parsedAutoCloseSeconds)
    ? Math.max(1, Math.min(600, Math.round(parsedAutoCloseSeconds)))
    : (previous.panelAutoCloseSeconds ?? 10);

  const config = {
    region,
    subdomain: subdomain || REGIONS[region] || '',
    encryptedPasswordBase64,
    browserProfile: browserProfile || null, // null이면 PortalPet 전용 프로필 사용
    browserChannel: browserChannel === 'msedge' ? 'msedge' : 'chrome', // 어떤 설치된 브라우저(크롬/엣지)를 쓸지
    autoLaunchMessenger: !!autoLaunchMessenger,
    autoLaunchSchedule: !!autoLaunchSchedule,
    customLinks: sanitizeCustomLinks(customLinks),
    autoLogin: autoLogin !== false, // 기본값 true - 명시적으로 false를 보낼 때만 수동 입력 모드
    panelOpacity: safeOpacity, // 메뉴(펼침 패널) 배경 투명도, 0.2~1
    dashboardAutoRefresh: dashboardAutoRefresh !== false, // 기본값 true - 나이스/K-에듀파인 결재 현황 자동 확인
    dashboardRefreshMinutes: safeMinutes, // 기본값 5분
    panelAutoCloseEnabled: !!panelAutoCloseEnabled, // 기본값 false - 메뉴를 일정 시간 뒤 자동으로 접을지
    panelAutoCloseSeconds: safeAutoCloseSeconds, // 자동으로 접히기까지 걸리는 시간(초)
  };
  credentialStore.saveConfig(config);
  if (setupWin) setupWin.close();
  // 펫 패널이 자주 가는 사이트 목록 등 바뀐 설정을 바로 반영하도록 알림.
  if (win && !win.isDestroyed()) win.webContents.send('config-updated');
  scheduleDashboardRefresh(); // 주기/on-off가 바뀌었을 수 있으니 즉시 재적용
  return { ok: true };
});

// 저장된 인증서 비밀번호만 따로 삭제한다("자동 로그인" 끄고 매번 직접 입력하고 싶을 때 등).
// 지역/자주 가는 사이트 등 나머지 설정은 그대로 둔다.
ipcMain.handle('delete-password', () => {
  const config = credentialStore.loadConfig();
  config.encryptedPasswordBase64 = '';
  credentialStore.saveConfig(config);
  if (win && !win.isDestroyed()) win.webContents.send('config-updated');
  return { ok: true };
});

// Windows 로그인 시 자동 실행(시작프로그램)으로 뜬 경우, G-ONE '메신저' 자동 실행이 브리지
// 페이지를 거쳐 결국 여는 건 별도의 네이티브 Brity 메신저 앱이다(brityaltsso:// 프로토콜).
// 그런데 Brity 메신저 자신도 보통 Windows 시작프로그램으로 같이 등록돼 있어서, 부팅 직후에는
// 아직 그 앱이 초기화(백그라운드 서비스/네트워크 연결) 중일 수 있다 - 이 경우 프로토콜 핸드오프를
// 받아줄 준비가 안 돼 있어 로그인이 조용히 실패한다(실측 확인: 개발 모드로 부팅 한참 뒤에 수동
// 실행하면 항상 되는데, exe 설치 후 재부팅 시 자동 실행으로 뜨면 메신저만 안 됨). 컴퓨터가 켜진
// 지 얼마 안 됐으면(os.uptime()) 다른 시작프로그램들이 자리잡을 시간을 벌어준다.
const BOOT_SETTLE_MS = 90 * 1000;
async function waitForSystemToSettleIfJustBooted() {
  const uptimeMs = os.uptime() * 1000;
  if (uptimeMs >= BOOT_SETTLE_MS) return;
  const remainingMs = BOOT_SETTLE_MS - uptimeMs;
  console.log(`[PortalPet] 부팅 직후로 보임(uptime ${Math.round(uptimeMs / 1000)}초) - Brity 메신저 등 다른 시작프로그램이 준비될 시간을 벌기 위해 ${Math.round(remainingMs / 1000)}초 대기`);
  await new Promise((resolve) => setTimeout(resolve, remainingMs));
}

// ===== 프로그램 실행 시 자동 실행(메신저/일정) =====
// 사용자 설정(체크박스)에 따라 앱이 뜰 때 자동으로 G-ONE 메신저 로그인/일정 페이지를 띄워둔다.
// "메신저 자동 실행"만 체크: 메신저만. "일정 자동 실행"만 체크: 일정만. 둘 다 체크: 메신저
// 로그인부터 한 뒤 이어서 일정 페이지를 띄운다(요청하신 순서) - 어차피 gone_schedule은
// launchService 안에서 "이미 G-ONE에 있으면 포털 재방문 생략" 로직 덕분에 바로 이어진다.
async function runStartupAutoLaunch() {
  const config = credentialStore.loadConfig();
  if (!config.autoLaunchMessenger && !config.autoLaunchSchedule) return;
  if (!(config.subdomain || config.region)) {
    console.log('[PortalPet] 자동 실행 체크됨 - 그러나 지역이 아직 설정되지 않아 건너뜀');
    return;
  }
  const autoLogin = config.autoLogin !== false;
  if (autoLogin && !config.encryptedPasswordBase64) {
    console.log('[PortalPet] 자동 실행 체크됨 - 그러나 비밀번호가 아직 설정되지 않아 건너뜀');
    return;
  }
  await waitForSystemToSettleIfJustBooted();
  const subdomain = REGIONS[config.region] || config.subdomain;
  // 자동 로그인이 꺼져 있으면 password를 null로 넘겨 - launchService가 인증서 창에서
  // 사용자의 수동 입력을 기다린다(자동 실행은 되지만 로그인만 직접 하게 됨).
  const password = (autoLogin && config.encryptedPasswordBase64)
    ? credentialStore.decryptPassword(config.encryptedPasswordBase64)
    : null;

  const steps = [];
  if (config.autoLaunchMessenger) steps.push('gone_msg');
  if (config.autoLaunchSchedule) steps.push('gone_schedule');

  for (const serviceKey of steps) {
    try {
      console.log(`[PortalPet] 시작 시 자동 실행: ${serviceKey}`);
      await loginEngine.launchService(serviceKey, subdomain, password, config.browserProfile || null, config.browserChannel || 'chrome');
    } catch (err) {
      console.error(`[PortalPet] 자동 실행(${serviceKey}) 실패:`, err);
    }
  }
}

// ===== 나이스 미결/협조함 · K-에듀파인 결재(긴급) 자동 확인(배지) =====
// 업무포털 메인 화면 하나에서 두 수치를 동시에 읽어와(loginEngine.checkPortalDashboard) 렌더러에
// 보내면, 렌더러가 "나이스 결재"/"공문 결재" 버튼 위에 배지로 표시한다. 사용자가 지정한 주기
// (기본 5분)마다 반복 - 예전엔 사용자가 직접 버튼을 눌러야 했는데(수동), 이제 자동으로 바뀐다.
let dashboardTimer = null;

function scheduleDashboardRefresh() {
  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }

  const config = credentialStore.loadConfig();
  if (config.dashboardAutoRefresh === false) {
    console.log('[PortalPet] 결재 현황 자동 확인 꺼짐 - 스케줄 안 함');
    return;
  }
  if (!(config.subdomain || config.region)) return;
  // 자동 로그인이 꺼져 있으면(수동 입력 모드) 백그라운드에서 조용히 인증서 창을 띄워놓고 사용자
  // 입력을 기다리는 꼴이 되므로, 자동 로그인이 켜져 있고 비밀번호가 저장돼 있을 때만 스케줄한다.
  if (config.autoLogin === false || !config.encryptedPasswordBase64) return;

  const minutes = Math.max(1, Number(config.dashboardRefreshMinutes) || 5);
  console.log(`[PortalPet] 결재 현황 자동 확인 스케줄 설정: ${minutes}분마다`);
  dashboardTimer = setInterval(runDashboardRefresh, minutes * 60 * 1000);
  runDashboardRefresh(); // 켜자마자 한 번 바로 확인해서 배지를 채워둔다.
}

// ===== 배지 값이 늘어나면 OS 알림 =====
// 렌더러의 DASHBOARD_BADGE_CONFIG와 같은 세 항목(나이스 미결/협조함, K-에듀파인 결재(긴급),
// 교데통 내부승인(처리))을 여기서도 추적한다. "늘어났을 때만" 알린다 - 줄어들거나 그대로면
// 이미 처리됐거나 변화가 없다는 뜻이라 알릴 필요가 없다.
const DASHBOARD_NOTIFY_CONFIG = [
  { bucket: 'neis', label: '미결/협조함', title: '나이스 결재' },
  { bucket: 'edufine', label: '결재(긴급)', title: 'K-에듀파인 공문 결재' },
  { bucket: 'edmgr', label: '내부승인(처리)', title: '교데통 내부승인 처리' },
];
// 직전 확인 결과(checkPortalDashboard의 { neis, edufine, edmgr } 형태) - 다음 확인 때 비교 기준.
let lastDashboardCounts = null;

function parseLeadingCount(rawValue) {
  const match = String(rawValue ?? '').match(/^[0-9]+/);
  return match ? parseInt(match[0], 10) : null;
}

/**
 * (수정) 앱을 막 켰을 때(lastDashboardCounts가 아직 없을 때) 바로 비교해버리면, 그 전부터
 * 밀려 있던 건까지 전부 "늘어난 것"으로 오인해 알림이 우르르 뜬다 - 그래서 최초 1회는
 * 기준값만 저장하고 알림 없이 넘어간다.
 */
function notifyDashboardIncreases(result) {
  if (!result) return;
  if (!lastDashboardCounts) {
    lastDashboardCounts = result;
    return;
  }
  for (const { bucket, label, title } of DASHBOARD_NOTIFY_CONFIG) {
    const prevRaw = lastDashboardCounts[bucket]?.[label];
    const currRaw = result[bucket]?.[label];
    const prev = parseLeadingCount(prevRaw);
    const curr = parseLeadingCount(currRaw);
    if (prev != null && curr != null && curr > prev) {
      console.log(`[PortalPet] ${title} "${label}" 증가 감지: ${prevRaw} -> ${currRaw}`);
      if (Notification.isSupported()) {
        // (수정) 사용자 요청 - 이전 값/화살표 없이 현재 결재 건수만 표시.
        new Notification({
          title: `${title} - 새로운 건이 있습니다`,
          body: `${label}: ${currRaw}`,
        }).show();
      }
    }
  }
  lastDashboardCounts = result;
}

/**
 * (임시/테스트용) 실제 로그인/포털 접속 없이 트레이 메뉴 클릭 한 번으로 "배지 증가 -> 알림" 흐름
 * 전체를 확인할 수 있게 만든 함수. lastDashboardCounts를 임의의 기준값으로 덮어쓴 뒤, 그보다
 * 큰 임의 값으로 notifyDashboardIncreases를 호출해 실제 알림 로직(Notification.isSupported()
 * 체크, 메시지 문구 등)을 그대로 타게 한다. 패널이 열려 있으면 배지도 같이 임의 값으로 바뀌는
 * 걸 볼 수 있도록 'portal-dashboard-updated'도 같이 보낸다. 테스트가 끝나면 다음 정기/수동
 * 확인이 실제 값으로 lastDashboardCounts를 다시 덮어써서 자연히 정상 상태로 돌아온다.
 */
function buildFakeDashboardResult({ neis, edufine, edmgr }) {
  return {
    ok: true,
    neis: { '미결/협조함': String(neis) },
    edufine: { '결재(긴급)': `${edufine}(0)` },
    edmgr: { '내부승인(처리)': String(edmgr) },
  };
}

function testDashboardNotification() {
  console.log('[PortalPet] 알림 테스트: 임의 값으로 증가 알림 미리보기');
  const before = buildFakeDashboardResult({ neis: 0, edufine: 0, edmgr: 0 });
  const after = buildFakeDashboardResult({ neis: 2, edufine: 1, edmgr: 3 });
  lastDashboardCounts = before; // 기준값을 임의로 세팅(테스트용 - 실제 값을 일시적으로 덮어씀)
  notifyDashboardIncreases(after);
  if (win && !win.isDestroyed()) win.webContents.send('portal-dashboard-updated', after); // 패널 배지도 같이 확인 가능
}

async function runDashboardRefresh() {
  const config = credentialStore.loadConfig();
  if (!(config.subdomain || config.region)) return;
  if (config.autoLogin === false || !config.encryptedPasswordBase64) return;

  const subdomain = REGIONS[config.region] || config.subdomain;
  const password = credentialStore.decryptPassword(config.encryptedPasswordBase64);

  try {
    console.log('[PortalPet] 결재 현황 자동 확인 실행...');
    const result = await loginEngine.checkPortalDashboard(subdomain, password, config.browserProfile || null, config.browserChannel || 'chrome');
    notifyDashboardIncreases(result);
    if (win && !win.isDestroyed()) win.webContents.send('portal-dashboard-updated', result);
  } catch (err) {
    console.error('[PortalPet] 결재 현황 자동 확인 실패:', err);
  }
}

// 패널의 새로고침 버튼 클릭 시 - 정기 자동 확인과 별개로 사용자가 원하는 시점에 즉시 확인.
// autoLogin이 꺼져 있어도(수동 입력 모드) 여기서는 사용자가 지금 화면 앞에 있다고 볼 수 있어
// 자동 확인 스케줄러와 달리 막지 않는다 - 필요하면 completeCertLoginIfNeeded가 알아서 인증서
// 창을 앞으로 가져와 입력을 기다린다.
ipcMain.handle('refresh-portal-dashboard', async () => {
  const config = credentialStore.loadConfig();
  if (!(config.subdomain || config.region)) return { ok: false, error: 'not-configured' };
  const autoLogin = config.autoLogin !== false;
  if (autoLogin && !config.encryptedPasswordBase64) return { ok: false, error: 'not-configured' };
  const subdomain = REGIONS[config.region] || config.subdomain;
  const password = (autoLogin && config.encryptedPasswordBase64)
    ? credentialStore.decryptPassword(config.encryptedPasswordBase64)
    : null;
  try {
    const result = await loginEngine.checkPortalDashboard(subdomain, password, config.browserProfile || null, config.browserChannel || 'chrome');
    notifyDashboardIncreases(result); // 수동 새로고침도 정기 확인과 동일하게 증가분 알림 대상에 포함
    return result;
  } catch (err) {
    console.error('[PortalPet] refresh-portal-dashboard failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

app.whenReady().then(async () => {
  createWindow();
  createTray();
  startDialogSuppressor(); // K-에듀파인 WXSClient의 "웹 페이지 메시지" 확인창 자동 취소

  const config = credentialStore.loadConfig();
  if (!config.encryptedPasswordBase64) {
    openSetupWindow(); // 최초 실행 시 바로 설정 창 띄우기
  } else {
    // (수정) 예전엔 이걸 await 없이 던져두고 바로 scheduleDashboardRefresh()를 불렀는데,
    // scheduleDashboardRefresh 쪽의 "즉시 1회 확인"(runDashboardRefresh)이 taskQueue에 먼저
    // 등록되는 경우가 있어(둘 다 첫 await 이전엔 동기 실행이라 타이밍에 따라 순서가 갈림 -
    // 실측 확인: 사용자 콘솔 로그) 결재 현황 확인이 먼저 포털 홈 탭을 차지해버리고, 뒤이어
    // 실행되는 메신저(gone_msg)가 "이미 다른 화면(포털 홈)이 사용 중"으로 판단돼 새 탭에서
    // 열리는 문제가 있었다(사용자 요청: "메신저와 일정 탭은 현재 창에서 열리도록"). 메신저/일정
    // 자동 실행을 먼저 완전히 끝낸 뒤에 결재 현황 확인을 시작하도록 순서를 명시적으로 고정한다 -
    // 그러면 아직 아무 탭도 없는 상태에서 메신저가 먼저 원래 탭을 그대로 쓰고, 일정도 같은
    // G-ONE 그룹이라 그 탭을 이어 쓴다. 결재 현황 확인은 그 다음에 필요하면 별도 탭을 연다.
    await runStartupAutoLaunch();
  }
  scheduleDashboardRefresh();
});

app.on('window-all-closed', () => {
  // 트레이 상주 앱이므로 창이 닫혀도 종료하지 않음 (macOS 관례와 무관하게 통일)
});

app.on('will-quit', () => {
  stopDialogSuppressor();
  if (dashboardTimer) clearInterval(dashboardTimer);
});
