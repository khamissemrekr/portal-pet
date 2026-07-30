// 3열(나이스 / K-에듀파인 / G-ONE) 구조. 열마다 헤더 버튼(시스템 홈 바로가기) + 하위 액션
// 버튼들을 세로로 쌓는다. G-ONE만 하위 항목이 3개(메신저/AI 대화·초안/일정)라 열마다
// 높이가 달라질 수 있어서, 균일한 grid가 아니라 열별 독립 flex 레이아웃을 쓴다.
const COLUMNS = [
  {
    key: 'nice', label: '나이스',
    subs: [
      { key: 'bokmu', label: '복무 신청' },
      { key: 'trip', label: '출장 신청' },
      { key: 'nice_approval', label: '나이스 결재' },
    ],
  },
  {
    key: 'edufine', label: 'K-에듀파인',
    subs: [
      { key: 'giahn', label: '기안문 작성' },
      { key: 'pumui', label: '품의 작성' },
      { key: 'edufine_approval', label: '공문 결재' },
      // { key: 'edufine_check', label: '결재 건수 확인' }, // 임시로 화면에서 숨김(다른 수정 먼저 진행) - 코드/커밋은 유지, 이 줄만 주석 해제하면 복원됨
    ],
  },
  {
    key: 'gone', label: 'G-ONE',
    subs: [
      { key: 'gone_msg', label: '메신저' },
      { key: 'gone_ai', label: 'AI 대화·초안' },
      { key: 'gone_schedule', label: '일정' },
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

function makeButton(key, label, isHeader) {
  const btn = document.createElement('button');
  btn.className = isHeader ? 'service-btn header' : 'service-btn';
  btn.textContent = label;
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

// ===== K-에듀파인 결재 대기 건수 확인 =====
// launchService(브라우저 화면 전환)와 달리, 이미 있던 화면을 그대로 둔 채 상단 상태바의
// "결재(긴급) N(N)" 배지만 읽어와서 캐릭터 위에 배지로 표시한다. 버튼 클릭으로만 동작하고
// 백그라운드에서 자동으로 반복 확인하지는 않는다(그러면 자동화용 크롬 창이 주기적으로 떠서
// 작업 중인 화면을 방해할 수 있어서 - 은애님과 상의해서 수동 확인 방식으로 결정).
const approvalBadgeEl = document.getElementById('approval-badge');
function updateApprovalBadge(total, urgent) {
  if (!approvalBadgeEl) return;
  if (total > 0) {
    approvalBadgeEl.textContent = total > 99 ? '99+' : String(total);
    approvalBadgeEl.title = `결재 대기 ${total}건${urgent > 0 ? ` (긴급 ${urgent}건)` : ''}`;
    approvalBadgeEl.classList.remove('hidden');
  } else {
    approvalBadgeEl.title = '결재 대기 문서 없음';
    approvalBadgeEl.classList.add('hidden');
  }
}

function makeApprovalCheckButton(label) {
  const btn = document.createElement('button');
  btn.className = 'service-btn';
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    if (launching) return;
    launching = true;
    setButtonsDisabled(true);
    statusDot.className = 'idle';
    hideError();
    setPose('working');
    try {
      const result = await window.portalPet.checkEdufineApprovals();
      if (result.ok) {
        statusDot.className = 'connected';
        setPose('success', { autoResetMs: 2000 });
        updateApprovalBadge(result.total, result.urgent);
      } else {
        statusDot.className = 'error';
        setPose('error', { autoResetMs: 2500 });
        showError(result.error === 'not-configured'
          ? '먼저 설정에서 지역/비밀번호를 저장해 주세요.'
          : (result.error || '결재 건수를 확인하지 못했습니다.'));
      }
    } catch (e) {
      statusDot.className = 'error';
      setPose('error', { autoResetMs: 2500 });
      showError(e?.message || '결재 건수를 확인하지 못했습니다.');
    } finally {
      launching = false;
      setButtonsDisabled(false);
    }
  });
  return btn;
}

// ===== 업무포털 메인(예: https://goe.eduptl.kr/bpm_man_mn00_001.do) - 세 시스템 메뉴 위에 별도로 =====
document.getElementById('portal-home-wrap').appendChild(makeButton('portal_home', '업무포털 메인', true));

COLUMNS.forEach(({ key, label, subs }) => {
  const col = document.createElement('div');
  col.className = 'service-col';
  col.appendChild(makeButton(key, label, true));
  subs.forEach(({ key: subKey, label: subLabel }) => {
    col.appendChild(
      subKey === 'edufine_check' ? makeApprovalCheckButton(subLabel) : makeButton(subKey, subLabel, false)
    );
  });
  servicesEl.appendChild(col);
});

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

window.portalPet.onPanelState((expanded) => {
  document.getElementById('panel').classList.toggle('hidden', !expanded);
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

async function loadCustomLinks() {
  const config = await window.portalPet.getConfig();
  renderCustomLinks(config?.customLinks);
}
loadCustomLinks();
window.portalPet.onConfigUpdated(loadCustomLinks);
