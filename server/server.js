require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const compression = require('compression');

const app = express();

app.use(cors());
app.use(compression()); // gzip every response — cuts transfer size/CPU on both ends
app.use(express.json({ limit: '20mb' }));

// Serve the frontend files from the repository root
app.use(express.static(path.join(__dirname, "..")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"));
});

const PORT = process.env.PORT || 4000;
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/tee_sheet_tour";

/* =====================================================================
   WHY THIS FILE LOOKS DIFFERENT FROM BEFORE
   ---------------------------------------------------------------------
   The old version stuffed the ENTIRE game — every season's full archive
   (STATE.history), every news item (STATE.news), and every player's
   whole world-ranking history (worldRanking[id].history) — into ONE
   Mongo document per profile. Those three things only ever grow, never
   shrink, so after a handful of simulated seasons the document creeps
   toward (and eventually past) MongoDB's hard 16MB-per-document limit.
   That's the warning you saw in Compass/Atlas.

   The fix: keep a small "core" document per profile (roster, schedule,
   current standings, rydercup state, etc. — things that don't grow
   without bound), and split the three ever-growing pieces into ONE
   TINY DOCUMENT PER SEASON. A single season's worth of data is small
   and stays small no matter how many seasons you rack up, because each
   season gets its own document instead of piling into one blob. With
   this scheme you can comfortably simulate hundreds of seasons.

   The API contract (GET/PUT/DELETE /api/state/:profileId) is UNCHANGED
   from the frontend's point of view — index.html does not need any
   edits. The server transparently splits state on save and reassembles
   it on load.
   ===================================================================== */

/* ===== CORE SAVE (small, one per profile) ===== */
const saveSchema = new mongoose.Schema(
  {
    profileId: { type: String, required: true, unique: true, index: true },
    state: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);
const Save = mongoose.model("Save", saveSchema);

/* ===== SEASON CHUNK (small, one per profile PER SEASON) =====
   Holds the three unbounded-growth pieces for a single season:
     history    -> STATE.history entries whose seasonNumber === season
     news       -> STATE.news entries whose season === season
     wr         -> { [playerId]: [worldRanking history entries for that season] }
     standings  -> { [playerId]: [standings.history result rows for that season] }
   season = 0 is used as a bucket for anything without a clean numeric
   season (e.g. the "seed"/preseason worldRanking entries). */
const seasonChunkSchema = new mongoose.Schema(
  {
    profileId: { type: String, required: true, index: true },
    season: { type: Number, required: true },
    history: { type: [mongoose.Schema.Types.Mixed], default: [] },
    news: { type: [mongoose.Schema.Types.Mixed], default: [] },
    wr: { type: mongoose.Schema.Types.Mixed, default: {} },
    standings: { type: mongoose.Schema.Types.Mixed, default: {} },
    compacted: { type: Boolean, default: false }, // true once this season's detail has been summarized (see compactOldSeasons)
  },
  { timestamps: true }
);
seasonChunkSchema.index({ profileId: 1, season: 1 }, { unique: true });
const SeasonChunk = mongoose.model("SeasonChunk", seasonChunkSchema);

/* ===== SEASON COMPACTION =====
   Seasons older than KEEP_FULL_SEASONS (counting back from the player's
   current season) get their heavy per-tournament detail collapsed down
   to season totals. This keeps EVERY season's storage tiny forever,
   instead of just "doesn't grow within a season."

   What happens to an old season's chunk:
     - standings[playerId].history (one row per tournament played) ->
       collapsed to ONE summary row per player: {points, earnings, wins, events}
     - wr (world ranking history) -> dropped; the player's current WR
       points already live in the core doc, this was just the trail
     - news -> kept ONLY for majors (news.major === true); everything
       else (droughts, hot streaks, awards blurbs, ryder cup recaps) is
       dropped for old seasons
     - history (season-archive top5 entry) -> left alone; it's already
       one tiny row per season, not worth touching
     - majorChampions / career.winsList -> untouched, always. They live
       in the core doc and are the permanent trophy case — see the note
       at the top of SPLIT / REASSEMBLE HELPERS. Compaction never runs
       against them. */
const KEEP_FULL_SEASONS = 3;

function summarizeStandingsHistory(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  const summary = { summary: true, points: 0, earnings: 0, wins: 0, events: rows.length };
  rows.forEach((h) => {
    summary.points += h.pts || 0;
    summary.earnings += h.prize || 0;
    if (h.pos === 1) summary.wins += 1;
  });
  return [summary];
}

// Compacts any of this profile's season chunks that are older than the
// keep-full window and haven't been compacted yet. Cheap to call on
// every save: after the first pass, only newly-aged-out seasons match.
async function compactOldSeasons(profileId, currentSeasonNumber) {
  const threshold = Number(currentSeasonNumber) - KEEP_FULL_SEASONS;
  if (!Number.isFinite(threshold) || threshold < 1) return; // nothing old enough yet

  const candidates = await SeasonChunk.find({
    profileId,
    season: { $gte: 1, $lte: threshold },
    compacted: { $ne: true },
  });

  for (const chunk of candidates) {
    const compactedStandings = {};
    const standingsObj = chunk.standings || {};
    Object.keys(standingsObj).forEach((pid) => {
      compactedStandings[pid] = summarizeStandingsHistory(standingsObj[pid]);
    });

    chunk.standings = compactedStandings;
    chunk.wr = {};
    chunk.news = (chunk.news || []).filter((n) => n && n.major === true);
    chunk.compacted = true;
    await chunk.save();
  }

  if (candidates.length) {
    console.log(`🗜️  Compacted ${candidates.length} old season chunk(s) for profile "${profileId}" (season <= ${threshold}).`);
  }
}

/* ===== SPLIT / REASSEMBLE HELPERS =====
   NOTE: state.majorChampions and each player's career.winsList are NOT
   split out here — they're small forever (one row per major win, ever),
   they're the permanent trophy-case record, and they must always be
   shown in full, so they stay in the lean core doc untouched. */

function seasonBucketOf(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0; // non-numeric (e.g. 'seed') -> bucket 0
}

// Given a full incoming state blob, pull out the unbounded arrays into
// per-season chunks, and return a lean "core" copy with those arrays
// emptied out (they get reattached on load from the chunks).
function splitState(state) {
  const chunksBySeason = new Map(); // season -> {history:[], news:[], wr:{}, standings:{}}

  function getChunk(season) {
    if (!chunksBySeason.has(season)) {
      chunksBySeason.set(season, { history: [], news: [], wr: {}, standings: {} });
    }
    return chunksBySeason.get(season);
  }

  const history = Array.isArray(state.history) ? state.history : [];
  history.forEach((entry) => {
    const season = seasonBucketOf(entry.seasonNumber);
    getChunk(season).history.push(entry);
  });

  const news = Array.isArray(state.news) ? state.news : [];
  news.forEach((entry) => {
    const season = seasonBucketOf(entry.season);
    getChunk(season).news.push(entry);
  });

  const worldRanking = state.worldRanking || {};
  const coreWorldRanking = {};
  Object.keys(worldRanking).forEach((playerId) => {
    const wr = worldRanking[playerId] || {};
    coreWorldRanking[playerId] = { ...wr, history: [] }; // strip, kept in chunks
    const wrHistory = Array.isArray(wr.history) ? wr.history : [];
    wrHistory.forEach((entry) => {
      const season = seasonBucketOf(entry.season);
      const chunk = getChunk(season);
      if (!chunk.wr[playerId]) chunk.wr[playerId] = [];
      chunk.wr[playerId].push(entry);
    });
  });

  // standings[playerId].history -> per-tournament result rows. This was the
  // one unbounded piece the original split missed: it stayed in the core
  // doc forever, growing every tournament, every season, per player.
  const standings = state.standings || {};
  const coreStandings = {};
  Object.keys(standings).forEach((playerId) => {
    const st = standings[playerId] || {};
    coreStandings[playerId] = { ...st, history: [] }; // strip, kept in chunks
    const stHistory = Array.isArray(st.history) ? st.history : [];
    stHistory.forEach((entry) => {
      const season = seasonBucketOf(entry.season);
      const chunk = getChunk(season);
      if (!chunk.standings[playerId]) chunk.standings[playerId] = [];
      chunk.standings[playerId].push(entry);
    });
  });

  const core = {
    ...state,
    history: [],
    news: [],
    worldRanking: coreWorldRanking,
    standings: coreStandings,
  };
  return { core, chunksBySeason };
}

// Reassemble a full state blob for the frontend from the core doc + all
// of that profile's season chunks (sorted so history/news/standings come
// back in season order, same as before).
function reassembleState(coreState, chunks) {
  const state = { ...coreState };
  const sorted = [...chunks].sort((a, b) => a.season - b.season);

  const history = [];
  const news = [];
  const worldRanking = { ...(state.worldRanking || {}) };
  const standings = { ...(state.standings || {}) };
  // make sure every player has a history array to push into
  Object.keys(worldRanking).forEach((pid) => {
    worldRanking[pid] = { ...worldRanking[pid], history: [...(worldRanking[pid].history || [])] };
  });
  Object.keys(standings).forEach((pid) => {
    standings[pid] = { ...standings[pid], history: [...(standings[pid].history || [])] };
  });

  sorted.forEach((chunk) => {
    if (Array.isArray(chunk.history)) history.push(...chunk.history);
    if (Array.isArray(chunk.news)) news.push(...chunk.news);
    const wr = chunk.wr || {};
    Object.keys(wr).forEach((pid) => {
      if (!worldRanking[pid]) worldRanking[pid] = { pts: 0, history: [] };
      if (!worldRanking[pid].history) worldRanking[pid].history = [];
      worldRanking[pid].history.push(...wr[pid]);
    });
    const stChunk = chunk.standings || {};
    Object.keys(stChunk).forEach((pid) => {
      if (!standings[pid]) standings[pid] = { points: 0, earnings: 0, wins: 0, events: 0, history: [] };
      if (!standings[pid].history) standings[pid].history = [];
      standings[pid].history.push(...stChunk[pid]);
    });
  });

  state.history = history;
  state.news = news;
  state.worldRanking = worldRanking;
  state.standings = standings;
  return state;
}

/* ===== HEALTH CHECK ===== */
app.get('/api/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  res.json({
    ok: true,
    db: dbState === 1 ? 'connected' : 'not connected',
    dbState,
  });
});

/* ===== LOAD STATE =====
   GET /api/state/:profileId
   Loads the core doc + every season chunk for this profile and
   reassembles the full state, exactly like the old single-document
   version used to return. */
app.get('/api/state/:profileId', async (req, res) => {
  try {
    const { profileId } = req.params;
    const doc = await Save.findOne({ profileId }).lean();
    if (!doc) return res.status(404).json({ error: 'No save found for this profile.' });

    const chunks = await SeasonChunk.find({ profileId }).lean();
    const state = reassembleState(doc.state, chunks);

    res.json({ profileId: doc.profileId, state, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('GET /api/state error:', err);
    res.status(500).json({ error: 'Failed to load save.' });
  }
});

/* ===== SAVE STATE =====
   PUT /api/state/:profileId
   The client still sends the entire STATE object, same as before — but:
     1. Chunks already marked `compacted` are skipped on write. Once a
        season is old enough to compact, live gameplay never touches it
        again, so re-upserting it every save was pure waste — this is
        what kept save cost growing forever even after chunking.
     2. The response no longer reassembles/returns the full state. The
        client already has the authoritative state in memory (it just
        sent it); echoing the whole thing back was wasted serialization
        on every single save. */
app.put('/api/state/:profileId', async (req, res) => {
  try {
    const { profileId } = req.params;
    let { state } = req.body;
    if (!state || typeof state !== 'object') {
      return res.status(400).json({ error: 'Request body must include a "state" object.' });
    }

    // ── Migration: remove legacy fantasy field if present ──
    if (state.fantasy !== undefined) {
      delete state.fantasy;
    }
    // ── Migration: ensure rydercupHistory array exists ──
    if (!Array.isArray(state.rydercupHistory)) {
      state.rydercupHistory = [];
    }
    // ── Migration: ensure worldRanking exists ──
    if (!state.worldRanking || typeof state.worldRanking !== 'object') {
      state.worldRanking = {};
    }

    const { core, chunksBySeason } = splitState(state);

    // Upsert the lean core doc.
    const doc = await Save.findOneAndUpdate(
      { profileId },
      { $set: { state: core } },
      { upsert: true, new: true }
    );

    // Find out which seasons are already compacted so we can skip them —
    // compacted seasons are frozen (gameplay never edits old seasons),
    // so writing them again every save would be pure waste.
    const compactedDocs = await SeasonChunk.find(
      { profileId, compacted: true },
      { season: 1 }
    ).lean();
    const compactedSeasons = new Set(compactedDocs.map((d) => d.season));

    const seasonWrites = [];
    for (const [season, chunk] of chunksBySeason.entries()) {
      if (compactedSeasons.has(season)) continue; // frozen, skip
      seasonWrites.push(
        SeasonChunk.findOneAndUpdate(
          { profileId, season },
          { $set: { history: chunk.history, news: chunk.news, wr: chunk.wr, standings: chunk.standings } },
          { upsert: true }
        )
      );
    }
    await Promise.all(seasonWrites);

    // Roll any newly-aged-out seasons into summary form. Cheap after the
    // first pass — only fires again once a new season crosses the line.
    await compactOldSeasons(profileId, core.seasonNumber);

    res.json({ profileId: doc.profileId, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('PUT /api/state error:', err);
    res.status(500).json({ error: 'Failed to save.' });
  }
});

/* ===== LIVE TOURNAMENT SAVE (lightweight, no season-chunk work at all) =====
   PATCH /api/state/:profileId/live
   Body: { schedule, activeTournamentId, currentWeekIndex }

   Hole-by-hole score entry (recordHoleScore in index.html) used to call
   the full PUT above on every single stroke typed — sending and
   reprocessing the ENTIRE game state (every season chunk) just to
   record one number. Live, in-progress tournament data (STATE.schedule)
   never touches standings/history/news/worldRanking until the
   tournament is finalized elsewhere, so it doesn't need any of that
   machinery. This endpoint does one `$set` on three fields in the core
   doc and nothing else — no splitState, no season chunks, no reassembly. */
app.patch('/api/state/:profileId/live', async (req, res) => {
  try {
    const { profileId } = req.params;
    const { schedule, activeTournamentId, currentWeekIndex } = req.body || {};
    if (!Array.isArray(schedule)) {
      return res.status(400).json({ error: 'Request body must include a "schedule" array.' });
    }

    const update = {
      'state.schedule': schedule,
      'state.activeTournamentId': activeTournamentId ?? null,
    };
    if (currentWeekIndex !== undefined) update['state.currentWeekIndex'] = currentWeekIndex;

    // upsert:false is intentional and important — this endpoint must never
    // be allowed to CREATE a save document. A dot-path $set on a brand new
    // doc would produce a "state" object containing ONLY schedule and
    // activeTournamentId, missing players/standings/worldRanking/everything
    // else. If that ever happened (e.g. a hole score gets recorded before
    // the profile's first full save has landed), the corrupted doc would
    // load back as a nearly-empty state on next visit. Instead, if no full
    // save exists yet, this is a no-op (404) and the client falls back to
    // a normal full saveState(), which is always safe to create the doc.
    const doc = await Save.findOneAndUpdate(
      { profileId },
      { $set: update },
      { upsert: false, new: true }
    );

    if (!doc) {
      return res.status(404).json({ error: 'No existing save for this profile yet — do a full save first.' });
    }

    res.json({ ok: true, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('PATCH /api/state/live error:', err);
    res.status(500).json({ error: 'Failed to save live tournament state.' });
  }
});

/* ===== DELETE SAVE =====
   DELETE /api/state/:profileId
   Wipes the core save AND all of its season chunks (used by "Restart Tour"). */
app.delete('/api/state/:profileId', async (req, res) => {
  try {
    const { profileId } = req.params;
    await Promise.all([
      Save.deleteOne({ profileId }),
      SeasonChunk.deleteMany({ profileId }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/state error:', err);
    res.status(500).json({ error: 'Failed to delete save.' });
  }
});

/* ===== LIST ALL PROFILES =====
   GET /api/profiles
   Returns a list of all profile IDs and their last-updated timestamps.
   Useful for admin/debug — not exposed to the frontend in normal use. */
app.get('/api/profiles', async (req, res) => {
  try {
    const docs = await Save.find({}, { profileId: 1, updatedAt: 1 }).lean();
    res.json({ profiles: docs.map(d => ({ profileId: d.profileId, updatedAt: d.updatedAt })) });
  } catch (err) {
    console.error('GET /api/profiles error:', err);
    res.status(500).json({ error: 'Failed to list profiles.' });
  }
});

/* ===== AUTO-MIGRATION (runs on every startup, self-skips once done) =====
   Old saves (from before this file was updated) still have everything —
   full history/news/worldRanking-history — crammed into one Save.state
   blob. This walks every profile once, splits any old-format data into
   season chunks, and leaves already-migrated profiles untouched. Because
   it's idempotent (checks before touching each profile), it's completely
   safe for this to run on every deploy/restart — including on Render. */
async function migrateLegacySavesIfNeeded() {
  const saves = await Save.find({});
  let migrated = 0;

  for (const doc of saves) {
    const state = doc.state || {};
    const looksUnmigrated =
      (Array.isArray(state.history) && state.history.length > 0) ||
      (Array.isArray(state.news) && state.news.length > 0) ||
      Object.values(state.worldRanking || {}).some(
        (wr) => Array.isArray(wr && wr.history) && wr.history.length > 0
      ) ||
      Object.values(state.standings || {}).some(
        (st) => Array.isArray(st && st.history) && st.history.length > 0
      );

    if (!looksUnmigrated) continue; // already lean -> already migrated

    const { core, chunksBySeason } = splitState(state);

    for (const [season, chunk] of chunksBySeason.entries()) {
      await SeasonChunk.findOneAndUpdate(
        { profileId: doc.profileId, season },
        { $set: { history: chunk.history, news: chunk.news, wr: chunk.wr, standings: chunk.standings } },
        { upsert: true }
      );
    }

    doc.state = core;
    await doc.save();
    migrated++;
    console.log(`🔄 Migrated legacy save for profile "${doc.profileId}" into ${chunksBySeason.size} season chunk(s).`);
  }

  if (migrated > 0) console.log(`✅ Auto-migration complete: ${migrated} profile(s) migrated.`);
  else console.log(`✅ Auto-migration check: nothing to do, all saves already in season-chunk format.`);

  // Also sweep compaction across every profile on startup — catches any
  // profile whose season count already exceeds the keep-full window,
  // including ones that were already in season-chunk format before this
  // update (so upgrading applies compaction immediately, not just on
  // this profile's next save).
  const allSaves = await Save.find({}, { profileId: 1, 'state.seasonNumber': 1 }).lean();
  for (const doc of allSaves) {
    try {
      await compactOldSeasons(doc.profileId, doc.state && doc.state.seasonNumber);
    } catch (err) {
      console.error(`⚠️  Compaction sweep failed for profile "${doc.profileId}":`, err);
    }
  }
}

/* ===== STARTUP ===== */
async function start() {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`✅ Connected to MongoDB at ${MONGODB_URI}`);
  } catch (err) {
    console.error('❌ Could not connect to MongoDB:', err.message);
    console.error('Is MongoDB running? Check your MONGODB_URI in .env.');
    process.exit(1);
  }

  try {
    await migrateLegacySavesIfNeeded();
  } catch (err) {
    console.error('⚠️  Auto-migration hit an error (server will still start):', err);
  }

  app.listen(PORT, () => {
    console.log(`🏌️  Tee Sheet Tour save server running on http://localhost:${PORT}`);
    console.log(`📡 API base: http://localhost:${PORT}/api`);
    console.log(`🏆 Ryder Cup mode: USA vs Europe (auto every odd season)`);
    console.log(`🗂️  Storage: 1 core doc + 1 doc per season per profile (no more 16MB blobs)`);
    console.log(`🗜️  Seasons older than ${KEEP_FULL_SEASONS} get auto-compacted to summary totals`);
    console.log(`⚡ PATCH /api/state/:profileId/live handles hole-by-hole scoring without touching season chunks`);
  });
}

start();
