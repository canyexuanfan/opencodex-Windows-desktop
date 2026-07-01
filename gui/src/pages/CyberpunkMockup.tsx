const routes = [
  { model: "kiro/claude-opus-4.8", lane: "agentic edits", status: "hot" },
  { model: "opencode-go/glm-5.2", lane: "1m context", status: "clear" },
  { model: "openai/gpt-5.5", lane: "native codex", status: "prime" },
];

const signals = [
  { label: "providers", value: "09", text: "Anthropic, OpenAI, Kiro, GLM and local gateways stay visible from one cockpit." },
  { label: "sidecars", value: "02", text: "Vision and web-search lanes attach to text-only providers without changing Codex." },
  { label: "account pool", value: "live", text: "OAuth-backed Codex accounts, reset windows, and routed API keys stay separated." },
  { label: "request logs", value: "499+", text: "Native passthrough, cancellations, token usage, and latency land in one trace stream." },
];

const flow = ["Codex CLI", "opencodex", "provider adapter", "response bridge"];

const terminalRows = [
  "[02:14:08] route=kiro/claude-opus-4.8  sidecar=search  usage=streaming  latency=812ms",
  "[02:14:11] catalog=codex-picker       sync=clean      models=09         stale=0",
  "[02:14:16] route=opencode-go/glm-5.2  context=1m      bridge=anthropic  status=ok",
  "[02:14:19] auth=codex-business        reset=03:42     pool=isolated     state=ready",
];

export default function CyberpunkMockup() {
  return (
    <section className="cyber-page" aria-labelledby="cyber-title">
      <div className="cyber-shell">
        <div className="cyber-hero">
          <div className="cyber-hero-copy">
            <p className="cyber-kicker">LOCAL PROXY / GLOBAL MODEL GRID</p>
            <h1 id="cyber-title" className="cyber-title">opencodex routing command center</h1>
            <p className="cyber-subtitle">
              A cyberpunk cockpit for watching Codex traffic split across provider adapters,
              sidecars, account pools, model catalogs, and response bridges.
            </p>
            <div className="cyber-actions" aria-label="mockup controls">
              <button type="button" className="cyber-button cyber-button-primary">arm routing grid</button>
              <button type="button" className="cyber-button">inspect model picker</button>
            </div>
          </div>
          <div className="cyber-orb" aria-hidden="true">
            <span className="cyber-orb-ring" />
            <span className="cyber-orb-core" />
            <span className="cyber-orb-line cyber-orb-line-a" />
            <span className="cyber-orb-line cyber-orb-line-b" />
          </div>
        </div>

        <div className="cyber-command" aria-label="active routed models">
          {routes.map(route => (
            <div className="cyber-route" key={route.model}>
              <span>{route.model}</span>
              <strong>{route.lane}</strong>
              <em>{route.status}</em>
            </div>
          ))}
        </div>

        <div className="cyber-grid">
          {signals.map(signal => (
            <article className="cyber-card" key={signal.label}>
              <div className="cyber-card-top">
                <span>{signal.label}</span>
                <strong>{signal.value}</strong>
              </div>
              <p>{signal.text}</p>
            </article>
          ))}
        </div>

        <div className="cyber-lower">
          <div className="cyber-flow" aria-label="request flow">
            {flow.map((step, index) => (
              <div className="cyber-flow-node" key={step}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{step}</strong>
              </div>
            ))}
          </div>

          <div className="cyber-terminal" aria-label="simulated request log stream">
            <div className="cyber-terminal-bar">
              <span>request stream</span>
              <strong>native + routed</strong>
            </div>
            <pre>{terminalRows.join("\n")}</pre>
          </div>
        </div>

        <div className="cyber-band">
          <span>local proxy</span>
          <strong>global routing without breaking the Codex surface</strong>
          <span>provider-aware</span>
        </div>
      </div>
      <span className="cyber-scanline" aria-hidden="true" />
    </section>
  );
}
