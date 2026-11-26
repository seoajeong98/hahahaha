import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`외부 서비스 응답 오류 (${response.status})`);
  try {
    return await response.json();
  } catch {
    throw new Error('외부 서비스의 응답을 읽을 수 없습니다. API 키와 서비스 승인 상태를 확인해 주세요.');
  }
}

export function createServer(config = process.env) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') return json(res, 405, { error: '지원하지 않는 요청입니다.' });
      const url = new URL(req.url, 'http://localhost');
      if (publicFiles[url.pathname]) {
        const [file, type] = publicFiles[url.pathname];
        res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
        return res.end(await readFile(path.join(root, 'public', file)));
      }
      if (url.pathname === '/api/config') {
        return json(res, 200, { mapsClientId: config.NAVER_CLIENT_ID || '', directions: Boolean(config.NAVER_CLIENT_ID && config.NAVER_CLIENT_SECRET), bus: Boolean(config.DATA_GO_KR_KEY) });
      }
      if (url.pathname === '/api/route') {
        const start = url.searchParams.get('start')?.trim();
        const goal = url.searchParams.get('goal')?.trim();
        if (!start || !goal || start.length > 200 || goal.length > 200) return json(res, 400, { error: '출발지와 도착지 주소를 입력해 주세요.' });
        if (!config.NAVER_CLIENT_ID || !config.NAVER_CLIENT_SECRET) return json(res, 503, { error: '네이버 Maps API 키가 설정되지 않았습니다.' });
        const headers = { 'x-ncp-apigw-api-key-id': config.NAVER_CLIENT_ID, 'x-ncp-apigw-api-key': config.NAVER_CLIENT_SECRET };
        async function geocode(query) {
          const target = new URL('https://maps.apigw.ntruss.com/map-geocode/v2/geocode');
          target.searchParams.set('query', query);
          const result = await requestJson(target, { headers });
          if (result.status !== 'OK') throw new Error('주소 검색에 실패했습니다. API 설정을 확인해 주세요.');
          if (!result.addresses?.length) throw new Error(`주소를 찾을 수 없습니다: ${query}`);
          const { x, y, roadAddress, jibunAddress } = result.addresses[0];
          return { x, y, address: roadAddress || jibunAddress };
        }
        const [from, to] = await Promise.all([geocode(start), geocode(goal)]);
        const target = new URL('https://maps.apigw.ntruss.com/map-direction/v1/driving');
        target.search = new URLSearchParams({ start: `${from.x},${from.y}`, goal: `${to.x},${to.y}`, option: 'trafast' });
        const result = await requestJson(target, { headers });
        const route = result.route?.trafast?.[0];
        if (result.code !== 0 || !route?.summary || !Array.isArray(route.path)) throw new Error('자동차 경로를 찾지 못했습니다. 주소와 API 사용 설정을 확인해 주세요.');
        return json(res, 200, { from, to, distance: route.summary.distance, duration: route.summary.duration, path: route.path });
      }
      if (url.pathname === '/api/buses') {
        const city = url.searchParams.get('city')?.trim();
        const stop = url.searchParams.get('stop')?.trim();
        if (!/^\d{1,9}$/.test(city || '') || !/^[a-zA-Z0-9]{1,30}$/.test(stop || '')) return json(res, 400, { error: '올바른 도시코드와 정류소 ID를 입력해 주세요.' });
        if (!config.DATA_GO_KR_KEY) return json(res, 503, { error: '공공데이터포털 API 키가 설정되지 않았습니다.' });
        const target = new URL('https://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList');
        target.search = new URLSearchParams({ serviceKey: config.DATA_GO_KR_KEY, cityCode: city, nodeId: stop, numOfRows: '100', pageNo: '1', _type: 'json' });
        const result = await requestJson(target);
        const response = result.response;
        if (response?.header?.resultCode !== '00') throw new Error('버스 정보를 불러오지 못했습니다. 서비스 승인과 정류소 정보를 확인해 주세요.');
        const items = response.body?.items?.item || [];
        return json(res, 200, {
          buses: (Array.isArray(items) ? items : [items]).filter(item => item.vehicletp?.includes('저상') && item.routeno != null && item.arrtime != null && Number.isFinite(Number(item.arrtime)) && Number(item.arrtime) >= 0).map(item => ({ route: item.routeno, seconds: Number(item.arrtime) })),
          truncated: Number(response.body?.totalCount || 0) > 100
        });
      }
      return json(res, 404, { error: '페이지를 찾을 수 없습니다.' });
    } catch (error) {
      console.error(error);
      return json(res, 502, { error: error.message || '요청 처리 중 오류가 발생했습니다.' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`http://localhost:${port}`));
}
