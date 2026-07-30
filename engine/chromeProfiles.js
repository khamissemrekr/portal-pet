// chromeProfiles.js
// 사용자가 이미 로그인/보안프로그램 설정이 끝난 실제 크롬 프로필을 그대로 쓸 수 있게,
// 설치된 크롬의 프로필 목록을 읽어온다. 크롬은 "User Data" 폴더 하나에 여러 프로필
// (Default, Profile 1, Profile 2...)을 폴더로 담고, Local State 파일에 표시 이름이 있다.

const fs = require('node:fs');
const path = require('node:path');

function chromeUserDataRoot() {
  // Windows 기준 크롬 기본 경로.
  return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
}

/**
 * [{ folder: "Default", name: "홍길동", isCurrentlyLocked }, ...] 형태로 반환.
 * 크롬이 설치돼 있지 않거나 Local State가 없으면 빈 배열.
 */
function listChromeProfiles() {
  const root = chromeUserDataRoot();
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
    console.log('[PortalPet] failed to read Chrome Local State:', e.message);
    return [];
  }
}

module.exports = { listChromeProfiles, chromeUserDataRoot };
