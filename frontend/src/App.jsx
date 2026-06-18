import { useEffect, useRef, useState, useCallback } from 'react'
import mqtt from 'mqtt'
import RosarioPage from './RosarioPage'
import TolinPage from './TolinPage'
import './App.css'
import './Pagestyle.css'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from 'recharts'

const MQTT_URL = import.meta.env.VITE_MQTT_URL?.trim() || 'wss://broker.emqx.io:8084/mqtt'
const MQTT_BASE_TOPIC = import.meta.env.VITE_MQTT_BASE_TOPIC?.trim().replace(/\/+$/, '') || 'group1/mp'

function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-'
  return Number(value).toFixed(digits)
}

function topic(suffix) {
  return `${MQTT_BASE_TOPIC}/${suffix}`
}

function StatusDot({ status }) {
  const colors = {
    good: '#22c55e',
    warning: '#f59e0b',
    neutral: '#6b7280',
    error: '#ef4444',
  }
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: colors[status] || colors.neutral,
        marginRight: 6,
        boxShadow: status === 'good' ? `0 0 6px ${colors.good}` : 'none',
      }}
    />
  )
}

function HistoryChart({ data, dataKey, label, unit, color, threshold }) {
  if (!data || data.length === 0) {
    return (
      <div className="chart-empty">
        <span>No history data yet</span>
      </div>
    )
  }
  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={data} margin={{ top: 6, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis
          dataKey="time"
          tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        {threshold !== undefined && (
          <ReferenceLine
            y={threshold}
            stroke="rgba(251,191,36,0.5)"
            strokeDasharray="4 4"
            label={{ value: 'threshold', fill: 'rgba(251,191,36,0.5)', fontSize: 9, position: 'insideTopRight' }}
          />
        )}
        <Tooltip
          contentStyle={{
            background: '#0f1923',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            fontSize: 12,
            color: '#e2e8f0',
          }}
          formatter={(v) => [`${formatNumber(v, 2)} ${unit || ''}`, label]}
          labelStyle={{ color: 'rgba(255,255,255,0.5)' }}
        />
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          activeDot={{ r: 3, fill: color }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

function ControlButton({ label, icon, onClick, disabled, variant = 'default', active = false }) {
  const variants = {
    default: 'ctrl-btn',
    danger: 'ctrl-btn ctrl-btn--danger',
    success: 'ctrl-btn ctrl-btn--success',
    warning: 'ctrl-btn ctrl-btn--warning',
  }
  return (
    <button
      className={`${variants[variant]} ${active ? 'ctrl-btn--active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      <span className="ctrl-btn__icon">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

const CHART_COLORS = {
  tds: '#38bdf8',
  ph: '#a78bfa',
  turbidity: '#fb923c',
  water: '#34d399',
  ammonia: '#f472b6',
  temperature: '#fbbf24',
}

export default function App() {
  const clientRef = useRef(null)
  const [brokerStatus, setBrokerStatus] = useState('connecting')
  const [esp32Status, setEsp32Status] = useState('unknown')
  const [status, setStatus] = useState(null)
  const [telemetry, setTelemetry] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [backendStatus, setBackendStatus] = useState('idle')
  const [backendError, setBackendError] = useState('')
  const [backendLastSync, setBackendLastSync] = useState(null)
  const [backendSyncCount, setBackendSyncCount] = useState(0)
  const [feedState, setFeedState] = useState('idle')
  const [actuatorState, setActuatorState] = useState('idle')
  const [actuatorStatus, setActuatorStatus] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [activePage, setActivePage] = useState('dashboard')
  const [historyData, setHistoryData] = useState({})
  const [historyLoading, setHistoryLoading] = useState(false)
  const [activeChart, setActiveChart] = useState('tds')
  const [pumpOverrides, setPumpOverrides] = useState({})
  const [irSensorState, setIrSensorState] = useState('HIGH')
  const [actuatorRunning, setActuatorRunning] = useState(false)
  const [actuatorCycleState, setActuatorCycleState] = useState('IDLE')
  const [actuatorHistory, setActuatorHistory] = useState([])

  // ── Fetch history from SQLite backend ──
  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await fetch('/api/data?limit=60&sensor=telemetry')
      if (!res.ok) throw new Error('History fetch failed')
      const rows = await res.json()

      const parsed = (rows || []).map((row) => {
        let raw = {}
        try { raw = JSON.parse(row.raw_data) } catch {}
        return {
          time: new Date(row.timestamp).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }),
          tds: raw.tds?.value ?? raw.tds ?? null,
          ph: raw.ph?.value ?? raw.ph ?? null,
          turbidity: raw.turbidity?.ntu ?? raw.turbidity ?? null,
          water: raw.waterLevel?.percentage ?? raw.water ?? null,
          ammonia: raw.ammonia?.ppm ?? raw.ammonia ?? null,
          temperature: raw.temperature ?? null,
        }
      }).reverse()

      const grouped = {}
      for (const key of ['tds', 'ph', 'turbidity', 'water', 'ammonia', 'temperature']) {
        grouped[key] = parsed.filter((r) => r[key] !== null)
      }
      setHistoryData(grouped)
    } catch (e) {
      console.warn('History fetch error:', e.message)
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  // ── Fetch actuator / IR history from backend ──
  const fetchActuatorHistory = useCallback(async (limit = 60) => {
    try {
      const res = await fetch(`/api/ir?limit=${limit}`)
      if (!res.ok) throw new Error('Actuator history fetch failed')
      const rows = await res.json()

      const parsed = (rows || []).map((row) => {
        let p = row.parsed ?? null
        if (!p) {
          try { p = JSON.parse(row.raw_data) } catch { p = row }
        }
        const hit = p?.hitCount ?? row.hitCount ?? null
        const running = (p?.running ?? row.running) ? 1 : 0
        const ir = p?.ir_sensor ?? row.ir_sensor ?? null
        return {
          time: new Date(row.timestamp).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }),
          hitCount: hit,
          running,
          ir_state: ir,
          raw: p,
        }
      }).reverse()

      setActuatorHistory(parsed.filter((item) => item.hitCount !== null))
    } catch (e) {
      console.warn('Actuator history fetch error:', e?.message || e)
    }
  }, [])

  // ── MQTT setup ──
  useEffect(() => {
    fetchHistory()
    fetchActuatorHistory()
    const historyInterval = setInterval(() => {
      fetchHistory()
      fetchActuatorHistory()
    }, 30_000)

    ;(async () => {
      try {
        const res = await fetch('/api/ir?limit=1')
        if (res.ok) {
          const rows = await res.json()
          const data = Array.isArray(rows) ? rows[0] : rows
          if (data) {
            const parsed = data.parsed ?? data
            setActuatorStatus(parsed)
            setActuatorState(parsed.running ? 'running' : 'idle')
            setActuatorRunning(parsed.running || false)
            setActuatorCycleState(parsed.state || 'IDLE')
            setIrSensorState(parsed.ir_sensor || 'HIGH')
            setLastUpdated(new Date(data.timestamp || Date.now()))
          }
        }
      } catch (e) {
        console.warn('Failed to fetch initial actuator/IR:', e.message)
      }
    })()

    const client = mqtt.connect(MQTT_URL, {
      clean: true,
      connectTimeout: 5000,
      clientId: `group1-mp-web-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 3000,
    })
    clientRef.current = client

    const subscriptions = [
      topic('status'), 
      topic('telemetry'), 
      topic('status/availability'), 
      topic('actuator')
    ]

    const handleConnect = () => { 
      setBrokerStatus('connected'); 
      setError(''); 
      client.subscribe(subscriptions) 
    }
    const handleReconnect = () => setBrokerStatus('connecting')
    const handleClose = () => setBrokerStatus('disconnected')
    const handleError = (e) => { 
      setBrokerStatus('error'); 
      setError(e?.message || 'MQTT connection failed') 
    }

    const handleMessage = async (incomingTopic, payload) => {
      const message = payload.toString()
      if (incomingTopic === topic('status')) {
        try {
          const data = JSON.parse(message)
          setStatus(data)
          setEsp32Status(data.wifiConnected ? 'online' : 'offline')
          setLastUpdated(new Date())
          setError('')
          await postToBackend({ 
            timestamp: data.timestamp ?? new Date().toISOString(), 
            sensor: 'status', 
            value: null, 
            raw_data: JSON.stringify(data) 
          })
        } catch { 
          setError('Received malformed MQTT status payload.') 
        }
        return
      }
      if (incomingTopic === topic('telemetry')) {
        try {
          const data = JSON.parse(message)
          setTelemetry(data)
          setLastUpdated(new Date())
          await postToBackend({ 
            timestamp: data.timestamp ?? new Date().toISOString(), 
            sensor: 'telemetry', 
            value: null, 
            raw_data: JSON.stringify(data) 
          })
        } catch { 
          setError('Received malformed MQTT telemetry payload.') 
        }
        return
      }
      if (incomingTopic === topic('status/availability')) {
        setEsp32Status(message === 'online' ? 'online' : 'offline')
        setLastUpdated(new Date())
        return
      }
      if (incomingTopic === topic('actuator')) {
        try {
          const data = JSON.parse(message)
          setActuatorStatus(data)
          setActuatorState(data.running ? 'running' : 'idle')
          setActuatorRunning(data.running || false)
          setActuatorCycleState(data.state || 'IDLE')
          setIrSensorState(data.ir_sensor || 'HIGH')
          setLastUpdated(new Date())
        } catch { 
          setActuatorStatus({ raw: message }) 
        }
        return
      }
    }

    client.on('connect', handleConnect)
    client.on('reconnect', handleReconnect)
    client.on('close', handleClose)
    client.on('error', handleError)
    client.on('message', handleMessage)

    return () => {
      clearInterval(historyInterval)
      client.removeListener('connect', handleConnect)
      client.removeListener('reconnect', handleReconnect)
      client.removeListener('close', handleClose)
      client.removeListener('error', handleError)
      client.removeListener('message', handleMessage)
      client.end(true)
      clientRef.current = null
    }
  }, [fetchHistory, fetchActuatorHistory])

  useEffect(() => {
    if (status || telemetry) { 
      setLoading(false); 
      return 
    }
    setLoading(brokerStatus === 'connecting')
  }, [brokerStatus, status, telemetry])

  const postToBackend = async (payload) => {
    setBackendStatus('saving')
    setBackendError('')
    try {
      const response = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}))
        throw new Error(errorBody.error || 'Failed to save backend data')
      }
      setBackendSyncCount((c) => c + 1)
      setBackendLastSync(new Date())
      setBackendStatus('synced')
    } catch (saveError) {
      setBackendStatus('error')
      setBackendError(saveError.message)
    }
  }

  const publishCommand = (topicSuffix, payload, onSuccess, onError) => {
    const client = clientRef.current
    if (!client || brokerStatus !== 'connected') {
      setError('MQTT broker is not connected.')
      return
    }
    client.publish(topic(topicSuffix), payload, { qos: 1, retain: false }, (err) => {
      if (err) { 
        onError?.(err); 
        setError(err.message) 
      } else { 
        onSuccess?.(); 
        setError('') 
      }
    })
  }

  const handleFeedNow = () => {
    setFeedState('sending')
    publishCommand('feed', '1',
      () => { 
        setFeedState('queued'); 
        window.setTimeout(() => setFeedState('idle'), 2000) 
      },
      () => { 
        setFeedState('error'); 
        window.setTimeout(() => setFeedState('idle'), 2000) 
      }
    )
  }

  const handleActuatorNow = () => {
    setActuatorState('sending')
    publishCommand('actuator', '1',
      () => {
        setActuatorState('queued')
        window.setTimeout(() => setActuatorState('idle'), 2000)
      },
      () => {
        setActuatorState('error')
        window.setTimeout(() => setActuatorState('idle'), 2000)
      }
    )
  }

  const handlePumpToggle = (pumpKey, currentState) => {
    const newState = currentState ? '0' : '1'
    publishCommand(`pump/${pumpKey}`, newState, () => {
      setPumpOverrides((prev) => ({ ...prev, [pumpKey]: !currentState }))
    })
  }

  const reconnectBroker = () => clientRef.current?.reconnect()

  const src = status || telemetry || {}

  const statusTone = brokerStatus === 'connected'
    ? esp32Status === 'online' ? 'good' : 'warning'
    : brokerStatus === 'connecting' ? 'warning' : 'neutral'

  const connectionLabel = brokerStatus === 'connected'
    ? esp32Status === 'online'
      ? `ESP32 online${status?.ip ? ` · ${status.ip}` : ''}`
      : 'Broker connected · awaiting ESP32'
    : brokerStatus === 'connecting' ? 'Connecting…'
    : brokerStatus === 'error' ? 'Connection error'
    : 'Disconnected'

  const metrics = [
    {
      key: 'tds',
      label: 'TDS',
      value: formatNumber(src?.tds?.value ?? telemetry?.tds, 0),
      unit: 'ppm',
      sub: `Threshold ${src?.tds?.threshold ?? '-'} ppm`,
      pumpActive: pumpOverrides.tds ?? src?.tds?.pumpActive,
      pumpKey: 'tds',
      chartKey: 'tds',
      threshold: src?.tds?.threshold,
    },
    {
      key: 'ph',
      label: 'pH',
      value: formatNumber(src?.ph?.value ?? telemetry?.ph, 2),
      unit: '',
      sub: `Threshold ${formatNumber(src?.ph?.threshold, 2)}`,
      pumpActive: pumpOverrides.ph ?? src?.ph?.pumpActive,
      pumpKey: 'ph',
      chartKey: 'ph',
      threshold: src?.ph?.threshold,
    },
    {
      key: 'turbidity',
      label: 'Turbidity',
      value: formatNumber(src?.turbidity?.ntu ?? telemetry?.turbidity, 1),
      unit: 'NTU',
      sub: `ADC ${src?.turbidity?.adc ?? '-'}`,
      pumpActive: pumpOverrides.turbidity ?? src?.turbidity?.pumpActive,
      pumpKey: 'turbidity',
      chartKey: 'turbidity',
    },
    {
      key: 'water',
      label: 'Water level',
      value: formatNumber(src?.waterLevel?.percentage ?? telemetry?.water, 1),
      unit: '%',
      sub: `${formatNumber(src?.waterLevel?.heightMm, 1)} mm`,
      valveOpen: pumpOverrides.water ?? src?.waterLevel?.valveOpen,
      pumpKey: 'water',
      chartKey: 'water',
    },
    {
      key: 'ammonia',
      label: 'Ammonia',
      value: formatNumber(src?.ammonia?.ppm ?? telemetry?.ammonia, 2),
      unit: 'ppm',
      sub: `Threshold ${formatNumber(src?.ammonia?.threshold, 2)} ppm`,
      pumpActive: pumpOverrides.ammonia ?? src?.ammonia?.pumpActive,
      pumpKey: 'ammonia',
      chartKey: 'ammonia',
      threshold: src?.ammonia?.threshold,
    },
    {
      key: 'feeder',
      label: 'Feeder',
      value: src?.feeder?.ldrValue ?? telemetry?.ldr ?? '-',
      unit: 'ADC',
      sub: src?.feeder?.isDark ? 'Dark detected' : 'Light detected',
      chartKey: null,
    },
  ]

  const chartTabs = [
    { key: 'tds', label: 'TDS' },
    { key: 'ph', label: 'pH' },
    { key: 'turbidity', label: 'Turbidity' },
    { key: 'water', label: 'Water' },
    { key: 'ammonia', label: 'Ammonia' },
  ]

  const chartMeta = {
    tds: { label: 'TDS', unit: 'ppm', threshold: src?.tds?.threshold },
    ph: { label: 'pH', unit: '', threshold: src?.ph?.threshold },
    turbidity: { label: 'Turbidity', unit: 'NTU' },
    water: { label: 'Water level', unit: '%' },
    ammonia: { label: 'Ammonia', unit: 'ppm', threshold: src?.ammonia?.threshold },
  }

  if (activePage === 'rosario') {
    return (
      <RosarioPage
        sourceStatus={src}
        telemetry={telemetry}
        brokerStatus={brokerStatus}
        esp32Status={esp32Status}
        lastUpdated={lastUpdated}
        feedState={feedState}
        onFeedNow={handleFeedNow}
      />
    )
  }

  if (activePage === 'tolin') {
    return (
      <TolinPage
        sourceStatus={src}
        telemetry={telemetry}
        brokerStatus={brokerStatus}
        esp32Status={esp32Status}
        lastUpdated={lastUpdated}
        feedState={feedState}
        onFeedNow={handleFeedNow}
      />
    )
  }

  return (
    <div className="aq-app">
      {/* ── Nav ── */}
      <nav className="aq-nav">
        <div className="aq-nav__brand">
          <span className="aq-nav__brand-icon">◈</span>
          AquaControl
        </div>
        <div className="aq-nav__links">
          {[{ id: 'dashboard', label: 'Dashboard' }].map((l) => (
            <button
              key={l.id}
              className={`aq-nav__link ${activePage === l.id ? 'aq-nav__link--active' : ''}`}
              onClick={() => setActivePage(l.id)}
              type="button"
            >
              {l.label}
            </button>
          ))}
        </div>
        <div className="aq-nav__status">
          <StatusDot status={statusTone} />
          <span className="aq-nav__status-label">{connectionLabel}</span>
          {lastUpdated && (
            <span className="aq-nav__status-time">
              {lastUpdated.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
      </nav>

      <main className="aq-main">
        {/* ── Hero ── */}
        <header className="aq-hero">
          <div className="aq-hero__text">
            <p className="aq-hero__eyebrow">ESP32 · MQTT · Live</p>
            <h1 className="aq-hero__title">
              Water Quality &amp; Habitat<br />Control
            </h1>
            <p className="aq-hero__sub">
              Real-time monitoring for crayfish &amp; guppy fish.
              Sensor data from TDS, pH, turbidity, ammonia, and water level sensors.
            </p>
          </div>
          <div className="aq-hero__controls">
            <div className="aq-status-card">
              <div className="aq-status-card__row">
                <StatusDot status={statusTone} />
                <span>{connectionLabel}</span>
              </div>
              {status?.ip && <div className="aq-status-card__meta">{status.ip}</div>}
              <div className="aq-status-card__meta">
                {lastUpdated
                  ? `Updated ${lastUpdated.toLocaleTimeString()}`
                  : 'Waiting for first reading…'}
              </div>
              <div className="aq-status-card__sync">
                <span>{backendError ? '⚠ Sync failed' : backendSyncCount > 0 ? `✓ ${backendSyncCount} synced` : 'Idle'}</span>
                {backendLastSync && <span>{backendLastSync.toLocaleTimeString()}</span>}
              </div>
            </div>
          </div>
        </header>

        {error && <div className="aq-alert">{error}</div>}

        {/* ── Output controls ── */}
        <section className="aq-section">
          <div className="aq-section__header">
            <h2 className="aq-section__title">Output controls</h2>
            <span className="aq-section__hint">Send commands to the ESP32 via MQTT</span>
          </div>
          <div className="aq-controls-grid">
            {/* Feed */}
            <div className="aq-control-group">
              <div className="aq-control-group__label">Feeder</div>
              <ControlButton
                label={feedState === 'sending' ? 'Queuing…' : feedState === 'queued' ? 'Queued ✓' : 'Feed now'}
                icon="🐟"
                onClick={handleFeedNow}
                disabled={brokerStatus !== 'connected' || feedState === 'sending'}
                variant="success"
                active={feedState === 'queued'}
              />
            </div>

            {/* Actuator */}
            <div className="aq-control-group">
              <div className="aq-control-group__label">Linear Actuator</div>
              <ControlButton
                label={actuatorState === 'sending' ? 'Sending…' : 
                       actuatorState === 'queued' ? 'Triggered ✓' : 
                       actuatorRunning ? 'Running' : 
                       actuatorCycleState === 'EXTENDING' ? 'Extending' :
                       actuatorCycleState === 'RETRACTING' ? 'Retracting' :
                       'Trigger Actuator'}
                icon="⚙️"
                onClick={handleActuatorNow}
                disabled={brokerStatus !== 'connected' || actuatorState === 'sending' || actuatorRunning}
                variant={actuatorRunning ? 'warning' : 'default'}
                active={actuatorRunning || actuatorState === 'queued'}
              />
              {actuatorStatus?.hitCount !== undefined && (
                <span className="aq-control-group__meta">Hits: {actuatorStatus.hitCount}</span>
              )}
              {actuatorStatus?.state && (
                <span className="aq-control-group__meta" style={{ fontSize: '10px' }}>
                  State: {actuatorStatus.state}
                </span>
              )}
              {irSensorState && (
                <span className="aq-control-group__meta" style={{ fontSize: '10px' }}>
                  IR: {irSensorState === 'LOW' ? '🔴 Object Detected' : '🟢 Clear'}
                </span>
              )}
            </div>

            {/* TDS pump */}
            <div className="aq-control-group">
              <div className="aq-control-group__label">TDS pump</div>
              <ControlButton
                label={(pumpOverrides.tds ?? src?.tds?.pumpActive) ? 'Pump ON' : 'Pump OFF'}
                icon="💧"
                onClick={() => handlePumpToggle('tds', pumpOverrides.tds ?? src?.tds?.pumpActive)}
                disabled={brokerStatus !== 'connected'}
                variant={(pumpOverrides.tds ?? src?.tds?.pumpActive) ? 'warning' : 'default'}
                active={pumpOverrides.tds ?? src?.tds?.pumpActive}
              />
            </div>

            {/* pH acid pump */}
            <div className="aq-control-group">
              <div className="aq-control-group__label">pH acid pump</div>
              <ControlButton
                label={(pumpOverrides.ph ?? src?.ph?.pumpActive) ? 'Acid pump ON' : 'Acid pump OFF'}
                icon="🧪"
                onClick={() => handlePumpToggle('ph', pumpOverrides.ph ?? src?.ph?.pumpActive)}
                disabled={brokerStatus !== 'connected'}
                variant={(pumpOverrides.ph ?? src?.ph?.pumpActive) ? 'danger' : 'default'}
                active={pumpOverrides.ph ?? src?.ph?.pumpActive}
              />
            </div>

            {/* Air pump (ammonia) */}
            <div className="aq-control-group">
              <div className="aq-control-group__label">Air pump</div>
              <ControlButton
                label={(pumpOverrides.ammonia ?? src?.ammonia?.pumpActive) ? 'Air pump ON' : 'Air pump OFF'}
                icon="💨"
                onClick={() => handlePumpToggle('ammonia', pumpOverrides.ammonia ?? src?.ammonia?.pumpActive)}
                disabled={brokerStatus !== 'connected'}
                variant={(pumpOverrides.ammonia ?? src?.ammonia?.pumpActive) ? 'warning' : 'default'}
                active={pumpOverrides.ammonia ?? src?.ammonia?.pumpActive}
              />
            </div>

            {/* Water valve */}
            <div className="aq-control-group">
              <div className="aq-control-group__label">Water valve</div>
              <ControlButton
                label={(pumpOverrides.water ?? src?.waterLevel?.valveOpen) ? 'Valve OPEN' : 'Valve CLOSED'}
                icon="🔧"
                onClick={() => handlePumpToggle('water', pumpOverrides.water ?? src?.waterLevel?.valveOpen)}
                disabled={brokerStatus !== 'connected'}
                variant={(pumpOverrides.water ?? src?.waterLevel?.valveOpen) ? 'success' : 'default'}
                active={pumpOverrides.water ?? src?.waterLevel?.valveOpen}
              />
            </div>

            {/* Reconnect */}
            <div className="aq-control-group">
              <div className="aq-control-group__label">Broker</div>
              <ControlButton
                label="Reconnect"
                icon="↻"
                onClick={reconnectBroker}
                variant="default"
              />
            </div>
          </div>
        </section>

        {/* ── IR Sensor & Actuator Status ── */}
        <section className="aq-section">
          <div className="aq-section__header">
            <h2 className="aq-section__title">IR Sensor & Actuator Status</h2>
            <span className="aq-section__hint">Linear actuator with IR object detection</span>
          </div>
          <div className="aq-actuator-status-grid">
            <div className="aq-actuator-status-card">
              <div className="aq-actuator-status__label">IR Sensor</div>
              <div className="aq-actuator-status__value">
                <span className={`aq-actuator-status__indicator ${irSensorState === 'LOW' ? 'active' : ''}`}>
                  {irSensorState === 'LOW' ? '🔴 Object Detected' : '🟢 Clear'}
                </span>
              </div>
            </div>
            <div className="aq-actuator-status-card">
              <div className="aq-actuator-status__label">Actuator State</div>
              <div className="aq-actuator-status__value">
                <span className={`aq-actuator-status__indicator ${actuatorRunning ? 'active' : ''}`}>
                  {actuatorCycleState || 'IDLE'}
                </span>
              </div>
            </div>
            <div className="aq-actuator-status-card">
              <div className="aq-actuator-status__label">Hit Count</div>
              <div className="aq-actuator-status__value">
                <span>{actuatorStatus?.hitCount ?? 0}</span>
              </div>
            </div>
            <div className="aq-actuator-status-card">
              <div className="aq-actuator-status__label">Running</div>
              <div className="aq-actuator-status__value">
                <span className={`aq-actuator-status__indicator ${actuatorRunning ? 'active' : ''}`}>
                  {actuatorRunning ? '✅ Yes' : '❌ No'}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ── Metric cards ── */}
        <section className="aq-section">
          <div className="aq-section__header">
            <h2 className="aq-section__title">Live readings</h2>
            <span className="aq-section__hint">
              {loading ? 'Waiting for data…' : esp32Status === 'online' ? 'Live from ESP32' : 'Last known values'}
            </span>
          </div>
          <div className="aq-metrics-grid">
            {metrics.map((m) => (
              <article
                key={m.key}
                className={`aq-metric ${activeChart === m.chartKey ? 'aq-metric--selected' : ''} ${m.chartKey ? 'aq-metric--clickable' : ''}`}
                onClick={() => m.chartKey && setActiveChart(m.chartKey)}
                title={m.chartKey ? 'Click to view history chart' : undefined}
              >
                <div className="aq-metric__header">
                  <span className="aq-metric__label">{m.label}</span>
                  <span
                    className={`aq-metric__state ${(m.pumpActive || m.valveOpen) ? 'aq-metric__state--on' : ''}`}
                  >
                    {m.pumpActive ? 'Pump ON'
                      : m.valveOpen !== undefined ? (m.valveOpen ? 'Valve OPEN' : 'Valve CLOSED')
                      : 'Pump OFF'}
                  </span>
                </div>
                <div className="aq-metric__value">
                  {m.value}
                  {m.unit && <span className="aq-metric__unit">{m.unit}</span>}
                </div>
                <p className="aq-metric__sub">{m.sub}</p>
                {m.chartKey && (
                  <div
                    className="aq-metric__bar"
                    style={{ background: CHART_COLORS[m.chartKey] }}
                  />
                )}
              </article>
            ))}
          </div>
        </section>

        {/* ── History chart ── */}
        <section className="aq-section">
          <div className="aq-section__header">
            <h2 className="aq-section__title">Sensor history</h2>
            <div className="aq-chart-tabs">
              {chartTabs.map((t) => (
                <button
                  key={t.key}
                  className={`aq-chart-tab ${activeChart === t.key ? 'aq-chart-tab--active' : ''}`}
                  style={activeChart === t.key ? { borderColor: CHART_COLORS[t.key], color: CHART_COLORS[t.key] } : {}}
                  onClick={() => setActiveChart(t.key)}
                  type="button"
                >
                  {t.label}
                </button>
              ))}
              <button
                className="aq-chart-tab aq-chart-tab--refresh"
                onClick={fetchHistory}
                disabled={historyLoading}
                type="button"
                title="Refresh history"
              >
                {historyLoading ? '…' : '↻'}
              </button>
            </div>
          </div>

          <div className="aq-chart-card">
            <div className="aq-chart-card__meta">
              <span style={{ color: CHART_COLORS[activeChart] }}>●</span>
              &nbsp;{chartMeta[activeChart]?.label}
              {chartMeta[activeChart]?.unit ? ` (${chartMeta[activeChart].unit})` : ''}
              &nbsp;·&nbsp;
              <span className="aq-chart-card__count">
                {historyData[activeChart]?.length ?? 0} readings
              </span>
            </div>
            <HistoryChart
              data={historyData[activeChart]}
              dataKey={activeChart}
              label={chartMeta[activeChart]?.label}
              unit={chartMeta[activeChart]?.unit}
              color={CHART_COLORS[activeChart]}
              threshold={chartMeta[activeChart]?.threshold}
            />
          </div>
        </section>

        {/* ── Footer summary ── */}
        <footer className="aq-footer">
          <div>
            <span className="aq-footer__label">Feed</span>
            <strong className={`aq-footer__val aq-footer__val--${feedState}`}>
              {feedState === 'queued' ? 'Queued' : feedState === 'sending' ? 'Sending' : feedState === 'error' ? 'Failed' : 'Idle'}
            </strong>
          </div>
          <div>
            <span className="aq-footer__label">Actuator</span>
            <strong className={`aq-footer__val ${actuatorRunning ? 'aq-footer__val--active' : ''}`}>
              {actuatorRunning ? '🔄 Running' : '⏸️ Idle'}
            </strong>
          </div>
          <div>
            <span className="aq-footer__label">Sync</span>
            <strong className={`aq-footer__val ${backendError ? 'aq-footer__val--error' : backendSyncCount > 0 ? 'aq-footer__val--synced' : ''}`}>
              {backendError ? 'Failed' : backendStatus === 'saving' ? 'Saving…' : backendSyncCount > 0 ? `Synced (${backendSyncCount})` : 'Idle'}
            </strong>
          </div>
          <div>
            <span className="aq-footer__label">Broker</span>
            <strong>{brokerStatus}</strong>
          </div>
          <div>
            <span className="aq-footer__label">ESP32</span>
            <strong>{esp32Status}</strong>
          </div>
        </footer>
      </main>
    </div>
  )
}
