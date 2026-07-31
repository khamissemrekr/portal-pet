// engine/fileLogger.js
// 배포판(패키지된 exe)은 콘솔 창이 없어서 console.log가 어디에도 안 보인다 - 이번 세션에서
// 여러 버그를 사용자가 붙여준 콘솔 로그로 진단했는데, 그건 전부 npm start(개발 모드, 터미널
// 있음)에서만 가능했던 방법이다. 배포판에서 문제가 생겼을 때도 같은 방식으로 진단할 수 있도록,
// console.log/warn/error 출력을 그대로 파일에도 남긴다.
const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB - 넘으면 이전 파일로 밀어내고 새로 시작(무한정 커지는 것 방지)

let logFilePath = null;

function rotateIfTooBig() {
  try {
    if (!fs.existsSync(logFilePath)) return;
    const { size } = fs.statSync(logFilePath);
    if (size > MAX_LOG_BYTES) {
      const oldPath = logFilePath.replace(/\.log$/, '.old.log');
      fs.rmSync(oldPath, { force: true });
      fs.renameSync(logFilePath, oldPath);
    }
  } catch (e) {
    // 로테이션 실패해도 로깅 자체를 막을 정도는 아니다 - 조용히 무시하고 계속 진행
  }
}

function formatArg(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'object' && a !== null) {
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  return String(a);
}

function appendLine(prefix, args) {
  if (!logFilePath) return;
  try {
    const line = `[${new Date().toISOString()}] ${prefix} ${args.map(formatArg).join(' ')}\n`;
    fs.appendFileSync(logFilePath, line, 'utf-8');
  } catch (e) {
    // 파일 쓰기 실패(디스크 꽉 참 등)해도 앱 동작에 영향을 주면 안 되니 조용히 무시
  }
}

/**
 * userDataDir 아래 PortalPet/logs/portalpet.log에 console.log/warn/error 출력을 그대로 남긴다.
 * 원래 console 함수는 그대로 유지해서(개발 모드 터미널 출력은 예전과 동일하게 보임) 파일에도
 * 추가로 기록만 한다 - 배포판에서 문제가 생겼을 때 이 파일을 찾아 보내주면 진단할 수 있다.
 * main.js 아주 초반에 한 번만 호출한다(그래야 이후 모든 모듈의 console.log가 잡힘 - console은
 * Node 프로세스 전역 객체라 어느 모듈에서 바꾸든 전체에 적용된다).
 */
function startFileLogger(userDataDir) {
  try {
    const logDir = path.join(userDataDir, 'PortalPet', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, 'portalpet.log');
    rotateIfTooBig();
  } catch (e) {
    console.error('[PortalPet] 로그 파일 초기화 실패(non-fatal, 파일 로깅 없이 계속 진행):', e.message);
    return;
  }

  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => { original.log(...args); appendLine('[LOG]', args); };
  console.warn = (...args) => { original.warn(...args); appendLine('[WARN]', args); };
  console.error = (...args) => { original.error(...args); appendLine('[ERROR]', args); };

  console.log('[PortalPet] 파일 로깅 시작:', logFilePath);
}

function getLogFilePath() {
  return logFilePath;
}

module.exports = { startFileLogger, getLogFilePath };
