import { useEffect, useRef, useState } from 'react'
import mqtt from 'mqtt'
import RosarioPage from './RosarioPage'
import TolinPage from './TolinPage'
import './App.css'
import './Pagestyle.css'

const MQTT_URL = import.meta.env.VITE_MQTT_URL?.trim() || 'wss://broker.emqx.io:8084/mqtt'
const MQTT_BASE_TOPIC = import.meta.env.VITE_MQTT_BASE_TOPIC?.trim().replace(/\/+$/, '') || 'group1/mp'

function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '-'
  }
  return Number(value).toFixed(digits)
}

function topic(suffix) {
  return `${MQTT_BASE_TOPIC}/${suffix}`
}

function App() {
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
  const [lastUpdated, setLastUpdated] = useState(null)
  const [activePage, setActivePage] = useState('dashboard') // 'dashboard' | 'rosario' | 'tolin'

  useEffect(() => {
    const client = mqtt.connect(MQTT_URL, {
      clean: true,
      connectTimeout: 5000,
      clientId: `group1-mp-web-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 3000,
    })

    clientRef.current = client

    const subscriptions = [topic('status'), topic('telemetry'), topic('status/availability')]

    const handleConnect = () => {
      setBrokerStatus('connected')
      setError('')
      client.subscribe(subscriptions)
    }

    const handleReconnect = () => {
      setBrokerStatus('connecting')
    }

    const handleClose = () => {
      setBrokerStatus('disconnected')
    }

    const handleError = (mqttError) => {
      setBrokerStatus('error')
      setError(mqttError?.message || 'MQTT connection failed')
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
            raw_data: JSON.stringify(data),
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
            raw_data: JSON.stringify(data),
          })
        } catch {
          setError('Received malformed MQTT telemetry payload.')
        }
        return
      }

      if (incomingTopic === topic('status/availability')) {
        setEsp32Status(message === 'online' ? 'online' : 'offline')
        setLastUpdated(new Date())
      }
    }

    client.on('connect', handleConnect)
    client.on('reconnect', handleReconnect)
    client.on('close', handleClose)
    client.on('error', handleError)
    client.on('message', handleMessage)

    return () => {
      client.removeListener('connect', handleConnect)
      client.removeListener('reconnect', handleReconnect)
      client.removeListener('close', handleClose)
      client.removeListener('error', handleError)
      client.removeListener('message', handleMessage)
      client.end(true)
      clientRef.current = null
    }
  }, [])

  useEffect(() => {
    if (status || telemetry) {
      setLoading(false)
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
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}))
        throw new Error(errorBody.error || 'Failed to save backend data')
      }

      setBackendSyncCount((current) => current + 1)
      setBackendLastSync(new Date())
      setBackendStatus('synced')
    } catch (saveError) {
      setBackendStatus('error')
      setBackendError(saveError.message)
      console.error('Backend save failed', saveError)
    }
  }

  const handleFeedNow = async () => {
    const client = clientRef.current

    if (!client || brokerStatus !== 'connected') {
      setError('MQTT broker is not connected yet.')
      return
    }

    setFeedState('sending')

    client.publish(topic('feed'), '1', { qos: 1, retain: false }, (publishError) => {
      if (publishError) {
        setFeedState('error')
        setError(publishError.message || 'Failed to publish the feed command.')
      } else {
        setFeedState('queued')
        setError('')
      }

      window.setTimeout(() => setFeedState('idle'), 1500)
    })
  }

  const reconnectBroker = () => {
    clientRef.current?.reconnect()
  }

  const connectionLabel = brokerStatus === 'connected'
    ? esp32Status === 'online'
      ? `ESP32 online via MQTT${status?.ip ? ` (${status.ip})` : ''}`
      : 'Broker connected, waiting for ESP32'
    : brokerStatus === 'connecting'
      ? 'Connecting to MQTT broker'
      : brokerStatus === 'error'
        ? 'MQTT error'
        : 'MQTT disconnected'

  const statusTone = brokerStatus === 'connected'
    ? esp32Status === 'online'
      ? 'good'
      : 'warning'
    : brokerStatus === 'connecting'
      ? 'warning'
      : 'neutral'

  const sourceStatus = status || telemetry || {}
  const cards = [
    {
      key: 'tds',
      title: 'TDS',
      value: formatNumber(sourceStatus?.tds?.value ?? telemetry?.tds, 0),
      unit: 'ppm',
      detail: `Threshold ${sourceStatus?.tds?.threshold ?? '-'} ppm`,
      state: sourceStatus?.tds?.pumpActive ? 'Pump ON' : 'Pump OFF',
    },
    {
      key: 'ph',
      title: 'pH',
      value: formatNumber(sourceStatus?.ph?.value ?? telemetry?.ph, 2),
      unit: '',
      detail: `Threshold ${formatNumber(sourceStatus?.ph?.threshold, 2)}`,
      state: sourceStatus?.ph?.pumpActive ? 'Acid pump ON' : 'Pump OFF',
    },
    {
      key: 'feeder',
      title: 'Feeder',
      value: sourceStatus?.feeder?.ldrValue ?? telemetry?.ldr ?? '-',
      unit: 'ADC',
      detail: sourceStatus?.feeder?.isDark ? 'Dark detected' : 'Light detected',
      state: sourceStatus?.feeder?.lastMessage || 'Idle',
    },
    {
      key: 'turbidity',
      title: 'Turbidity',
      value: sourceStatus?.turbidity?.ntu ?? telemetry?.turbidity ?? '-',
      unit: 'NTU',
      detail: `ADC ${sourceStatus?.turbidity?.adc ?? '-'}`,
      state: sourceStatus?.turbidity?.pumpActive ? 'Pump ON' : 'Pump OFF',
    },
    {
      key: 'water',
      title: 'Water level',
      value: formatNumber(sourceStatus?.waterLevel?.percentage ?? telemetry?.water, 1),
      unit: '%',
      detail: `${formatNumber(sourceStatus?.waterLevel?.heightMm, 1)} mm in tank`,
      state: sourceStatus?.waterLevel?.valveOpen ? 'Valve OPEN' : 'Valve CLOSED',
    },
    {
      key: 'ammonia',
      title: 'Ammonia',
      value: formatNumber(sourceStatus?.ammonia?.ppm ?? telemetry?.ammonia, 2),
      unit: 'ppm',
      detail: `Threshold ${formatNumber(sourceStatus?.ammonia?.threshold, 2)} ppm`,
      state: sourceStatus?.ammonia?.pumpActive ? 'Air pump ON' : 'Air pump OFF',
    },
  ]

  const navLinks = [
    { id: 'dashboard', label: 'Dashboard' },
  ]

  return (
    <>
      {/* ── Top navigation ── */}
      <nav className="site-nav">
        <div className="site-nav__brand">AquaControl</div>
        <div className="site-nav__links">
          {navLinks.map((link) => (
            <button
              key={link.id}
              className={`site-nav__link ${activePage === link.id ? 'site-nav__link--active' : ''}`}
              type="button"
              onClick={() => setActivePage(link.id)}
            >
              {link.label}
            </button>
          ))}
        </div>
      </nav>

      {/* ── Pages ── */}
      {activePage === 'rosario' ? (
        <RosarioPage
          sourceStatus={sourceStatus}
          telemetry={telemetry}
          brokerStatus={brokerStatus}
          esp32Status={esp32Status}
          lastUpdated={lastUpdated}
          feedState={feedState}
          onFeedNow={handleFeedNow}
        />
      ) : activePage === 'tolin' ? (
        <TolinPage
          sourceStatus={sourceStatus}
          telemetry={telemetry}
          brokerStatus={brokerStatus}
          esp32Status={esp32Status}
          lastUpdated={lastUpdated}
          feedState={feedState}
          onFeedNow={handleFeedNow}
        />
      ) : (
        <main className="dashboard">
          <section className="hero-panel">
            <div>
              <p className="eyebrow">ESP32 control dashboard</p>
              <h1>Real-Time Water Quality Monitoring and Habitat Control System for
Crayfish and Guppy Fish</h1>
              <p className="hero-copy">
                The dashboard connects to an MQTT broker automatically, subscribes to the ESP32 topics, and keeps the live sensor stream up to date.
              </p>
            </div>

            <div className={`connection-card connection-card--${statusTone}`}>
              <div className="connection-card__label">Connection</div>
              <div className="connection-card__value">{connectionLabel}</div>
              <div className="connection-card__meta">
                {lastUpdated ? `Last update ${lastUpdated.toLocaleTimeString()}` : 'Waiting for first reading'}
              </div>
            </div>
          </section>

          <section className="toolbar">
            <div className="toolbar-copy">
              <strong>MQTT auto-connect</strong>
              <span>{brokerStatus === 'connected' ? 'Broker connected and topics subscribed.' : `Connecting to ${MQTT_URL}.`}</span>
            </div>

            <div className="toolbar-actions">
              <button className="secondary-button" type="button" onClick={reconnectBroker}>
                Reconnect
              </button>
              <button className="feed-button" type="button" onClick={handleFeedNow} disabled={brokerStatus !== 'connected' || feedState === 'sending'}>
                {feedState === 'sending' ? 'Queuing...' : 'Feed now'}
              </button>
            </div>
          </section>

          {error ? <div className="alert">{error}</div> : null}

          <section className="card-grid">
            {cards.map((card) => (
              <article className="metric-card" key={card.key}>
                <div className="metric-card__header">
                  <h2>{card.title}</h2>
                  <span>{card.state}</span>
                </div>
                <div className="metric-card__value">
                  {card.value}
                  {card.unit ? <span>{card.unit}</span> : null}
                </div>
                <p>{card.detail}</p>
              </article>
            ))}
          </section>

          <section className="summary-panel">
            <div>
              <h2>Live summary</h2>
              <p>
                {loading
                  ? 'Refreshing readings...'
                  : brokerStatus === 'connected'
                    ? esp32Status === 'online'
                      ? 'ESP32 is publishing live MQTT updates.'
                      : 'Broker connected and waiting for the ESP32 to publish.'
                    : `Waiting for MQTT broker connection at ${MQTT_URL}.`}
              </p>
            </div>
            <div className="summary-panel__status">
              <span>Feed action</span>
              <strong>{feedState === 'queued' ? 'Queued' : feedState === 'sending' ? 'Sending' : feedState === 'error' ? 'Failed' : 'Idle'}</strong>
            </div>
            <div className="summary-panel__status">
              <span>Backend sync</span>
              <strong>{backendError ? 'Failed' : backendStatus === 'saving' ? 'Saving...' : backendSyncCount > 0 ? 'Synced' : 'Idle'}</strong>
              <small>{backendLastSync ? `Last ${backendLastSync.toLocaleTimeString()}` : 'No sync yet'}</small>
            </div>
          </section>
        </main>
      )}
    </>
  )
}

export default App