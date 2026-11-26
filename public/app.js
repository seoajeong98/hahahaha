const $ = id => document.getElementById(id);
let map, routeLine, markers = [], origin, chargerData = [], lastRoute;

function message(element, text, error = false) {
  element.textContent = text;
  element.classList.toggle('error', error);
}

async function api(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}

async function initMap() {
  try {
    const config = await api('/api/config');
    if (!config.mapsClientId) {
      $('map-status').lastChild.textContent = ' 지도 API 키 필요';
      return;
    }
    const script = document.createElement('script');
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(config.mapsClientId)}`;
    script.onload = () => {
      try {
        if (!window.naver?.maps) throw new Error('지도 SDK를 사용할 수 없습니다.');
        map = new naver.maps.Map('map', { center: new naver.maps.LatLng(37.5665, 126.978), zoom: 12 });
        $('map-placeholder').hidden = true;
        $('map-status').lastChild.textContent = ' 네이버 지도';
        if (lastRoute) drawRoute(lastRoute);
      } catch (error) {
        message($('map-status'), `지도 오류: ${error.message}`, true);
      }
    };
    script.onerror = () => message($('map-status'), '지도 SDK를 불러오지 못했습니다.', true);
    document.head.append(script);
  } catch (error) {
    message($('map-status'), error.message, true);
  }
}
initMap();

function clearRoute() {
  if (routeLine) routeLine.setMap(null);
  markers.forEach(marker => marker.setMap(null));
  routeLine = undefined;
  markers = [];
  origin = undefined;
  lastRoute = undefined;
  $('route-result').replaceChildren();
  $('chargers').replaceChildren();
}

function drawRoute(data) {
  if (map) {
    const points = data.path.map(([lng, lat]) => new naver.maps.LatLng(lat, lng));
    routeLine = new naver.maps.Polyline({ map, path: points, strokeColor: '#3c9b70', strokeWeight: 5, strokeOpacity: 0.9 });
    const bounds = new naver.maps.LatLngBounds();
    points.forEach(point => bounds.extend(point));
    [data.from, data.to].forEach(point => {
      const position = new naver.maps.LatLng(Number(point.y), Number(point.x));
      bounds.extend(position);
      markers.push(new naver.maps.Marker({ map, position }));
    });
    map.fitBounds(bounds, { top: 50, right: 50, bottom: 50, left: 50 });
  }
}

function showRoute(data) {
  const result = $('route-result');
  result.replaceChildren();
  result.className = 'route-summary';
  for (const [label, value] of [['자동차 거리', `${(data.distance / 1000).toFixed(1)} km`], ['자동차 예상 시간', `${Math.ceil(data.duration / 60000)}분`]]) {
    const item = document.createElement('div');
    item.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    item.append(strong);
    result.append(item);
  }
  origin = { lat: Number(data.from.y), lng: Number(data.from.x) };
  lastRoute = data;
  drawRoute(data);
  showChargers();
}

$('route-form').addEventListener('submit', async event => {
  event.preventDefault();
  clearRoute();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  message($('route-message'), '자동차 경로를 불러오는 중입니다.');
  try {
    const params = new URLSearchParams({ start: $('start').value.trim(), goal: $('goal').value.trim() });
    const result = await api(`/api/route?${params}`);
    showRoute(result);
    message($('route-message'), `${result.from.address} → ${result.to.address}`);
  } catch (error) {
    message($('route-message'), error.message, true);
    showChargers();
  } finally {
    button.disabled = false;
  }
});

function updateBattery() {
  const battery = $('battery').valueAsNumber;
  const range = $('full-range').valueAsNumber;
  $('remaining').textContent = Number.isFinite(battery) && battery >= 0 && battery <= 100 && Number.isFinite(range) && range > 0 && range <= 300
    ? `약 ${(battery * range / 100).toFixed(1)} km` : '올바른 값 입력 필요';
}
$('battery').addEventListener('input', updateBattery);
$('full-range').addEventListener('input', updateBattery);

$('bus-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  message($('bus-result'), '도착 정보를 불러오는 중입니다.');
  try {
    const params = new URLSearchParams({ city: $('city').value.trim(), stop: $('stop').value.trim() });
    const result = await api(`/api/buses?${params}`);
    const text = result.buses.length ? result.buses.map(bus => `${bus.route}번 · ${Math.ceil(Number(bus.seconds) / 60)}분 후`).join(' / ') : '현재 조회된 저상버스 도착 정보가 없습니다.';
    message($('bus-result'), text + (result.truncated ? ' (첫 100건만 조회됨)' : ''));
  } catch (error) {
    message($('bus-result'), error.message, true);
  } finally {
    button.disabled = false;
  }
});

function parseCsv(text) {
  const rows = [], row = [];
  let value = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(value); value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(value); rows.push(row.splice(0)); value = '';
    } else value += char;
  }
  if (quoted) throw new Error('CSV 따옴표가 닫히지 않았습니다.');
  if (value || row.length) { row.push(value); rows.push(row); }
  const headers = rows.shift()?.map(header => header.trim()) || [];
  if (!['시설명', '위도', '경도'].every(header => headers.includes(header))) throw new Error('필수 열(시설명, 위도, 경도)이 없습니다. UTF-8 CSV 파일을 확인해 주세요.');
  return rows.map(values => Object.fromEntries(headers.map((header, i) => [header, (values[i] || '').trim()])))
    .filter(item => item.시설명 && item.위도 && item.경도 && Number.isFinite(Number(item.위도)) && Number.isFinite(Number(item.경도)));
}

function distance(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function showChargers() {
  $('chargers').replaceChildren();
  if (!chargerData.length) return message($('charger-message'), '충전소 데이터가 없습니다. CSV 파일을 불러와 주세요.');
  if (!origin) return message($('charger-message'), `${chargerData.length}개 충전소를 불러왔습니다. 출발지에서 찾으려면 경로를 조회해 주세요.`);
  const closest = chargerData.map(item => ({ item, km: distance(origin, { lat: Number(item.위도), lng: Number(item.경도) }) })).sort((a, b) => a.km - b.km).slice(0, 5);
  message($('charger-message'), `출발지 기준 가까운 충전소 ${closest.length}곳 (직선거리)`);
  for (const { item, km } of closest) {
    const element = document.createElement('div');
    element.className = 'charger';
    const name = document.createElement('strong');
    name.textContent = `${item.시설명} · ${km.toFixed(1)} km`;
    const address = document.createElement('div');
    address.textContent = item.소재지도로명주소 || item.소재지지번주소 || '주소 정보 없음';
    const hours = document.createElement('div');
    hours.textContent = `평일 ${item.평일운영시작시각 || '확인 필요'} ~ ${item.평일운영종료시각 || '확인 필요'} · 토요일 ${item.토요일운영시작시각 || '확인 필요'} ~ ${item.토요일운영종료시각 || '확인 필요'} · 공휴일 ${item.공휴일운영시작시각 || '확인 필요'} ~ ${item.공휴일운영종료시각 || '확인 필요'} · 전화 ${item.관리기관전화번호 || '확인 필요'}`;
    element.append(name, address, hours);
    $('chargers').append(element);
  }
}

$('charger-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('10MB 이하의 CSV 파일을 선택해 주세요.');
    chargerData = parseCsv(await file.text());
    if (!chargerData.length) throw new Error('유효한 충전소 데이터가 없습니다.');
    showChargers();
  } catch (error) {
    chargerData = [];
    $('chargers').replaceChildren();
    message($('charger-message'), error.message, true);
  }
});
