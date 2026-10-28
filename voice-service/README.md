# GradPrep AI — Voice Service

Local Piper TTS microservice that replaces the ElevenLabs integration.

## Architecture

```
Local development: Browser / Vite frontend ──► FastAPI voice-service
Production:        Browser / Vite frontend ──► Supabase voice-tts Edge Function ──► FastAPI
       │  subprocess
       ▼
Piper TTS binary  +  .onnx model files
       │  raw PCM audio
       ▼
WAV response  →  <Audio> element in browser
```

The frontend uses `VITE_VOICE_SERVICE_URL` for local development and the
Supabase `voice-tts` Edge Function otherwise. The Edge Function requires
`PIPER_SERVICE_URL` to proxy production requests. Missing or unavailable Piper
is reported as an error instead of silently switching to browser voices. No
ElevenLabs API key is required.

## Quick Start (Windows)

### Prerequisites

| Tool       | Version | Notes                                         |
|------------|---------|-----------------------------------------------|
| Python     | 3.10+   | https://python.org (add to PATH)              |
| Git        | any     | for cloning the repo                          |
| PowerShell | 5.1+    | built into Windows 10/11                      |

> **No WSL or Docker required.** Piper has native Windows AMD64 binaries.

### 1 — Run the setup script

From the repository root:

```powershell
cd voice-service
.\setup_models.ps1
```

This will:
1. Create a Python virtual environment in `voice-service/.venv`
2. Install FastAPI + Uvicorn
3. Download the Piper Windows binary into `voice-service/bin/`
4. Download two voice models into `voice-service/models/`:
   - `en_US-hfc_female-medium` — female, American English (MIT)
   - `en_US-hfc_male-medium`   — male,   American English (MIT)

### 2 — Start the voice service

```powershell
# still inside voice-service\
.\.venv\Scripts\Activate.ps1
python main.py
```

Service starts at **http://localhost:8001**.

### 3 — Configure the frontend

Add to `gradprepai-f17d1a26-main/.env`:

```
VITE_VOICE_SERVICE_URL=http://localhost:8001
```

Leave `API_SECRET_KEY` empty in `voice-service/.env` when using the local
development endpoint directly. Do not put a production service key in a
`VITE_` variable or expose it in browser code.

### 4 — Start the frontend

```powershell
cd ..   # back to repo root / gradprepai-f17d1a26-main
npm run dev
```

### 5 — Verify

```powershell
# Health check
Invoke-WebRequest http://localhost:8001/health | Select-Object -Expand Content

# Female voice preview (saves female.wav)
Invoke-WebRequest http://localhost:8001/preview/en_female -OutFile female.wav

# Male voice preview
Invoke-WebRequest http://localhost:8001/preview/en_male -OutFile male.wav
```

Open the `.wav` files in any media player to verify audio quality.

## API Reference

### `GET /health`

Returns service status and model availability.

```json
{
  "status": "ok",
  "piper_available": true,
  "voices": {
    "en_female": true,
    "en_male": true
  }
}
```

### `GET /voices`

Returns all configured voices with availability flags.

### `POST /synthesize`

Synthesises text and returns `audio/wav`.

```json
{
  "text": "Hello, let's start the interview.",
  "persona": "lusy",
  "speed": 1.0
}
```

| Field      | Type   | Default     | Notes                                      |
|------------|--------|-------------|--------------------------------------------|
| `text`     | string | required    | 1–4000 characters                          |
| `voice_id` | string | auto        | `en_female` or `en_male` (overrides persona) |
| `persona`  | string | `"female"`  | `lusy` / `female` → female; `amds` / `siddu` / `male` → male |
| `speed`    | float  | `1.0`       | 0.5–2.0 (1.0 = normal)                    |

### `GET /preview/{voice_id}`

Returns a short `audio/wav` preview clip for the given voice.

```
GET /preview/en_female
GET /preview/en_male
```

## Voice Model Licensing

| Model                      | Licence | Source                            |
|----------------------------|---------|-----------------------------------|
| en_US-hfc_female-medium    | MIT     | https://github.com/rhasspy/piper  |
| en_US-hfc_male-medium      | MIT     | https://github.com/rhasspy/piper  |

Both models are free to use in commercial and non-commercial projects under the MIT licence.
Both HFC models are English (US) voices; multilingual input support does not
make these English TTS models multilingual.

## Troubleshooting

### "Voice model is not installed"

Run `.\setup_models.ps1` again. Check that `models/` contains both `.onnx`
and `.onnx.json` files for each voice.

### "Piper synthesis failed" (rc=1)

Check the `PIPER_EXECUTABLE` path in `.env`. Test manually:

```powershell
echo "Hello world" | & .\bin\piper.exe --model .\models\en_US-hfc_female-medium.onnx --output-raw > test.raw
```

### Port already in use

Change `VOICE_SERVICE_PORT` in `.env` and update `VITE_VOICE_SERVICE_URL` in
the frontend `.env`.

## Production Notes

- Run behind a reverse proxy (nginx / Caddy) with HTTPS.
- Set a strong `API_SECRET_KEY` and `PIPER_API_KEY` for the server-to-server
  Edge Function connection. Do not expose either value to the frontend.
- Restrict `ALLOWED_ORIGINS` to your actual frontend domain.
- The service is stateless; scale horizontally as needed.
- Model files are ~65 MB each; cache them on the host, not in the container image.
