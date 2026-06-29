require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve the frontend files from the repository root
app.use(express.static(path.join(__dirname, "..")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"));
});

const PORT = process.env.PORT || 4000;
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/tee_sheet_tour";

/* ===== MONGOOSE SCHEMA =====
   One document per browser profile.
   "state" stores the entire game state JSON blob.
   updatedAt is auto-managed by Mongoose timestamps.
   ================================================ */
const saveSchema = new mongoose.Schema(
  {
    profileId: { type: String, required: true, unique: true, index: true },
    state: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

const Save = mongoose.model("Save", saveSchema);

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
   Returns the full game state for this profile, or 404 if none exists yet. */
app.get('/api/state/:profileId', async (req, res) => {
  try {
    const doc = await Save.findOne({ profileId: req.params.profileId }).lean();
    if (!doc) return res.status(404).json({ error: 'No save found for this profile.' });
    res.json({ profileId: doc.profileId, state: doc.state, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('GET /api/state error:', err);
    res.status(500).json({ error: 'Failed to load save.' });
  }
});

/* ===== SAVE STATE =====
   PUT /api/state/:profileId
   Upserts the full game state. The client sends the entire STATE object.
   We also migrate old saves that still have the legacy "fantasy" field. */
app.put('/api/state/:profileId', async (req, res) => {
  try {
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

    const doc = await Save.findOneAndUpdate(
      { profileId: req.params.profileId },
      { $set: { state } },
      { upsert: true, new: true }
    );
    res.json({ profileId: doc.profileId, state: doc.state, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('PUT /api/state error:', err);
    res.status(500).json({ error: 'Failed to save.' });
  }
});

/* ===== DELETE SAVE =====
   DELETE /api/state/:profileId
   Wipes the save for this profile (used by "Restart Tour"). */
app.delete('/api/state/:profileId', async (req, res) => {
  try {
    await Save.deleteOne({ profileId: req.params.profileId });
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

/* ===== STARTUP ===== */
async function start() {
  try {
    await mongoose.connect(MONGODB_URI, {
      // Recommended options for newer Mongoose versions
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`✅ Connected to MongoDB at ${MONGODB_URI}`);
  } catch (err) {
    console.error('❌ Could not connect to MongoDB:', err.message);
    console.error('Is MongoDB running? Check your MONGODB_URI in .env.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`🏌️  Tee Sheet Tour save server running on http://localhost:${PORT}`);
    console.log(`📡 API base: http://localhost:${PORT}/api`);
    console.log(`🏆 Ryder Cup mode: USA vs Europe (auto every odd season)`);
  });
}

start();
