// credentialStore.js
// Electron 내장 safeStorage는 Windows에서 DPAPI(CryptProtectData)를 그대로 사용합니다.
// 즉, C# 쪽에서 구상했던 "현재 Windows 계정에 바인딩된 암호화 저장"과 동일한 보안 수준을
// 별도 네이티브 코드 없이 얻을 수 있습니다. (macOS는 Keychain, Linux는 libsecret로 자동 대응)

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_DIR = path.join(app.getPath('userData'), 'PortalPet');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      region: '', subdomain: '', encryptedPasswordBase64: '', runAtStartup: false,
      autoLaunchMessenger: false, autoLaunchSchedule: false, minimizeMessengerOnLaunch: true,
      customLinks: [],
      autoLogin: true, // 기본값: 비밀번호 저장해서 자동 로그인
      browserChannel: 'chrome', // 기본값: 크롬 사용 ('chrome' | 'msedge')
      panelOpacity: 0.92, // 메뉴(펼침 패널) 배경 투명도, 0.2~1
      dashboardAutoRefresh: true, // 나이스 미결/협조함, K-에듀파인 결재(긴급) 자동 확인
      dashboardRefreshMinutes: 5, // 확인 주기(분)
      panelAutoCloseEnabled: false, // 메뉴(펼침 패널)를 일정 시간 뒤 자동으로 접을지 여부 - 기본 꺼짐
      panelAutoCloseSeconds: 10, // 자동으로 접히기까지 걸리는 시간(초)
      neisRoleMode: '학급담임', // 나이스 출결관리 등에서 쓸 역할 - '학급담임' | '부서장' | 'custom'
      neisRoleCustomText: '', // neisRoleMode가 'custom'일 때 직접 입력한 역할 탭 이름
      certUserName: '', // 인증서가 여러 개 등록된 PC에서 선택할 인증서의 "사용자" 이름(비어있으면 선택 단계 생략)
    };
  }
  // 기존에 저장된 config.json에는 이 필드들이 없을 수 있어(과거 버전 사용자) 기본값으로 채워준다.
  return {
    autoLaunchMessenger: false, autoLaunchSchedule: false, minimizeMessengerOnLaunch: true, customLinks: [], autoLogin: true,
    browserChannel: 'chrome', panelOpacity: 0.92, dashboardAutoRefresh: true, dashboardRefreshMinutes: 5,
    panelAutoCloseEnabled: false, panelAutoCloseSeconds: 10,
    neisRoleMode: '학급담임', neisRoleCustomText: '', certUserName: '',
    ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')),
  };
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function encryptPassword(plainPassword) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('이 OS에서는 safeStorage 암호화를 사용할 수 없습니다.');
  }
  return safeStorage.encryptString(plainPassword).toString('base64');
}

function decryptPassword(encryptedBase64) {
  const buf = Buffer.from(encryptedBase64, 'base64');
  return safeStorage.decryptString(buf);
}

module.exports = { loadConfig, saveConfig, encryptPassword, decryptPassword };
