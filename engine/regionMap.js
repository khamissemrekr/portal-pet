// 시도교육청 도메인 규칙. 출처: OneClickPortal(zeroboom92/OneClickPortal)의 EducationOffice.cs —
// 같은 문제를 다루는 실사용 프로그램의 실측 데이터라 신뢰도가 높다. 경북(gbe)만 에듀파인 도메인이
// 예외 패턴(klef.gbe.kr, 나머지는 klef.{code}.go.kr)이라 별도로 override 해둔다.
const OFFICES = {
  '서울': { code: 'sen' },
  '경기': { code: 'goe' },
  '경남': { code: 'gne' },
  '부산': { code: 'pen' },
  '대구': { code: 'dge' },
  '대전': { code: 'dje' },
  '경북': { code: 'gbe', edufineDomain: 'klef.gbe.kr' },
  '세종': { code: 'sje' },
  '울산': { code: 'use' },
  '인천': { code: 'ice' },
  '광주': { code: 'gen' },
  '전남': { code: 'jne' },
  '전북': { code: 'jbe' },
  '충남': { code: 'cne' },
  '충북': { code: 'cbe' },
  '강원': { code: 'gwe' },
  '제주': { code: 'jje' },
};

// 기존 코드 호환용: 지역명 -> 서브도메인 코드 (setup.html 드롭다운 등에서 사용)
const REGIONS = Object.fromEntries(Object.entries(OFFICES).map(([name, o]) => [name, o.code]));

/** 지역명("경기") 또는 코드("goe") 어느 쪽으로 와도 office 정보를 찾는다. */
function getOffice(regionOrCode) {
  if (OFFICES[regionOrCode]) return { name: regionOrCode, ...OFFICES[regionOrCode] };
  const entry = Object.entries(OFFICES).find(([, o]) => o.code === regionOrCode);
  if (entry) return { name: entry[0], ...entry[1] };
  return null; // 목록에 없는 지역 - 직접 입력한 서브도메인일 수 있음
}

function buildPortalUrl(subdomain) {
  return `https://${subdomain}.eduptl.kr/bpm_man_mn00_001.do`;
}

function buildNeisUrl(subdomain) {
  return `https://${subdomain}.neis.go.kr/jsp/main.jsp`;
}

function buildEdufineUrl(subdomain) {
  const office = getOffice(subdomain);
  const domain = office?.edufineDomain || `klef.${subdomain}.go.kr`;
  return `https://${domain}/keris_ui/main.do`;
}

// 교육행정데이터통합관리(교데통)도 G-ONE과 마찬가지로 지역마다 서브도메인이 붙는 패턴으로
// 보인다(실측 확인된 건 goe.edmgr.kr 하나뿐 - 다른 지역은 미검증). path 기본값은 "내부승인처리"
// 화면(taskPotlMain), SSO 진입점은 path='main'으로 호출.
function buildEdmgrUrl(subdomain, path = 'taskPotlMain') {
  return `https://${subdomain}.edmgr.kr/${path}`;
}

// G-ONE(업무협업G-ONE)은 경기도교육청 전용 플랫폼이라 다른 지역엔 없을 가능성이 높다(미확인).
// 포털 메뉴 실측 DOM(a.menuBtn id 속성)에서 확인한 정확한 SSO 진입 URL. 지금은 goToPortalMenu가
// 포털 홈의 실시간 DOM에서 먼저 읽어오므로, 이 값은 그게 실패했을 때의 fallback으로만 쓰인다.
const GONE_URL_BY_SUBDOMAIN = {
  goe: 'https://gdp.goe.go.kr/api/auth/login/ssoNeisReturn',
};

module.exports = {
  OFFICES,
  REGIONS,
  getOffice,
  buildPortalUrl,
  buildNeisUrl,
  buildEdufineUrl,
  buildEdmgrUrl,
  GONE_URL_BY_SUBDOMAIN,
};
