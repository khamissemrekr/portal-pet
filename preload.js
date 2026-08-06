const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portalPet', {
  launchService: (serviceKey, region) => ipcRenderer.invoke('launch-service', serviceKey, region),
  togglePanel: () => ipcRenderer.invoke('toggle-panel'),
  // 메뉴 하단 톱니 아이콘에서 설정 창을 바로 연다.
  openSetup: () => ipcRenderer.invoke('open-setup-window'),
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
  // 교외체험학습신청서관리 접수대기/미상신 건수 자동 확인 결과(결재 현황과 별도 주기).
  onFieldTripApplyUpdated: (callback) => ipcRenderer.on('field-trip-apply-updated', (_evt, data) => callback(data)),
  // 교외체험학습보고서관리 접수대기/미상신 건수 자동 확인 결과(별도 주기).
  onFieldTripReportUpdated: (callback) => ipcRenderer.on('field-trip-report-updated', (_evt, data) => callback(data)),
  // 새로고침 버튼 클릭 시 즉시 확인(정기 자동 확인과 별개).
  refreshPortalDashboard: () => ipcRenderer.invoke('refresh-portal-dashboard'),
  // 드래그로 펫 위치 이동: 매 mousemove마다 화면 좌표 델타(dx, dy)만 보낸다 - 창을 프레임
  // 없이 쓰고 있어서(-webkit-app-region: drag는 클릭과 충돌할 수 있어) 직접 구현.
  movePetBy: (dx, dy) => ipcRenderer.send('move-pet-by', dx, dy),
  // 메뉴 항목 표시/숨김, 자주 가는 사이트 개수 등에 따라 실제 콘텐츠 높이가 달라져 - 렌더러가
  // 측정한 실제 높이(px)를 보내면 그만큼 창 높이를 다시 맞춘다.
  resizePanel: (height) => ipcRenderer.send('resize-panel', height),
  // 자주 가는 사이트(사용자 지정 링크)는 SSO 자동화 대상이 아니라 그냥 기본 브라우저로 연다.
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // 프로그램 정보 창(버전 표시 / 새 버전 확인 버튼)에서 사용.
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
});
