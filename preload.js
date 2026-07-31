const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portalPet', {
  launchService: (serviceKey, region) => ipcRenderer.invoke('launch-service', serviceKey, region),
  togglePanel: () => ipcRenderer.invoke('toggle-panel'),
  onPanelState: (callback) => ipcRenderer.on('panel-state', (_evt, expanded) => callback(expanded)),
  // 설정 창에서 저장(자주 가는 사이트 등 변경)이 끝나면 펫 패널이 목록을 다시 불러오도록 알림.
  onConfigUpdated: (callback) => ipcRenderer.on('config-updated', () => callback()),
  saveSetup: (data) => ipcRenderer.invoke('save-setup', data),
  deletePassword: () => ipcRenderer.invoke('delete-password'),
  // channel: 'chrome' | 'msedge' - 설정 창에서 브라우저를 바꿀 때마다 그 브라우저의 프로필 목록을 다시 불러온다.
  listBrowserProfiles: (channel) => ipcRenderer.invoke('list-browser-profiles', channel),
  getConfig: () => ipcRenderer.invoke('get-config'),
  // 나이스 미결/협조함, K-에듀파인 결재(긴급) 자동 확인 결과(주기적으로 main.js가 보냄).
  onPortalDashboardUpdated: (callback) => ipcRenderer.on('portal-dashboard-updated', (_evt, data) => callback(data)),
  // 드래그로 펫 위치 이동: 매 mousemove마다 화면 좌표 델타(dx, dy)만 보낸다 - 창을 프레임
  // 없이 쓰고 있어서(-webkit-app-region: drag는 클릭과 충돌할 수 있어) 직접 구현.
  movePetBy: (dx, dy) => ipcRenderer.send('move-pet-by', dx, dy),
  // 자주 가는 사이트(사용자 지정 링크)는 SSO 자동화 대상이 아니라 그냥 기본 브라우저로 연다.
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
