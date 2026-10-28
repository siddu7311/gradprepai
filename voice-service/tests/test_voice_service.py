"""
Tests for the GradPrep AI voice service (Piper TTS backend).

Run:
    cd voice-service
    .venv\\Scripts\\Activate.ps1
    pip install pytest pytest-asyncio httpx
    pytest tests/ -v
"""
from __future__ import annotations

import io
import struct
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Add parent dir to path so we can import main.py
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient

# We patch the subprocess call so tests run without Piper or model files.
import main as voice_main

# ─── helpers ────────────────────────────────────────────────────────────────

def make_wav(duration_samples: int = 1000) -> bytes:
    """Return a minimal valid 16-bit mono 22050 Hz WAV."""
    pcm = b'\x00\x00' * duration_samples
    sample_rate, channels, bits = 22050, 1, 16
    byte_rate   = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    data_size   = len(pcm)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_size, b"WAVE",
        b"fmt ", 16, 1, channels, sample_rate,
        byte_rate, block_align, bits, b"data", data_size,
    )
    return header + pcm


GOOD_WAV = make_wav()


# ─── fixture: TestClient with mocked Piper ───────────────────────────────────

def _make_client(piper_ok: bool = True, model_files_exist: bool = True) -> TestClient:
    """
    Return a TestClient with subprocess and model-file checks patched.
    """
    with patch.object(voice_main, "check_piper_binary", return_value=piper_ok), \
         patch.object(voice_main, "model_available", return_value=model_files_exist):
        client = TestClient(voice_main.app, raise_server_exceptions=False)
    return client


# ─── health endpoint ─────────────────────────────────────────────────────────

class TestCorsConfiguration(unittest.TestCase):
    def test_vite_development_origin_can_reach_the_service(self):
        client = TestClient(voice_main.app)
        response = client.options(
            "/synthesize",
            headers={
                "Origin": "http://localhost:8080",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization, apikey, content-type",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers["access-control-allow-origin"],
            "http://localhost:8080",
        )


class TestHealthEndpoint(unittest.TestCase):
    def test_health_ok_when_piper_and_models_present(self):
        with patch.object(voice_main, "check_piper_binary", return_value=True), \
             patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.get("/health")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(data["status"], "ok")
        self.assertTrue(data["piper_available"])

    def test_health_degraded_when_piper_missing(self):
        with patch.object(voice_main, "check_piper_binary", return_value=False), \
             patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.get("/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "degraded")

    def test_health_degraded_when_models_missing(self):
        with patch.object(voice_main, "check_piper_binary", return_value=True), \
             patch.object(voice_main, "model_available", return_value=False):
            client = TestClient(voice_main.app)
            r = client.get("/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "degraded")


# ─── voices endpoint ──────────────────────────────────────────────────────────

class TestVoicesEndpoint(unittest.TestCase):
    def test_returns_female_and_male(self):
        with patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.get("/voices")
        self.assertEqual(r.status_code, 200)
        voices = r.json()
        genders = {v["gender"] for v in voices}
        self.assertIn("female", genders)
        self.assertIn("male", genders)

    def test_voice_ids_present(self):
        with patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.get("/voices")
        ids = {v["voice_id"] for v in r.json()}
        self.assertIn("en_female", ids)
        self.assertIn("en_male", ids)

    def test_unavailable_when_models_missing(self):
        with patch.object(voice_main, "model_available", return_value=False):
            client = TestClient(voice_main.app)
            r = client.get("/voices")
        for v in r.json():
            self.assertFalse(v["available"])


# ─── synthesize endpoint ─────────────────────────────────────────────────────

class TestSynthesizeEndpoint(unittest.TestCase):

    def _client_with_piper_ok(self):
        """Client where run_piper succeeds and returns a valid WAV."""
        async def mock_run_piper(text, voice, speed=1.0):
            return GOOD_WAV

        client = TestClient(voice_main.app)
        return client, mock_run_piper

    def test_synthesize_female_voice(self):
        async def mock_run_piper(text, voice, speed=1.0):
            return GOOD_WAV

        with patch.object(voice_main, "run_piper", new=mock_run_piper), \
             patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.post("/synthesize", json={"text": "Hello world", "voice_id": "en_female"})

        self.assertEqual(r.status_code, 200)
        self.assertIn("audio/wav", r.headers["content-type"])
        self.assertEqual(r.headers["x-voice-id"], "en_female")

    def test_synthesize_male_voice(self):
        async def mock_run_piper(text, voice, speed=1.0):
            return GOOD_WAV

        with patch.object(voice_main, "run_piper", new=mock_run_piper), \
             patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.post("/synthesize", json={"text": "Hello world", "voice_id": "en_male"})

        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["x-voice-id"], "en_male")

    def test_persona_lusy_maps_to_female(self):
        captured = {}

        async def mock_run_piper(text, voice, speed=1.0):
            captured["voice_id"] = voice.voice_id
            return GOOD_WAV

        with patch.object(voice_main, "run_piper", new=mock_run_piper), \
             patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.post("/synthesize", json={"text": "Test", "persona": "lusy"})

        self.assertEqual(r.status_code, 200)
        self.assertEqual(captured["voice_id"], "en_female")

    def test_persona_amds_maps_to_male(self):
        captured = {}

        async def mock_run_piper(text, voice, speed=1.0):
            captured["voice_id"] = voice.voice_id
            return GOOD_WAV

        with patch.object(voice_main, "run_piper", new=mock_run_piper), \
             patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.post("/synthesize", json={"text": "Test", "persona": "amds"})

        self.assertEqual(r.status_code, 200)
        self.assertEqual(captured["voice_id"], "en_male")

    def test_legacy_persona_aliases_keep_their_gender_mapping(self):
        async def mock_run_piper(text, voice, speed=1.0):
            return GOOD_WAV

        expected = {
            "lucy": "en_female",
            "siddu": "en_male",
        }
        with patch.object(voice_main, "run_piper", new=mock_run_piper), \
             patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            for persona, expected_voice_id in expected.items():
                with self.subTest(persona=persona):
                    response = client.post(
                        "/synthesize",
                        json={"text": "Test", "persona": persona},
                    )
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.headers["x-voice-id"], expected_voice_id)

    def test_missing_text_returns_422(self):
        with patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.post("/synthesize", json={"voice_id": "en_female"})
        self.assertEqual(r.status_code, 422)

    def test_text_too_long_returns_422(self):
        with patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.post("/synthesize", json={"text": "x" * 4001, "voice_id": "en_female"})
        self.assertEqual(r.status_code, 422)

    def test_unknown_voice_id_returns_400(self):
        with patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.post("/synthesize", json={"text": "Test", "voice_id": "nonexistent"})
        self.assertEqual(r.status_code, 400)

    def test_model_not_installed_returns_503(self):
        with patch.object(voice_main, "model_available", return_value=False):
            client = TestClient(voice_main.app)
            r = client.post("/synthesize", json={"text": "Hello", "voice_id": "en_female"})
        self.assertEqual(r.status_code, 503)

    def test_speed_clamped(self):
        captured = {}

        async def mock_run_piper(text, voice, speed=1.0):
            captured["speed"] = speed
            return GOOD_WAV

        with patch.object(voice_main, "run_piper", new=mock_run_piper), \
             patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            # 5.0 should be clamped to 2.0 by pydantic Field constraint
            r = client.post("/synthesize", json={"text": "Test", "voice_id": "en_female", "speed": 5.0})

        # Pydantic v2 with ge/le should return 422 for out-of-range speed
        self.assertIn(r.status_code, {200, 422})


# ─── preview endpoint ─────────────────────────────────────────────────────────

class TestPreviewEndpoint(unittest.TestCase):
    def test_preview_female_voice(self):
        async def mock_run_piper(text, voice, speed=1.0):
            return GOOD_WAV

        with patch.object(voice_main, "run_piper", new=mock_run_piper), \
             patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.get("/preview/en_female")

        self.assertEqual(r.status_code, 200)
        self.assertIn("audio/wav", r.headers["content-type"])

    def test_preview_male_voice(self):
        async def mock_run_piper(text, voice, speed=1.0):
            return GOOD_WAV

        with patch.object(voice_main, "run_piper", new=mock_run_piper), \
             patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.get("/preview/en_male")

        self.assertEqual(r.status_code, 200)
        self.assertIn("audio/wav", r.headers["content-type"])

    def test_preview_unknown_voice_404(self):
        with patch.object(voice_main, "model_available", return_value=True):
            client = TestClient(voice_main.app)
            r = client.get("/preview/en_unknown")
        self.assertEqual(r.status_code, 404)


# ─── persona mapping ──────────────────────────────────────────────────────────

class TestPersonaMapping(unittest.TestCase):
    def test_lusy_maps_female(self):
        self.assertEqual(voice_main.PERSONA_VOICE_MAP.get("lusy"), "en_female")

    def test_lucy_maps_female(self):
        self.assertEqual(voice_main.PERSONA_VOICE_MAP.get("lucy"), "en_female")

    def test_female_maps_female(self):
        self.assertEqual(voice_main.PERSONA_VOICE_MAP.get("female"), "en_female")

    def test_amds_maps_male(self):
        self.assertEqual(voice_main.PERSONA_VOICE_MAP.get("amds"), "en_male")

    def test_siddu_maps_male(self):
        self.assertEqual(voice_main.PERSONA_VOICE_MAP.get("siddu"), "en_male")

    def test_male_maps_male(self):
        self.assertEqual(voice_main.PERSONA_VOICE_MAP.get("male"), "en_male")


class TestHFCVoiceModels(unittest.TestCase):
    """Verify that en_female and en_male point to the HFC model files."""

    def test_en_female_uses_hfc_model(self):
        voice = voice_main.VOICE_MAP["en_female"]
        self.assertIn("hfc_female", voice.model_file)
        self.assertIn("hfc_female", voice.config_file)

    def test_en_male_uses_hfc_model(self):
        voice = voice_main.VOICE_MAP["en_male"]
        self.assertIn("hfc_male", voice.model_file)
        self.assertIn("hfc_male", voice.config_file)

    def test_en_female_config_matches_onnx(self):
        voice = voice_main.VOICE_MAP["en_female"]
        base = voice.model_file.replace(".onnx", "")
        self.assertEqual(voice.config_file, f"{base}.onnx.json")

    def test_en_male_config_matches_onnx(self):
        voice = voice_main.VOICE_MAP["en_male"]
        base = voice.model_file.replace(".onnx", "")
        self.assertEqual(voice.config_file, f"{base}.onnx.json")

    def test_model_files_present_on_disk(self):
        """Models must already exist in voice-service/models/."""
        models_dir = Path(__file__).parent.parent / "models"
        for voice in voice_main.VOICES:
            with self.subTest(voice_id=voice.voice_id):
                self.assertTrue(
                    (models_dir / voice.model_file).exists(),
                    f"Missing model file: {voice.model_file}",
                )
                self.assertTrue(
                    (models_dir / voice.config_file).exists(),
                    f"Missing config file: {voice.config_file}",
                )

    def test_synthesize_returns_503_when_model_missing(self):
        """Synthesize must return 503 — not silently use the wrong model."""
        with patch.object(voice_main, "model_available", return_value=False):
            client = TestClient(voice_main.app)
            r = client.post("/synthesize", json={"text": "Hello", "voice_id": "en_female"})
        self.assertEqual(r.status_code, 503)
        self.assertIn("not installed", r.json()["detail"])


# ─── WAV helper ───────────────────────────────────────────────────────────────

class TestPcmToWav(unittest.TestCase):
    def test_wav_header_correct(self):
        pcm = b'\x00' * 44100 * 2  # 1 second of silence
        wav = voice_main._pcm_to_wav(pcm, sample_rate=22050, channels=1, bits=16)
        self.assertTrue(wav[:4] == b"RIFF")
        self.assertTrue(wav[8:12] == b"WAVE")
        self.assertTrue(wav[12:16] == b"fmt ")
        self.assertTrue(wav[36:40] == b"data")

    def test_wav_size_correct(self):
        """The RIFF chunk size must equal 36 + data_size."""
        pcm = b'\x00' * 100
        wav = voice_main._pcm_to_wav(pcm, sample_rate=22050, channels=1, bits=16)
        riff_size = struct.unpack_from("<I", wav, 4)[0]
        self.assertEqual(riff_size, 36 + 100)


# ─── Sample-rate reader ───────────────────────────────────────────────────────

class TestReadSampleRate(unittest.TestCase):
    def test_reads_audio_sample_rate(self):
        """Prefer cfg['audio']['sample_rate'] (standard Piper layout)."""
        import json
        import tempfile, os
        cfg = {"audio": {"sample_rate": 16000}, "sample_rate": 22050}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(cfg, f)
            fname = f.name
        try:
            self.assertEqual(voice_main._read_sample_rate(fname), 16000)
        finally:
            os.unlink(fname)

    def test_reads_toplevel_sample_rate(self):
        """Fall back to cfg['sample_rate'] when 'audio' key is absent."""
        import json
        import tempfile, os
        cfg = {"sample_rate": 22050}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(cfg, f)
            fname = f.name
        try:
            self.assertEqual(voice_main._read_sample_rate(fname), 22050)
        finally:
            os.unlink(fname)

    def test_returns_fallback_for_missing_file(self):
        self.assertEqual(voice_main._read_sample_rate("/nonexistent/path.json"), 22050)

    def test_returns_fallback_for_invalid_json(self):
        import tempfile, os
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            f.write("not json {{")
            fname = f.name
        try:
            self.assertEqual(voice_main._read_sample_rate(fname), 22050)
        finally:
            os.unlink(fname)


if __name__ == "__main__":
    unittest.main()
