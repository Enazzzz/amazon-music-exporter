// Unit + mocked-paging tests for the pure Core of the userscript.
// Run: node --test test/core.test.js   (real-data tests skip when fixtures are missing)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Core = require('../amazon-music-exporter.user.js');

// Optional real-data fixtures (not committed: they contain personal listening data).
//   AMEXP_HISTORY = a listening-history JSON with {plays:[{playedAt,id,title}]}
//   AMEXP_LOOKUP  = a lookup JSON with {tracks:{ASIN: TrackNode}}
//   AMEXP_CAPTURE = a folder with raw playlist GraphQL responses page1..page4.json
const FIX = path.join(__dirname, 'fixtures');
const HIST = process.env.AMEXP_HISTORY || path.join(FIX, 'history.json');
const LOOKUP = process.env.AMEXP_LOOKUP || path.join(FIX, 'lookup.json');
const CAPDIR = process.env.AMEXP_CAPTURE || FIX;
const have = (p) => fs.existsSync(p);
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ---------------------------------------------------------------- CSV
test('csvEscape: quotes, commas, newlines, BOM, verbatim weird titles', () => {
  assert.equal(Core.csvEscape('plain'), 'plain');
  assert.equal(Core.csvEscape('a,b'), '"a,b"');
  assert.equal(Core.csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(Core.csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(Core.csvEscape(' lead'), '" lead"');
  assert.equal(Core.csvEscape(null), '');
  assert.equal(Core.csvEscape(undefined), '');
  assert.equal(Core.csvEscape(0), '0');
  assert.equal(Core.csvEscape(false), 'false');
  assert.equal(Core.csvEscape(['a', 'b']), 'a; b');
  const weird = 'ÿ̷̢̛̖ơ̶͎u̵ ⚸ 𝖜𝖊𝖎𝖗𝖉 ∆';
  assert.equal(Core.csvEscape(weird), weird);
  const csv = Core.toCSV(['a', 'b'], [{ a: 'x,y', b: weird }, { a: '"q"', b: null }]);
  assert.ok(csv.startsWith('\uFEFFa,b\r\n'));
  assert.equal(csv, '\uFEFFa,b\r\n"x,y",' + weird + '\r\n"""q""",\r\n');
});

// ---------------------------------------------------------------- inputs
test('extractPlaylistId handles URLs, paths, raw ids', () => {
  const id = '0f8c2d1e-1234-4abc-9def-0123456789ab';
  assert.equal(Core.extractPlaylistId(`https://music.amazon.com/user-playlists/${id}?ref=x`), id);
  assert.equal(Core.extractPlaylistId(`https://music.amazon.com/my/playlists/${id}`), id);
  assert.equal(Core.extractPlaylistId(`/my/playlists/${id}`), id);
  assert.equal(Core.extractPlaylistId(id), id);
  assert.equal(Core.extractPlaylistId('https://music.amazon.com/user-playlists/0123456789abcdef0123456789abcdefxyzw'), '0123456789abcdef0123456789abcdefxyzw');
  assert.equal(Core.extractPlaylistId('https://music.amazon.com/my/library'), null);
  assert.equal(Core.extractPlaylistId(''), null);
});

test('extractAsins dedupes and reads URLs', () => {
  assert.deepEqual(Core.extractAsins('B000VZKU4K, b0ct4yr2sb\nhttps://music.amazon.com/tracks/B000VZKU4K/?x B0CT4YR2SBX'), ['B000VZKU4K', 'B0CT4YR2SB']);
});

test('sanitizeHeaders drops browser-managed headers, keeps auth-looking ones', () => {
  const h = Core.sanitizeHeaders([['X-Amz-Access-Token', 't'], ['Content-Length', '9'], ['Cookie', 'c'], ['csrf-token', 'z'], ['sec-ch-ua', 'x'], ['content-type', 'application/json']]);
  assert.deepEqual(h, { 'x-amz-access-token': 't', 'csrf-token': 'z', 'content-type': 'application/json' });
  assert.ok(Core.looksAuthenticated(h));
  assert.ok(!Core.looksAuthenticated({ 'content-type': 'application/json' }));
  // Headers-like object
  const fake = { forEach(cb) { cb('v', 'X-Amz-Device'); }, get() {} };
  assert.deepEqual(Core.headersToObject(fake), { 'x-amz-device': 'v' });
});

// ---------------------------------------------------------------- cutoff
test('resolveCutoff presets, custom, errors', () => {
  const now = new Date('2026-11-17T12:00:00Z');
  assert.equal(Core.resolveCutoff('7d', null, now).toISOString(), '2026-11-10T12:00:00.000Z');
  assert.equal(Core.resolveCutoff('1y', null, now).toISOString(), '2025-11-17T12:00:00.000Z');
  assert.equal(Core.resolveCutoff('all', null, now), null);
  const c = Core.resolveCutoff('custom', '2026-01-05', now);
  assert.equal(c.getFullYear(), 2026); assert.equal(c.getMonth(), 0); assert.equal(c.getDate(), 5); assert.equal(c.getHours(), 0);
  assert.throws(() => Core.resolveCutoff('custom', 'nope'));
  assert.throws(() => Core.resolveCutoff('5d'));
});

test('effectiveCutoff + isBeforeCutoff (inclusive range, exclusive since-last)', () => {
  const cut = Core.effectiveCutoff(new Date('2026-11-01T00:00:00Z'), null);
  assert.equal(cut.exclusive, false);
  assert.equal(Core.isBeforeCutoff('2026-11-01T00:00:00.000Z', cut), false);
  assert.equal(Core.isBeforeCutoff('2026-10-31T23:59:59.999Z', cut), true);
  const since = Core.effectiveCutoff(new Date('2026-11-01T00:00:00Z'), '2026-11-10T05:00:00.000Z');
  assert.equal(since.exclusive, true);
  assert.equal(Core.isBeforeCutoff('2026-11-10T05:00:00.000Z', since), true); // already exported
  assert.equal(Core.isBeforeCutoff('2026-11-10T05:00:00.001Z', since), false);
  // since older than range cutoff -> range wins
  const older = Core.effectiveCutoff(new Date('2026-11-01T00:00:00Z'), '2026-01-01T00:00:00Z');
  assert.equal(older.exclusive, false);
  assert.equal(Core.isBeforeCutoff('2026-01-01T00:00:00Z', Core.effectiveCutoff(null, null)), false);
});

test('isoLocal produces an offset timestamp for the same instant', () => {
  const s = Core.isoLocal('2026-11-18T02:48:40.414Z');
  assert.match(s, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  assert.equal(Math.floor(Date.parse(s) / 1000), Math.floor(Date.parse('2026-11-18T02:48:40.414Z') / 1000));
});

// ---------------------------------------------------------------- parsing (real captures)
test('parsePlaylistPage on captured page1.json', { skip: !have(path.join(CAPDIR, 'page1.json')) }, () => {
  const p = Core.parsePlaylistPage(load(path.join(CAPDIR, 'page1.json')));
  assert.equal(p.edges.length, 100);
  assert.equal(p.totalCount, p.meta.trackCount);
  assert.equal(p.hasNext, true);
  assert.ok(p.token && p.endCursor);
  assert.equal(p.edges[0].index, 0);
  const t = p.edges[0].track;
  assert.match(t.asin, /^B[0-9A-Z]{9}$/);
  assert.ok(t.title && t.artist && t.album);
  assert.equal(typeof t.duration, 'number');
  assert.ok(t.artUrl.startsWith('https://'));
  // audio quality flags derived from enum list
  const atmos = p.edges.map((e) => e.track).filter((x) => x.dolbyAtmos);
  assert.ok(atmos.length > 0);
  const row = Core.playlistCsvRow(Object.assign({ position: 1 }, t));
  for (const c of Core.PLAYLIST_COLUMNS) assert.ok(c in row, c);
});

test('parseLookupResponse on real lookup results', { skip: !have(LOOKUP) }, () => {
  const L = load(LOOKUP).tracks;
  const ids = Object.keys(L).slice(0, 40);
  const json = { data: Object.fromEntries(ids.map((id, k) => [`t${k}`, L[id]])) };
  json.data.t3 = null;
  const out = Core.parseLookupResponse(json, ids);
  assert.equal(out[ids[3]], null);
  assert.equal(out[ids[0]].asin, ids[0]);
  assert.ok(out[ids[0]].artist);
});

test('normalizeTrack splits primary vs featured artists', () => {
  const t = Core.normalizeTrack({ id: 'B000000001', title: 'X', contributingArtists: { edges: [
    { role: 'FEATURED', node: { id: 'A2', name: 'Feat' } }, { role: 'PRIMARY', node: { id: 'A1', name: 'Main' } }, { role: 'PRIMARY', node: { id: 'A3', name: 'Main2' } }] } });
  assert.equal(t.artist, 'Main, Main2');
  assert.deepEqual(t.featuredArtists, ['Feat']);
  const noPrimary = Core.normalizeTrack({ id: 'B000000002', title: 'Y', contributingArtists: { edges: [{ role: 'COMPOSER', node: { name: 'C' } }] } });
  assert.equal(noPrimary.artist, 'C');
});

test('query builders escape ids/cursors and match known-good shapes', () => {
  assert.equal(Core.buildHistoryQuery(null, false), 'query{user{recentTrackPlayback(limit:100){edgeCount pageInfo{hasNextPage token endCursor} edges{playedAt skipped device{family} node{__typename ... on Track{id title}}}}}}');
  assert.equal(Core.buildHistoryQuery(null, false, 100, false), 'query{user{recentTrackPlayback(limit:100){edgeCount pageInfo{hasNextPage token endCursor} edges{playedAt node{__typename ... on Track{id title}}}}}}');
  assert.ok(Core.buildHistoryQuery('1761:ab"c', true).includes('cursor:"1761:ab\\"c"'));
  const q = Core.buildLookupQuery(['B000VZKU4K', 'B0CT4YR2SB']);
  assert.ok(q.startsWith('query{t0:track(id:"B000VZKU4K"){__typename ... on Track{'));
  assert.ok(q.includes('isrc'));
  assert.ok(q.includes('t1:track(id:"B0CT4YR2SB")'));
  assert.ok(!/isExplicit/.test(Core.buildPlaylistQuery('x', null)));
  assert.ok(Core.buildPlaylistQuery('x', 'tok').includes('tracks(first:100, after:"tok")'));
  assert.ok(Core.buildPlaylistQuery('x', null).includes('isrc'));
  assert.ok(Core.buildArtistsQuery('followedArtists', null).includes('followedArtists(limit:100)'));
  assert.ok(Core.buildArtistsQuery('libraryArtists', 'c').includes('cursor:"c"'));
  assert.throws(() => Core.buildArtistsQuery('playlists'));
  assert.ok(Core.buildRecentEntitiesQuery(50).includes('recentEntitiesPlayback(limit:50)'));
  assert.ok(!/cursor:/.test(Core.buildRecentEntitiesQuery(50)));
});

// ---------------------------------------------------------------- mocked API
function mockResponse(status, body) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}
function makeClient(handler, extra) {
  const log = { calls: 0, sleeps: [] };
  const client = Core.createClient(Object.assign({
    minInterval: 1500, backoff: 30000,
    getAuth: () => ({ url: 'https://gql.music.amazon.com/', headers: { 'x-amz-access-token': 'FAKE' } }),
    sleep: async (ms, cancel) => { log.sleeps.push(ms); if (cancel && cancel.cancelled) throw new Core.ExportError('Cancelled', 'cancel'); },
    fetchFn: async (url, init) => { log.calls++; const body = JSON.parse(init.body); return handler(body.query, log.calls, init); },
  }, extra || {}));
  return { client, log };
}

function historyPagesFrom(plays, pageSize = 100) {
  const pages = [];
  for (let i = 0; i < plays.length; i += pageSize) pages.push(plays.slice(i, i + pageSize));
  return pages;
}

test('runHistory: pages via cursor token, survives 429, skips null nodes, falls back + lookup', { skip: !have(HIST) || !have(LOOKUP) }, async () => {
  const H = load(HIST).plays.slice(0, 1000);
  const L = load(LOOKUP).tracks;
  // Use plays whose ASIN we can resolve, so lookup is fully checkable.
  const pages = historyPagesFrom(H);
  let saw429 = false, richRejected = 0, lookupCalls = 0;
  const { client, log } = makeClient((q, n) => {
    if (q.includes('recentTrackPlayback')) {
      if (q.includes('contributingArtists')) { richRejected++; return mockResponse(200, { errors: [{ message: 'Validation error: Cannot query field "contributingArtists"' }] }); }
      const m = q.match(/cursor:"(\d+)"/);
      const idx = m ? +m[1] : 0;
      if (idx === 3 && !saw429) { saw429 = true; return mockResponse(429, {}); }
      const edges = pages[idx].map((p) => ({ playedAt: p.playedAt, node: { __typename: 'Track', id: p.id, title: p.title } }));
      edges.splice(5, 0, { playedAt: '2026-01-01T00:00:00Z', node: null }); // null node
      return mockResponse(200, { data: { user: { recentTrackPlayback: { edgeCount: edges.length, pageInfo: { hasNextPage: idx < pages.length - 1, token: String(idx + 1), endCursor: null }, edges } } } });
    }
    if (q.includes(':track(id:')) {
      lookupCalls++;
      const ids = [...q.matchAll(/t(\d+):track\(id:"([^"]+)"\)/g)].map((m) => m[2]);
      const data = {};
      ids.forEach((id, k) => { data['t' + k] = L[id] || { id, title: 'T' + id, duration: 200, album: { id: 'AL', shortTitle: 'Alb' }, contributingArtists: { edges: [{ role: 'PRIMARY', node: { id: 'AR', name: 'Artist ' + id.slice(-2) } }] } }; });
      return mockResponse(200, { data });
    }
    throw new Error('unexpected query ' + q);
  });
  const state = {};
  const prog = [];
  await Core.runHistory(client, state, { cut: Core.effectiveCutoff(null, null), onProgress: (p) => prog.push(p) });
  assert.equal(richRejected, 1);
  assert.equal(state.rich, false);
  assert.ok(saw429);
  assert.ok(log.sleeps.includes(30000), '30s backoff after 429');
  assert.ok(log.sleeps.every((ms) => ms <= 30000));
  assert.equal(state.pages, pages.length);
  assert.equal(state.nulls, pages.length);
  assert.equal(state.plays.length, new Set(H.map((p) => p.playedAt + '|' + p.id)).size);
  assert.ok(state.plays.every((p) => p.artist && p.duration != null), 'all resolved via lookup');
  const unique = new Set(H.map((p) => p.id)).size;
  assert.equal(lookupCalls, Math.ceil(unique / 40));
  assert.ok(prog.some((p) => p.phase === 'lookup'));
  const stats = Core.computeStats(state.plays);
  assert.equal(stats.totalPlays, state.plays.length);
  assert.ok(stats.estimatedHours > 0 && stats.topArtists.length > 0);
  const csv = Core.toCSV(Core.HISTORY_COLUMNS, state.plays.map(Core.historyCsvRow));
  assert.equal(csv.split('\r\n').length - 2, state.plays.length);
});

test('runHistory: stops at cutoff (rich mode, no lookup needed)', { skip: !have(HIST) }, async () => {
  const H = load(HIST).plays.slice(0, 600);
  const pages = historyPagesFrom(H);
  const cutoffIso = H[250].playedAt;
  let maxIdx = 0;
  const { client } = makeClient((q) => {
    const m = q.match(/cursor:"(\d+)"/);
    const idx = m ? +m[1] : 0; maxIdx = Math.max(maxIdx, idx);
    const edges = pages[idx].map((p) => ({ playedAt: p.playedAt, node: { __typename: 'Track', id: p.id, title: p.title, duration: 100, album: { id: 'A', shortTitle: 'Al' }, contributingArtists: { edges: [{ role: 'PRIMARY', node: { id: 'X', name: 'Art' } }] } } }));
    return mockResponse(200, { data: { user: { recentTrackPlayback: { pageInfo: { hasNextPage: true, token: String(idx + 1) }, edges } } } });
  });
  const state = {};
  await Core.runHistory(client, state, { cut: Core.effectiveCutoff(new Date(cutoffIso), null) });
  assert.equal(state.rich, true);
  assert.equal(maxIdx, 2, 'stopped on the page containing the cutoff');
  assert.ok(state.reachedCutoff);
  assert.ok(state.plays.every((p) => p.playedAt >= cutoffIso));
  assert.equal(state.plays.length, H.filter((p) => p.playedAt >= cutoffIso).length);
  assert.equal(state.lookedUp, undefined);
});

test('client: GraphQL error stops with a clear message; cancel works', async () => {
  const { client } = makeClient(() => mockResponse(200, { errors: [{ message: 'Something broke' }] }));
  await assert.rejects(client.gql('query{x}'), (e) => e.kind === 'graphql' && /Something broke/.test(e.message));
  const { client: c2 } = makeClient(() => mockResponse(200, { data: {} }));
  await assert.rejects(c2.gql('query{x}', { cancelled: true }), (e) => e.kind === 'cancel');
  const { client: c3 } = makeClient(() => mockResponse(200, {}), { getAuth: () => null });
  await assert.rejects(c3.gql('query{x}'), (e) => e.kind === 'noauth');
  const { client: c4 } = makeClient(() => mockResponse(403, {}));
  await assert.rejects(c4.gql('query{x}'), (e) => e.kind === 'auth');
  const { client: c5, log } = makeClient(() => mockResponse(429, {}), { maxRetries: 2 });
  await assert.rejects(c5.gql('query{x}'), (e) => e.kind === 'http');
  assert.equal(log.calls, 3);
});

test('client: never puts headers in the body, sends POST JSON', async () => {
  let seen;
  const { client } = makeClient((q, n, init) => { seen = init; return mockResponse(200, { data: { ok: 1 } }); });
  await client.gql('query{a}');
  assert.equal(seen.method, 'POST');
  assert.deepEqual(JSON.parse(seen.body), { query: 'query{a}', variables: {} });
  assert.equal(seen.headers['x-amz-access-token'], 'FAKE');
  assert.equal(seen.headers['content-type'], 'application/json');
});

test('runPlaylist: pages captured pages 1-4, dedupe summary', { skip: !have(path.join(CAPDIR, 'page4.json')) }, async () => {
  const P = [1, 2, 3, 4].map((i) => load(path.join(CAPDIR, `page${i}.json`)));
  P[3].data.playlist.tracks.pageInfo.hasNextPage = false;
  const tokens = P.map((p) => p.data.playlist.tracks.pageInfo.token);
  const { client } = makeClient((q) => {
    const m = q.match(/after:"([^"]+)"/);
    const idx = m ? tokens.indexOf(m[1]) + 1 : 0;
    assert.ok(idx >= 0);
    return mockResponse(200, P[idx]);
  });
  const state = { rows: [] };
  await Core.runPlaylist(client, 'pl-id', state, {});
  assert.equal(state.rows.length, 250);
  assert.deepEqual(state.rows.map((r) => r.position).slice(0, 3), [1, 2, 3]);
  const sum = Core.playlistSummary(state.rows);
  assert.equal(sum.tracks, 250);
  assert.equal(sum.uniqueTracks + sum.duplicateEntries, 250);
  const csv = Core.toCSV(Core.PLAYLIST_COLUMNS, state.rows.map(Core.playlistCsvRow));
  assert.ok(csv.startsWith('\uFEFFposition,asin,title'));
});

test('runPlaylist: switches to endCursor when token restarts at index 0', async () => {
  const mk = (start, n, more) => ({ data: { playlist: { id: 'p', title: 'T', trackCount: 4, tracks: { totalCount: 4,
    pageInfo: { hasNextPage: more, token: 'TOK' + start, endCursor: `${start + n - 1}:x` },
    edges: Array.from({ length: n }, (_, k) => ({ cursor: `${start + k}:x`, node: { id: 'B00000000' + (start + k), title: 't' + (start + k) } })) } } } });
  const { client } = makeClient((q) => {
    if (!q.includes('after:')) return mockResponse(200, mk(0, 2, true));
    if (q.includes('after:"TOK0"')) return mockResponse(200, mk(0, 2, true)); // token ignored
    if (q.includes('after:"1:x"')) return mockResponse(200, mk(2, 2, false));
    throw new Error(q);
  });
  const state = { rows: [] };
  await Core.runPlaylist(client, 'p', state, {});
  assert.deepEqual(state.rows.map((r) => r.asin), ['B000000000', 'B000000001', 'B000000002', 'B000000003']);
});

test('runListPlaylists: probes paging argument names', async () => {
  const page = (ids, more, tok) => ({ data: { user: { playlists: { pageInfo: { hasNextPage: more, token: tok }, edges: ids.map((i) => ({ node: { id: i, title: 'P' + i, trackCount: 1 } })) } } } });
  const { client } = makeClient((q) => {
    if (/cursor:/.test(q)) return mockResponse(200, { errors: [{ message: 'Unknown argument "cursor" on field "User.playlists".' }] });
    if (/token:"T1"/.test(q)) return mockResponse(200, page(['c', 'd'], false, null));
    return mockResponse(200, page(['a', 'b'], true, 'T1'));
  });
  const res = await Core.runListPlaylists(client, {});
  assert.deepEqual(res.playlists.map((p) => p.id), ['a', 'b', 'c', 'd']);
  assert.equal(res.warning, null);
});

test('runLookup batches 40 and reports not-found', async () => {
  const ids = Array.from({ length: 85 }, (_, i) => 'B' + String(i).padStart(9, '0'));
  const { client, log } = makeClient((q) => {
    const got = [...q.matchAll(/t(\d+):track\(id:"([^"]+)"\)/g)];
    assert.ok(got.length <= 40);
    const data = {};
    got.forEach(([, k, id]) => { data['t' + k] = id.endsWith('7') ? null : { id, title: 'x' }; });
    return mockResponse(200, { data });
  });
  const r = await Core.runLookup(client, ids, {});
  assert.equal(log.calls, 3);
  assert.equal(r.notFound.length, ids.filter((i) => i.endsWith('7')).length);
  assert.ok(log.sleeps.filter((s) => s > 0).every((s) => s <= 1500));
});

test('history row keeps skipped, device family, and isrc', () => {
  const page = Core.parseHistoryPage({ data: { user: { recentTrackPlayback: { edgeCount: 1, pageInfo: { hasNextPage: false, token: null }, edges: [
    { playedAt: '2026-01-02T03:04:05.000Z', skipped: true, device: { family: 'MobileiOS' }, node: { __typename: 'Track', id: 'B000000001', title: 'Song', duration: 180, album: { id: 'ALB', shortTitle: 'Alb' }, contributingArtists: { edges: [{ role: 'PRIMARY', node: { name: 'Artist' } }] } } },
  ] } } } });
  assert.equal(page.plays.length, 1);
  assert.equal(page.plays[0].skipped, true);
  assert.equal(page.plays[0].deviceFamily, 'MobileiOS');
  const row = Core.historyCsvRow(Object.assign({}, page.plays[0], { isrc: 'USAAA0000001' }));
  assert.deepEqual(Object.keys(row), Core.HISTORY_COLUMNS);
  assert.equal(row.played_at, '2026-01-02T03:04:05.000Z');
  assert.equal(row.skipped, true);
  assert.equal(row.device_family, 'MobileiOS');
  assert.equal(row.isrc, 'USAAA0000001');
  const stats = Core.computeStats([{ playedAt: '2026-01-02T03:04:05.000Z', asin: 'B000000001', title: 'Song', artist: 'Artist', duration: 180, skipped: true }]);
  assert.equal(stats.estimatedMinutes, 0);
});

test('artist and recently-opened parsers', () => {
  const artists = Core.parseArtistsPage({ data: { user: { libraryArtists: { pageInfo: { hasNextPage: true, token: 'n' }, edges: [
    { node: { id: 'A1', name: 'Kept', followsContext: { isFollowed: true } } },
    { node: { id: 'A2', name: 'Not', followsContext: { isFollowed: false } } },
    { node: null },
  ] } } } }, 'libraryArtists');
  assert.equal(artists.rows.length, 2);
  assert.equal(artists.token, 'n');
  assert.deepEqual(Core.libraryArtistCsvRow(artists.rows[1]), { id: 'A2', name: 'Not', isFollowed: false });
  assert.deepEqual(Core.followedArtistCsvRow(artists.rows[0]), { id: 'A1', name: 'Kept', followed: true });
  const recent = Core.parseRecentEntitiesPage({ data: { user: { recentEntitiesPlayback: { edges: [
    { playedDate: '2026-11-01T00:00:00.000Z', node: { __typename: 'Album', id: 'ALB1', title: 'Album' } },
    { playedDate: '2026-11-02T00:00:00.000Z', node: { __typename: 'Artist', id: 'ART1', name: 'Name' } },
    { playedDate: null, node: null },
  ] } } } });
  assert.equal(recent.rows.length, 2);
  assert.deepEqual(Core.recentEntityCsvRow(recent.rows[1]), { type: 'Artist', id: 'ART1', title: 'Name', opened_at: '2026-11-02T00:00:00.000Z' });
});

test('runArtists pages with the token cursor and runRecentEntities does not', async () => {
  const { client, log } = makeClient((q) => {
    if (q.includes('followedArtists')) {
      const more = !q.includes('cursor:');
      return mockResponse(200, { data: { user: { followedArtists: { pageInfo: { hasNextPage: more, token: more ? 'T' : null }, edges: [{ node: { id: more ? 'A1' : 'A2', name: 'N', followsContext: { isFollowed: true } } }] } } } });
    }
    if (q.includes('recentEntitiesPlayback')) {
      assert.ok(!q.includes('cursor:'));
      return mockResponse(200, { data: { user: { recentEntitiesPlayback: { edges: [{ playedDate: '2026-01-01T00:00:00.000Z', node: { __typename: 'Playlist', id: 'P1', title: 'Mix' } }] } } } });
    }
    throw new Error(q);
  });
  const artists = await Core.runArtists(client, 'followedArtists', {});
  assert.deepEqual(artists.rows.map((r) => r.id), ['A1', 'A2']);
  const recent = await Core.runRecentEntities(client, {});
  assert.equal(recent.rows[0].title, 'Mix');
  assert.equal(log.calls, 3);
});
