// TolinPage.jsx
// Drop this file next to App.jsx and RosarioPage.jsx

export default function TolinPage({ sourceStatus, telemetry, brokerStatus, esp32Status, lastUpdated, feedState, onFeedNow }) {
  function formatNumber(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return '-'
    return Number(value).toFixed(digits)
  }

  const cards = [
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
      key: 'ph',
      title: 'pH Sensor',
      icon: '🧪',
      value: formatNumber(sourceStatus?.ph?.value ?? telemetry?.ph, 2),
      unit: '',
      detail: `Threshold ${formatNumber(sourceStatus?.ph?.threshold, 2)}`,
      state: sourceStatus?.ph?.pumpActive ? 'Acid pump ON' : 'Pump OFF',
      stateActive: sourceStatus?.ph?.pumpActive,
    },
    {
      key: 'turbidity',
      title: 'Turbidity',
      icon: '🌊',
      value: sourceStatus?.turbidity?.ntu ?? telemetry?.turbidity ?? '-',
      unit: 'NTU',
      detail: `ADC ${sourceStatus?.turbidity?.adc ?? '-'}`,
      state: sourceStatus?.turbidity?.pumpActive ? 'Pump ON' : 'Pump OFF',
      stateActive: sourceStatus?.turbidity?.pumpActive,
    },
  ]

  const statusTone = brokerStatus === 'connected'
    ? esp32Status === 'online' ? 'good' : 'warning'
    : brokerStatus === 'connecting' ? 'warning' : 'neutral'

  return (
    <main className="tolin-page">
      <section className="tolin-hero">
        <div className="tolin-hero__text">
          <p className="eyebrow">Station monitoring</p>
          <h1 className="tolin-title">TOLIN</h1>
          <p className="hero-copy">
            Live sensor feed for Ammonia, pH, and Turbidity at the Tolin station.
          </p>
        </div>

        <div className={`connection-card connection-card--${statusTone}`}>
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

      <section className="toolbar tolin-toolbar">
        <div className="toolbar-copy">
          <strong>Tolin Station</strong>
          <span>Ammonia, pH sensor, and turbidity monitoring.</span>
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

      <section className="tolin-cards">
        {cards.map((card) => (
          <article className="tolin-card" key={card.key}>
            <div className="tolin-card__icon">{card.icon}</div>
            <div className="tolin-card__header">
              <h2>{card.title}</h2>
              <span className={`tolin-card__state ${card.stateActive ? 'tolin-card__state--active' : ''}`}>
                {card.state}
              </span>
            </div>
            <div className="tolin-card__value">
              {card.value}
              {card.unit ? <span className="tolin-card__unit">{card.unit}</span> : null}
            </div>
            <p className="tolin-card__detail">{card.detail}</p>
          </article>
        ))}
      </section>

      <section className="summary-panel">
        <div>
          <h2>Live summary</h2>
          <p>
            {brokerStatus === 'connected'
              ? esp32Status === 'online'
                ? 'ESP32 is publishing live MQTT updates to Tolin.'
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