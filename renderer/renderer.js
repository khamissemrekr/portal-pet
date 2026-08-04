// 3열(나이스 / K-에듀파인 / G-ONE) 구조. 열마다 헤더 버튼(시스템 홈 바로가기) + 하위 액션
// 버튼들을 세로로 쌓는다. G-ONE만 하위 항목이 3개(메신저/AI 대화·초안/일정)라 열마다
// 높이가 달라질 수 있어서, 균일한 grid가 아니라 열별 독립 flex 레이아웃을 쓴다.
const COLUMNS = [
  {
    key: 'neis', label: '나이스',
    subs: [
      { key: 'bokmu', label: '복무 신청' },
      { key: 'trip', label: '출장 신청' },
      { key: 'neis_approval', label: '나이스 결재' },
      { key: 'neis_attendance', label: '출결관리' },
      { key: 'neis_field_trip_apply', label: '체험신청서' },
      { key: 'neis_field_trip_report', label: '체험보고서' },
    ],
  },
  {
    key: 'edufine', label: 'K-에듀파인',
    subs: [
      { key: 'giahn', label: '기안문 작성' },
      { key: 'pumui', label: '품의 작성' },
      { key: 'edufine_approval', label: '공문 결재' },
    ],
  },
  {
    key: 'gone', label: 'G-ONE',
    subs: [
      // (수정) 사용자 요청으로 메뉴 화면에서만 숨김 - 기능 코드/자동 실행 설정(autoLaunchMessenger)은
      // 그대로 둔다.
      // { key: 'gone_msg', label: '메신저' },
      { key: 'gone_ai', label: 'AI 대화·초안' },
      { key: 'gone_schedule', label: '일정' },
      { key: 'edmgr_approval', label: '교데통' },
    ],
  },
];

const servicesEl = document.getElementById('services');
const regionSelect = document.getElementById('region-select');
const statusDot = document.getElementById('status-dot');
const errorBox = document.getElementById('error-box');
const petEl = document.getElementById('pet');
const petFaceEl = document.getElementById('pet-face');

let launching = false; // 요청 진행 중 중복 클릭(중복 브라우저 실행) 방지

// ===== 캐릭터 포즈 =====
// theme/tiger_actions/ 에 사용자가 직접 넣어둔 호랑이 캐릭터 이미지로 상태별 포즈를 교체.
const POSES = {
  idle: '../theme/tiger_actions/tiger_idle.png',
  dragging: '../theme/tiger_actions/tiger_grooming.png', // 편안하게 들려있는 느낌
  working: '../theme/tiger_actions/tiger_pounce.png',    // 집중해서 몸을 낮춘 포즈
  success: '../theme/tiger_actions/tiger_wave.png',      // 윙크+손 흔들기
  error: '../theme/tiger_actions/tiger_yawning.png',     // 놀란 듯 양팔을 든 포즈
  sleep: '../theme/tiger_actions/tiger_sleeping.png',    // 장시간 미사용 시(아래 참고)
};
let poseResetTimer = null;
function setPose(pose, { autoResetMs = 0 } = {}) {
  petFaceEl.src = POSES[pose] || POSES.idle;
  if (poseResetTimer) { clearTimeout(poseResetTimer); poseResetTimer = null; }
  if (autoResetMs > 0) {
    poseResetTimer = setTimeout(() => { petFaceEl.src = POSES.idle; }, autoResetMs);
  }
  scheduleSleep(); // 어떤 포즈로든 활동이 있었으니 잠들기까지 남은 시간을 다시 채운다
}

// 3분 이상 아무 상호작용(클릭/드래그/서비스 실행)이 없으면 자는 포즈로 바뀐다.
const SLEEP_AFTER_MS = 3 * 60 * 1000;
let sleepTimer = null;
function scheduleSleep() {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => { petFaceEl.src = POSES.sleep; }, SLEEP_AFTER_MS);
}
scheduleSleep();

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}
function hideError() {
  errorBox.classList.add('hidden');
  errorBox.textContent = '';
}
function setButtonsDisabled(disabled) {
  servicesEl.querySelectorAll('.service-btn').forEach((b) => { b.disabled = disabled; });
}

// 나이스 결재/공문 결재/교데통 내부승인처리 버튼에 붙는 자동 확인 배지(주기적으로 main.js가
// 보내주는 데이터로 갱신). 버튼 element가 만들어질 때 key -> 배지 span을 기록해뒀다가,
// updateDashboardBadges에서 찾아 쓴다. bucket은 checkPortalDashboard 결과(neis/edufine/edmgr)
// 중 어디서 값을 읽을지, label은 그 안에서 찾을 정확한 라벨 텍스트.
const dashboardBadgeEls = {};
const DASHBOARD_BADGE_CONFIG = {
  neis_approval: { bucket: 'neis', label: '미결/협조함' },
  edufine_approval: { bucket: 'edufine', label: '결재(긴급)' },
  edmgr_approval: { bucket: 'edmgr', label: '내부승인(처리)' },
};

function makeButton(key, label, isHeader) {
  const btn = document.createElement('button');
  btn.className = isHeader ? 'service-btn header' : 'service-btn';
  btn.textContent = label;
  if (DASHBOARD_BADGE_CONFIG[key]) {
    const badge = document.createElement('span');
    badge.className = 'dashboard-badge hidden';
    btn.appendChild(badge);
    dashboardBadgeEls[key] = badge;
  }
  btn.addEventListener('click', async () => {
    if (launching) return;
    let region = regionSelect.value;
    if (region === 'custom') {
      region = prompt('eduptl.kr 서브도메인을 입력하세요 (예: goe)') || '';
      if (!region) return;
    }
    launching = true;
    setButtonsDisabled(true);
    statusDot.className = 'idle';
    hideError();
    setPose('working');
    try {
      const result = await window.portalPet.launchService(key, region);
      statusDot.className = result.ok ? 'connected' : 'error';
      setPose(result.ok ? 'success' : 'error', { autoResetMs: 2500 });
      if (!result.ok) showError(result.error || '알 수 없는 오류가 발생했습니다.');
    } catch (e) {
      statusDot.className = 'error';
      setPose('error', { autoResetMs: 2500 });
      showError(e?.message || '알 수 없는 오류가 발생했습니다.');
    } finally {
      launching = false;
      setButtonsDisabled(false);
    }
  });
  return btn;
}

// ===== 나이스 결재 / 공문 결재 자동 확인 배지 =====
// main.js가 사용자가 지정한 주기(기본 5분)마다 포털 메인에서 읽어온 값을 IPC로 보내주면,
// 여기서 해당 버튼의 배지를 갱신한다. 예전(결재 건수 확인 버튼)과 달리 클릭 없이 자동으로 채워짐.
function updateDashboardBadges(data) {
  if (!data || !data.ok) return; // 실패하면 마지막으로 성공했던 값을 그대로 둔다.
  for (const [key, { bucket, label }] of Object.entries(DASHBOARD_BADGE_CONFIG)) {
    const system = data[bucket];
    const rawValue = system ? system[label] : null;
    setDashboardBadge(key, rawValue);
  }
}

// (수정) 예전엔 0건이면 배지를 아예 숨겼는데, 사용자가 "지금 잘 불러와지고 있는지" 확인할 방법이
// 없어서(0인지 아직 값을 못 받아온 건지 구분이 안 됨) 헷갈렸다 - 이제 데이터를 한 번이라도 받아온
// 이후에는 0이어도 "0"으로 표시한다(아직 한 번도 못 받아왔을 때만 숨김). 0건일 땐 회색으로 옅게.
function setDashboardBadge(key, rawValue) {
  const badge = dashboardBadgeEls[key];
  if (!badge) return;
  if (rawValue == null) {
    badge.classList.add('hidden');
    return;
  }
  const leadingNum = parseInt(String(rawValue).match(/^[0-9]+/)?.[0] || '0', 10);
  badge.textContent = String(rawValue).length > 6 ? String(leadingNum) : String(rawValue); // 예: "0(0)"은 그대로, 너무 길면 숫자만
  badge.title = `${DASHBOARD_BADGE_CONFIG[key]?.label || ''} ${rawValue}`;
  badge.classList.toggle('zero', leadingNum <= 0);
  badge.classList.remove('hidden');
}

window.portalPet.onPortalDashboardUpdated(updateDashboardBadges);

// 정기 자동 확인(기본 5분)과 별개로, 사용자가 원할 때 바로 새로고침할 수 있는 버튼.
function makeDashboardRefreshButton() {
  const btn = document.createElement('button');
  btn.className = 'dashboard-refresh-btn';
  btn.type = 'button';
  btn.title = '나이스 결재 / 공문 결재 현황 새로고침';
  // (버그 수정) btn.textContent에 직접 "⟳"를 넣고 버튼 자신(.dashboard-refresh-btn)에 회전
  // 애니메이션을 걸었더니, 화살표 글자만이 아니라 버튼의 테두리/배경까지 통째로 돌아 어색해
  // 보였다(사용자 지적) - 화살표만 담는 내부 span을 따로 두고, 그 span에만 회전 애니메이션을
  // 걸어 버튼 자체(테두리/배경)는 고정된 채 화살표만 돌게 한다.
  const icon = document.createElement('span');
  icon.className = 'dashboard-refresh-icon';
  icon.textContent = '⟳';
  btn.appendChild(icon);
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    icon.classList.add('spinning');
    hideError();
    try {
      const result = await window.portalPet.refreshPortalDashboard();
      if (result?.ok) {
        updateDashboardBadges(result);
      } else {
        showError(result?.error === 'not-configured'
          ? '먼저 설정에서 지역/비밀번호를 저장해 주세요.'
          : (result?.error || '결재 현황을 확인하지 못했습니다.'));
      }
    } catch (e) {
      showError(e?.message || '결재 현황을 확인하지 못했습니다.');
    } finally {
      btn.disabled = false;
      icon.classList.remove('spinning');
    }
  });
  return btn;
}

// ===== 업무포털 메인(예: https://goe.eduptl.kr/bpm_man_mn00_001.do) - 세 시스템 메뉴 위에 별도로 =====
const portalHomeWrap = document.getElementById('portal-home-wrap');
portalHomeWrap.appendChild(makeButton('portal_home', '업무포털 메인', true));
portalHomeWrap.appendChild(makeDashboardRefreshButton());

// (신규, 사용자 요청: "나이스/K-에듀파인/G-ONE 모두 표시 여부를 설정할 수 있도록") 학교·역할
// 마다 권한 없는 메뉴가 다를 수 있어, 모든 하위 메뉴 버튼을 설정에서 개별적으로 숨길 수 있게
// 한다 - subKey -> 버튼 element를 전부 기록해뒀다가, applyMenuVisibility에서
// config.hiddenMenuItems(숨길 key 배열, 기본값 빈 배열=전부 표시)에 따라 보이기/숨기기를 적용한다.
const menuBtnEls = {};

// (신규, 사용자 요청) 하위 메뉴 없이 그 화면으로 바로 이동만 하는 포털 상단 메뉴 바로가기들 -
// 나이스/K-에듀파인/G-ONE처럼 여러 하위 기능이 있는 시스템이 아니라 "업무포털 메인"과 같은
// 성격이라 3열 그리드가 아니라 그 아래 별도 영역에 줄바꿈되는 좁은 버튼으로 둔다(라벨도
// 짧게 줄여서 한 줄에 2~3개씩 들어가게 함).
const PORTAL_LINKS = [
  { key: 'staff_home', label: '교직원홈' },
  { key: 'edasan', label: 'e-다산' },
  { key: 'ginsight', label: 'G-인사이트' },
  { key: 'hicoaching', label: '하이코칭' },
];
const portalLinksWrap = document.getElementById('portal-links-wrap');
PORTAL_LINKS.forEach(({ key, label }) => {
  const btn = makeButton(key, label, true);
  menuBtnEls[key] = btn;
  portalLinksWrap.appendChild(btn);
});

COLUMNS.forEach(({ key, label, subs }) => {
  const col = document.createElement('div');
  col.className = 'service-col';
  col.appendChild(makeButton(key, label, true));
  subs.forEach(({ key: subKey, label: subLabel }) => {
    const btn = makeButton(subKey, subLabel, false);
    menuBtnEls[subKey] = btn;
    col.appendChild(btn);
  });
  servicesEl.appendChild(col);
});

function applyMenuVisibility(config) {
  const hidden = new Set(Array.isArray(config?.hiddenMenuItems) ? config.hiddenMenuItems : []);
  for (const [subKey, btn] of Object.entries(menuBtnEls)) {
    btn.style.display = hidden.has(subKey) ? 'none' : '';
  }
}

// ===== 드래그로 위치 이동 =====
// frame:false 창이라 -webkit-app-region:drag는 클릭 토글과 충돌할 수 있어(실측 확인 필요
// 없이도 잘 알려진 제약) mousedown/mousemove/mouseup으로 직접 구현한다. 실제로 마우스가
// 일정 거리 이상 움직였을 때만 "드래그"로 보고, 그렇지 않으면 기존처럼 클릭(패널 토글)으로
// 처리한다.
const DRAG_THRESHOLD_PX = 4;
let dragging = false;
let dragMoved = false;
let lastScreenX = 0;
let lastScreenY = 0;

petEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // 좌클릭만
  dragging = true;
  dragMoved = false;
  lastScreenX = e.screenX;
  lastScreenY = e.screenY;
  setPose('dragging');
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.screenX - lastScreenX;
  const dy = e.screenY - lastScreenY;
  if (!dragMoved && (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX)) {
    dragMoved = true;
  }
  if (dragMoved && (dx !== 0 || dy !== 0)) {
    window.portalPet.movePetBy(dx, dy);
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
  }
});

window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  if (!dragMoved) {
    window.portalPet.togglePanel(); // 움직인 적 없으면 원래대로 클릭 = 패널 토글
  }
  setPose('idle');
});

// (신규, 사용자 요청: "메뉴가 늘어났을 때 팝업 메뉴의 세로가 길어지도록") 펼침 패널의 실제
// 콘텐츠 높이(#panel.scrollHeight)를 측정해 main.js에 보내 창 높이를 맞춘다. 패널이 숨겨진
// 상태(display:none)에서는 scrollHeight가 0이라 측정해봐야 의미가 없으니 건너뛴다. 방금
// display가 바뀐 직후라 레이아웃이 아직 반영 안 됐을 수 있어 requestAnimationFrame으로 한
// 프레임 미룬 뒤 잰다.
const panelEl = document.getElementById('panel');
function resizePanelToContent() {
  if (panelEl.classList.contains('hidden')) return;
  requestAnimationFrame(() => {
    window.portalPet.resizePanel(panelEl.scrollHeight);
  });
}

window.portalPet.onPanelState((expanded) => {
  panelEl.classList.toggle('hidden', !expanded);
  if (expanded) resizePanelToContent();
});

// 메뉴 하단 톱니 아이콘 - 트레이 메뉴를 거치지 않고 바로 설정 창을 연다.
document.getElementById('footer-settings-btn').addEventListener('click', () => {
  window.portalPet.openSetup();
});

// ===== 자주 가는 사이트 (사용자 지정 링크) =====
// SSO 자동화 대상이 아니라 그냥 기본 브라우저로 여는 단순 바로가기라, launchService가 아니라
// openExternal을 쓴다. 설정 창에서 저장할 때마다 'config-updated'가 와서 목록을 다시 그린다.
const customLinksWrap = document.getElementById('custom-links-wrap');
const customLinksEl = document.getElementById('custom-links');

function renderCustomLinks(customLinks) {
  customLinksEl.innerHTML = '';
  const links = Array.isArray(customLinks) ? customLinks : [];
  customLinksWrap.classList.toggle('hidden', links.length === 0);
  for (const { label, url } of links) {
    const btn = document.createElement('button');
    btn.className = 'custom-link-btn';
    btn.textContent = label;
    btn.title = url;
    btn.addEventListener('click', () => window.portalPet.openExternal(url));
    customLinksEl.appendChild(btn);
  }
}

// 메뉴(펼침 패널) 배경 투명도 - 설정 창의 슬라이더 값(0.2~1)을 CSS 변수로 반영한다.
function applyPanelOpacity(config) {
  const alpha = typeof config?.panelOpacity === 'number' ? config.panelOpacity : 0.92;
  document.documentElement.style.setProperty('--panel-alpha', String(alpha));
}

async function loadCustomLinks() {
  const config = await window.portalPet.getConfig();
  renderCustomLinks(config?.customLinks);
  applyPanelOpacity(config);
  applyMenuVisibility(config);
  resizePanelToContent(); // 설정 변경으로 표시되는 항목이 바뀌면 창 높이도 다시 맞춘다.
}
loadCustomLinks();
window.portalPet.onConfigUpdated(loadCustomLinks);
