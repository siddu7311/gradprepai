"""Quick smoke-test: invoke piper via stdin redirect and --output_file."""
import subprocess, os, uuid, time
from pathlib import Path
import tempfile

piper = str(Path(__file__).parent / "bin" / "piper.exe")
model = str(Path(__file__).parent / "models" / "en_US-hfc_male-medium.onnx")
cfg   = str(Path(__file__).parent / "models" / "en_US-hfc_male-medium.onnx.json")
espk  = str(Path(__file__).parent / "bin" / "espeak-ng-data")

tmp   = Path(tempfile.gettempdir())
txt_f = tmp / ("pin_" + uuid.uuid4().hex + ".txt")
wav_f = tmp / ("pout_" + uuid.uuid4().hex + ".wav")

txt_f.write_text("Hello I am Siddu.", encoding="utf-8")
env   = {**os.environ, "ESPEAK_DATA_PATH": espk}
cmd   = [piper, "--model", model, "--config", cfg,
         "--output_file", str(wav_f), "--length-scale", "1.0"]

print("Running piper via file-redirect stdin + --output_file ...")
t0 = time.time()
with open(txt_f, "rb") as fin:
    proc = subprocess.Popen(
        cmd, stdin=fin, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env
    )
    _, err = proc.communicate(timeout=20)
elapsed = time.time() - t0

print(f"rc={proc.returncode}  elapsed={elapsed:.2f}s")
print(f"stderr={err[:300].decode('utf-8','replace')}")
if wav_f.exists():
    print(f"WAV size={wav_f.stat().st_size} bytes  -> OK")
    wav_f.unlink()
else:
    print("WAV file not created -> FAILED")

txt_f.unlink(missing_ok=True)
