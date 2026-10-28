"""
GradPrep AI — Piper TTS Voice Service
======================================
Provides text-to-speech via Piper (local, self-hosted) using FastAPI.

Endpoints
---------
GET  /health              — readiness probe
GET  /voices              — list available voices with metadata
POST /synthesize          — synthesise text, returns audio/wav
POST /preview/{voice_id}  — short preview clip for a voice

Environment Variables
---------------------
PIPER_EXECUTABLE   path to the piper binary (default: piper in PATH)
MODELS_DIR         directory that contains *.onnx + *.onnx.json model files
                   (default: ./models)
VOICE_SERVICE_PORT port to listen on (default: 8001)
ALLOWED_ORIGINS    comma-separated CORS origins (default: *)
API_SECRET_KEY     optional bearer-token guard for all endpoints
"""

from __future__ import annotations

# ── Python 3.12+ / Windows compatibility ────────────────────────────────────
# NOTE: We previously forced WindowsSelectorEventLoopPolicy here, but on
# Python 3.14 that policy is deprecated and breaks uvicorn's ability to flush
# large binary HTTP responses (the WAV write blocks the SelectorEventLoop and
# the client times out). We now let uvicorn choose the correct loop via
# loop="auto" in the uvicorn.run() call below.
import sys
import asyncio
import json
import logging
import os
import struct
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
import uvicorn

# Load .env from the same directory as this script so the service works
# regardless of which directory it is launched from.
load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=False)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
log = logging.getLogger("voice-service")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PIPER_EXECUTABLE = os.getenv("PIPER_EXECUTABLE", "piper")
MODELS_DIR = Path(os.getenv("MODELS_DIR", "./models"))
PORT = int(os.getenv("VOICE_SERVICE_PORT", "8001"))
ALLOWED_ORIGINS_RAW = os.getenv("ALLOWED_ORIGINS", "*")
ALLOWED_ORIGINS = [o.strip() for o in ALLOWED_ORIGINS_RAW.split(",")]
API_SECRET_KEY = os.getenv("API_SECRET_KEY", "")  # empty → no auth required

# espeak-ng-data lives next to piper.exe in the bin/ directory.
# Piper on Windows needs ESPEAK_DATA_PATH to find its phoneme tables.
# Infer automatically from the piper executable path; override with env var.
_piper_bin_dir = Path(PIPER_EXECUTABLE).parent if Path(PIPER_EXECUTABLE).is_absolute() else Path(__file__).parent / "bin"
ESPEAK_DATA_PATH = os.getenv(
    "ESPEAK_DATA_PATH",
    str(_piper_bin_dir / "espeak-ng-data"),
)

# ---------------------------------------------------------------------------
# Voice catalogue
# Piper model files are downloaded separately; see README.
# Model file names match piper-voices naming convention.
# Licences: all voices listed below use LGPL / Apache-2.0 / CC licences
# that allow free use. See https://github.com/rhasspy/piper for details.
# ---------------------------------------------------------------------------
@dataclass
class VoiceInfo:
    voice_id: str
    name: str
    gender: str          # "female" | "male"
    language: str        # BCP-47
    language_name: str
    model_file: str      # relative to MODELS_DIR, .onnx file
    config_file: str     # relative to MODELS_DIR, .onnx.json file
    quality: str         # "low" | "medium" | "high" | "x_low"
    description: str
    preview_text: str
    licence: str = "LGPL"


VOICES: list[VoiceInfo] = [
    VoiceInfo(
        voice_id="en_female",
        name="HFC Female",
        gender="female",
        language="en-US",
        language_name="English (US)",
        model_file="en_US-hfc_female-medium.onnx",
        config_file="en_US-hfc_female-medium.onnx.json",
        quality="medium",
        description="Clear, natural American female voice — warm and articulate.",
        preview_text="Hello! I am Lusy, your AI interview coach. Let's prepare you for your next interview!",
        licence="MIT",
    ),
    VoiceInfo(
        voice_id="en_male",
        name="HFC Male",
        gender="male",
        language="en-US",
        language_name="English (US)",
        model_file="en_US-hfc_male-medium.onnx",
        config_file="en_US-hfc_male-medium.onnx.json",
        quality="medium",
        description="Natural, confident American male voice — professional and clear.",
        preview_text="Hey there! I am Siddu, your AI interviewer. I'll help you ace your next technical interview.",
        licence="MIT",
    ),
]

VOICE_MAP: dict[str, VoiceInfo] = {v.voice_id: v for v in VOICES}

# Persona → voice_id mapping  (mirrors the legacy ElevenLabs persona mapping)
PERSONA_VOICE_MAP: dict[str, str] = {
    "female": "en_female",
    "lusy": "en_female",
    "lucy": "en_female",
    "male": "en_male",
    "amds": "en_male",
    "siddu": "en_male",
}


# ---------------------------------------------------------------------------
# Model availability check
# ---------------------------------------------------------------------------
def model_available(voice: VoiceInfo) -> bool:
    onnx = MODELS_DIR / voice.model_file
    cfg  = MODELS_DIR / voice.config_file
    return onnx.exists() and cfg.exists()


def check_piper_binary() -> bool:
    try:
        result = subprocess.run(
            [PIPER_EXECUTABLE, "--version"],
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


# ---------------------------------------------------------------------------
# Read the sample rate from a Piper model config (.onnx.json)
# ---------------------------------------------------------------------------
def _read_sample_rate(config_path: str) -> int:
    """Return the sample_rate declared in the Piper model JSON config.
    Falls back to 22050 if the config is missing or unreadable."""
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        # Piper config stores sample_rate at the top level
        return int(cfg.get("audio", {}).get("sample_rate", cfg.get("sample_rate", 22050)))
    except Exception:
        return 22050


def _pcm_to_wav(
    pcm: bytes,
    sample_rate: int = 22050,
    channels: int = 1,
    bits: int = 16,
) -> bytes:
    """Wrap PCM audio bytes in a standard little-endian WAV header."""
    block_align = channels * bits // 8
    byte_rate = sample_rate * block_align
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        1,
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits,
        b"data",
        len(pcm),
    ) + pcm


# ---------------------------------------------------------------------------
# Piper synthesis (subprocess call)
# ---------------------------------------------------------------------------
import tempfile
import uuid

async def run_piper(text: str, voice: VoiceInfo, speed: float = 1.0) -> bytes:
    """
    Call the Piper binary and return WAV bytes.

    Uses --output_file with a temp file instead of --output-raw / stdin→stdout.

    Background: on Windows, using --output-raw causes piper.exe to write raw PCM
    to stdout while reading text from stdin. Python's subprocess.run() with
    capture_output=True and input=... hits a pipe-buffer deadlock on Windows when
    the PCM output exceeds the OS pipe buffer (~64 KB). The process blocks waiting
    for the reader (Python) to drain stdout, but Python is blocked waiting for the
    process to finish — a classic write–write deadlock. The fix is to use
    --output_file so Piper writes directly to a temp file and Python reads it
    afterwards, with no pipe involved.
    """
    onnx_path   = str((MODELS_DIR / voice.model_file).resolve())
    config_path = str((MODELS_DIR / voice.config_file).resolve())

    if not Path(onnx_path).exists():
        raise HTTPException(
            status_code=503,
            detail=f"Voice model '{voice.voice_id}' is not installed. "
                   f"Run setup_models.ps1 to download it.",
        )

    # Write text to a temp file so we avoid any stdin encoding issues on Windows.
    tmp_dir  = Path(tempfile.gettempdir())
    txt_file = tmp_dir / f"piper_in_{uuid.uuid4().hex}.txt"
    wav_file = tmp_dir / f"piper_out_{uuid.uuid4().hex}.wav"

    try:
        txt_file.write_text(text, encoding="utf-8")

        cmd = [
            PIPER_EXECUTABLE,
            "--model",        onnx_path,
            "--config",       config_path,
            "--output_file",  str(wav_file),   # write WAV directly — no pipe
            "--length-scale", str(round(1.0 / max(0.5, min(2.0, speed)), 3)),
        ]

        # Piper on Windows needs ESPEAK_DATA_PATH to locate its phoneme tables.
        piper_env = {**os.environ, "ESPEAK_DATA_PATH": ESPEAK_DATA_PATH}

        # Run piper in a thread so we don't block the uvicorn event loop.
        # Use asyncio.to_thread() (Python 3.9+) which correctly schedules the
        # callable on the running loop's default thread executor.
        # Open the text file as piper's stdin (file-redirect) to avoid the
        # Windows pipe-buffer deadlock that occurs with communicate(input=bytes).
        def _run_piper_sync() -> subprocess.CompletedProcess:
            with open(txt_file, "rb") as txt_in:
                with subprocess.Popen(
                    cmd,
                    stdin=txt_in,
                    stdout=subprocess.DEVNULL,   # WAV written to file, not stdout
                    stderr=subprocess.PIPE,
                    env=piper_env,
                ) as p:
                    _, stderr_bytes = p.communicate(timeout=30)
                    return subprocess.CompletedProcess(
                        args=cmd,
                        returncode=p.returncode,
                        stderr=stderr_bytes,
                    )

        try:
            proc = await asyncio.to_thread(_run_piper_sync)
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="Piper synthesis timed out")

        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", errors="replace")
            log.error("Piper error (rc=%d): %s", proc.returncode, err[:500])
            raise HTTPException(status_code=500, detail="Piper synthesis failed")

        if not wav_file.exists() or wav_file.stat().st_size == 0:
            raise HTTPException(status_code=500, detail="Piper produced no audio")

        wav_bytes = wav_file.read_bytes()
        log.info(
            "run_piper voice=%s chars=%d wav_bytes=%d speed=%.2f",
            voice.voice_id, len(text), len(wav_bytes), speed,
        )
        return wav_bytes

    finally:
        # Always clean up temp files, even on error.
        for f in (txt_file, wav_file):
            try:
                f.unlink(missing_ok=True)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="GradPrep AI Voice Service",
    description="Piper TTS backend for GradPrep AI interviews and LUSY assistant",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Optional bearer-token authentication
# ---------------------------------------------------------------------------
async def verify_token(authorization: Optional[str] = Header(default=None)) -> None:
    if not API_SECRET_KEY:
        return  # auth disabled
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    token = authorization.removeprefix("Bearer ").strip()
    if token != API_SECRET_KEY:
        raise HTTPException(status_code=403, detail="Invalid API key")


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------
class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    voice_id: Optional[str] = None    # explicit voice_id takes priority
    persona: Optional[str] = None     # "lusy" | "amds" | "female" | "male"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


class VoiceListItem(BaseModel):
    voice_id: str
    name: str
    gender: str
    language: str
    language_name: str
    quality: str
    description: str
    available: bool
    licence: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
async def health() -> dict:
    piper_ok   = check_piper_binary()
    voices_ok  = {v.voice_id: model_available(v) for v in VOICES}
    any_voice  = any(voices_ok.values())
    status     = "ok" if (piper_ok and any_voice) else "degraded"

    return {
        "status": status,
        "piper_available": piper_ok,
        "piper_executable": PIPER_EXECUTABLE,
        "models_dir": str(MODELS_DIR.resolve()),
        "voices": voices_ok,
        "timestamp": time.time(),
    }


@app.get("/voices", response_model=list[VoiceListItem])
async def list_voices() -> list[VoiceListItem]:
    return [
        VoiceListItem(
            voice_id=v.voice_id,
            name=v.name,
            gender=v.gender,
            language=v.language,
            language_name=v.language_name,
            quality=v.quality,
            description=v.description,
            available=model_available(v),
            licence=v.licence,
        )
        for v in VOICES
    ]


@app.post(
    "/synthesize",
    response_class=Response,
    dependencies=[Depends(verify_token)],
)
async def synthesize(req: SynthesizeRequest) -> Response:
    # Resolve voice
    voice_id = req.voice_id
    if not voice_id and req.persona:
        voice_id = PERSONA_VOICE_MAP.get(req.persona.lower(), "en_female")
    if not voice_id:
        voice_id = "en_female"

    voice = VOICE_MAP.get(voice_id)
    if not voice:
        raise HTTPException(status_code=400, detail=f"Unknown voice_id: '{voice_id}'")

    if not model_available(voice):
        raise HTTPException(
            status_code=503,
            detail=(
                f"Voice model '{voice_id}' is not installed "
                f"(expected {voice.model_file} and {voice.config_file} in {MODELS_DIR}). "
                f"Run setup_models.ps1 (Windows) or download the models manually."
            ),
        )

    text = req.text.strip()
    log.info(
        "synthesize voice=%s persona=%s chars=%d speed=%.2f",
        voice_id, req.persona, len(text), req.speed,
    )

    wav_bytes = await run_piper(text, voice, speed=req.speed)
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "X-Voice-Id": voice_id,
            "X-Persona": req.persona or "",
            "Cache-Control": "no-store",
        },
    )


@app.get(
    "/preview/{voice_id}",
    response_class=Response,
    dependencies=[Depends(verify_token)],
)
async def preview_voice(voice_id: str) -> Response:
    voice = VOICE_MAP.get(voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail=f"Unknown voice_id: '{voice_id}'")

    log.info("preview voice=%s", voice_id)
    wav_bytes = await run_piper(voice.preview_text, voice, speed=1.0)
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    log.info("Starting GradPrep AI voice service on port %d", PORT)
    log.info("Piper executable: %s", PIPER_EXECUTABLE)
    log.info("Models directory: %s", MODELS_DIR.resolve())
    log.info("espeak-ng-data:   %s", ESPEAK_DATA_PATH)
    for v in VOICES:
        avail = "✓" if model_available(v) else "✗ MISSING"
        log.info("  Voice %-12s [%s] %s — %s", v.voice_id, v.gender, avail, v.model_file)
    # loop="auto" lets uvicorn pick the correct event loop for the current
    # Python version and platform. On Python 3.14 Windows, this avoids the
    # deprecated WindowsSelectorEventLoopPolicy that blocked WAV response delivery.
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info", loop="auto")
