#!/usr/bin/env python3
"""
Orbit transcription sidecar.

Long-running process: loads an MLX Whisper model once, then reads JSON
commands (one per line) from stdin and writes JSON results to stdout.

Protocol
  stdin :  {"id": <int>, "path": "<file of raw float32 mono 16kHz samples>"}
  stdout:  {"type":"log","msg":"ready"}                 # once model is warm
           {"type":"result","id":<int>,"text":"..."}    # per segment
           {"type":"error","id":<int>,"msg":"..."}
"""
import sys
import json
import numpy as np

# Map friendly names -> MLX-community HF repos (auto-downloaded on first use).
REPOS = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
}

SAMPLE_RATE = 16000


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    model_name = sys.argv[1] if len(sys.argv) > 1 else "base"
    repo = REPOS.get(model_name, REPOS["base"])

    try:
        import mlx_whisper
    except Exception as e:  # pragma: no cover
        emit({"type": "error", "id": None, "msg": f"mlx_whisper import failed: {e}"})
        return

    emit({"type": "log", "msg": f"loading {repo}"})
    # Warm up (downloads weights on first run) with 0.5s of silence.
    try:
        mlx_whisper.transcribe(
            np.zeros(SAMPLE_RATE // 2, dtype=np.float32),
            path_or_hf_repo=repo,
        )
    except Exception as e:
        emit({"type": "error", "id": None, "msg": f"model load failed: {e}"})
        return
    emit({"type": "log", "msg": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            audio = np.fromfile(req["path"], dtype=np.float32)
            if audio.size == 0:
                emit({"type": "result", "id": req["id"], "text": ""})
                continue
            result = mlx_whisper.transcribe(audio, path_or_hf_repo=repo)
            emit({"type": "result", "id": req["id"], "text": result.get("text", "").strip()})
        except Exception as e:
            emit({"type": "error", "id": (req or {}).get("id"), "msg": str(e)})


if __name__ == "__main__":
    main()
