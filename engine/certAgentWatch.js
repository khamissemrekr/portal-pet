// engine/certAgentWatch.js
// 인증서 로그인에 쓰이는 보안프로그램(AnySign4PC, Wizvera Delfino/Veraport 등)은 PC를 켠 직후
// 스스로 업데이트/재설치되며 다시 뜨는 경우가 있다(실측: 부팅 직후 자동 실행에서 인증서 모달은
// 닫히는데 곧바로 로그인 버튼 화면으로 되돌아가는 실패 - 2026-09-07~09 아침 로그). 그 사이에는
// 로그인이 조용히 실패하므로, 설치/재시작이 끝날 때까지 기다리고 한두 번만 다시 시도하게 돕는다.
const { execFile } = require('node:child_process');

const CERT_AGENT_NAMES = ['anysign4pc', 'delfino', 'veraport', 'veraport-x64', 'localserverd', 'crossexservice', 'kcaselib'];
const INSTALLER_NAME_PATTERN = /^(msiexec|veraport.*(setup|install|update)|delfino.*(setup|install|update)|anysign.*(setup|install|update)|wizvera.*(setup|install|update))/i;
const FRESH_AGENT_MS = 45 * 1000; // 에이전트가 이 시간 안에 막 (재)시작됐으면 아직 준비 중으로 본다

function snapshotProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const script = 'Get-Process | ForEach-Object { try { [pscustomobject]@{ n = $_.ProcessName; t = [DateTimeOffset]::new($_.StartTime).ToUnixTimeMilliseconds() } } catch {} } | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const parsed = JSON.parse(stdout || '[]');
          resolve((Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ name: String(p.n || ''), startedAt: Number(p.t) || 0 })));
        } catch { resolve([]); }
      });
  });
}

/** { unsettled, recentlyRestarted, reason } - 프로세스 목록을 못 읽으면 둘 다 false(막지 않는다). */
async function checkCertAgents() {
  const procs = await snapshotProcesses();
  const now = Date.now();
  const installer = procs.find((p) => INSTALLER_NAME_PATTERN.test(p.name));
  const agents = procs.filter((p) => CERT_AGENT_NAMES.includes(p.name.toLowerCase()));
  const fresh = agents.find((p) => p.startedAt && now - p.startedAt < FRESH_AGENT_MS);
  const recent = agents.find((p) => p.startedAt && now - p.startedAt < 10 * 60 * 1000);
  const reason = installer ? `설치 프로그램 실행 중(${installer.name})` : fresh ? `보안프로그램이 방금 시작됨(${fresh.name})` : '';
  return { unsettled: !!reason, recentlyRestarted: !!(installer || recent), reason };
}

/** 설치/재시작이 끝날 때까지 기다린다. 끝내 안 끝나도 maxWaitMs 뒤에는 그냥 진행한다. */
async function waitForCertAgentsSettled(maxWaitMs = 120000) {
  const startedAt = Date.now();
  let logged = false;
  for (;;) {
    const { unsettled, reason } = await checkCertAgents();
    if (!unsettled) {
      if (logged) console.log(`[PortalPet] 인증서 보안프로그램 준비됨(${Math.round((Date.now() - startedAt) / 1000)}초 대기)`);
      return true;
    }
    if (Date.now() - startedAt >= maxWaitMs) {
      console.log(`[PortalPet] 인증서 보안프로그램 준비 대기 시간 초과(${reason}) - 그대로 진행`);
      return false;
    }
    if (!logged) { console.log(`[PortalPet] 인증서 보안프로그램 준비 대기 중: ${reason}`); logged = true; }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

module.exports = { checkCertAgents, waitForCertAgentsSettled };
