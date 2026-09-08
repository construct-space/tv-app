# Construct TV

Ambient TV dashboard in the Construct design system — a living clock, weather, and
voice-driven generated screens, styled with Construct tokens (`--c-*`), Rubik, and the
coral mark accent (`#FF2D55`). Light + dark.

## Architecture
- **Backend:** [`api/tv`](../../api/tv) — a `construct/tv` Go service (stdlib `net/http`).
  Serves this frontend (embedded), proxies weather (Open-Meteo, no key), and turns a
  query into a typed **screen-spec** by calling the Construct **inference** API
  (`/api/chat`, `X-Internal-Secret`). Falls back to a local composer if inference is
  unreachable.
- **Frontend (this app):** a self-contained `index.html` the Go service embeds at
  `api/tv/web/index.html`. (Kept here as the canonical source; can be migrated to the
  Vue + `@construct-space/ui` app stack later.)
- **Display:** an Android TV WebView kiosk points at the service. Voice in = the remote's
  **OK button → Google STT** (the app injects `window.jarvisAsk(text)`); replies via the
  browser's SpeechSynthesis.

## Run locally
```
cd api/tv && go run .        # http://localhost:8087
```

## Endpoints
- `GET /api/health` — status + model + token usage
- `GET /api/weather?city=Ferizaj` (or `?lat=&lon=`) — Open-Meteo current + 6-day
- `POST /api/ask {query}` — `{spec, meta}` (screen-spec via inference, local fallback)

## Production
Deploy `api/tv` (CapRover `captain-definition` + `Dockerfile`) to **tv.construct.space**.
Env: `INTERNAL_SHARED_SECRET` (for inference), `INFERENCE_URL` (default
`https://llm.construct.space`), `TV_MODEL`, `TV_DEFAULT_CITY`, `PORT` (8087).
