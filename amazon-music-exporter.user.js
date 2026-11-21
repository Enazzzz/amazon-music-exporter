// ==UserScript==
// @name         Amazon Music Exporter
// @namespace    https://github.com/Enazzzz
// @version      1.1.0
// @description  Export your own Amazon Music playlists, full listening history, and track metadata to JSON + CSV. Read-only, runs locally in your browser.
// @author       Zane Davis (Enazzzz)
// @homepageURL  https://github.com/Enazzzz/amazon-music-exporter
// @supportURL   https://github.com/Enazzzz/amazon-music-exporter/issues
// @downloadURL  https://raw.githubusercontent.com/Enazzzz/amazon-music-exporter/main/amazon-music-exporter.user.js
// @updateURL    https://raw.githubusercontent.com/Enazzzz/amazon-music-exporter/main/amazon-music-exporter.user.js
// @license      MIT
// @match        https://music.amazon.com/*
// @match        https://music.amazon.co.uk/*
// @match        https://music.amazon.de/*
// @match        https://music.amazon.fr/*
// @match        https://music.amazon.it/*
// @match        https://music.amazon.es/*
// @match        https://music.amazon.ca/*
// @match        https://music.amazon.com.au/*
// @match        https://music.amazon.co.jp/*
// @match        https://music.amazon.in/*
// @match        https://music.amazon.com.br/*
// @match        https://music.amazon.com.mx/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @noframes
// ==/UserScript==

/*
 * RESPONSIBLE USE — please read
 * -----------------------------
 * - Unofficial. Not affiliated with, endorsed by, or supported by Amazon.
 *   "Amazon Music" is a trademark of Amazon.com, Inc. or its affiliates.
 * - Uses undocumented internal endpoints that may change or break. Using them
 *   may conflict with Amazon's Conditions of Use / Amazon Music Terms of Use;
 *   you alone are responsible for compliance and any account consequences.
 * - Use ONLY on your own account, to back up and analyze your own data.
 *   Do not use it to access anyone else's account or data, share sessions,
 *   scrape/bulk-harvest the catalog, redistribute or sell data, bypass DRM,
 *   paywalls or rate limits, or obtain audio. It downloads no audio.
 * - Read-only and rate-limited by design. Do not modify it to hammer Amazon.
 * - Never share exports, console output, HAR files or headers that may contain
 *   tokens. Only install userscripts from sources you trust and review the code.
 * - Provided AS IS, without warranty; see LICENSE and DISCLAIMER.md.
 *   https://github.com/Enazzzz/amazon-music-exporter/blob/main/DISCLAIMER.md
 */

/*
 * Amazon Music Exporter
 *
 * Uses the same internal GraphQL endpoint (gql.music.amazon.com) that the
 * Amazon Music web player itself uses. This is NOT an official API: it can
 * change or break at any time.
 *
 * Privacy / safety:
 *   - Read-only. The script only sends GraphQL *queries*, never mutations.
 *   - The request headers the page uses (auth / CSRF tokens) are captured in
 *     memory only. They are never written to storage, logged, or included in
 *     any export file.
 *   - Everything stays in your browser. Nothing is sent anywhere except to
 *     Amazon's own endpoint, exactly like the web player does.
 *
 * The file is structured as:
 *   1. `Core`  - pure, browser-independent logic (query building, parsing,
 *                CSV, stats, paging runners). Exported for Node unit tests.
 *   2. Browser - header capture hooks (document-start) and the floating panel.
 */
(function () {
  'use strict';

  // ===========================================================================
  // 1. CORE (pure logic, no DOM)
  // ===========================================================================
  const Core = (() => {
    const VERSION = '1.1.0';
    const DISCLAIMER_URL = 'https://github.com/Enazzzz/amazon-music-exporter/blob/main/DISCLAIMER.md';
    const DAY_MS = 86400000;

    // ---- small helpers -------------------------------------------------------
    const gqlString = (s) => JSON.stringify(String(s));
    const pad = (n, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, '0');

    /** ISO 8601 with the local UTC offset, e.g. 2026-11-17T18:22:05-08:00 */
    function isoLocal(date) {
      const d = date instanceof Date ? date : new Date(date);
      if (isNaN(d)) return '';
      const off = -d.getTimezoneOffset();
      const sign = off >= 0 ? '+' : '-';
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
        `${sign}${pad(off / 60)}:${pad(off % 60)}`;
    }

    /** Filename-safe local timestamp, e.g. 2026-11-17_18-22-05 */
    function fileStamp(date = new Date()) {
      const d = date;
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
        `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    }

    function safeFileName(s, max = 60) {
      const cleaned = String(s || '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
      return cleaned || 'untitled';
    }

    function formatDuration(sec) {
      if (sec == null || isNaN(sec)) return '';
      sec = Math.round(sec);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    // ---- CSV -----------------------------------------------------------------
    /** Escape one CSV cell (RFC 4180). Values are kept verbatim otherwise. */
    function csvEscape(v) {
      if (v === null || v === undefined) return '';
      if (Array.isArray(v)) v = v.join('; ');
      else if (typeof v === 'boolean') v = v ? 'true' : 'false';
      else if (typeof v === 'object') v = JSON.stringify(v);
      const s = String(v);
      return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    /** Build a UTF-8 CSV string with a BOM (so Excel reads Unicode correctly). */
    function toCSV(columns, rows) {
      const lines = [columns.map(csvEscape).join(',')];
      for (const r of rows) lines.push(columns.map((c) => csvEscape(r[c])).join(','));
      return '\uFEFF' + lines.join('\r\n') + '\r\n';
    }

    // ---- input parsing ---------------------------------------------------------
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    /** Pull a playlist id out of a URL, path, or raw id. Returns null if none. */
    function extractPlaylistId(input) {
      if (!input) return null;
      const s = String(input).trim();
      const m = s.match(/\/(?:my\/playlists|user-playlists|playlists)\/([A-Za-z0-9-]+)/);
      if (m) return m[1];
      const u = s.match(UUID_RE);
      if (u) return u[0];
      if (/^[A-Za-z0-9-]{8,64}$/.test(s)) return s;
      return null;
    }

    /** Extract unique track ASINs (B0XXXXXXXX style) from free text / URLs. */
    function extractAsins(text) {
      const out = [];
      const seen = new Set();
      const re = /\b(B[0-9A-Z]{9})\b/g;
      let m;
      while ((m = re.exec(String(text || '').toUpperCase()))) {
        if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
      }
      return out;
    }

    // ---- headers ----------------------------------------------------------------
    // Headers the browser manages itself (or that must not be replayed).
    const DROP_HEADERS = /^(content-length|host|cookie|connection|accept-encoding|origin|referer|user-agent|te|trailer|transfer-encoding|upgrade|keep-alive|priority|sec-.*|proxy-.*)$/i;

    /** Normalize Headers / [[k,v]] / plain object into a lowercase plain object. */
    function headersToObject(h) {
      const out = {};
      if (!h) return out;
      try {
        if (typeof h.forEach === 'function' && typeof h.get === 'function') {
          h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
        } else if (Array.isArray(h)) {
          for (const pair of h) if (pair && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
        } else if (typeof h === 'object') {
          for (const k of Object.keys(h)) out[k.toLowerCase()] = String(h[k]);
        }
      } catch (_) { /* ignore */ }
      return out;
    }

    function sanitizeHeaders(h) {
      const o = headersToObject(h);
      for (const k of Object.keys(o)) if (DROP_HEADERS.test(k)) delete o[k];
      return o;
    }

    /** Heuristic: does this header set look like an authenticated page request? */
    function looksAuthenticated(h) {
      return Object.keys(h || {}).some((k) => /^x-amz|csrf|token|authorization/i.test(k));
    }

    // ---- track normalization ------------------------------------------------------
    function artistsOf(node) {
      const edges = (node && node.contributingArtists && node.contributingArtists.edges) || [];
      const all = edges.filter((e) => e && e.node && e.node.name);
      let primary = all.filter((e) => (e.role || '').toUpperCase() === 'PRIMARY');
      let other = all.filter((e) => (e.role || '').toUpperCase() !== 'PRIMARY');
      if (!primary.length && other.length) { primary = [other[0]]; other = other.slice(1); }
      return {
        artist: primary.map((e) => e.node.name).join(', '),
        artistAsins: primary.map((e) => e.node.id).filter(Boolean),
        featured: other.map((e) => e.node.name),
        artistUrl: (primary[0] && primary[0].node.url) || '',
      };
    }

    function bestImage(images) {
      if (!Array.isArray(images) || !images.length) return '';
      const prim = images.filter((i) => i && i.url && (!i.imageType || i.imageType === 'PRIMARY'));
      const pool = prim.length ? prim : images.filter((i) => i && i.url);
      pool.sort((a, b) => (b.width || 0) - (a.width || 0));
      return pool.length ? pool[0].url : '';
    }

    /** Normalize any Track node (history, playlist, lookup) into a flat object. */
    function normalizeTrack(node) {
      if (!node || typeof node !== 'object') return null;
      const a = artistsOf(node);
      const aq = Array.isArray(node.audioQualities) ? node.audioQualities : null;
      const has = (q) => (aq ? aq.includes(q) : null);
      return {
        asin: node.id || '',
        title: node.title != null ? node.title : '',
        artist: a.artist,
        featuredArtists: a.featured,
        artistAsins: a.artistAsins,
        album: (node.album && (node.album.shortTitle || node.album.title)) || '',
        albumAsin: (node.album && node.album.id) || '',
        duration: typeof node.duration === 'number' ? node.duration : null,
        trackNumber: node.trackNumber != null ? node.trackNumber : null,
        explicit: node.parentalSettings ? !!node.parentalSettings.hasExplicitLanguage : null,
        hasLyrics: node.hasLyrics != null ? !!node.hasLyrics : null,
        audioQualities: aq,
        hd: has('HD'),
        ultraHd: has('ULTRA_HD'),
        dolbyAtmos: aq ? (aq.includes('ATMOS') || aq.includes('IMMERSIVE')) : null,
        sony360: has('SONY_360'),
        liked: node.likesContext ? node.likesContext.state === 'LIKE' : null,
        likeState: (node.likesContext && node.likesContext.state) || '',
        artUrl: bestImage(node.images),
        trackUrl: node.url || (node.id ? `https://music.amazon.com/tracks/${node.id}` : ''),
        albumUrl: (node.album && node.album.url) || '',
        previewUrl: node.previewUrl || '',
        // Catalog code. Empty when the track lookup has not been run yet.
        isrc: typeof node.isrc === 'string' ? node.isrc : '',
      };
    }

    // ---- GraphQL query builders ----------------------------------------------------
    const HISTORY_TRACK_FIELDS_RICH = 'id title duration album{id shortTitle} contributingArtists{edges{role node{id name}}}';
    const HISTORY_TRACK_FIELDS_BASIC = 'id title';
    const LOOKUP_TRACK_FIELDS = 'id isrc title duration trackNumber hasLyrics url audioQualities parentalSettings{hasExplicitLanguage} images{url width height imageType} album{id shortTitle url} contributingArtists{edges{role node{id name url}}}';
    const PLAYLIST_TRACK_FIELDS = 'id isrc title duration trackNumber hasLyrics previewUrl url audioQualities parentalSettings{hasExplicitLanguage} likesContext{state} images{url width height imageType} contributingArtists{edges{role node{id name url}}} album{id shortTitle url}';
    const ARTIST_CONNECTIONS = { followedArtists: true, libraryArtists: true };

    function buildHistoryQuery(cursor, rich = true, limit = 100, playMeta = true) {
      const fields = rich ? HISTORY_TRACK_FIELDS_RICH : HISTORY_TRACK_FIELDS_BASIC;
      const args = `limit:${limit}` + (cursor ? `, cursor:${gqlString(cursor)}` : '');
      // skipped and device.family sit on the play edge, not on the track.
      const edge = playMeta ? 'playedAt skipped device{family}' : 'playedAt';
      return `query{user{recentTrackPlayback(${args}){edgeCount pageInfo{hasNextPage token endCursor} edges{${edge} node{__typename ... on Track{${fields}}}}}}}`;
    }

    function buildPlaylistQuery(id, after, pageSize = 100, fields = PLAYLIST_TRACK_FIELDS) {
      const args = `first:${pageSize}` + (after ? `, after:${gqlString(after)}` : '');
      return `query{playlist(id:${gqlString(id)}){id title trackCount duration visibility description url curator{name} ` +
        `tracks(${args}){totalCount edgeCount pageInfo{hasNextPage token endCursor} edges{cursor node{__typename ... on Track{${fields}}}}}}}`;
    }

    /** Page followedArtists or libraryArtists. Cursor is pageInfo.token. */
    function buildArtistsQuery(field, cursor, limit = 100) {
      if (!ARTIST_CONNECTIONS[field]) throw new Error('Unknown artist connection: ' + field);
      const args = `limit:${limit}` + (cursor ? `, cursor:${gqlString(cursor)}` : '');
      return `query{user{${field}(${args}){pageInfo{hasNextPage token endCursor} edges{node{__typename id name followsContext{isFollowed}}}}}}`;
    }

    /**
     * First page only. A later page can fail when a saved playlist was deleted,
     * so this export does not follow the cursor.
     */
    function buildRecentEntitiesQuery(limit = 50) {
      const fragments = [
        '... on Album{id title}',
        '... on Artist{id name}',
        '... on Playlist{id title}',
        '... on Track{id title}',
        '... on Station{id name}',
      ].join(' ');
      return `query{user{recentEntitiesPlayback(limit:${Number(limit) || 50}){edges{playedDate node{__typename ${fragments}}}}}}`;
    }

    function buildLookupQuery(ids, fields = LOOKUP_TRACK_FIELDS) {
      return 'query{' + ids.map((id, k) => `t${k}:track(id:${gqlString(id)}){__typename ... on Track{${fields}}}`).join(' ') + '}';
    }

    function buildPlaylistsQuery(limitArg, limit, pageArg, token) {
      const args = [`${limitArg}:${limit}`];
      if (token) args.push(`${pageArg}:${gqlString(token)}`);
      return `query{user{playlists(${args.join(', ')}){pageInfo{hasNextPage token endCursor} edges{node{id title trackCount visibility url curator{name}}}}}}`;
    }

    // ---- response parsers ----------------------------------------------------------
    /** Parse one recentTrackPlayback page. */
    function parseHistoryPage(json) {
      const conn = json && json.data && json.data.user && json.data.user.recentTrackPlayback;
      if (!conn) return null;
      const plays = [];
      let nulls = 0, nonTrack = 0;
      for (const e of conn.edges || []) {
        if (!e || !e.node || !e.playedAt) { nulls++; continue; }
        const n = e.node;
        if (n.__typename && n.__typename !== 'Track') { nonTrack++; continue; }
        if (!n.id) { nulls++; continue; }
        const t = normalizeTrack(n);
        plays.push({
          playedAt: e.playedAt,
          asin: t.asin,
          title: t.title,
          artist: t.artist,
          featuredArtists: t.featuredArtists,
          album: t.album,
          albumAsin: t.albumAsin,
          duration: t.duration,
          skipped: typeof e.skipped === 'boolean' ? e.skipped : null,
          deviceFamily: (e.device && typeof e.device.family === 'string') ? e.device.family : '',
          isrc: t.isrc || '',
        });
      }
      const pi = conn.pageInfo || {};
      return {
        plays,
        nulls,
        nonTrack,
        edgeCount: conn.edgeCount != null ? conn.edgeCount : (conn.edges || []).length,
        hasNext: !!pi.hasNextPage,
        token: pi.token || null,
      };
    }

    /** Parse one playlist(id){tracks} page. */
    function parsePlaylistPage(json) {
      const p = json && json.data && json.data.playlist;
      if (!p) return null;
      const conn = p.tracks || {};
      const pi = conn.pageInfo || {};
      const edges = [];
      let nulls = 0;
      for (const e of conn.edges || []) {
        if (!e || !e.node || !e.node.id) { nulls++; continue; }
        const idx = e.cursor && /^(\d+):/.test(e.cursor) ? parseInt(e.cursor, 10) : null;
        edges.push({ index: idx, track: normalizeTrack(e.node) });
      }
      return {
        meta: {
          id: p.id, title: p.title, trackCount: p.trackCount, duration: p.duration,
          visibility: p.visibility, description: p.description, url: p.url,
          curator: (p.curator && p.curator.name) || '',
        },
        edges,
        nulls,
        totalCount: conn.totalCount != null ? conn.totalCount : p.trackCount,
        hasNext: !!pi.hasNextPage,
        token: pi.token || null,
        endCursor: pi.endCursor || null,
      };
    }

    /** Parse an aliased track lookup response into {asin: normalized|null}. */
    function parseLookupResponse(json, ids) {
      const out = {};
      const d = (json && json.data) || {};
      ids.forEach((id, k) => {
        const n = d['t' + k];
        out[id] = n && n.id ? normalizeTrack(n) : null;
      });
      return out;
    }

    function parsePlaylistsPage(json) {
      const c = json && json.data && json.data.user && json.data.user.playlists;
      if (!c) return null;
      const pi = c.pageInfo || {};
      return {
        playlists: (c.edges || []).filter((e) => e && e.node && e.node.id).map((e) => ({
          id: e.node.id, title: e.node.title, trackCount: e.node.trackCount,
          visibility: e.node.visibility, url: e.node.url,
          curator: (e.node.curator && e.node.curator.name) || '',
        })),
        hasNext: !!pi.hasNextPage,
        token: pi.token || pi.endCursor || null,
      };
    }

    /** Parse one followedArtists or libraryArtists page. */
    function parseArtistsPage(json, field) {
      const user = json && json.data && json.data.user;
      const conn = user && user[field];
      if (!conn) return null;
      const rows = [];
      for (const e of conn.edges || []) {
        const n = e && e.node;
        if (!n || !n.id) continue;
        const followed = n.followsContext ? !!n.followsContext.isFollowed : null;
        rows.push({ id: n.id, name: n.name != null ? n.name : '', isFollowed: followed });
      }
      const pi = conn.pageInfo || {};
      return { rows, hasNext: !!pi.hasNextPage, token: pi.token || null };
    }

    /** Parse the single recentEntitiesPlayback page this export requests. */
    function parseRecentEntitiesPage(json) {
      const conn = json && json.data && json.data.user && json.data.user.recentEntitiesPlayback;
      if (!conn) return null;
      const rows = [];
      for (const e of conn.edges || []) {
        const n = e && e.node;
        if (!n || !n.id) continue;
        rows.push({
          type: n.__typename || '',
          id: n.id,
          title: n.title || n.name || '',
          openedAt: typeof e.playedDate === 'string' ? e.playedDate : '',
        });
      }
      return { rows };
    }

    // ---- cutoff logic ----------------------------------------------------------------
    const PRESETS = { '7d': 7, '30d': 30, '90d': 90, '1y': 365, all: null };

    /**
     * Resolve a "how far back" choice to a Date (or null = everything).
     * customDate is 'YYYY-MM-DD', interpreted as local midnight.
     */
    function resolveCutoff(preset, customDate, now = new Date()) {
      if (preset === 'custom') {
        const m = String(customDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) throw new Error('Pick a valid custom date (YYYY-MM-DD).');
        return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
      }
      if (!(preset in PRESETS)) throw new Error('Unknown range: ' + preset);
      const days = PRESETS[preset];
      return days == null ? null : new Date(now.getTime() - days * DAY_MS);
    }

    /**
     * Combine the range cutoff and the optional "since last export" timestamp.
     * Returns { cutoffMs, exclusive } — plays with playedAt < cutoffMs are
     * dropped; when exclusive, plays exactly at cutoffMs are dropped too.
     */
    function effectiveCutoff(cutoffDate, sinceIso) {
      const c = cutoffDate ? cutoffDate.getTime() : null;
      const s = sinceIso ? Date.parse(sinceIso) : NaN;
      if (!isNaN(s) && (c == null || s >= c)) return { cutoffMs: s, exclusive: true };
      return { cutoffMs: c, exclusive: false };
    }

    function isBeforeCutoff(playedAtIso, cut) {
      if (!cut || cut.cutoffMs == null) return false;
      const t = Date.parse(playedAtIso);
      if (isNaN(t)) return false;
      return cut.exclusive ? t <= cut.cutoffMs : t < cut.cutoffMs;
    }

    // ---- stats -----------------------------------------------------------------------
    function computeStats(plays, topN = 25) {
      const artists = new Map(), tracks = new Map(), months = new Map(), days = new Set();
      let seconds = 0, withDuration = 0, newest = null, oldest = null;
      for (const p of plays) {
        if (typeof p.duration === 'number' && p.skipped !== true) { seconds += p.duration; withDuration++; }
        const a = p.artist || '(unknown artist)';
        artists.set(a, (artists.get(a) || 0) + 1);
        const key = p.asin || `${p.title}\u0000${a}`;
        const t = tracks.get(key) || { asin: p.asin, title: p.title, artist: p.artist, plays: 0 };
        t.plays++;
        tracks.set(key, t);
        const d = new Date(p.playedAt);
        if (!isNaN(d)) {
          const mk = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
          months.set(mk, (months.get(mk) || 0) + 1);
          days.add(`${mk}-${pad(d.getDate())}`);
          if (!newest || p.playedAt > newest) newest = p.playedAt;
          if (!oldest || p.playedAt < oldest) oldest = p.playedAt;
        }
      }
      const avgDur = withDuration ? seconds / withDuration : 0;
      const estSeconds = seconds + avgDur * (plays.length - withDuration);
      return {
        totalPlays: plays.length,
        uniqueTracks: tracks.size,
        uniqueArtists: artists.size,
        playsWithDuration: withDuration,
        estimatedHours: Math.round((estSeconds / 3600) * 10) / 10,
        estimatedMinutes: Math.round(estSeconds / 60),
        activeDays: days.size,
        avgHoursPerActiveDay: days.size ? Math.round((estSeconds / 3600 / days.size) * 10) / 10 : 0,
        newest, oldest,
        note: 'Estimated time sums full track lengths and leaves out plays marked skipped. Plays with unknown length use the average of the ones that have a length.',
        topArtists: [...artists.entries()].sort((x, y) => y[1] - x[1]).slice(0, topN).map(([artist, plays]) => ({ artist, plays })),
        topTracks: [...tracks.values()].sort((x, y) => y.plays - x.plays).slice(0, topN),
        playsByMonth: Object.fromEntries([...months.entries()].sort()),
      };
    }

    function playlistSummary(rows) {
      const byAsin = new Map();
      rows.forEach((r) => {
        const k = r.asin;
        if (!byAsin.has(k)) byAsin.set(k, []);
        byAsin.get(k).push(r.position);
      });
      const dups = [];
      for (const [asin, positions] of byAsin) {
        if (positions.length > 1) {
          const r = rows.find((x) => x.asin === asin);
          dups.push({ asin, title: r.title, artist: r.artist, positions });
        }
      }
      return {
        tracks: rows.length,
        uniqueTracks: byAsin.size,
        duplicateEntries: rows.length - byAsin.size,
        duplicates: dups,
        totalSeconds: rows.reduce((s, r) => s + (r.duration || 0), 0),
      };
    }

    // ---- row shapes for CSV ----------------------------------------------------------
    const HISTORY_COLUMNS = ['played_at', 'asin', 'title', 'artist', 'album', 'duration', 'skipped', 'device_family', 'isrc'];
    function historyCsvRow(p) {
      return {
        played_at: p.playedAt,
        asin: p.asin,
        title: p.title,
        artist: p.artist,
        album: p.album,
        duration: p.duration,
        skipped: p.skipped,
        device_family: p.deviceFamily || '',
        isrc: p.isrc || '',
      };
    }

    const PLAYLIST_COLUMNS = ['position', 'asin', 'title', 'artist', 'featured_artists', 'album', 'album_asin', 'duration_sec', 'duration', 'track_number', 'explicit', 'lyrics', 'hd', 'ultra_hd', 'dolby_atmos', 'sony_360', 'liked', 'art_url', 'track_url', 'isrc'];
    function playlistCsvRow(r) {
      return {
        position: r.position, asin: r.asin, title: r.title, artist: r.artist,
        featured_artists: r.featuredArtists || [], album: r.album, album_asin: r.albumAsin,
        duration_sec: r.duration, duration: formatDuration(r.duration), track_number: r.trackNumber,
        explicit: r.explicit, lyrics: r.hasLyrics, hd: r.hd, ultra_hd: r.ultraHd,
        dolby_atmos: r.dolbyAtmos, sony_360: r.sony360, liked: r.liked,
        art_url: r.artUrl, track_url: r.trackUrl, isrc: r.isrc || '',
      };
    }

    const LOOKUP_COLUMNS = ['asin', 'found', 'title', 'artist', 'featured_artists', 'album', 'album_asin', 'duration_sec', 'track_number', 'explicit', 'lyrics', 'ultra_hd', 'dolby_atmos', 'sony_360', 'art_url', 'track_url', 'isrc'];
    function lookupCsvRow(asin, t) {
      if (!t) return { asin, found: false };
      return {
        asin, found: true, title: t.title, artist: t.artist, featured_artists: t.featuredArtists,
        album: t.album, album_asin: t.albumAsin, duration_sec: t.duration, track_number: t.trackNumber,
        explicit: t.explicit, lyrics: t.hasLyrics, ultra_hd: t.ultraHd, dolby_atmos: t.dolbyAtmos,
        sony_360: t.sony360, art_url: t.artUrl, track_url: t.trackUrl, isrc: t.isrc || '',
      };
    }

    const FOLLOWED_ARTIST_COLUMNS = ['id', 'name', 'followed'];
    const LIBRARY_ARTIST_COLUMNS = ['id', 'name', 'isFollowed'];
    function followedArtistCsvRow(a) {
      return { id: a.id, name: a.name, followed: a.isFollowed };
    }
    function libraryArtistCsvRow(a) {
      return { id: a.id, name: a.name, isFollowed: a.isFollowed };
    }

    const RECENT_ENTITY_COLUMNS = ['type', 'id', 'title', 'opened_at'];
    function recentEntityCsvRow(r) {
      return { type: r.type, id: r.id, title: r.title, opened_at: r.openedAt };
    }

    // ---- errors ------------------------------------------------------------------------
    class ExportError extends Error {
      constructor(message, kind, details) { super(message); this.name = 'ExportError'; this.kind = kind; this.details = details; }
    }
    const isUnknownArgError = (e) => e && e.kind === 'graphql' && /Unknown argument|Unknown field|Cannot query field|Validation/i.test(e.message);

    // ---- HTTP client (dependency-injected so it can be unit tested) ----------------------
    /**
     * opts.fetchFn(url, init) -> Response-like {status, json(), text()}
     * opts.getAuth() -> {url, headers, credentials} | null
     * opts.sleep(ms, cancelToken)
     */
    function createClient(opts) {
      const minInterval = opts.minInterval != null ? opts.minInterval : 1500;
      const backoff = opts.backoff != null ? opts.backoff : 30000;
      const maxRetries = opts.maxRetries != null ? opts.maxRetries : 6;
      const sleep = opts.sleep;
      const now = opts.now || (() => Date.now());
      let last = 0;
      const stats = { requests: 0, retries: 0 };

      async function gql(query, cancel, onWait) {
        let attempt = 0;
        for (;;) {
          if (cancel && cancel.cancelled) throw new ExportError('Cancelled', 'cancel');
          const auth = opts.getAuth();
          if (!auth || !auth.headers) {
            throw new ExportError('Not connected yet: the page has not made an Amazon Music API request since this script loaded. Click around (open Library or a playlist) or reload the page, then try again.', 'noauth');
          }
          const wait = last + minInterval - now();
          if (wait > 0) await sleep(wait, cancel);
          last = now();
          stats.requests++;
          const headers = Object.assign({}, auth.headers);
          if (!headers['content-type']) headers['content-type'] = 'application/json';
          let res;
          try {
            res = await opts.fetchFn(auth.url || 'https://gql.music.amazon.com/', {
              method: 'POST',
              headers,
              body: JSON.stringify({ query, variables: {} }),
              credentials: auth.credentials || 'include',
              mode: 'cors',
            });
          } catch (err) {
            if (attempt++ < maxRetries) {
              stats.retries++;
              if (onWait) onWait(`Network error, retrying in ${Math.round(backoff / 1000)}s…`);
              await sleep(backoff, cancel);
              continue;
            }
            throw new ExportError('Network error: ' + (err && err.message), 'network');
          }
          if (res.status === 429 || res.status >= 500) {
            if (attempt++ < maxRetries) {
              stats.retries++;
              if (onWait) onWait(`Amazon said slow down (HTTP ${res.status}), waiting ${Math.round(backoff / 1000)}s…`);
              await sleep(backoff, cancel);
              continue;
            }
            throw new ExportError(`HTTP ${res.status} after ${maxRetries} retries`, 'http');
          }
          if (res.status === 401 || res.status === 403) {
            throw new ExportError(`HTTP ${res.status}: the captured session looks expired. Reload the page and try again.`, 'auth');
          }
          if (res.status === 400) {
            let json;
            try { json = await res.json(); } catch (e) { throw new ExportError('HTTP 400', 'http'); }
            if (json && json.errors && json.errors.length) {
              const msg = json.errors.map((e) => e && e.message).filter(Boolean).join(' | ').slice(0, 500);
              throw new ExportError('GraphQL error: ' + msg, 'graphql', json.errors);
            }
            throw new ExportError('HTTP 400', 'http');
          }
          if (res.status < 200 || res.status >= 300) {
            throw new ExportError(`HTTP ${res.status}`, 'http');
          }
          let json;
          try { json = await res.json(); } catch (e) { throw new ExportError('Response was not JSON', 'parse'); }
          if (json && json.errors && json.errors.length && !json.data) {
            const msg = json.errors.map((e) => e && e.message).filter(Boolean).join(' | ').slice(0, 500);
            throw new ExportError('GraphQL error: ' + msg, 'graphql', json.errors);
          }
          return json;
        }
      }
      return { gql, stats };
    }

    // ---- runners (mutate `state` so a partial result is always available) ------------------
    /**
     * Listening history.
     * state: { plays:[], pages, nulls, nonTrack, token, done, reachedCutoff, rich }
     * opts: { cut, resolveUnknown, onProgress, onWait, cancel, checkpoint, checkpointEvery }
     */
    async function runHistory(client, state, opts) {
      const o = opts || {};
      const cut = o.cut || { cutoffMs: null, exclusive: false };
      state.plays = state.plays || [];
      state.pages = state.pages || 0;
      state.nulls = state.nulls || 0;
      state.nonTrack = state.nonTrack || 0;
      if (state.rich === undefined) state.rich = true;
      if (state.playMeta === undefined) state.playMeta = true;
      const seenTokens = new Set();
      const seenPlays = new Set(state.plays.map((p) => p.playedAt + '|' + p.asin));
      while (!state.done) {
        let json;
        try {
          json = await client.gql(buildHistoryQuery(state.token, state.rich, 100, state.playMeta), o.cancel, o.onWait);
        } catch (e) {
          // Artist/album fields, or the skip/device fields, can be rejected independently.
          // Drop the rich selection first, then the play-edge fields, then give up.
          if (state.pages === 0 && isUnknownArgError(e)) {
            if (state.rich) { state.rich = false; continue; }
            if (state.playMeta) { state.playMeta = false; continue; }
          }
          throw e;
        }
        const page = parseHistoryPage(json);
        if (!page) throw new ExportError('Unexpected response shape for listening history.', 'parse');
        state.pages++;
        state.nulls += page.nulls;
        state.nonTrack += page.nonTrack;
        for (const p of page.plays) {
          if (isBeforeCutoff(p.playedAt, cut)) { state.reachedCutoff = true; continue; }
          const k = p.playedAt + '|' + p.asin;
          if (seenPlays.has(k)) continue;
          seenPlays.add(k);
          state.plays.push(p);
        }
        const last = page.plays.length ? page.plays[page.plays.length - 1].playedAt : null;
        if (last) state.oldestSeen = last;
        if (o.onProgress) o.onProgress({ phase: 'history', pages: state.pages, plays: state.plays.length, reached: state.oldestSeen, nulls: state.nulls });
        if (o.checkpoint && state.pages % (o.checkpointEvery || 10) === 0) o.checkpoint(state);
        if (state.reachedCutoff || !page.hasNext || !page.token || seenTokens.has(page.token) || page.token === state.token) {
          state.done = true;
          break;
        }
        seenTokens.add(page.token);
        state.token = page.token;
      }
      // Fill in artist/album/duration for any plays that came back without them.
      if (o.resolveUnknown !== false) {
        const missing = [...new Set(state.plays.filter((p) => !p.artist || p.duration == null).map((p) => p.asin))];
        if (missing.length) {
          const found = await runLookup(client, missing, {
            cancel: o.cancel, onWait: o.onWait,
            onProgress: (x) => o.onProgress && o.onProgress({ phase: 'lookup', done: x.done, total: x.total, plays: state.plays.length }),
          });
          for (const p of state.plays) {
            const t = found.results[p.asin];
            if (!t) continue;
            p.title = p.title || t.title;
            p.artist = p.artist || t.artist;
            if (!p.featuredArtists || !p.featuredArtists.length) p.featuredArtists = t.featuredArtists;
            p.album = p.album || t.album;
            p.albumAsin = p.albumAsin || t.albumAsin;
            if (p.duration == null) p.duration = t.duration;
            if (!p.isrc && t.isrc) p.isrc = t.isrc;
          }
          state.lookedUp = missing.length;
          state.lookupNotFound = found.notFound;
        }
      }
      // ISRC is not on the history edge. Look up every ASIN that still lacks one.
      if (o.resolveIsrc !== false) {
        const need = [...new Set(state.plays.filter((p) => p.asin && !p.isrc).map((p) => p.asin))];
        if (need.length) {
          const found = await runLookup(client, need, {
            cancel: o.cancel, onWait: o.onWait,
            onProgress: (x) => o.onProgress && o.onProgress({ phase: 'isrc', done: x.done, total: x.total, plays: state.plays.length }),
          });
          for (const p of state.plays) {
            const t = found.results[p.asin];
            if (t && t.isrc) p.isrc = t.isrc;
          }
          state.isrcLookedUp = need.length;
          state.isrcNotFound = found.notFound.length;
        }
      }
      return state;
    }

    /** Track lookup by ASIN, `batch` per request. */
    async function runLookup(client, ids, opts) {
      const o = opts || {};
      const batch = o.batch || 40;
      const results = o.results || {};
      let fields = o.fields || LOOKUP_TRACK_FIELDS;
      const todo = ids.filter((id) => !(id in results));
      let done = ids.length - todo.length;
      for (let i = 0; i < todo.length; i += batch) {
        const b = todo.slice(i, i + batch);
        let json;
        try {
          json = await client.gql(buildLookupQuery(b, fields), o.cancel, o.onWait);
        } catch (e) {
          // Drop ISRC once if this schema rejects it, then keep going.
          if (fields.includes('isrc') && isUnknownArgError(e) && /isrc/i.test(e.message)) {
            fields = fields.replace(/\bisrc\b/g, '').replace(/\s+/g, ' ').trim();
            json = await client.gql(buildLookupQuery(b, fields), o.cancel, o.onWait);
          } else {
            throw e;
          }
        }
        Object.assign(results, parseLookupResponse(json, b));
        done += b.length;
        if (o.onProgress) o.onProgress({ phase: 'lookup', done, total: ids.length });
      }
      const notFound = ids.filter((id) => !results[id]);
      return { results, notFound };
    }

    /** Export every track of one playlist. state: { meta, rows, pages, ... } */
    async function runPlaylist(client, id, state, opts) {
      const o = opts || {};
      state.rows = state.rows || [];
      state.pages = 0;
      state.nulls = 0;
      let after = null;
      let mode = 'token'; // which pageInfo value to feed into `after`
      let switched = false;
      let fields = PLAYLIST_TRACK_FIELDS;
      const seenAfter = new Set();
      for (;;) {
        let json;
        try {
          json = await client.gql(buildPlaylistQuery(id, after, 100, fields), o.cancel, o.onWait);
        } catch (e) {
          if (!after && fields.includes('isrc') && isUnknownArgError(e) && /isrc/i.test(e.message)) {
            fields = fields.replace(/\bisrc\b/g, '').replace(/\s+/g, ' ').trim();
            continue;
          }
          // A rejected cursor value: try the other pageInfo flavour once.
          if (after && !switched && e && e.kind === 'graphql' && state.lastPage) {
            switched = true;
            mode = mode === 'token' ? 'endCursor' : 'token';
            after = mode === 'token' ? state.lastPage.token : state.lastPage.endCursor;
            if (after) continue;
          }
          throw e;
        }
        const page = parsePlaylistPage(json);
        if (!page) throw new ExportError('Playlist not found or not accessible: ' + id, 'parse');
        // Paging sanity check: if a follow-up page restarts at index 0, the
        // other cursor flavour is the right one. Switch once and retry.
        if (after && page.edges.length && page.edges[0].index === 0 && !switched) {
          switched = true;
          mode = mode === 'token' ? 'endCursor' : 'token';
          after = mode === 'token' ? state.lastPage.token : state.lastPage.endCursor;
          if (!after) break;
          continue;
        }
        state.meta = page.meta;
        state.total = page.totalCount;
        state.pages++;
        state.nulls += page.nulls;
        for (const e of page.edges) {
          state.rows.push(Object.assign({ position: state.rows.length + 1 }, e.track));
        }
        state.lastPage = page;
        if (o.onProgress) o.onProgress({ phase: 'playlist', title: page.meta.title, done: state.rows.length, total: state.total, pages: state.pages });
        const next = mode === 'token' ? (page.token || page.endCursor) : (page.endCursor || page.token);
        if (!page.hasNext || !next || seenAfter.has(next) || !page.edges.length) break;
        seenAfter.add(next);
        after = next;
      }
      state.done = true;
      return state;
    }

    /** List the user's own library playlists. Paging argument names are probed. */
    async function runListPlaylists(client, opts) {
      const o = opts || {};
      const limitArgs = ['limit', 'first'];
      const pageArgs = ['cursor', 'token', 'nextToken', 'after'];
      let li = 0, pa = 0;
      const out = [];
      const seen = new Set();
      let token = null;
      let warning = null;
      for (let guard = 0; guard < 200; guard++) {
        let json;
        try {
          json = await client.gql(buildPlaylistsQuery(limitArgs[li], 50, pageArgs[pa], token), o.cancel, o.onWait);
        } catch (e) {
          if (!isUnknownArgError(e)) throw e;
          if (!token && li < limitArgs.length - 1) { li++; continue; }
          if (token && pa < pageArgs.length - 1) { pa++; continue; }
          warning = 'Could only load the first page of playlists (' + e.message + ')';
          break;
        }
        const page = parsePlaylistsPage(json);
        if (!page) throw new ExportError('Unexpected response shape for playlists.', 'parse');
        let added = 0;
        for (const p of page.playlists) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); added++; }
        if (o.onProgress) o.onProgress({ phase: 'playlists', done: out.length });
        if (!page.hasNext || !page.token || (token && added === 0)) {
          if (token && added === 0 && pa < pageArgs.length - 1) { pa++; continue; }
          break;
        }
        token = page.token;
      }
      return { playlists: out, warning };
    }

    /** Page followedArtists or libraryArtists until the cursor ends. */
    async function runArtists(client, field, opts) {
      const o = opts || {};
      const rows = [];
      const seen = new Set();
      let token = null;
      const seenTokens = new Set();
      for (let guard = 0; guard < 100; guard++) {
        const json = await client.gql(buildArtistsQuery(field, token), o.cancel, o.onWait);
        const page = parseArtistsPage(json, field);
        if (!page) throw new ExportError('Unexpected response shape for ' + field + '.', 'parse');
        for (const row of page.rows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          rows.push(row);
        }
        if (o.onProgress) o.onProgress({ phase: field, done: rows.length });
        if (!page.hasNext || !page.token || seenTokens.has(page.token)) break;
        seenTokens.add(page.token);
        token = page.token;
      }
      return { rows };
    }

    /** One page of albums, artists, and playlists that were opened. */
    async function runRecentEntities(client, opts) {
      const o = opts || {};
      const json = await client.gql(buildRecentEntitiesQuery(o.limit || 50), o.cancel, o.onWait);
      const page = parseRecentEntitiesPage(json);
      if (!page) throw new ExportError('Unexpected response shape for recently opened items.', 'parse');
      return page;
    }

    return {
      VERSION, DISCLAIMER_URL, gqlString, isoLocal, fileStamp, safeFileName, formatDuration,
      csvEscape, toCSV, extractPlaylistId, extractAsins,
      headersToObject, sanitizeHeaders, looksAuthenticated,
      normalizeTrack, artistsOf, bestImage,
      buildHistoryQuery, buildPlaylistQuery, buildLookupQuery, buildPlaylistsQuery, buildArtistsQuery, buildRecentEntitiesQuery,
      parseHistoryPage, parsePlaylistPage, parseLookupResponse, parsePlaylistsPage, parseArtistsPage, parseRecentEntitiesPage,
      PRESETS, resolveCutoff, effectiveCutoff, isBeforeCutoff,
      computeStats, playlistSummary,
      HISTORY_COLUMNS, historyCsvRow, PLAYLIST_COLUMNS, playlistCsvRow, LOOKUP_COLUMNS, lookupCsvRow,
      FOLLOWED_ARTIST_COLUMNS, followedArtistCsvRow, LIBRARY_ARTIST_COLUMNS, libraryArtistCsvRow,
      RECENT_ENTITY_COLUMNS, recentEntityCsvRow,
      ExportError, createClient, runHistory, runLookup, runPlaylist, runListPlaylists, runArtists, runRecentEntities,
    };
  })();

  // Node / test harness: export Core and stop before touching the browser.
  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = Core;
    return;
  }

  // ===========================================================================
  // 2. BROWSER
  // ===========================================================================
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const LOG = (...a) => console.log('%c[AM Exporter]', 'color:#25d1da', ...a);

  // ---- storage (only non-sensitive values: timestamps, UI prefs, checkpoints) ----
  const store = {
    get(k, d) {
      try { if (typeof GM_getValue === 'function') return GM_getValue(k, d); } catch (_) {}
      try { const v = localStorage.getItem('amexp_' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; }
    },
    set(k, v) {
      try { if (typeof GM_setValue === 'function') return GM_setValue(k, v); } catch (_) {}
      try { localStorage.setItem('amexp_' + k, JSON.stringify(v)); } catch (_) {}
    },
    del(k) {
      try { if (typeof GM_deleteValue === 'function') return GM_deleteValue(k); } catch (_) {}
      try { localStorage.removeItem('amexp_' + k); } catch (_) {}
    },
  };

  // ---- header capture (document-start hooks) -------------------------------------
  // Headers live ONLY in this closure variable. Never persisted or exported.
  const auth = { url: null, headers: null, credentials: 'include', capturedAt: 0, seen: 0 };
  const authListeners = new Set();

  function isGqlUrl(u) {
    try { return /^gql\.music\.amazon\./i.test(new URL(String(u), location.href).hostname); } catch (_) { return false; }
  }
  function recordAuth(url, rawHeaders, credentials) {
    try {
      const h = Core.sanitizeHeaders(rawHeaders);
      if (!Core.looksAuthenticated(h)) return;
      const u = new URL(String(url), location.href);
      auth.url = u.origin + u.pathname;
      auth.headers = h; // latest wins, so refreshed tokens are picked up
      if (credentials) auth.credentials = String(credentials);
      auth.capturedAt = Date.now();
      auth.seen++;
      if (auth.seen === 1) LOG('Connected: captured Amazon Music API headers (kept in memory only).');
      authListeners.forEach((fn) => { try { fn(); } catch (_) {} });
    } catch (_) { /* never break the page */ }
  }
  const expose = (fn) => (typeof exportFunction === 'function' ? exportFunction(fn, W) : fn);

  const origFetch = W.fetch;
  try {
    W.fetch = expose(function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (isGqlUrl(url)) {
          let h = init && init.headers;
          if (!h && input && typeof input === 'object' && input.headers) h = input.headers;
          recordAuth(url, h, (init && init.credentials) || (input && input.credentials));
        }
      } catch (_) {}
      return origFetch.apply(W, arguments);
    });
  } catch (e) { LOG('fetch hook failed', e); }

  try {
    const XP = W.XMLHttpRequest.prototype;
    const oOpen = XP.open, oSet = XP.setRequestHeader, oSend = XP.send;
    const meta = new WeakMap();
    XP.open = expose(function (method, url) {
      try { meta.set(this, { gql: isGqlUrl(url), url: String(url), h: {} }); } catch (_) {}
      return oOpen.apply(this, arguments);
    });
    XP.setRequestHeader = expose(function (k, v) {
      try { const m = meta.get(this); if (m && m.gql) m.h[k] = v; } catch (_) {}
      return oSet.apply(this, arguments);
    });
    XP.send = expose(function () {
      try { const m = meta.get(this); if (m && m.gql) recordAuth(m.url, m.h, this.withCredentials ? 'include' : null); } catch (_) {}
      return oSend.apply(this, arguments);
    });
  } catch (e) { LOG('XHR hook failed', e); }

  // Our own requests go through the ORIGINAL fetch (not the hook).
  async function pageFetch(url, init) {
    const i = typeof cloneInto === 'function' ? cloneInto(init, W) : init;
    return origFetch.call(W, url, i);
  }
  function cancellableSleep(ms, cancel) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (cancel && cancel.cancelled) return reject(new Core.ExportError('Cancelled', 'cancel'));
        if (Date.now() - start >= ms) return resolve();
        setTimeout(tick, Math.min(250, ms));
      };
      tick();
    });
  }
  const client = Core.createClient({
    fetchFn: pageFetch,
    getAuth: () => (auth.headers ? { url: auth.url, headers: auth.headers, credentials: auth.credentials } : null),
    sleep: cancellableSleep,
  });

  // ---- downloads ---------------------------------------------------------------
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function downloadPair(base, jsonObj, columns, rows) {
    download(base + '.json', JSON.stringify(jsonObj, null, 2), 'application/json;charset=utf-8');
    if (columns) setTimeout(() => download(base + '.csv', Core.toCSV(columns, rows), 'text/csv;charset=utf-8'), 400);
  }
  const meta = (extra) => Object.assign({
    exporter: 'Amazon Music Exporter', version: Core.VERSION,
    exportedAt: new Date().toISOString(), exportedAtLocal: Core.isoLocal(new Date()),
    timeZone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || '',
    source: 'Unofficial: Amazon Music web player internal GraphQL API',
  }, extra || {});

  // ---- export actions ----------------------------------------------------------
  let job = null; // { cancel, kind, state, partial() }

  function buildHistoryExport(state, info) {
    const plays = state.plays.slice().sort((a, b) => (a.playedAt < b.playedAt ? 1 : -1));
    const stats = Core.computeStats(plays);
    return {
      json: Object.assign(meta({
        kind: 'listening-history',
        complete: !!info.complete,
        range: { requestedFrom: info.cutoffIso || 'everything available', sinceLastExport: !!info.sinceLast, newest: stats.newest, oldest: stats.oldest },
        pagesFetched: state.pages, skippedNullNodes: state.nulls, skippedNonTrackItems: state.nonTrack || 0,
        unresolvedAsins: state.lookupNotFound || [],
        stats,
      }), { plays: plays.map((p) => Object.assign({ playedAtLocal: Core.isoLocal(p.playedAt) }, p)) }),
      rows: plays.map(Core.historyCsvRow),
      stats,
    };
  }

  async function doHistory(ui, { preset, custom, sinceLast, resolve, resume }) {
    let cutoffDate = null, state, sinceIso = null;
    if (resume) {
      const cp = store.get('checkpoint_history', null);
      if (!cp) throw new Error('No checkpoint to resume.');
      state = cp.state;
      cutoffDate = cp.cutoffIso ? new Date(cp.cutoffIso) : null;
      sinceIso = cp.sinceIso || null;
    } else {
      cutoffDate = Core.resolveCutoff(preset, custom);
      sinceIso = sinceLast ? store.get('lastPlayedAt', null) : null;
      state = { plays: [] };
    }
    const cut = Core.effectiveCutoff(cutoffDate, sinceIso);
    const info = { cutoffIso: cut.cutoffMs != null ? new Date(cut.cutoffMs).toISOString() : null, sinceLast: !!sinceIso };
    const cancel = { cancelled: false };
    const cutMs = cut.cutoffMs;
    let newestMs = null;
    const saveCheckpoint = (s) => store.set('checkpoint_history', { savedAt: new Date().toISOString(), cutoffIso: cutoffDate ? cutoffDate.toISOString() : null, sinceIso, state: s });
    job = { cancel, kind: 'history', saveCheckpoint: () => saveCheckpoint(state), partial: () => buildHistoryExport(state, Object.assign({ complete: false }, info)) };
    ui.startJob('Listening history');
    await Core.runHistory(client, state, {
      cut, resolveUnknown: resolve, cancel,
      onWait: (m) => ui.status(m),
      checkpointEvery: 10,
      checkpoint: saveCheckpoint,
      onProgress: (p) => {
        if (p.phase === 'history') {
          const reached = p.reached ? new Date(p.reached) : null;
          if (newestMs == null && state.plays.length) newestMs = Date.parse(state.plays[0].playedAt);
          let frac = null;
          if (cutMs != null && reached && newestMs) frac = (newestMs - reached.getTime()) / Math.max(1, newestMs - cutMs);
          ui.progress(frac, `Page ${p.pages} · ${p.plays.toLocaleString()} plays · reached ${reached ? reached.toLocaleDateString() : '…'}`);
        } else if (p.phase === 'lookup' || p.phase === 'isrc') {
          ui.progress(p.done / p.total, `Looking up ISRC and track details ${p.done}/${p.total}`);
        }
      },
    });
    const out = buildHistoryExport(state, Object.assign({ complete: true }, info));
    downloadPair(`amazon-music-history_${Core.fileStamp()}`, out.json, Core.HISTORY_COLUMNS, out.rows);
    if (out.stats.newest) {
      const prev = store.get('lastPlayedAt', null);
      if (!prev || out.stats.newest > prev) store.set('lastPlayedAt', out.stats.newest);
    }
    store.del('checkpoint_history');
    ui.showStats(out.stats);
    ui.done(`Done: ${out.stats.totalPlays.toLocaleString()} plays, ~${out.stats.estimatedHours.toLocaleString()} h. Files downloaded.`);
  }

  function buildPlaylistExport(state, complete) {
    const rows = state.rows || [];
    const summary = Core.playlistSummary(rows);
    return {
      json: Object.assign(meta({ kind: 'playlist', complete, playlist: state.meta || { id: state.id }, summary, skippedNullNodes: state.nulls || 0 }), { tracks: rows }),
      rows: rows.map(Core.playlistCsvRow),
      summary,
    };
  }

  async function doPlaylist(ui, input) {
    const id = Core.extractPlaylistId(input);
    if (!id) throw new Error('Could not find a playlist ID. Open a playlist page or paste its URL.');
    const state = { id, rows: [] };
    const cancel = { cancelled: false };
    job = { cancel, kind: 'playlist', partial: () => buildPlaylistExport(state, false), base: () => `amazon-music-playlist_${Core.safeFileName(state.meta && state.meta.title || id)}_PARTIAL_${Core.fileStamp()}` };
    ui.startJob('Playlist');
    await Core.runPlaylist(client, id, state, {
      cancel, onWait: (m) => ui.status(m),
      onProgress: (p) => ui.progress(p.total ? p.done / p.total : null, `“${p.title}” · ${p.done}/${p.total || '?'} tracks · page ${p.pages}`),
    });
    const out = buildPlaylistExport(state, true);
    downloadPair(`amazon-music-playlist_${Core.safeFileName(state.meta.title)}_${Core.fileStamp()}`, out.json, Core.PLAYLIST_COLUMNS, out.rows);
    ui.done(`Done: ${out.summary.tracks} tracks (${out.summary.uniqueTracks} unique, ${out.summary.duplicateEntries} duplicate entries).`);
  }

  async function doLoadPlaylists(ui) {
    const cancel = { cancelled: false };
    job = { cancel, kind: 'list', partial: null };
    ui.startJob('Loading playlists');
    const res = await Core.runListPlaylists(client, { cancel, onWait: (m) => ui.status(m), onProgress: (p) => ui.progress(null, `Found ${p.done} playlists…`) });
    ui.renderPlaylistList(res.playlists);
    ui.done(`Found ${res.playlists.length} playlists.` + (res.warning ? ' ⚠ ' + res.warning : ''));
  }

  async function doPlaylistsBatch(ui, list) {
    if (!list.length) throw new Error('Select at least one playlist.');
    const cancel = { cancelled: false };
    const all = [];
    const combined = () => {
      const rows = [];
      for (const s of all) for (const r of s.rows) rows.push(Object.assign({ playlist_title: s.meta ? s.meta.title : s.id, playlist_id: s.id }, Core.playlistCsvRow(r)));
      return {
        json: Object.assign(meta({ kind: 'playlists', playlistCount: all.length }), {
          playlists: all.map((s) => ({ playlist: s.meta || { id: s.id }, summary: Core.playlistSummary(s.rows), tracks: s.rows })),
        }),
        rows,
      };
    };
    job = { cancel, kind: 'playlists', partial: () => combined(), columns: ['playlist_title', 'playlist_id'].concat(Core.PLAYLIST_COLUMNS) };
    ui.startJob('All playlists');
    for (let i = 0; i < list.length; i++) {
      const s = { id: list[i].id, rows: [] };
      all.push(s);
      await Core.runPlaylist(client, s.id, s, {
        cancel, onWait: (m) => ui.status(m),
        onProgress: (p) => ui.progress((i + (p.total ? p.done / p.total : 0)) / list.length, `Playlist ${i + 1}/${list.length}: “${p.title}” · ${p.done}/${p.total || '?'}`),
      });
    }
    const out = combined();
    downloadPair(`amazon-music-all-playlists_${Core.fileStamp()}`, out.json, job.columns, out.rows);
    ui.done(`Done: ${all.length} playlists, ${out.rows.length} tracks total.`);
  }

  async function doLookup(ui, text) {
    const ids = Core.extractAsins(text);
    if (!ids.length) throw new Error('No track IDs found. Paste ASINs like B000VZKU4K or track URLs.');
    const cancel = { cancelled: false };
    const results = {};
    const build = () => ({
      json: Object.assign(meta({ kind: 'track-lookup', requested: ids.length, found: ids.filter((i) => results[i]).length }), { tracks: results }),
      rows: ids.filter((i) => i in results).map((i) => Core.lookupCsvRow(i, results[i])),
    });
    job = { cancel, kind: 'lookup', partial: build, columns: Core.LOOKUP_COLUMNS };
    ui.startJob('Track lookup');
    await Core.runLookup(client, ids, { results, cancel, onWait: (m) => ui.status(m), onProgress: (p) => ui.progress(p.done / p.total, `Looked up ${p.done}/${p.total}`) });
    const out = build();
    downloadPair(`amazon-music-track-lookup_${Core.fileStamp()}`, out.json, Core.LOOKUP_COLUMNS, out.rows);
    ui.done(`Done: found ${out.json.found}/${ids.length} tracks.`);
  }

  async function doArtists(ui, field) {
    const cancel = { cancelled: false };
    const columns = field === 'followedArtists' ? Core.FOLLOWED_ARTIST_COLUMNS : Core.LIBRARY_ARTIST_COLUMNS;
    const toRow = field === 'followedArtists' ? Core.followedArtistCsvRow : Core.libraryArtistCsvRow;
    const label = field === 'followedArtists' ? 'Followed artists' : 'Library artists';
    let rows = [];
    job = {
      cancel, kind: field, columns,
      partial: () => ({
        json: Object.assign(meta({ kind: field, count: rows.length }), { artists: rows }),
        rows: rows.map(toRow),
      }),
    };
    ui.startJob(label);
    const res = await Core.runArtists(client, field, {
      cancel, onWait: (m) => ui.status(m),
      onProgress: (p) => ui.progress(null, `${label}: ${p.done}`),
    });
    rows = res.rows;
    const out = job.partial();
    const base = field === 'followedArtists' ? 'followed_artists' : 'library_artists';
    downloadPair(`${base}_${Core.fileStamp()}`, out.json, columns, out.rows);
    ui.done(`Done: ${rows.length} ${label.toLowerCase()}.`);
  }

  async function doRecent(ui) {
    const cancel = { cancelled: false };
    job = { cancel, kind: 'recent', partial: null };
    ui.startJob('Recently opened');
    const page = await Core.runRecentEntities(client, { limit: 50, cancel, onWait: (m) => ui.status(m) });
    const rows = page.rows.map(Core.recentEntityCsvRow);
    downloadPair(`recently_opened_${Core.fileStamp()}`, Object.assign(meta({ kind: 'recently-opened', count: rows.length, note: 'First page only (50).' }), { items: page.rows }), Core.RECENT_ENTITY_COLUMNS, rows);
    ui.done(`Done: ${rows.length} recently opened items (first page).`);
  }

  function downloadPartial() {
    if (!job || !job.partial) return;
    const out = job.partial();
    const cols = job.columns || (job.kind === 'history' ? Core.HISTORY_COLUMNS : Core.PLAYLIST_COLUMNS);
    const base = job.base ? job.base() : `amazon-music-${job.kind}_PARTIAL_${Core.fileStamp()}`;
    downloadPair(base, out.json, cols, out.rows);
  }

  // ---- UI ---------------------------------------------------------------------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:"Amazon Ember",-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{position:fixed;z-index:2147483646;width:340px;background:#0f1111e6;color:#e8eaed;border:1px solid #2b3236;border-radius:12px;box-shadow:0 10px 30px #000a;backdrop-filter:blur(10px);font-size:13px;overflow:hidden}
  .hdr{display:flex;align-items:center;gap:8px;padding:9px 10px;background:linear-gradient(90deg,#11262b,#14181a);cursor:move;user-select:none}
  .hdr b{flex:1;font-size:13px;letter-spacing:.2px}
  .dot{width:9px;height:9px;border-radius:50%;background:#c77d18;box-shadow:0 0 6px #c77d18}
  .dot.ok{background:#25d1da;box-shadow:0 0 6px #25d1da}
  .ib{background:none;border:0;color:#aab;cursor:pointer;font-size:15px;padding:0 4px}
  .ib:hover{color:#fff}
  .body{padding:10px;max-height:70vh;overflow:auto}
  .wrap.min .body{display:none}
  .wrap.min{width:auto}
  .tabs{display:flex;gap:4px;margin-bottom:10px}
  .tab{flex:1;padding:6px 4px;border-radius:8px;border:1px solid #2b3236;background:#1a1f21;color:#bbb;cursor:pointer;font-size:12px}
  .tab.on{background:#25d1da22;border-color:#25d1da;color:#fff}
  .pane{display:none}.pane.on{display:block}
  label{display:block;margin:6px 0 3px;color:#9aa4a8;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  input[type=text],input[type=date],select,textarea{width:100%;padding:7px 8px;border-radius:8px;border:1px solid #2b3236;background:#161a1c;color:#eee;font-size:12px}
  textarea{height:80px;resize:vertical}
  .row{display:flex;gap:6px;align-items:center}
  .chk{display:flex;gap:6px;align-items:center;margin:6px 0;color:#cfd4d6;font-size:12px;text-transform:none;letter-spacing:0}
  .btn{width:100%;margin-top:8px;padding:9px;border-radius:999px;border:0;background:#25d1da;color:#062022;font-weight:700;cursor:pointer;font-size:13px}
  .btn:hover{filter:brightness(1.1)}.btn:disabled{opacity:.45;cursor:not-allowed}
  .btn.sec{background:#2a3134;color:#eee;font-weight:600}
  .btn.warn{background:#d9534f;color:#fff}
  .hint{color:#8b9599;font-size:11px;margin-top:4px;line-height:1.35}
  .prog{margin-top:10px;display:none}.prog.on{display:block}
  .bar{height:8px;border-radius:99px;background:#22292c;overflow:hidden;position:relative}
  .fill{height:100%;width:0;background:linear-gradient(90deg,#25d1da,#7cf);transition:width .3s}
  .bar.ind .fill{width:30%;position:absolute;animation:slide 1.2s ease-in-out infinite}
  @keyframes slide{0%{left:-30%}100%{left:100%}}
  .ptext{margin-top:6px;font-size:12px;color:#cfd4d6;word-break:break-word}
  .msg{margin-top:8px;font-size:12px;line-height:1.4;word-break:break-word}
  .msg.err{color:#ff8a80}.msg.ok{color:#7ee2a8}
  .stats{margin-top:8px;font-size:12px;background:#161a1c;border-radius:8px;padding:8px;display:none}
  .stats.on{display:block}
  .stats ol{margin:4px 0 6px 18px;padding:0}
  .plist{max-height:200px;overflow:auto;border:1px solid #2b3236;border-radius:8px;padding:4px 6px;margin-top:6px;display:none}
  .plist.on{display:block}
  .plist .chk{margin:3px 0}
  .notice{font-size:12px;line-height:1.45;color:#dfe3e5}
  .notice ul{margin:6px 0 8px 16px;padding:0}.notice li{margin:3px 0}
  .notice a{color:#25d1da}
  `;

  function mountUI() {
    if (document.getElementById('amexp-host')) return;
    const host = h('div', { id: 'amexp-host' });
    const root = host.attachShadow({ mode: 'open' });
    root.append(h('style', { text: CSS }));

    const dot = h('span', { class: 'dot', title: 'Waiting for the page to make an API request' });
    const minBtn = h('button', { class: 'ib', title: 'Collapse', text: '–' });
    const hdr = h('div', { class: 'hdr' }, dot, h('b', { text: 'Amazon Music Exporter' }), minBtn);

    const tabNames = [['pl', 'Playlist'], ['hist', 'History'], ['more', 'More']];
    const tabs = {}, panes = {};
    const tabBar = h('div', { class: 'tabs' });
    const showTab = (k) => { for (const [n] of tabNames) { tabs[n].classList.toggle('on', n === k); panes[n].classList.toggle('on', n === k); } store.set('tab', k); };
    for (const [k, label] of tabNames) { tabs[k] = h('button', { class: 'tab', text: label, onclick: () => showTab(k) }); tabBar.append(tabs[k]); }

    // Playlist pane
    const plInput = h('input', { type: 'text', placeholder: 'Playlist URL or ID (blank = current page)' });
    const plDetected = h('div', { class: 'hint' });
    const plBtn = h('button', { class: 'btn', text: 'Export playlist' });
    panes.pl = h('div', { class: 'pane' },
      h('label', { text: 'Playlist' }), plInput, plDetected, plBtn,
      h('div', { class: 'hint', text: 'Exports JSON + CSV, including ISRC. Also: position, title, artists, album, duration, explicit, lyrics, Ultra HD / Atmos / 360, liked, art + track URLs.' }));

    // History pane
    const range = h('select', {},
      h('option', { value: '7d', text: 'Last 7 days' }), h('option', { value: '30d', text: 'Last 30 days' }),
      h('option', { value: '90d', text: 'Last 90 days' }), h('option', { value: '1y', text: 'Last year' }),
      h('option', { value: 'all', text: 'Everything available' }), h('option', { value: 'custom', text: 'Since a date…' }));
    range.value = store.get('range', '30d');
    const custom = h('input', { type: 'date' });
    const customWrap = h('div', {}, h('label', { text: 'From date' }), custom);
    const sinceLast = h('input', { type: 'checkbox' });
    const resolve = h('input', { type: 'checkbox', checked: true });
    const lastInfo = h('div', { class: 'hint' });
    const histBtn = h('button', { class: 'btn', text: 'Export listening history' });
    const resumeBtn = h('button', { class: 'btn sec', text: 'Resume interrupted export' });
    const statsBox = h('div', { class: 'stats' });
    panes.hist = h('div', { class: 'pane' },
      h('label', { text: 'How far back' }), range, customWrap,
      h('label', { class: 'chk' }, sinceLast, 'Only new plays since my last export'), lastInfo,
      h('label', { class: 'chk' }, resolve, 'Fill in missing artist/album details'),
      histBtn, resumeBtn, statsBox,
      h('div', { class: 'hint', text: 'Each play includes skipped and device family. ISRCs are filled by track lookup. Pages 100 plays at a time (~1.5 s each).' }));

    // More pane
    const loadPlBtn = h('button', { class: 'btn sec', text: 'Load my playlists' });
    const plist = h('div', { class: 'plist' });
    const allBtn = h('button', { class: 'btn', text: 'Export selected playlists', disabled: true });
    const asinBox = h('textarea', { placeholder: 'Paste track IDs (B0…) or track URLs, any format' });
    const lookupBtn = h('button', { class: 'btn', text: 'Look up track IDs' });
    const followedBtn = h('button', { class: 'btn', text: 'Export followed artists' });
    const libraryArtistsBtn = h('button', { class: 'btn', text: 'Export library artists' });
    const recentBtn = h('button', { class: 'btn', text: 'Export recently opened' });
    const resetBtn = h('button', { class: 'btn sec', text: 'Forget “last export” marker' });
    panes.more = h('div', { class: 'pane' },
      h('label', { text: 'All my playlists' }), loadPlBtn, plist, allBtn,
      h('label', { text: 'Artists' }), followedBtn, libraryArtistsBtn,
      h('label', { text: 'Recently opened' }), recentBtn,
      h('div', { class: 'hint', text: 'Followed artists and library artists are full lists. Recently opened is the first 50 only.' }),
      h('label', { text: 'Track ID lookup' }), asinBox, lookupBtn,
      h('label', { text: 'Housekeeping' }), resetBtn);

    // Progress + messages
    const fill = h('div', { class: 'fill' });
    const bar = h('div', { class: 'bar' }, fill);
    const ptext = h('div', { class: 'ptext' });
    const cancelBtn = h('button', { class: 'btn warn', text: 'Cancel' });
    const partialBtn = h('button', { class: 'btn sec', text: 'Download what I have so far' });
    const prog = h('div', { class: 'prog' }, bar, ptext, h('div', { class: 'row' }, cancelBtn, partialBtn));
    const msg = h('div', { class: 'msg' });
    const connMsg = h('div', { class: 'hint' });

    const main = h('div', {}, connMsg, tabBar, panes.pl, panes.hist, panes.more, prog, msg);
    const ACK_KEY = 'ackDisclaimer_v1';
    const ackBtn = h('button', { class: 'btn', text: 'I understand — use only on my own account' });
    const notice = h('div', { class: 'notice' },
      h('b', { text: 'Before you start' }),
      h('ul', {},
        h('li', { text: 'Unofficial tool, not affiliated with or endorsed by Amazon. It uses undocumented internal endpoints that may break.' }),
        h('li', { text: 'Use it only on your own account, to back up your own data. Never on anyone else\'s account, never to scrape the catalog, resell data, or get audio.' }),
        h('li', { text: 'Using it may conflict with Amazon\'s terms; you are responsible for any account consequences.' }),
        h('li', { text: 'Exports are personal data. Never share files, console output or headers that may contain tokens.' })),
      h('a', { href: Core.DISCLAIMER_URL, target: '_blank', rel: 'noopener noreferrer', text: 'Read the full disclaimer' }),
      ackBtn);
    const applyAck = () => { const ok = !!store.get(ACK_KEY, false); notice.style.display = ok ? 'none' : 'block'; main.style.display = ok ? 'block' : 'none'; };
    ackBtn.addEventListener('click', () => { store.set(ACK_KEY, true); applyAck(); });
    applyAck();
    const body = h('div', { class: 'body' }, notice, main);
    const wrap = h('div', { class: 'wrap' }, hdr, body);
    root.append(wrap);
    document.documentElement.append(host);

    // position + collapse
    const pos = store.get('pos', null);
    const place = (x, y) => {
      x = Math.max(0, Math.min(window.innerWidth - 60, x)); y = Math.max(0, Math.min(window.innerHeight - 40, y));
      Object.assign(wrap.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
    };
    if (pos) place(pos.x, pos.y); else Object.assign(wrap.style, { right: '16px', bottom: '96px' });
    const setMin = (m) => { wrap.classList.toggle('min', m); minBtn.textContent = m ? '+' : '–'; store.set('min', m); };
    setMin(!!store.get('min', false));
    minBtn.addEventListener('click', (e) => { e.stopPropagation(); setMin(!wrap.classList.contains('min')); });
    let drag = null;
    hdr.addEventListener('mousedown', (e) => { if (e.target === minBtn) return; const r = wrap.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (drag) place(e.clientX - drag.dx, e.clientY - drag.dy); });
    window.addEventListener('mouseup', () => { if (drag) { const r = wrap.getBoundingClientRect(); store.set('pos', { x: r.left, y: r.top }); drag = null; } });
    hdr.addEventListener('dblclick', () => { store.del('pos'); Object.assign(wrap.style, { left: 'auto', top: 'auto', right: '16px', bottom: '96px' }); });

    // dynamic bits
    const allActionBtns = [plBtn, histBtn, resumeBtn, loadPlBtn, allBtn, lookupBtn, followedBtn, libraryArtistsBtn, recentBtn];
    let busy = false;
    const refreshConn = () => {
      const ok = !!auth.headers;
      dot.classList.toggle('ok', ok);
      dot.title = ok ? 'Connected (headers captured in memory)' : 'Not connected yet';
      connMsg.textContent = ok ? '' : 'Waiting for Amazon Music to make an API request… Click around (Library, a playlist) or reload the page if this stays.';
      connMsg.style.display = ok ? 'none' : 'block';
    };
    authListeners.add(refreshConn); refreshConn();
    const refreshHist = () => {
      customWrap.style.display = range.value === 'custom' ? 'block' : 'none';
      const lp = store.get('lastPlayedAt', null);
      lastInfo.textContent = lp ? `Last export reached ${new Date(lp).toLocaleString()}` : 'No previous export recorded yet.';
      sinceLast.disabled = !lp;
      resumeBtn.style.display = store.get('checkpoint_history', null) ? 'block' : 'none';
    };
    range.addEventListener('change', () => { store.set('range', range.value); refreshHist(); });
    refreshHist();
    const refreshDetected = () => {
      const id = Core.extractPlaylistId(location.pathname);
      plDetected.textContent = id ? `Current page playlist: ${id}` : 'No playlist on this page — paste a URL or ID above.';
    };
    refreshDetected();
    setInterval(refreshDetected, 1500); // SPA navigation

    const ui = {
      startJob(name) {
        busy = true; allActionBtns.forEach((b) => (b.disabled = true));
        prog.classList.add('on'); cancelBtn.style.display = 'block'; partialBtn.style.display = job && job.partial ? 'block' : 'none';
        msg.className = 'msg'; msg.textContent = '';
        ui.progress(null, name + ': starting…');
      },
      progress(frac, text) {
        if (frac == null || !isFinite(frac)) { bar.classList.add('ind'); fill.style.width = ''; }
        else { bar.classList.remove('ind'); fill.style.width = Math.max(2, Math.min(100, frac * 100)).toFixed(1) + '%'; }
        if (text) ptext.textContent = text;
      },
      status(text) { ptext.textContent = text; },
      done(text) {
        busy = false; allActionBtns.forEach((b) => (b.disabled = false)); allBtn.disabled = !plist.querySelector('input:checked');
        bar.classList.remove('ind'); fill.style.width = '100%'; cancelBtn.style.display = 'none'; partialBtn.style.display = 'none';
        msg.className = 'msg ok'; msg.textContent = text; refreshHist();
      },
      fail(err) {
        busy = false; allActionBtns.forEach((b) => (b.disabled = false)); allBtn.disabled = !plist.querySelector('input:checked');
        bar.classList.remove('ind'); cancelBtn.style.display = 'none';
        const cancelled = err && err.kind === 'cancel';
        msg.className = 'msg ' + (cancelled ? '' : 'err');
        msg.textContent = cancelled ? 'Cancelled.' : 'Stopped: ' + (err && err.message || err);
        partialBtn.style.display = job && job.partial ? 'block' : 'none';
        if (job && job.saveCheckpoint) { try { job.saveCheckpoint(); } catch (_) {} }
        if (job && job.kind === 'history') msg.textContent += ' A checkpoint was saved; use “Resume interrupted export” or download the partial file.';
        refreshHist();
        if (!cancelled) LOG('Error:', err && err.message);
      },
      showStats(s) {
        statsBox.textContent = '';
        statsBox.append(
          h('div', {}, h('b', { text: `${s.totalPlays.toLocaleString()} plays · ~${s.estimatedHours.toLocaleString()} h (${s.estimatedMinutes.toLocaleString()} min)` })),
          h('div', { class: 'hint', text: `${s.uniqueTracks.toLocaleString()} tracks · ${s.uniqueArtists.toLocaleString()} artists · ${s.activeDays} active days · ~${s.avgHoursPerActiveDay} h/day` }),
          h('div', { text: 'Top artists' }), h('ol', {}, s.topArtists.slice(0, 5).map((a) => h('li', { text: `${a.artist} (${a.plays})` }))),
          h('div', { text: 'Top tracks' }), h('ol', {}, s.topTracks.slice(0, 5).map((t) => h('li', { text: `${t.title} — ${t.artist || '?'} (${t.plays})` }))));
        statsBox.classList.add('on');
      },
      renderPlaylistList(list) {
        plist.textContent = '';
        const all = h('input', { type: 'checkbox', checked: true });
        plist.append(h('label', { class: 'chk' }, all, h('b', { text: `Select all (${list.length})` })));
        const boxes = list.map((p) => {
          const cb = h('input', { type: 'checkbox', checked: true });
          cb._pl = p;
          plist.append(h('label', { class: 'chk', title: p.id }, cb, `${p.title} (${p.trackCount != null ? p.trackCount : '?'})`));
          return cb;
        });
        all.addEventListener('change', () => { boxes.forEach((b) => (b.checked = all.checked)); allBtn.disabled = busy || !all.checked; });
        boxes.forEach((b) => b.addEventListener('change', () => { allBtn.disabled = busy || !boxes.some((x) => x.checked); }));
        plist._boxes = boxes;
        plist.classList.add('on');
        allBtn.disabled = busy || !list.length;
      },
    };
    const run = (fn) => async () => {
      if (busy) return;
      try { await fn(); } catch (e) { ui.fail(e); }
    };
    plBtn.addEventListener('click', run(() => doPlaylist(ui, plInput.value.trim() || location.href)));
    histBtn.addEventListener('click', run(() => doHistory(ui, { preset: range.value, custom: custom.value, sinceLast: sinceLast.checked, resolve: resolve.checked })));
    resumeBtn.addEventListener('click', run(() => doHistory(ui, { resume: true, resolve: resolve.checked })));
    loadPlBtn.addEventListener('click', run(() => doLoadPlaylists(ui)));
    allBtn.addEventListener('click', run(() => doPlaylistsBatch(ui, (plist._boxes || []).filter((b) => b.checked).map((b) => b._pl))));
    lookupBtn.addEventListener('click', run(() => doLookup(ui, asinBox.value)));
    followedBtn.addEventListener('click', run(() => doArtists(ui, 'followedArtists')));
    libraryArtistsBtn.addEventListener('click', run(() => doArtists(ui, 'libraryArtists')));
    recentBtn.addEventListener('click', run(() => doRecent(ui)));
    resetBtn.addEventListener('click', () => { store.del('lastPlayedAt'); store.del('checkpoint_history'); sinceLast.checked = false; refreshHist(); msg.className = 'msg ok'; msg.textContent = 'Cleared the last-export marker and any saved checkpoint.'; });
    cancelBtn.addEventListener('click', () => { if (job && job.cancel) job.cancel.cancelled = true; ptext.textContent = 'Cancelling…'; });
    partialBtn.addEventListener('click', downloadPartial);
    showTab(store.get('tab', 'pl'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUI, { once: true });
  else mountUI();
})();
