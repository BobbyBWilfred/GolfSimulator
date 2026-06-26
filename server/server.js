
const path = require("path");
app.use(express.static(path.join(__dirname, "..")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"));
});
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/tee_sheet_tour';


const saveSchema = new mongoose.Schema(
  {
    profileId: { type: String, required: true, unique: true, index: true },
    state: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

const Save = mongoose.model('Save', saveSchema);

const app = express();
app.use(cors()); 
app.use(express.json({ limit: '5mb' })); 

/* ---------------------------------------------------------------- */
/* Routes                                                            */
/* ---------------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  const dbState = mongoose.connection.readyState; 
  res.json({ ok: true, db: dbState === 1 ? 'connected' : 'not connected' });
});

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

app.put('/api/state/:profileId', async (req, res) => {
  try {
    const { state } = req.body;
    if (!state || typeof state !== 'object') {
      return res.status(400).json({ error: 'Request body must include a "state" object.' });
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


app.delete('/api/state/:profileId', async (req, res) => {
  try {
    await Save.deleteOne({ profileId: req.params.profileId });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/state error:', err);
    res.status(500).json({ error: 'Failed to delete save.' });
  }
});

async function start() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log(`Connected to MongoDB at ${MONGODB_URI}`);
  } catch (err) {
    console.error('Could not connect to MongoDB:', err.message);
    console.error('Is MongoDB running? Check your MONGODB_URI in .env.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Tee Sheet Tour save server listening on http://localhost:${PORT}`);
    console.log(`API base for the client: http://localhost:${PORT}/api`);
  });
}

start();
