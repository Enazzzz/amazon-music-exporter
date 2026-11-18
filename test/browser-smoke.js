// Optional end-to-end smoke test in headless Chrome against a fake music.amazon.com page
// with a mocked GraphQL endpoint (no real Amazon traffic). Needs: npm i playwright-core
// Run: CHROME=/path/to/chrome node test/browser-smoke.js
const { chromium } = require('playwright-core');
const fs = require('fs');
const US = fs.readFileSync(require('path').join(__dirname, '..', 'amazon-music-exporter.user.js'), 'utf8');
const mkEdges = (start) => Array.from({length: 100}, (_, k) => ({ playedAt: new Date(Date.UTC(2026,10,17) - (start+k)*3600e3).toISOString(),
  node: k === 7 ? null : { __typename: 'Track', id: 'B0TEST' + String((start+k)%37).padStart(4,'0'), title: 'Song ' + ((start+k)%37), duration: 180, album: { id: 'BALB', shortTitle: 'Album, "Q"' }, contributingArtists: { edges: [{ role: 'PRIMARY', node: { id: 'BA', name: 'Artist ' + ((start+k)%5) } }] } } }));
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  let n429 = 0;
  await ctx.route('https://gql.music.amazon.com/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': 'https://music.amazon.com', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const q = (JSON.parse(req.postData()||'{}').query) || '';
    if (!q.includes('recentTrackPlayback')) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '{"data":{}}' });
    const m = q.match(/cursor:"(\d+)"/); const idx = m ? +m[1] : 0;
    route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ data: { user: { recentTrackPlayback: { edgeCount: 100, pageInfo: { hasNextPage: true, token: String(idx+1) }, edges: mkEdges(idx*100) } } } }) });
  });
  await ctx.route('https://music.amazon.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<html><head><script>const f=window.fetch;setTimeout(()=>f('https://gql.music.amazon.com/',{method:'POST',headers:{'x-amz-access-token':'FAKE','content-type':'application/json'},body:'{}'}),200)</script></head><body style="background:#111"></body></html>` }));
  await page.addInitScript({ content: `window.unsafeWindow=window;const __s={};window.GM_getValue=(k,d)=>(k in __s?__s[k]:d);window.GM_setValue=(k,v)=>{__s[k]=v};window.GM_deleteValue=k=>{delete __s[k]};` + US });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  const dls = []; page.on('download', d => dls.push(d));
  await page.goto('https://music.amazon.com/my/library');
  await page.waitForTimeout(600);
  await page.locator('#amexp-host >> text=I understand').click();
  await page.locator('#amexp-host >> button.tab', { hasText: 'History' }).click();
  await page.locator('#amexp-host select').selectOption('7d');
  await page.locator('#amexp-host >> text=Export listening history').click();
  await page.waitForTimeout(2500);
  console.log('mid:', await page.locator('#amexp-host .ptext').textContent());
  await page.waitForTimeout(3500);
  console.log('end:', await page.locator('#amexp-host .msg').textContent());
  if (!/Done: \d+ plays/.test(await page.locator('#amexp-host .msg').textContent())) { console.log('FAIL'); process.exitCode = 1; }
  console.log('stats:', (await page.locator('#amexp-host .stats').textContent()).slice(0,300));
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'amexp-smoke.png') });
  for (const d of dls) { const p=require('path').join(require('os').tmpdir(), d.suggestedFilename()); await d.saveAs(p); console.log('dl', d.suggestedFilename()); }
  await browser.close();
})();
