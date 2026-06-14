import express from 'express';
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const dbPath = path.join(__dirname, 'esp32.db');

app.use(express.json());

const SQL = await initSqlJs({
  locateFile: (file) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file),
});

const db = fs.existsSync(dbPath)
  ? new SQL.Database(fs.readFileSync(dbPath))
  : new SQL.Database();

const saveDb = () => {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
};

db.run(`
  CREATE TABLE IF NOT EXISTS sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    sensor TEXT NOT NULL,
    value REAL,
    raw_data TEXT
  )
`);

const getLastInsertId = () => {
  const result = db.exec('SELECT last_insert_rowid() AS id');
  return result?.[0]?.values?.[0]?.[0] ?? null;
};

app.post('/api/data', (req, res) => {
  const { timestamp, sensor, value, raw_data } = req.body;

  if (!timestamp || !sensor) {
    return res.status(400).json({ error: 'timestamp and sensor are required' });
  }

  const stmt = db.prepare(
    'INSERT INTO sensor_data (timestamp, sensor, value, raw_data) VALUES (?, ?, ?, ?)'
  );
  stmt.run([timestamp, sensor, value ?? null, raw_data ?? null]);
  stmt.free();
  saveDb();

  res.status(201).json({ id: getLastInsertId() });
});

app.get('/api/data', (req, res) => {
  const stmt = db.prepare('SELECT * FROM sensor_data ORDER BY id DESC');
  const rows = [];

  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }

  stmt.free();
  res.json(rows);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
