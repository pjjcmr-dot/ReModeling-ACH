import "dotenv/config";
import { writeFileSync } from "fs";

const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY;

// ========================================================
// 전국 아파트 리모델링사업 추진단지 현황 (2026년 3월 기준)
// ========================================================
const ALL_DATA = [
  // ── 완료 ──
  { name: "송파 성지", addr: "서울 송파구 송파동", year: 1992, units: 327, builder: "포스코", stage: "완료" },
  { name: "둔촌 현대1", addr: "서울 강동구 둔촌동", year: 1984, units: 572, builder: "포스코", stage: "완료" },
  { name: "오금 아남", addr: "서울 송파구 오금동", year: 1992, units: 328, builder: "쌍용", stage: "완료" },
  { name: "개포 우성9", addr: "서울 강남구 개포동", year: 1991, units: 232, builder: "포스코", stage: "완료" },
  // ── 공사중 ──
  { name: "분당 무지개4", addr: "성남시 분당구 구미동", year: 1995, units: 563, builder: "포스코", stage: "공사중" },
  { name: "분당 느티3", addr: "성남시 분당구 정자동", year: 1994, units: 770, builder: "포스코", stage: "공사중" },
  { name: "이촌 현대", addr: "서울 용산구 이촌동", year: 1974, units: 653, builder: "포스코", stage: "공사중" },
  { name: "분당 느티4", addr: "성남시 분당구 정자동", year: 1994, units: 1006, builder: "포스코", stage: "공사중" },
  { name: "신답 극동", addr: "서울 동대문구 답십리동", year: 1987, units: 225, builder: "쌍용", stage: "공사중" },
  { name: "잠원 노블레스", addr: "서울 서초구 잠원동", year: 2000, units: 20, builder: "포스코", stage: "공사중" },
  { name: "광장 상록타워", addr: "서울 광진구 광장동", year: 1997, units: 200, builder: "HDC현산", stage: "공사중" },
  { name: "청담 건영", addr: "서울 강남구 청담동", year: 1994, units: 240, builder: "GS건설", stage: "공사중" },
  // ── 이주 ──
  { name: "분당 한솔5", addr: "성남시 분당구 정자동", year: 1994, units: 1156, builder: "포스코/쌍용", stage: "이주 시작" },
  { name: "수지 초입마을", addr: "용인시 수지구 풍덕천동", year: 1994, units: 1620, builder: "포스코", stage: "이주 시작" },
  { name: "반포 엠브이", addr: "서울 서초구 반포동", year: 1994, units: 154, builder: "현대건설", stage: "이주 예정" },
  { name: "영통 8단영", addr: "수원시 영통구 영통동", year: 1997, units: 1842, builder: "대우건설", stage: "이주 예정" },
  { name: "수지 보원", addr: "용인시 수지구 풍덕천동", year: 1994, units: 619, builder: "포스코", stage: "이주 예정" },
  { name: "평촌 목련3", addr: "안양시 동안구 호계동", year: 1992, units: 994, builder: "효성", stage: "이주 예정" },
  // ── 허가(사업계획승인) 완료 ──
  { name: "둔촌 부영", addr: "서울 강동구 둔촌동", year: 1994, units: 712, builder: "포스코", stage: "허가완료" },
  { name: "수지 죽전프리체", addr: "용인시 수지구 죽전동", year: 1999, units: 430, builder: "SK", stage: "허가완료" },
  { name: "매탄 동남", addr: "수원시 영통구 매탄동", year: 1989, units: 892, builder: "효성", stage: "허가완료" },
  { name: "산본 캐나리13", addr: "군포시 산본동", year: 1995, units: 1778, builder: "포스코/현대", stage: "허가완료" },
  { name: "목동 우성", addr: "서울 양천구 목동", year: 1992, units: 1232, builder: "GS건설", stage: "허가완료" },
  { name: "성복역 리버파크", addr: "용인시 수지구 성복동", year: 1998, units: 702, builder: "포스코", stage: "허가완료" },
  { name: "수지 한국", addr: "용인시 수지구 풍덕천동", year: 1995, units: 416, builder: "KCC", stage: "허가완료" },
  { name: "문정 현대", addr: "서울 송파구 문정동", year: 1991, units: 120, builder: "쌍용건설", stage: "허가완료" },
  { name: "영통 5단영", addr: "수원시 영통구 영통동", year: 1997, units: 1616, builder: "DL/현연", stage: "허가완료" },
  { name: "수지 동부", addr: "용인시 수지구 풍덕천동", year: 1995, units: 612, builder: "포스코", stage: "허가완료" },
  { name: "대치 현대1", addr: "서울 강남구 대치동", year: 1990, units: 120, builder: "HDC현산", stage: "허가완료" },
  { name: "분당 매화1", addr: "성남시 분당구 야탑동", year: 1995, units: 562, builder: "포스코", stage: "허가완료" },
  // ── 허가 신청/준비 ──
  { name: "금호 벽산", addr: "서울 성동구 금호동", year: 2001, units: 1707, builder: "현대/삼성", stage: "허가신청" },
  { name: "영통 8주공", addr: "수원시 영통구 영통동", year: 1997, units: 1548, builder: "포스코", stage: "허가신청" },
  { name: "둔촌 현대2", addr: "서울 강동구 둔촌동", year: 1988, units: 196, builder: "효성", stage: "허가신청" },
  { name: "잠원 패밀리", addr: "서울 서초구 잠원동", year: 1992, units: 288, builder: "포스코", stage: "허가신청" },
  { name: "잠원 한신로얄", addr: "서울 서초구 잠원동", year: 1992, units: 208, builder: "HDC현산", stage: "허가준비" },
  { name: "평촌 향촌롯데", addr: "안양시 동안구 평촌동", year: 1993, units: 530, builder: "포스코", stage: "허가준비" },
  { name: "대치 현대아파트", addr: "서울 강남구 대치동", year: 1997, units: 630, builder: "GS건설", stage: "허가준비" },
  { name: "이촌 강촌", addr: "서울 용산구 이촌동", year: 1998, units: 1101, builder: "현대건설", stage: "허가준비" },
  { name: "성복역 현대홈타운", addr: "용인시 수지구 상현동", year: 2001, units: 462, builder: "DL이앤씨", stage: "허가준비" },
  { name: "산본 무궁화주공1", addr: "군포시 금정동", year: 1992, units: 1329, builder: "현대건설", stage: "허가준비" },
  { name: "수지 삼성1차", addr: "용인시 수지구 풍덕천동", year: 1994, units: 576, builder: "현대엔지니어링", stage: "허가준비" },
  { name: "분당 매화2", addr: "성남시 분당구 야탑동", year: 1995, units: 1185, builder: "포스코", stage: "허가준비" },
  { name: "광명 철산한신", addr: "광명시 철산동", year: 1992, units: 1568, builder: "쌍용/현연", stage: "허가준비" },
  { name: "영통 5주공", addr: "수원시 영통구 영통동", year: 1997, units: 1504, builder: "GS건설", stage: "허가준비" },
  { name: "산본 울곡3", addr: "군포시 산본동", year: 1995, units: 1778, builder: "포스코/현대", stage: "허가준비" },
  { name: "영통 삼성태야", addr: "수원시 영통구 영통동", year: 1997, units: 832, builder: "포스코", stage: "허가준비" },
  { name: "영통 신명동보", addr: "수원시 영통구 영통동", year: 1997, units: 836, builder: "현대건설", stage: "허가준비" },
  { name: "광교상현마을 현대", addr: "용인시 수지구 상현동", year: 2001, units: 498, builder: "포스코", stage: "허가준비" },
  { name: "수지 현대", addr: "용인시 수지구 풍덕천동", year: 1994, units: 1168, builder: "대우건설", stage: "허가준비" },
  { name: "신도림 우성1차", addr: "서울 구로구 신도림동", year: 1992, units: 169, builder: "GS건설", stage: "허가준비" },
  { name: "신도림 우성2차", addr: "서울 구로구 신도림동", year: 1996, units: 239, builder: "GS건설", stage: "허가준비" },
  { name: "신도림 우성3차", addr: "서울 구로구 신도림동", year: 1993, units: 284, builder: "포스코", stage: "허가준비" },
  { name: "신도림 우성5차", addr: "서울 구로구 신도림동", year: 1994, units: 154, builder: "포스코", stage: "허가준비" },
  { name: "수지 신정9", addr: "용인시 수지구 풍덕천동", year: 2000, units: 812, builder: "현대건설", stage: "허가준비" },
  { name: "둔촌 현대3", addr: "서울 강동구 둔촌동", year: 1988, units: 160, builder: "효성", stage: "허가준비" },
  { name: "신정 쌍용", addr: "서울 양천구 신정동", year: 1992, units: 270, builder: "포스코", stage: "허가준비" },
  { name: "평촌 목련3(2)", addr: "안양시 동안구 호계동", year: 1992, units: 902, builder: "쌍용", stage: "허가준비" },
  { name: "권선 산천리2차", addr: "수원시 권선구 권선동", year: 1996, units: 546, builder: "롯데건설", stage: "허가준비" },
  { name: "평촌 조원대림2", addr: "안양시 동안구 평촌동", year: 1993, units: 1035, builder: "현대엔지니어링", stage: "허가준비" },
  { name: "평촌 조원한양", addr: "안양시 동안구 평촌동", year: 1993, units: 870, builder: "대우건설", stage: "허가준비" },
  { name: "산본 우록7", addr: "군포시 산본동", year: 1994, units: 1312, builder: "DL이앤씨", stage: "허가준비" },
  { name: "개포 대청", addr: "서울 강남구 개포동", year: 1992, units: 822, builder: "포스코", stage: "허가준비" },
  { name: "개포 성원대치2", addr: "서울 강남구 개포동", year: 1992, units: 1758, builder: "DL/HDC/현연", stage: "허가준비" },
  // ── 건축심의 ──
  { name: "신반포 청구", addr: "서울 서초구 잠원동", year: 1998, units: 347, builder: "포스코", stage: "건축심의통과" },
  { name: "고덕 아남", addr: "서울 강동구 고덕동", year: 1996, units: 807, builder: "삼성물산", stage: "건축심의통과" },
  { name: "창원 토월성원", addr: "경남 창원시 상남동", year: 1994, units: 6252, builder: "현대/현연/코/포", stage: "건축심의통과" },
  { name: "잠원 롯데갤럭시1", addr: "서울 서초구 잠원동", year: 2002, units: 256, builder: "현대건설", stage: "건축심의통과" },
  { name: "평촌 한가람신라", addr: "안양시 동안구 관양동", year: 1992, units: 1068, builder: "포스코", stage: "건축심의통과" },
  { name: "옥수 극동", addr: "서울 성동구 옥수동", year: 1986, units: 900, builder: "쌍용", stage: "건축심의통과" },
  { name: "청담 신동아", addr: "서울 강남구 청담동", year: 1997, units: 106, builder: "롯데건설", stage: "건축심의통과" },
  { name: "목동 우성2차", addr: "서울 양천구 신정동", year: 2000, units: 1140, builder: "롯데건설", stage: "건축심의통과" },
  { name: "문정 시영", addr: "서울 송파구 문정동", year: 1989, units: 1316, builder: "포스코", stage: "건축심의신청" },
  { name: "문정 건영", addr: "서울 송파구 문정동", year: 1993, units: 545, builder: "GS건설", stage: "건축심의신청" },
  { name: "범어 우방청솔", addr: "대구 수성구 범어동", year: 1994, units: 194, builder: "효성", stage: "건축심의신청" },
  { name: "마포 서강GS", addr: "서울 마포구 신공덕동", year: 1999, units: 538, builder: "GS건설", stage: "건축심의신청" },
  // ── 지구단위/도시계획 ──
  { name: "자양 우성1차", addr: "서울 광진구 자양동", year: 1988, units: 656, builder: "포스코", stage: "지구단위계획통과" },
  { name: "고덕 배재현대", addr: "서울 강동구 고덕동", year: 1994, units: 449, builder: "대우건설", stage: "지구단위계획통과" },
  { name: "선사 현대", addr: "서울 강동구 암사동", year: 2000, units: 3090, builder: "롯데/현대", stage: "도시교통환경통과" },
  { name: "이촌 코오롱", addr: "서울 용산구 이촌동", year: 1999, units: 834, builder: "삼성물산", stage: "도시교통통과" },
  { name: "창원 대동중앙", addr: "경남 창원시 상남동", year: 1993, units: 1040, builder: "한양", stage: "도시계획심의통과" },
  { name: "송파 거여4단지", addr: "서울 송파구 거여동", year: 1997, units: 546, builder: "포스코", stage: "도시계획심의통과" },
  { name: "송파 거여5단지", addr: "서울 송파구 거여동", year: 1997, units: 605, builder: "대우건설", stage: "도시계획심의통과" },
  { name: "상동 항아울1차", addr: "부천시 상동", year: 1993, units: 1236, builder: "포스코", stage: "도시계획심의통과" },
  { name: "평촌 공작부영", addr: "안양시 동안구 관양동", year: 1993, units: 1710, builder: "-", stage: "도시계획심의통과" },
  { name: "가락 쌍용1차", addr: "서울 송파구 가락동", year: 1997, units: 2064, builder: "쌍용/포스코/대우", stage: "도시계획심의통과" },
  { name: "가락 상아2차", addr: "서울 송파구 오금동", year: 1988, units: 750, builder: "삼성물산", stage: "도시계획심의통과" },
  { name: "잠원 동아", addr: "서울 서초구 잠원동", year: 2002, units: 991, builder: "현대건설", stage: "교통영향평가통과" },
  { name: "잠원 강변", addr: "서울 서초구 잠원동", year: 1987, units: 360, builder: "삼성물산", stage: "교통영향평가통과" },
  { name: "명장 무학", addr: "서울 강서구 영등포동", year: 1999, units: 273, builder: "한화건설", stage: "서울시사전자문통과" },
  // ── 사전자문/심의 ──
  { name: "이촌 한가람", addr: "서울 용산구 이촌동", year: 1998, units: 2036, builder: "GS/현연", stage: "서울시사전자문통과" },
  { name: "명일 중앙하이츠", addr: "서울 강동구 상일동", year: 1992, units: 410, builder: "포스코", stage: "서울시사전자문통과" },
  { name: "가락 쌍용2차", addr: "서울 송파구 가락동", year: 1999, units: 492, builder: "삼성물산", stage: "서울시사전자문통과" },
  { name: "일산 문촌16", addr: "고양시 일산서구 주엽동", year: 1994, units: 956, builder: "포스코", stage: "심의신청" },
  { name: "부개주공3", addr: "인천 부평구 부개동", year: 1996, units: 1724, builder: "쌍용/SK", stage: "사업계획승인신청" },
  { name: "가락 금호", addr: "서울 송파구 가락동", year: 1997, units: 915, builder: "GS건설", stage: "심의준비" },
  { name: "해운대 상록", addr: "부산 해운대구 좌동", year: 1998, units: 1000, builder: "-", stage: "심의준비" },
  { name: "평촌 향촌현대", addr: "안양시 동안구 평촌동", year: 1992, units: 552, builder: "포스코", stage: "심의준비" },
  { name: "일산 강선14", addr: "고양시 일산서구 주엽동", year: 1994, units: 792, builder: "현대건설", stage: "심의준비" },
  { name: "조원 세경8", addr: "안양시 동안구 평촌동", year: 1996, units: 709, builder: "포스코", stage: "심의준비" },
  { name: "이촌 우성", addr: "서울 용산구 이촌동", year: 1995, units: 243, builder: "SK에코플랜트", stage: "심의준비" },
  { name: "현석 방성현대", addr: "서울 마포구 현석동", year: 1999, units: 219, builder: "GS건설", stage: "심의준비" },
  { name: "삼전 현대", addr: "서울 송파구 삼전동", year: 1989, units: 120, builder: "GS건설", stage: "심의준비" },
  { name: "길동 우성2차", addr: "서울 강동구 길동", year: 1994, units: 811, builder: "포스코", stage: "심의준비" },
  { name: "잠실동 현대", addr: "서울 송파구 잠실동", year: 1990, units: 336, builder: "포스코", stage: "심의준비" },
  { name: "명일 현대", addr: "서울 강동구 명일동", year: 1988, units: 226, builder: "쌍용건설", stage: "심의준비" },
  { name: "창원 남양피오르빌", addr: "경남 창원시 남양동", year: 1995, units: 1560, builder: "KCC", stage: "심의준비" },
  { name: "이문 삼익", addr: "서울 동대문구 이문동", year: 1997, units: 353, builder: "KCC", stage: "심의준비" },
  // ── 안전진단 ──
  { name: "문래 현대2차", addr: "서울 영등포구 문래동", year: 1987, units: 390, builder: "포스코", stage: "안전진단통과" },
  { name: "문래 대원", addr: "서울 영등포구 문래동", year: 1998, units: 218, builder: "포스코", stage: "안전진단통과" },
  { name: "잠원 현대채밀리", addr: "서울 서초구 잠원동", year: 1997, units: 113, builder: "쌍용", stage: "안전진단통과" },
  { name: "화정 별빛8단지", addr: "고양시 덕양구 화정동", year: 1995, units: 1232, builder: "포스코", stage: "안전진단통과" },
  { name: "산본 충무2단지2차", addr: "군포시 금정동", year: 1992, units: 476, builder: "SK에코플랜트", stage: "안전진단통과" },
  { name: "봉선 삼익1차", addr: "광주 남구 봉선동", year: 1991, units: 390, builder: "DL이앤씨", stage: "안전진단통과" },
  { name: "이촌 코스모스", addr: "서울 용산구 이촌동", year: 1974, units: 30, builder: "-", stage: "안전진단진행중" },
  // ── 시공사 선정 ──
  { name: "문래 현대5차", addr: "서울 영등포구 문래동", year: 1992, units: 282, builder: "포스코", stage: "시공사선정" },
  { name: "광나루 현대", addr: "서울 광진구 광장동", year: 1992, units: 282, builder: "삼성물산", stage: "시공사선정" },
  { name: "사당 유극신", addr: "서울 동작구 사당동", year: 1993, units: 4397, builder: "포스코", stage: "시공사선정" },
  { name: "강남 서광", addr: "서울 강남구 삼성동", year: 1998, units: 304, builder: "현대엔지니어링", stage: "시공사선정" },
  { name: "평촌 한가람세경", addr: "안양시 동안구 관양동", year: 1996, units: 1292, builder: "현대건설", stage: "시공사선정" },
  { name: "반포 푸르지오", addr: "서울 서초구 반포동", year: 2000, units: 237, builder: "삼성물산", stage: "시공사선정중" },
  { name: "산본 퇴계주공3", addr: "군포시 산본동", year: 1995, units: 1992, builder: "-", stage: "시공사선정중" },
  { name: "수지 풍산", addr: "용인시 수지구 상현동", year: 1997, units: 438, builder: "DL이앤씨", stage: "시공사선정중" },
  { name: "잠원 미주파스텔", addr: "서울 서초구 잠원동", year: 2002, units: 91, builder: "대보건설", stage: "시공사선정중" },
  { name: "산본 설악주공8", addr: "군포시 산본동", year: 1995, units: 1471, builder: "쌍용/SK", stage: "시공사선정중" },
  { name: "창원 토월 대동", addr: "경남 창원시 상남동", year: 1994, units: 2810, builder: "현대/한화/남영", stage: "시공사선정중" },
  { name: "강변 현대", addr: "서울 송파구 풍납동", year: 1991, units: 104, builder: "금호건설", stage: "시공사선정중" },
  { name: "응봉 신동아", addr: "서울 성동구 응봉동", year: 1998, units: 434, builder: "쌍용/호반", stage: "시공사선정중" },
  // ── 조합설립 ──
  { name: "유원 서초", addr: "서울 서초구 서초동", year: 1993, units: 590, builder: "-", stage: "조합설립인가완료" },
  { name: "마포 한강삼성", addr: "서울 마포구 토정동", year: 1997, units: 456, builder: "-", stage: "조합설립인가완료" },
  { name: "분당 한솔6", addr: "성남시 분당구 정자동", year: 1995, units: 1039, builder: "-", stage: "조합설립인가완료" },
  { name: "대림 역삼", addr: "서울 강남구 역삼동", year: 1997, units: 129, builder: "-", stage: "조합설립인가완료" },
  { name: "잠원 신화", addr: "서울 서초구 잠원동", year: 1997, units: 166, builder: "-", stage: "조합설립인가완료" },
  { name: "송파 현대", addr: "서울 송파구 송파동", year: 1997, units: 243, builder: "-", stage: "조합설립인가완료" },
  // ── 조합 초기 ──
  { name: "사당 신동아4차", addr: "서울 동작구 사당동", year: 1993, units: 912, builder: "-", stage: "조합창립총회" },
  { name: "사당 신동아5차", addr: "서울 동작구 사당동", year: 1998, units: 223, builder: "-", stage: "조합창립총회" },
];

// ── 지오코딩 ──
async function geocode(address) {
  const res = await fetch(
    `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}&size=1`,
    { headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` } }
  );
  const data = await res.json();
  if (data.documents?.[0]) {
    return { lng: +data.documents[0].x, lat: +data.documents[0].y };
  }
  // 키워드 검색 폴백
  const res2 = await fetch(
    `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(address + " 아파트")}&size=1`,
    { headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` } }
  );
  const data2 = await res2.json();
  if (data2.documents?.[0]) {
    return { lng: +data2.documents[0].x, lat: +data2.documents[0].y };
  }
  return null;
}

function makePolygon(lng, lat, size = 0.0015) {
  const h = size / 2;
  return [[ [lng-h,lat-h], [lng+h,lat-h], [lng+h,lat+h], [lng-h,lat+h], [lng-h,lat-h] ]];
}

async function main() {
  console.log(`전국 리모델링 현장 ${ALL_DATA.length}개 변환 시작 (2026.03 기준)\n`);
  const features = [];
  let success = 0, fail = 0;

  for (let i = 0; i < ALL_DATA.length; i++) {
    const d = ALL_DATA[i];
    process.stdout.write(`[${i+1}/${ALL_DATA.length}] ${d.name} ... `);

    const coord = await geocode(d.addr);
    if (!coord) {
      console.log("실패");
      fail++;
      continue;
    }
    console.log(`${coord.lat.toFixed(4)}, ${coord.lng.toFixed(4)}`);
    success++;

    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: makePolygon(coord.lng, coord.lat) },
      properties: {
        id: `RM${String(i+1).padStart(3,"0")}`,
        name: d.name,
        subtype: "세대수증가형",
        address: d.addr,
        stage: d.stage,
        stage_date: "2026.03 기준",
        expected_completion: "",
        households: d.units,
        existing_households: d.units,
        added_households: 0,
        increase_rate: 0,
        area: "",
        built_year: d.year,
        max_floors: 0,
        developer: d.name + " 리모델링조합",
        constructor: d.builder,
        price_per_pyeong: 0,
        price_change: 0,
        contribution: 0,
        sale_price: 0,
        sale_price_date: "-",
        premium: 0,
        legal: [
          { title: "근거법령", content: "주택법 제66조(리모델링의 허가)" },
          { title: "준공연도", content: `${d.year}년` },
          { title: "추진단계", content: d.stage },
        ],
      },
    });

    // API 과부하 방지
    await new Promise(r => setTimeout(r, 100));
  }

  const geojson = { type: "FeatureCollection", features };
  writeFileSync("public/sites.json", JSON.stringify(geojson, null, 2), "utf-8");
  console.log(`\n완료! 성공: ${success}개 / 실패: ${fail}개`);
  console.log(`public/sites.json 저장됨`);
}

main().catch(console.error);
