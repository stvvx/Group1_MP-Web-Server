// RosarioPage.jsx
// Drop this file next to App.jsx

export default function RosarioPage({ sourceStatus, telemetry, brokerStatus, esp32Status, lastUpdated, feedState, onFeedNow, onBack }) {
  function formatNumber(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return '-'
    return Number(value).toFixed(digits)
  }

  const cards = [
    {
      key: 'water',
      title: 'Water Level',
      icon: '💧',
      value: formatNumber(sourceStatus?.waterLevel?.percentage ?? telemetry?.water, 1),
      unit: '%',
      detail: `${formatNumber(sourceStatus?.waterLevel?.heightMm, 1)} mm in tank`,
      state: sourceStatus?.waterLevel?.valveOpen ? 'Valve OPEN' : 'Valve CLOSED',
      stateActive: sourceStatus?.waterLevel?.valveOpen,
    },
    {
      key: 'ammonia',
      title: 'Ammonia',
      icon: '⚗️',
      value: formatNumber(sourceStatus?.ammonia?.ppm ?? telemetry?.ammonia, 2),
      unit: 'ppm',
      detail: `Threshold ${formatNumber(sourceStatus?.ammonia?.threshold, 2)} ppm`,
      state: sourceStatus?.ammonia?.pumpActive ? 'Air pump ON' : 'Air pump OFF',
      stateActive: sourceStatus?.ammonia?.pumpActive,
    },
    {
      key: 'feeder',
      title: 'Feeder',
      icon: '🐟',
      value: sourceStatus?.feeder?.ldrValue ?? telemetry?.ldr ?? '-',
      unit: 'ADC',
      detail: sourceStatus?.feeder?.isDark ? 'Dark detected' : 'Light detected',
      state: sourceStatus?.feeder?.lastMessage || 'Idle',
      stateActive: false,
    },
  ]

  return (
    <main className="rosario-page">
      {/* Page header */}
      <section className="rosario-hero">
        <div className="rosario-hero__text">
          <p className="eyebrow">Station monitoring</p>
          <h1 className="rosario-title">ROSARIO</h1>
          <p className="hero-copy">
            Live sensor feed for Water Level, Ammonia, and Feeder status at the Rosario station.
          </p>
        </div>

        <div className={`connection-card connection-card--${
          brokerStatus === 'connected'
            ? esp32Status === 'online' ? 'good' : 'warning'
            : brokerStatus === 'connecting' ? 'warning' : 'neutral'
        }`}>
          <div className="connection-card__label">Connection</div>
          <div className="connection-card__value">
            {brokerStatus === 'connected'
              ? esp32Status === 'online' ? 'ESP32 online via MQTT' : 'Broker connected, waiting for ESP32'
              : brokerStatus === 'connecting' ? 'Connecting to MQTT broker' : 'MQTT disconnected'}
          </div>
          <div className="connection-card__meta">
            {lastUpdated ? `Last update ${lastUpdated.toLocaleTimeString()}` : 'Waiting for first reading'}
          </div>
        </div>
      </section>

      {/* Feed toolbar */}
      <section className="toolbar rosario-toolbar">
        <div className="toolbar-copy">
          <strong>Rosario Station</strong>
          <span>Water level, ammonia and feeder monitoring.</span>
        </div>
        <div className="toolbar-actions">
          <button
            className="feed-button"
            type="button"
            onClick={onFeedNow}
            disabled={brokerStatus !== 'connected' || feedState === 'sending'}
          >
            {feedState === 'sending' ? 'Queuing...' : 'Feed now'}
          </button>
        </div>
      </section>

      {/* Monitor cards */}
      <section className="rosario-cards">
        {cards.map((card) => (
          <article className="rosario-card" key={card.key}>
            <div className="rosario-card__icon">{card.icon}</div>
            <div className="rosario-card__header">
              <h2>{card.title}</h2>
              <span className={`rosario-card__state ${card.stateActive ? 'rosario-card__state--active' : ''}`}>
                {card.state}
              </span>
            </div>
            <div className="rosario-card__value">
              {card.value}
              {card.unit ? <span className="rosario-card__unit">{card.unit}</span> : null}
            </div>
            <p className="rosario-card__detail">{card.detail}</p>
          </article>
        ))}
      </section>

      {/* Live summary */}
      <section className="summary-panel">
        <div>
          <h2>Live summary</h2>
          <p>
            {brokerStatus === 'connected'
              ? esp32Status === 'online'
                ? 'ESP32 is publishing live MQTT updates to Rosario.'
                : 'Broker connected, waiting for ESP32 to publish.'
              : 'Waiting for MQTT broker connection.'}
          </p>
        </div>
        <div className="summary-panel__status">
          <span>Feed action</span>
          <strong>
            {feedState === 'queued' ? 'Queued' : feedState === 'sending' ? 'Sending' : feedState === 'error' ? 'Failed' : 'Idle'}
          </strong>
        </div>
      </section>
    </main>
  )
}