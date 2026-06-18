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

// Create tables for sensor data and actuator history
db.run(`
  CREATE TABLE IF NOT EXISTS sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    sensor TEXT NOT NULL,
    value REAL,
    raw_data TEXT
  )
`);

// Create separate table for actuator history for better querying
db.run(`
  CREATE TABLE IF NOT EXISTS actuator_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    hit_count INTEGER DEFAULT 0,
    state TEXT,
    running INTEGER DEFAULT 0,
    ir_sensor TEXT,
    stable INTEGER DEFAULT 0,
    raw_data TEXT
  )
`);

const getLastInsertId = () => {
  const result = db.exec('SELECT last_insert_rowid() AS id');
  return result?.[0]?.values?.[0]?.[0] ?? null;
};

// ----- MQTT subscriber to capture all messages -----
const BACKEND_MQTT_URL = process.env.MQTT_BROKER_URL || 'mqtt://172.20.10.2:1883';
const mqttClient = mqtt.connect(BACKEND_MQTT_URL);

// Track connection status
let mqttConnected = false;

mqttClient.on('connect', () => {
  console.log('✅ Backend MQTT connected to', BACKEND_MQTT_URL);
  mqttConnected = true;
  
  // Subscribe to all relevant topics
  const topics = [
    'group1/mp/status',
    'group1/mp/telemetry', 
    'group1/mp/actuator',
    'group1/mp/status/availability',
    'group1/mp/feed'
  ];
  
  mqttClient.subscribe(topics, (err) => {
    if (err) {
      console.warn('Failed to subscribe to topics:', err.message);
    } else {
      console.log('📡 Subscribed to topics:', topics.join(', '));
    }
  });
});

mqttClient.on('error', (err) => {
  console.error('❌ MQTT Error:', err.message);
  mqttConnected = false;
});

mqttClient.on('close', () => {
  console.log('🔌 MQTT connection closed');
  mqttConnected = false;
});

mqttClient.on('message', (topic, message) => {
  try {
    const msg = message.toString();
    const timestamp = new Date().toISOString();
    
    // Handle actuator messages specially
    if (topic === 'group1/mp/actuator' || topic.endsWith('/actuator')) {
      // Parse the actuator JSON
      let parsed = null;
      try {
        parsed = JSON.parse(msg);
      } catch (e) {
        // If not valid JSON, store as raw
      }
      
      // Save to sensor_data table
      const stmt = db.prepare('INSERT INTO sensor_data (timestamp, sensor, value, raw_data) VALUES (?, ?, ?, ?)');
      stmt.run([timestamp, 'actuator', null, msg]);
      stmt.free();
      
      // Save to actuator_history table with parsed fields
      if (parsed) {
        const hitCount = parsed.hitCount || 0;
        const state = parsed.state || 'IDLE';
        const running = parsed.running ? 1 : 0;
        const irSensor = parsed.ir_sensor || 'HIGH';
        const stable = parsed.stable ? 1 : 0;
        
        const stmt2 = db.prepare(`
          INSERT INTO actuator_history 
          (timestamp, hit_count, state, running, ir_sensor, stable, raw_data) 
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt2.run([timestamp, hitCount, state, running, irSensor, stable, msg]);
        stmt2.free();
      }
      
      saveDb();
      console.log('💾 Saved actuator data:', parsed ? parsed.state : 'raw');
    }
    // Handle status messages
    else if (topic === 'group1/mp/status' || topic.endsWith('/status')) {
      const stmt = db.prepare('INSERT INTO sensor_data (timestamp, sensor, value, raw_data) VALUES (?, ?, ?, ?)');
      stmt.run([timestamp, 'status', null, msg]);
      stmt.free();
      saveDb();
      console.log('💾 Saved status data');
    }
    // Handle telemetry messages
    else if (topic === 'group1/mp/telemetry' || topic.endsWith('/telemetry')) {
      const stmt = db.prepare('INSERT INTO sensor_data (timestamp, sensor, value, raw_data) VALUES (?, ?, ?, ?)');
      stmt.run([timestamp, 'telemetry', null, msg]);
      stmt.free();
      saveDb();
      console.log('💾 Saved telemetry data');
    }
    // Handle availability messages
    else if (topic === 'group1/mp/status/availability') {
      const stmt = db.prepare('INSERT INTO sensor_data (timestamp, sensor, value, raw_data) VALUES (?, ?, ?, ?)');
      stmt.run([timestamp, 'availability', msg === 'online' ? 1 : 0, msg]);
      stmt.free();
      saveDb();
      console.log('💾 Saved availability:', msg);
    }
    
  } catch (e) {
    console.error('❌ Error handling MQTT message:', e.message);
  }
});

// ----- API ROUTES -----

// POST /api/data - Save sensor data
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

// GET /api/data - Get sensor data history
app.get('/api/data', (req, res) => {
  const sensor = req.query.sensor;
  const limit = parseInt(req.query.limit, 10) || 100;
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';

  let sql = 'SELECT * FROM sensor_data';
  const params = [];

  if (sensor) {
    sql += ' WHERE sensor = ?';
    params.push(sensor);
  }

  sql += ` ORDER BY id ${order} LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];

  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }

  stmt.free();
  res.json(rows);
});

// GET /api/actuator - Get latest actuator status
app.get('/api/actuator', (req, res) => {
  // First try to get from actuator_history table
  let stmt = db.prepare("SELECT * FROM actuator_history ORDER BY id DESC LIMIT 1");
  let rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  
  if (rows.length > 0) {
    const row = rows[0];
    let parsed = null;
    try {
      parsed = JSON.parse(row.raw_data);
    } catch (e) {
      parsed = null;
    }
    return res.json({ 
      ...row, 
      parsed: parsed || {
        hitCount: row.hit_count,
        state: row.state,
        running: row.running === 1,
        ir_sensor: row.ir_sensor,
        stable: row.stable === 1
      }
    });
  }
  
  // Fallback to sensor_data table
  stmt = db.prepare("SELECT * FROM sensor_data WHERE sensor='actuator' ORDER BY id DESC LIMIT 1");
  rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  
  if (rows.length === 0) {
    return res.status(404).json({ error: 'No actuator records' });
  }
  
  const row = rows[0];
  let parsed = null;
  try {
    parsed = JSON.parse(row.raw_data);
  } catch (e) {
    parsed = null;
  }
  res.json({ ...row, parsed });
});

// GET /api/actuator/history - Get actuator history
app.get('/api/actuator/history', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const stmt = db.prepare(`SELECT * FROM actuator_history ORDER BY id DESC LIMIT ?`);
  stmt.bind([limit]);
  const rows = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    // Parse raw_data if available
    try {
      row.parsed = JSON.parse(row.raw_data);
    } catch (e) {
      row.parsed = null;
    }
    rows.push(row);
  }
  stmt.free();
  res.json(rows);
});

// GET /api/status - Get latest status
app.get('/api/status', (req, res) => {
  const stmt = db.prepare("SELECT * FROM sensor_data WHERE sensor='status' ORDER BY id DESC LIMIT 1");
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  
  if (rows.length === 0) {
    return res.status(404).json({ error: 'No status records' });
  }
  
  const row = rows[0];
  let parsed = null;
  try {
    parsed = JSON.parse(row.raw_data);
  } catch (e) {
    parsed = null;
  }
  res.json({ ...row, parsed });
});

// GET /api/telemetry - Get latest telemetry
app.get('/api/telemetry', (req, res) => {
  const stmt = db.prepare("SELECT * FROM sensor_data WHERE sensor='telemetry' ORDER BY id DESC LIMIT 1");
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  
  if (rows.length === 0) {
    return res.status(404).json({ error: 'No telemetry records' });
  }
  
  const row = rows[0];
  let parsed = null;
  try {
    parsed = JSON.parse(row.raw_data);
  } catch (e) {
    parsed = null;
  }
  res.json({ ...row, parsed });
});

// GET /api/availability - Get latest availability
app.get('/api/availability', (req, res) => {
  const stmt = db.prepare("SELECT * FROM sensor_data WHERE sensor='availability' ORDER BY id DESC LIMIT 1");
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  
  if (rows.length === 0) {
    return res.status(404).json({ error: 'No availability records' });
  }
  res.json(rows[0]);
});

// GET /api/mqtt/status - Get MQTT connection status
app.get('/api/mqtt/status', (req, res) => {
  res.json({ 
    connected: mqttConnected,
    broker: BACKEND_MQTT_URL
  });
});

// GET /api/stats - Get database statistics
app.get('/api/stats', (req, res) => {
  let stmt = db.prepare("SELECT COUNT(*) as count FROM sensor_data");
  let rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  const totalRecords = rows[0]?.count || 0;
  
  stmt = db.prepare("SELECT sensor, COUNT(*) as count FROM sensor_data GROUP BY sensor");
  rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  
  stmt = db.prepare("SELECT COUNT(*) as count FROM actuator_history");
  rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  const actuatorRecords = rows[0]?.count || 0;
  
  res.json({
    totalRecords,
    actuatorRecords,
    sensors: rows
  });
});

// DELETE /api/data - Clear data (optional, for testing)
app.delete('/api/data', (req, res) => {
  const { sensor } = req.query;
  let sql = 'DELETE FROM sensor_data';
  const params = [];
  if (sensor) {
    sql += ' WHERE sensor = ?';
    params.push(sensor);
  }
  const stmt = db.prepare(sql);
  stmt.run(params);
  stmt.free();
  saveDb();
  res.json({ message: 'Data cleared', sensor: sensor || 'all' });
});

// DELETE /api/actuator/history - Clear actuator history
app.delete('/api/actuator/history', (req, res) => {
  const stmt = db.prepare('DELETE FROM actuator_history');
  stmt.run();
  stmt.free();
  saveDb();
  res.json({ message: 'Actuator history cleared' });
});

const PORT = process.env.PORT || 3005;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`🚀 Backend running on http://${HOST}:${PORT}`);
  console.log(`📊 Database: ${dbPath}`);
  console.log(`📡 MQTT Broker: ${BACKEND_MQTT_URL}`);
  console.log('\n📋 API Endpoints:');
  console.log(`  POST /api/data - Save sensor data`);
  console.log(`  GET  /api/data?limit=60&sensor=telemetry - Get history`);
  console.log(`  GET  /api/actuator - Get latest actuator status`);
  console.log(`  GET  /api/actuator/history - Get actuator history`);
  console.log(`  GET  /api/status - Get latest status`);
  console.log(`  GET  /api/telemetry - Get latest telemetry`);
  console.log(`  GET  /api/availability - Get latest availability`);
  console.log(`  GET  /api/mqtt/status - Get MQTT connection status`);
  console.log(`  GET  /api/stats - Get database statistics`);
  console.log(`  DELETE /api/data? sensor=actuator - Clear data`);
  console.log(`  DELETE /api/actuator/history - Clear actuator history`);
});

