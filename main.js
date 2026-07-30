// PortalPet - main.js
// clawd-on-desk(https://github.com/rullerzhou-afk/clawd-on-desk)의 "미니 모드"(화면 가장자리에
// 숨어 있다가 마우스를 올리면 튀어나오는 방식)와 시스템 트레이 UX를 참고해 새로 구현.
// 코드/아트워크는 그대로 가져오지 않고, 우리 목적(원클릭 업무포털 접속)에 맞게 최소 구성으로 재작성.

const { app, BrowserWindow, Tray, Menu, screen, ipcMain, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const credentialStore = require('./engine/credentialStore');
const loginEngine = require('./engine/loginEngine');
const { REGIONS } = require('./engine/regionMap');
const { listBrowserProfiles } = require('./engine/browserProfiles');
const { startDialogSuppressor, stopDialogSuppressor } = require('./engine/dialogSuppressor');

// ===== 설정 =====
const PET_SIZE = 96;          // 대기 상태 캐릭터 크기(px)
const PANEL_WIDTH = 300;      // 펼침 패널 폭(px) - 3열 메뉴 구조라 기존보다 넓힘
const PANEL_HEIGHT = 360;     // 펼침 패널 높이(px)
const EDGE_MARGIN = 8;        // 화면 가장자리에서 살짝 보이는 여백(px), 미니모드일 때
const HOVER_POLL_MS = 150;
const RELEASES_URL = 'https://github.com/khamissemrekr/portal-pet/releases';

let win;
let setupWin;
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

function togglePanel() {
  ensureWindow();
  isExpanded = !isExpanded;
  const bounds = win.getBounds();
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;

  if (isExpanded) {
    const newWidth = PET_SIZE + PANEL_WIDTH;
    const newHeight = Math.max(PET_SIZE, PANEL_HEIGHT);
    win.setBounds({
      x: Math.max(0, sw - newWidth - 40),
      y: Math.min(bounds.y, sh - newHeight - 20),
      width: newWidth,
      height: newHeight,
    });
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

// ===== 트레이 =====
function createTray() {
  tray = new Tray(path.join(__dirname, 'theme', 'tray-icon.png'));
  const menu = Menu.buildFromTemplate([
    { label: '설정 (지역/비밀번호)', click: openSetupWindow },
    { label: '펼치기/접기', click: togglePanel },
    { label: '미니 모드', type: 'checkbox', checked: false, click: (item) => item.checked ? enterMiniMode() : exitMiniMode() },
    { type: 'separator' },
    { label: 'Windows 시작 시 자동 실행', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      // 개발 모드(npm start)에서 이 옵션을 켜면 path가 electron.exe만 가리켜서(앱 경로 없이) 부팅 시
      // Electron 기본 화면만 뜨는 문제가 있었다. app.isPackaged일 때만 기본값(process.execPath)을
      // 쓰고, 개발 모드에서는 실제 앱 폴더를 args로 명시해 같은 문제가 재발하지 않게 한다.
      click: (item) => {
        const settings = app.isPackaged
          ? { openAtLogin: item.checked }
          : { openAtLogin: item.checked, path: process.execPath, args: [path.resolve(process.argv[1] || '.')] };
        app.setLoginItemSettings(settings);
      } },
    { type: 'separator' },
    { label: `버전 ${app.getVersion()}`, enabled: false },
    { label: '새 버전 확인 (GitHub Releases)', click: () => shell.openExternal(RELEASES_URL) },
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

// ===== K-에듀파인 결재 건수 확인: 화면 전환 없이(이미 그 화면이면 그대로) 상단 배지만 읽음 =====
ipcMain.handle('check-edufine-approvals', async () => {
  const config = credentialStore.loadConfig();
  const autoLogin = config.autoLogin !== false;
  if (autoLogin && !config.encryptedPasswordBase64) {
    return { ok: false, error: 'not-configured' };
  }
  if (!(config.subdomain || config.region)) {
    return { ok: false, error: 'not-configured' };
  }
  const subdomain = REGIONS[config.region] || config.subdomain;
  const password = (autoLogin && config.encryptedPasswordBase64)
    ? credentialStore.decryptPassword(config.encryptedPasswordBase64)
    : null;

  try {
    const result = await loginEngine.checkEdufineApprovalCount(subdomain, password, config.browserProfile || null, config.browserChannel || 'chrome');
    return result;
  } catch (err) {
    console.error('[PortalPet] check-edufine-approvals failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

// channel: 'chrome' | 'msedge' - 설정 창에서 브라우저를 바꾸면 그 브라우저의 프로필 목록을 다시 읽어온다.
ipcMain.handle('list-browser-profiles', (_evt, channel) => listBrowserProfiles(channel || 'chrome'));
ipcMain.handle('get-config', () => credentialStore.loadConfig());

ipcMain.handle('toggle-panel', () => togglePanel());
ipcMain.handle('open-external', (_evt, url) => shell.openExternal(url));

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
  setupWin = new BrowserWindow({
    width: 360, height: 460, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; });
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

ipcMain.handle('save-setup', (_evt, { region, subdomain, password, browserProfile, browserChannel, autoLaunchMessenger, autoLaunchSchedule, customLinks, autoLogin }) => {
  const previous = credentialStore.loadConfig();
  // 비밀번호 칸을 비워두고 저장하면(지역/프로필만 바꾸는 경우) 기존 저장값을 그대로 둔다.
  const encryptedPasswordBase64 = password
    ? credentialStore.encryptPassword(password)
    : previous.encryptedPasswordBase64 || '';

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
  };
  credentialStore.saveConfig(config);
  if (setupWin) setupWin.close();
  // 펫 패널이 자주 가는 사이트 목록 등 바뀐 설정을 바로 반영하도록 알림.
  if (win && !win.isDestroyed()) win.webContents.send('config-updated');
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

app.whenReady().then(() => {
  createWindow();
  createTray();
  startDialogSuppressor(); // K-에듀파인 WXSClient의 "웹 페이지 메시지" 확인창 자동 취소

  const config = credentialStore.loadConfig();
  if (!config.encryptedPasswordBase64) {
    openSetupWindow(); // 최초 실행 시 바로 설정 창 띄우기
  } else {
    runStartupAutoLaunch(); // 설정돼 있으면 메신저/일정 자동 실행 체크 여부 확인 후 진행
  }
});

app.on('window-all-closed', () => {
  // 트레이 상주 앱이므로 창이 닫혀도 종료하지 않음 (macOS 관례와 무관하게 통일)
});

app.on('will-quit', () => {
  stopDialogSuppressor();
});
