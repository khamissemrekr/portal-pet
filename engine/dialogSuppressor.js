// dialogSuppressor.js
// K-에듀파인 표준서식 편집기(WXSClient)는 완전히 별도의 네이티브 Windows 앱이라, 그 안에서
// 뜨는 "웹 페이지 메시지" 확인창(예: "열려있는 기안/결재기를 닫습니다.",
// "자동저장문서를 읽어오시겠습니까?")은 Chrome 페이지가 아니므로 Playwright로는 절대
// 손댈 수 없다. 이런 창은 IE 임베디드 컨트롤이 만드는 표준 Windows MessageBox 스타일이라
// Escape 키를 보내면 항상 "취소"와 동일하게 동작한다. PowerShell + Win32 API로 그 제목의
// 창이 뜨는지 주기적으로 감시하다가, 뜨면 자동으로 Escape를 보내 닫는다.

const { spawn } = require('node:child_process');

const WATCH_TITLE = '웹 페이지 메시지';
let watcherProcess = null;

function startDialogSuppressor() {
  if (watcherProcess) return;

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PortalPetWin32 {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@
Add-Type -AssemblyName System.Windows.Forms
while ($true) {
  $h = [PortalPetWin32]::FindWindow($null, "${WATCH_TITLE}")
  if ($h -ne [IntPtr]::Zero -and [PortalPetWin32]::IsWindowVisible($h)) {
    [PortalPetWin32]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
    Start-Sleep -Milliseconds 500
  } else {
    Start-Sleep -Milliseconds 500
  }
}
`;

  watcherProcess = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
  });
  watcherProcess.on('exit', (code) => {
    console.log('[PortalPet] dialog suppressor exited, code:', code);
    watcherProcess = null;
  });
  watcherProcess.on('error', (e) => {
    console.log('[PortalPet] dialog suppressor failed to start (non-fatal):', e.message);
    watcherProcess = null;
  });
  console.log(`[PortalPet] dialog suppressor started (자동으로 "${WATCH_TITLE}" 창을 닫습니다)`);
}

function stopDialogSuppressor() {
  if (watcherProcess) {
    watcherProcess.kill();
    watcherProcess = null;
  }
}

module.exports = { startDialogSuppressor, stopDialogSuppressor };
