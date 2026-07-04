require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
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
     history -> STATE.history entries whose seasonNumber === season
     news    -> STATE.news entries whose season === season
     wr      -> { [playerId]: [worldRanking history entries for that season] }
   season = 0 is used as a bucket for anything without a clean numeric
   season (e.g. the "seed"/preseason worldRanking entries). */
const seasonChunkSchema = new mongoose.Schema(
  {
    profileId: { type: String, required: true, index: true },
    season: { type: Number, required: true },
    history: { type: [mongoose.Schema.Types.Mixed], default: [] },
    news: { type: [mongoose.Schema.Types.Mixed], default: [] },
    wr: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);
seasonChunkSchema.index({ profileId: 1, season: 1 }, { unique: true });
const SeasonChunk = mongoose.model("SeasonChunk", seasonChunkSchema);

/* ===== SPLIT / REASSEMBLE HELPERS ===== */

function seasonBucketOf(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0; // non-numeric (e.g. 'seed') -> bucket 0
}

// Given a full incoming state blob, pull out the unbounded arrays into
// per-season chunks, and return a lean "core" copy with those arrays
// emptied out (they get reattached on load from the chunks).
function splitState(state) {
  const chunksBySeason = new Map(); // season -> {history:[], news:[], wr:{}}

  function getChunk(season) {
    if (!chunksBySeason.has(season)) {
      chunksBySeason.set(season, { history: [], news: [], wr: {} });
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

  const core = { ...state, history: [], news: [], worldRanking: coreWorldRanking };
  return { core, chunksBySeason };
}

// Reassemble a full state blob for the frontend from the core doc + all
// of that profile's season chunks (sorted so history/news come back in
// season order, same as before).
function reassembleState(coreState, chunks) {
  const state = { ...coreState };
  const sorted = [...chunks].sort((a, b) => a.season - b.season);

  const history = [];
  const news = [];
  const worldRanking = { ...(state.worldRanking || {}) };
  // make sure every player has a history array to push into
  Object.keys(worldRanking).forEach((pid) => {
    worldRanking[pid] = { ...worldRanking[pid], history: [...(worldRanking[pid].history || [])] };
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
  });

  state.history = history;
  state.news = news;
  state.worldRanking = worldRanking;
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
   The client still sends the entire STATE object, same as before — but
   the server now splits it: unbounded arrays go into small per-season
   chunk documents (upserted per season, so a doc never re-grows past
   one season's worth of data), and everything else goes into the lean
   core document. */
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

    // Upsert one small doc per season. Each write fully replaces that
    // season's chunk (the client always sends the authoritative full
    // history), but never touches other seasons' documents — so this
    // stays cheap even at 20+ seasons.
    const seasonWrites = [];
    for (const [season, chunk] of chunksBySeason.entries()) {
      seasonWrites.push(
        SeasonChunk.findOneAndUpdate(
          { profileId, season },
          { $set: { history: chunk.history, news: chunk.news, wr: chunk.wr } },
          { upsert: true }
        )
      );
    }
    await Promise.all(seasonWrites);

    // Return the full reassembled state, same shape the client expects.
    const chunks = await SeasonChunk.find({ profileId }).lean();
    const fullState = reassembleState(doc.state, chunks);
    res.json({ profileId: doc.profileId, state: fullState, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('PUT /api/state error:', err);
    res.status(500).json({ error: 'Failed to save.' });
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
      );

    if (!looksUnmigrated) continue; // already lean -> already migrated

    const { core, chunksBySeason } = splitState(state);

    for (const [season, chunk] of chunksBySeason.entries()) {
      await SeasonChunk.findOneAndUpdate(
        { profileId: doc.profileId, season },
        { $set: { history: chunk.history, news: chunk.news, wr: chunk.wr } },
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
  });
}

start();
