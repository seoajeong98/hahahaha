import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server.js';

async function withServer(config, callback) {
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('keys remain private and missing services fail explicitly', async () => {
  await withServer({ NAVER_CLIENT_ID: 'public', NAVER_CLIENT_SECRET: 'secret', DATA_GO_KR_KEY: 'private' }, async base => {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(config, { mapsClientId: 'public', directions: true, bus: true });
    assert.equal(JSON.stringify(config).includes('secret'), false);
    assert.equal(JSON.stringify(config).includes('private'), false);
  });
  await withServer({}, async base => {
    const route = await fetch(`${base}/api/route?start=서울&goal=부산`);
    assert.equal(route.status, 503);
    assert.match((await route.json()).error, /키/);
    const bus = await fetch(`${base}/api/buses?city=25&stop=DJB8001793`);
    assert.equal(bus.status, 503);
    assert.equal((await fetch(`${base}/api/buses?city=bad&stop=x`)).status, 400);
  });
});

test('route geocodes addresses and returns the driving geometry', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options) => {
    if (typeof input === 'string' && input.startsWith('http://127.0.0.1')) return original(input, options);
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname.endsWith('/geocode')) {
      const start = url.searchParams.get('query') === '출발';
      return Response.json({ status: 'OK', addresses: [{ x: start ? '127' : '128', y: start ? '37' : '38', roadAddress: start ? '출발 주소' : '도착 주소' }] });
    }
    return Response.json({ code: 0, route: { trafast: [{ summary: { distance: 1200, duration: 60000 }, path: [[127, 37], [128, 38]] }] } });
  };
  try {
    await withServer({ NAVER_CLIENT_ID: 'id', NAVER_CLIENT_SECRET: 'secret' }, async base => {
      const response = await fetch(`${base}/api/route?start=출발&goal=도착`);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.from.address, '출발 주소');
      assert.equal(result.distance, 1200);
      assert.deepEqual(result.path, [[127, 37], [128, 38]]);
      const driving = calls.find(call => call.url.pathname.endsWith('/driving'));
      assert.equal(driving.url.searchParams.get('start'), '127,37');
      assert.equal(driving.options.headers['x-ncp-apigw-api-key'], 'secret');
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('bus arrivals include only valid low-floor vehicles and report truncation', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    if (typeof input === 'string' && input.startsWith('http://127.0.0.1')) return original(input, options);
    assert.equal(new URL(input).searchParams.get('serviceKey'), 'key+value');
    return Response.json({ response: { header: { resultCode: '00' }, body: { totalCount: 101, items: { item: [
      { routeno: '1', vehicletp: '저상버스', arrtime: 120 },
      { routeno: '2', vehicletp: '일반버스', arrtime: 60 },
      { routeno: '3', vehicletp: '저상버스', arrtime: null }
    ] } } } });
  };
  try {
    await withServer({ DATA_GO_KR_KEY: 'key+value' }, async base => {
      const response = await fetch(`${base}/api/buses?city=25&stop=DJB8001793`);
      assert.deepEqual(await response.json(), { buses: [{ route: '1', seconds: 120 }], truncated: true });
    });
  } finally {
    globalThis.fetch = original;
  }
});
