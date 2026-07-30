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
      autoLaunchMessenger: false, autoLaunchSchedule: false,
      customLinks: [],
      autoLogin: true, // 기본값: 비밀번호 저장해서 자동 로그인
      browserChannel: 'chrome', // 기본값: 크롬 사용 ('chrome' | 'msedge')
      panelOpacity: 0.92, // 메뉴(펼침 패널) 배경 투명도, 0.2~1
    };
  }
  // 기존에 저장된 config.json에는 이 필드들이 없을 수 있어(과거 버전 사용자) 기본값으로 채워준다.
  return {
    autoLaunchMessenger: false, autoLaunchSchedule: false, customLinks: [], autoLogin: true,
    browserChannel: 'chrome', panelOpacity: 0.92,
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
