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
   Three things in this game only ever grow, never shrink:
     1. STATE.history            (season archive)
     2. STATE.news               (news feed)
     3. worldRanking[id].history (every player's WR-points history)
   ...and now a fourth, since Strokes Gained was added to every event
   result:
     4. STATE.players[i].career.history (every player's full event log,
        each entry now carrying an {ott,app,arg,putt,total} SG snapshot)

   Stuffing all four into ONE Mongo document per profile is what pushed
   old saves toward (and eventually past) MongoDB's hard 16MB-per-document
   limit — and adding SG data to every entry only makes each one heavier.

   The fix is the same idea as before, just extended to cover #4: keep a
   small "core" document per profile (roster ratings, schedule, current
   standings, ryder cup state, etc. — things that don't grow without
   bound), and split all four unbounded pieces into ONE TINY DOCUMENT PER
   SEASON. A single season's worth of data stays small no matter how many
   seasons you rack up, because each season gets its own document instead
   of piling into one blob.

   SYNC SPEED: writes for a season now go through one bulkWrite() call
   instead of N separate findOneAndUpdate() round-trips (one per season
   touched). Reads use .lean() everywhere (skip Mongoose document
   hydration) and only fetch what's needed. Both core and chunk writes
   fire in parallel via Promise.all.

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
  { timestamps: true, minimize: false }
);
const Save = mongoose.model("Save", saveSchema);

/* ===== SEASON CHUNK (small, one per profile PER SEASON) =====
   Holds the four unbounded-growth pieces for a single season:
     history     -> STATE.history entries whose seasonNumber === season
     news        -> STATE.news entries whose season === season
     wr          -> { [playerId]: [worldRanking history entries] }
     careerHist  -> { [playerId]: [career.history / SG event entries] }
   season = 0 is used as a bucket for anything without a clean numeric
   season (e.g. the "seed"/preseason worldRanking entries). */
const seasonChunkSchema = new mongoose.Schema(
  {
    profileId: { type: String, required: true, index: true },
    season: { type: Number, required: true },
    history: { type: [mongoose.Schema.Types.Mixed], default: [] },
    news: { type: [mongoose.Schema.Types.Mixed], default: [] },
    wr: { type: mongoose.Schema.Types.Mixed, default: {} },
    careerHist: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false }
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
  const chunksBySeason = new Map(); // season -> {history:[], news:[], wr:{}, careerHist:{}}

  function getChunk(season) {
    if (!chunksBySeason.has(season)) {
      chunksBySeason.set(season, { history: [], news: [], wr: {}, careerHist: {} });
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

  // Players carry their own unbounded career.history (per-event results,
  // each now including a Strokes Gained snapshot). Strip it the same way.
  const players = Array.isArray(state.players) ? state.players : [];
  const corePlayers = players.map((p) => {
    const career = p.career || null;
    if (!career || !Array.isArray(career.history) || career.history.length === 0) {
      return p; // nothing to split for this player
    }
    career.history.forEach((entry) => {
      const season = seasonBucketOf(entry.season);
      const chunk = getChunk(season);
      if (!chunk.careerHist[p.id]) chunk.careerHist[p.id] = [];
      chunk.careerHist[p.id].push(entry);
    });
    return { ...p, career: { ...career, history: [] } };
  });

  const core = {
    ...state,
    history: [],
    news: [],
    worldRanking: coreWorldRanking,
    players: corePlayers,
  };
  return { core, chunksBySeason };
}

// Reassemble a full state blob for the frontend from the core doc + all
// of that profile's season chunks (sorted so history/news/career entries
// come back in season order, same as before).
function reassembleState(coreState, chunks) {
  const state = { ...coreState };
  const sorted = [...chunks].sort((a, b) => a.season - b.season);

  const history = [];
  const news = [];
  const worldRanking = { ...(state.worldRanking || {}) };
  Object.keys(worldRanking).forEach((pid) => {
    worldRanking[pid] = { ...worldRanking[pid], history: [...(worldRanking[pid].history || [])] };
  });

  // Prep a map of playerId -> career object so we can push career-history
  // entries back onto the matching player as we walk the chunks.
  const players = Array.isArray(state.players) ? state.players.map((p) => ({ ...p })) : [];
  const playerById = {};
  players.forEach((p) => {
    if (!p.career) p.career = { points: 0, earnings: 0, wins: 0, events: 0, seasons: 0, history: [] };
    else p.career = { ...p.career, history: [...(p.career.history || [])] };
    playerById[p.id] = p;
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
    const ch = chunk.careerHist || {};
    Object.keys(ch).forEach((pid) => {
      if (!playerById[pid]) return; // player was removed from roster since
      playerById[pid].career.history.push(...ch[pid]);
    });
  });

  state.history = history;
  state.news = news;
  state.worldRanking = worldRanking;
  state.players = players;
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
   version used to return. Both queries run in parallel, and .lean()
   skips Mongoose document hydration since we only need plain objects. */
app.get('/api/state/:profileId', async (req, res) => {
  try {
    const { profileId } = req.params;
    const [doc, chunks] = await Promise.all([
      Save.findOne({ profileId }).lean(),
      SeasonChunk.find({ profileId }).lean(),
    ]);
    if (!doc) return res.status(404).json({ error: 'No save found for this profile.' });

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
   the server now splits it: unbounded arrays/maps go into small
   per-season chunk documents, and everything else goes into the lean
   core document.

   SPEED: instead of firing one findOneAndUpdate per season touched, all
   season writes are batched into a single bulkWrite() call — one round
   trip to Mongo no matter how many seasons a save has accumulated. The
   core-doc upsert runs concurrently with that bulkWrite. */
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

    const bulkOps = [];
    for (const [season, chunk] of chunksBySeason.entries()) {
      bulkOps.push({
        updateOne: {
          filter: { profileId, season },
          update: { $set: { history: chunk.history, news: chunk.news, wr: chunk.wr, careerHist: chunk.careerHist } },
          upsert: true,
        },
      });
    }

    const [doc] = await Promise.all([
      Save.findOneAndUpdate(
        { profileId },
        { $set: { state: core } },
        { upsert: true, new: true }
      ),
      bulkOps.length ? SeasonChunk.bulkWrite(bulkOps, { ordered: false }) : Promise.resolve(),
    ]);

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
   full history/news/worldRanking-history/career-history — crammed into
   one Save.state blob. This walks every profile once, splits any
   old-format data into season chunks, and leaves already-migrated
   profiles untouched. Idempotent (checks before touching each profile),
   so it's safe to run on every deploy/restart — including on Render. */
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
      (Array.isArray(state.players) &&
        state.players.some(
          (p) => p.career && Array.isArray(p.career.history) && p.career.history.length > 0
        ));

    if (!looksUnmigrated) continue; // already lean -> already migrated

    const { core, chunksBySeason } = splitState(state);

    const bulkOps = [];
    for (const [season, chunk] of chunksBySeason.entries()) {
      bulkOps.push({
        updateOne: {
          filter: { profileId: doc.profileId, season },
          update: { $set: { history: chunk.history, news: chunk.news, wr: chunk.wr, careerHist: chunk.careerHist } },
          upsert: true,
        },
      });
    }
    if (bulkOps.length) await SeasonChunk.bulkWrite(bulkOps, { ordered: false });

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
      maxPoolSize: 10,
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
    console.log(`📊 Strokes Gained: tracked per event (OTT/APP/ARG/PUTT) and rolled up per season & career`);
    console.log(`🗂️  Storage: 1 core doc + 1 doc per season per profile, bulk-synced (no more 16MB blobs)`);
  });
}

start();
