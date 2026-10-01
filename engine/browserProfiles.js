// browserProfiles.js (구 chromeProfiles.js를 크롬/엣지 공용으로 일반화)
// 사용자가 이미 로그인/보안프로그램 설정이 끝난 실제 브라우저 프로필을 그대로 쓸 수 있게,
// 설치된 크롬 또는 엣지의 프로필 목록을 읽어온다. 둘 다 크로미움 기반이라 구조가 동일하다:
// "User Data" 폴더 하나에 여러 프로필(Default, Profile 1, Profile 2...)을 폴더로 담고,
// Local State 파일에 표시 이름이 있다 - 루트 경로만 브라우저별로 다르다.

const fs = require('node:fs');
const path = require('node:path');

// Playwright의 channel 값('chrome' | 'msedge')에 대응하는 Windows User Data 경로.
const BROWSER_USER_DATA_PARTS = {
  chrome: ['Google', 'Chrome'],
  msedge: ['Microsoft', 'Edge'],
};

function browserUserDataRoot(channel = 'chrome') {
  const parts = BROWSER_USER_DATA_PARTS[channel] || BROWSER_USER_DATA_PARTS.chrome;
  return path.join(process.env.LOCALAPPDATA || '', ...parts, 'User Data');
}

/**
 * [{ folder: "Default", name: "홍길동", root }, ...] 형태로 반환.
 * 해당 브라우저가 설치돼 있지 않거나 Local State가 없으면 빈 배열.
 */
function listBrowserProfiles(channel = 'chrome') {
  const root = browserUserDataRoot(channel);
  const localStatePath = path.join(root, 'Local State');
  if (!fs.existsSync(localStatePath)) return [];

  try {
    const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
    const infoCache = localState?.profile?.info_cache || {};
    return Object.entries(infoCache).map(([folder, info]) => ({
      folder,
      name: info.name || info.shortcut_name || folder,
      root,
    }));
  } catch (e) {
    console.log(`[PortalPet] failed to read ${channel} Local State:`, e.message);
    return [];
  }
}

// (신규, 사용자 요청: 자주 가는 사이트를 원하는 브라우저 프로필로 열기) 자동화(Playwright) 없이
// 실행 파일에 --profile-directory만 넘겨 주소를 여는 용도라, 크롬 136+의 원격 디버깅 제한과 무관하게
// 평소 쓰던 프로필로도 열 수 있다. 시스템 설치/사용자별 설치 위치를 차례로 확인한다.
const BROWSER_EXE_CANDIDATES = {
  chrome: [
    [process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'],
    [process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'],
    [process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'],
  ],
  msedge: [
    [process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    [process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    [process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ],
};

function findBrowserExecutable(channel) {
  for (const parts of BROWSER_EXE_CANDIDATES[channel] || []) {
    if (!parts[0]) continue;
    const exe = path.join(...parts);
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

module.exports = { listBrowserProfiles, browserUserDataRoot, findBrowserExecutable };
