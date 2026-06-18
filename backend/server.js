import express from 'express';
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mqtt from 'mqtt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const dbPath = path.join(__dirname, 'esp32.db');

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

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

// ----- MQTT subscriber to capture actuator messages (falls back to local broker)
const BACKEND_MQTT_URL = process.env.MQTT_BROKER_URL || 'mqtt://172.20.10.2:1883';
const mqttClient = mqtt.connect(BACKEND_MQTT_URL);

mqttClient.on('connect', () => {
  console.log('Backend MQTT connected to', BACKEND_MQTT_URL);
  mqttClient.subscribe('group1/mp/actuator', (err) => {
    if (err) console.warn('Failed to subscribe to actuator topic:', err.message);
  });
});

mqttClient.on('message', (topic, message) => {
  try {
    const msg = message.toString();
    if (topic === 'group1/mp/actuator' || topic.endsWith('/actuator')) {
      const timestamp = new Date().toISOString();
      const stmt = db.prepare('INSERT INTO sensor_data (timestamp, sensor, value, raw_data) VALUES (?, ?, ?, ?)');
      stmt.run([timestamp, 'actuator', null, msg]);
      stmt.free();
      saveDb();
      console.log('Saved actuator message to DB:', msg);
    }
  } catch (e) {
    console.error('Error handling MQTT message', e.message);
  }
});

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
  const sensor = req.query.sensor
  const limit = parseInt(req.query.limit, 10) || 100
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC'

  let sql = 'SELECT * FROM sensor_data'
  const params = []

  if (sensor) {
    sql += ' WHERE sensor = ?'
    params.push(sensor)
  }

  sql += ` ORDER BY id ${order} LIMIT ?`
  params.push(limit)

  const stmt = db.prepare(sql)
  stmt.bind(params)
  const rows = []

  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }

  stmt.free()
  // If actuator records, attempt to parse raw_data JSON for convenience
  if (sensor === 'actuator') {
    const enhanced = rows.map((r) => {
      let parsed = null
      try {
        parsed = JSON.parse(r.raw_data)
      } catch (e) {
        parsed = null
      }
      return {
        ...r,
        parsed,
        ir_sensor: parsed?.ir_sensor ?? null,
        hitCount: parsed?.hitCount ?? null,
        running: parsed?.running ?? null,
        state: parsed?.state ?? null,
      }
    })
    return res.json(enhanced)
  }

  res.json(rows)
});

// Return recent IR-specific readings (parsed actuator messages)
app.get('/api/ir', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC'
  const stmt = db.prepare("SELECT * FROM sensor_data WHERE sensor='actuator' ORDER BY id " + order + " LIMIT ?")
  stmt.bind([limit])
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()

  const parsed = rows.map((r) => {
    let p = null
    try { p = JSON.parse(r.raw_data) } catch {}
    return {
      id: r.id,
      timestamp: r.timestamp,
      raw_data: r.raw_data,
      ir_sensor: p?.ir_sensor ?? null,
      hitCount: p?.hitCount ?? null,
      running: p?.running ?? null,
      state: p?.state ?? null,
      stable: p?.stable ?? null,
      parsed: p,
    }
  })

  res.json(parsed)
})

// Return last actuator message
app.get('/api/actuator', (req, res) => {
  const stmt = db.prepare("SELECT * FROM sensor_data WHERE sensor='actuator' ORDER BY id DESC LIMIT 1");
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  if (rows.length === 0) return res.status(404).json({ error: 'No actuator records' });
  const row = rows[0];
  // attempt to parse raw_data as JSON
  let parsed = null;
  try {
    parsed = JSON.parse(row.raw_data);
  } catch (e) {
    parsed = null;
  }
  res.json({ ...row, parsed });
});

const PORT = process.env.PORT || 5376;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Backend running on http://${HOST}:${PORT}`);
});
