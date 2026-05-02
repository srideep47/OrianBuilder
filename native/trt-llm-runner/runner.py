"""
OrianBuilder TensorRT-LLM Python Sidecar Runner
================================================
Reads JSON-line requests from stdin, writes JSON-line responses to stdout.

Protocol (all messages are single-line JSON terminated by \n):

  Request types:
    { "id": "...", "type": "build", "modelId": "Qwen/Qwen2.5-0.5B-Instruct",
      "outputDir": "...", "maxInputLen": 8192, "maxOutputLen": 2048,
      "dtype": "fp16" }

    { "id": "...", "type": "load", "engineDir": "..." }

    { "id": "...", "type": "chat", "stream": true/false,
      "system": "...", "prompt": "...",
      "maxTokens": 512, "temperature": 0.7, "topP": 0.95, "topK": 40,
      "stop": ["<|im_end|>"] }

    { "id": "...", "type": "unload" }

    { "id": "...", "type": "status" }

  Response types:
    { "id": "...", "ok": true }                          -- ack for load/unload
    { "id": "...", "ok": false, "error": "..." }         -- any error
    { "id": "...", "type": "token", "text": "..." }      -- streaming token
    { "id": "...", "type": "done",                       -- chat complete
      "text": "...", "tokenCount": N, "promptTokens": N,
      "prefillDurationMs": N, "decodeTps": F, "durationMs": N }
    { "id": "...", "type": "build_progress",             -- build phase update
      "phase": "...", "message": "..." }
    { "id": "...", "type": "build_done",                 -- build complete
      "engineDir": "...", "durationMs": N }
    { "id": "...", "type": "status", "loaded": bool,
      "engineDir": "...", "modelId": "...",
      "trtVersion": "...", "torchVersion": "..." }
"""

from __future__ import annotations

import gc
import json
import math
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Stdout flushing helper — every write must flush immediately so Electron
# reads it without waiting for the buffer to fill.
# ---------------------------------------------------------------------------

def emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_error(req_id: str, msg: str) -> None:
    emit({"id": req_id, "ok": False, "error": msg})


# ---------------------------------------------------------------------------
# Lazy imports — only pulled in when actually needed so the process starts
# fast and errors surface as proper JSON responses rather than import crashes.
# ---------------------------------------------------------------------------

_torch: Any = None
_trt: Any = None
_transformers: Any = None


def _get_torch():
    global _torch
    if _torch is None:
        import torch
        _torch = torch
    return _torch


def _get_trt():
    global _trt
    if _trt is None:
        import tensorrt as trt
        _trt = trt
    return _trt


def _get_transformers():
    global _transformers
    if _transformers is None:
        import transformers
        _transformers = transformers
    return _transformers


# ---------------------------------------------------------------------------
# Engine build
# ---------------------------------------------------------------------------

def _build_engine(req_id: str, model_id: str, output_dir: str,
                  max_input_len: int, max_output_len: int, dtype: str) -> None:
    """
    Export a HuggingFace causal-LM to ONNX then compile to a TensorRT engine.
    Uses TensorRT's ONNX parser — no TensorRT-LLM required.
    """
    import shutil
    import subprocess

    torch = _get_torch()
    trt = _get_trt()
    transformers = _get_transformers()

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    onnx_path = out / "model.onnx"
    engine_path = out / "model.engine"
    t0 = time.monotonic()

    def progress(phase: str, message: str) -> None:
        emit({"id": req_id, "type": "build_progress", "phase": phase, "message": message})

    # ── Step 1: download / load model ────────────────────────────────────────
    progress("downloading", f"Loading {model_id} from HuggingFace cache…")
    AutoTokenizer = transformers.AutoTokenizer
    AutoModelForCausalLM = transformers.AutoModelForCausalLM

    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    torch_dtype = torch.float16 if dtype == "fp16" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        torch_dtype=torch_dtype,
        trust_remote_code=True,
        device_map="cpu",   # export on CPU to avoid VRAM pressure
    )
    model.eval()

    # Save tokenizer into the engine dir so the runner can load it
    tokenizer.save_pretrained(str(out))
    progress("downloading", "Tokenizer saved.")

    # ── Step 2: export ONNX ──────────────────────────────────────────────────
    progress("exporting", f"Exporting ONNX to {onnx_path}…")

    # Build a minimal dummy input
    dummy_ids = torch.zeros((1, 16), dtype=torch.long)
    dummy_mask = torch.ones((1, 16), dtype=torch.long)

    # Export with use_cache=False — transformers ≥5.x returns DynamicCache objects
    # which torch.onnx.export cannot trace. We do full-context re-evaluation each
    # decode step anyway, so we don't need KV cache outputs in the ONNX graph.
    class _NoCacheWrapper(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m
        def forward(self, input_ids, attention_mask):
            out = self.m(input_ids=input_ids, attention_mask=attention_mask,
                         use_cache=False)
            return out.logits

    wrapped = _NoCacheWrapper(model)

    input_names = ["input_ids", "attention_mask"]
    output_names = ["logits"]
    dynamic_axes: dict[str, dict[int, str]] = {
        "input_ids": {0: "batch", 1: "seq"},
        "attention_mask": {0: "batch", 1: "seq"},
        "logits": {0: "batch", 1: "seq"},
    }

    with torch.no_grad():
        import torch.onnx
        torch.onnx.export(
            wrapped,
            (dummy_ids, dummy_mask),
            str(onnx_path),
            input_names=input_names,
            output_names=output_names,
            dynamic_axes=dynamic_axes,
            opset_version=17,
            do_constant_folding=True,
        )

    # Free model weights — we're done with them on the Python side
    del model
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    progress("exporting", "ONNX export complete.")

    # ── Step 3: build TensorRT engine via trtexec ────────────────────────────
    # Using trtexec is simpler than driving the TRT Python API directly for
    # models with complex dynamic shapes — and avoids workspace OOM issues.
    progress("building", "Compiling TensorRT engine (this may take 10–30 min)…")

    trtexec = _find_trtexec()
    if not trtexec:
        raise RuntimeError(
            "trtexec not found. Set TENSORRT_ROOT or add TensorRT bin to PATH."
        )

    max_seq = max_input_len + max_output_len
    trt_args = [
        trtexec,
        f"--onnx={onnx_path}",
        f"--saveEngine={engine_path}",
        "--fp16" if dtype == "fp16" else "--noTF32",
        "--minShapes=input_ids:1x1,attention_mask:1x1",
        f"--optShapes=input_ids:1x{max_input_len},attention_mask:1x{max_input_len}",
        f"--maxShapes=input_ids:1x{max_seq},attention_mask:1x{max_seq}",
        "--memPoolSize=workspace:6144",
        "--verbose",
    ]

    proc = subprocess.Popen(
        trt_args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            progress("building", line[:200])
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"trtexec failed (exit {proc.returncode})")

    # ── Step 4: write engine_meta.json ───────────────────────────────────────
    progress("writing_meta", "Writing engine_meta.json…")
    import subprocess as _sp
    gpu_name = "unknown"
    try:
        r = _sp.run(
            ["nvidia-smi", "--query-gpu=name,compute_cap", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10,
        )
        parts = r.stdout.strip().split(",")
        gpu_name = parts[0].strip() if parts else "unknown"
        compute_cap = parts[1].strip() if len(parts) > 1 else "unknown"
    except Exception:
        compute_cap = "unknown"

    trt_version = "unknown"
    try:
        trt_version = trt.__version__
    except Exception:
        pass

    meta = {
        "format": "tensorrt-llm",
        "modelId": model_id,
        "engineFile": "model.engine",
        "tokenizerPath": ".",
        "maxInputLen": max_input_len,
        "maxOutputLen": max_output_len,
        "maxBatchSize": 1,
        "dtype": dtype,
        "quantization": "none",
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "gpu": gpu_name,
        "computeCapability": compute_cap,
        "tensorRtVersion": trt_version,
    }
    (out / "engine_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    emit({
        "id": req_id,
        "type": "build_done",
        "engineDir": str(out),
        "durationMs": elapsed_ms,
    })


def _find_trtexec() -> str | None:
    import shutil
    exe = shutil.which("trtexec")
    if exe:
        return exe
    for env_var in ("TENSORRT_ROOT", "ORIAN_TENSORRT_ROOT"):
        root = os.environ.get(env_var)
        if root:
            candidate = Path(root) / "bin" / "trtexec.exe"
            if candidate.exists():
                return str(candidate)
    return None


# ---------------------------------------------------------------------------
# Loaded engine session
# ---------------------------------------------------------------------------

class _EngineSession:
    """
    Wraps a loaded TensorRT engine.
    Handles tokenization → prefill → decode loop → sampling.
    """

    def __init__(self, engine_dir: str) -> None:
        torch = _get_torch()
        trt = _get_trt()
        transformers = _get_transformers()

        self.engine_dir = Path(engine_dir)
        meta_path = self.engine_dir / "engine_meta.json"
        if not meta_path.exists():
            raise FileNotFoundError(f"engine_meta.json not found in {engine_dir}")

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        self.meta = meta
        self.model_id: str = meta.get("modelId", "unknown")
        self.max_input_len: int = int(meta.get("maxInputLen", 8192))
        self.max_output_len: int = int(meta.get("maxOutputLen", 2048))

        # Load tokenizer from engine dir
        tok_path = str(self.engine_dir / meta.get("tokenizerPath", "."))
        self.tokenizer = transformers.AutoTokenizer.from_pretrained(
            tok_path, trust_remote_code=True
        )

        # Load TensorRT engine
        engine_file = self.engine_dir / meta.get("engineFile", "model.engine")
        if not engine_file.exists():
            raise FileNotFoundError(f"Engine file not found: {engine_file}")

        trt_logger = trt.Logger(trt.Logger.WARNING)
        runtime = trt.Runtime(trt_logger)
        with open(engine_file, "rb") as f:
            engine_data = f.read()
        self.engine = runtime.deserialize_cuda_engine(engine_data)
        if self.engine is None:
            raise RuntimeError("deserialize_cuda_engine returned None")
        self.context = self.engine.create_execution_context()
        if self.context is None:
            raise RuntimeError("create_execution_context returned None")

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    def _apply_chat_template(self, system: str, prompt: str) -> str:
        """Format system+user into the model's native chat template."""
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        try:
            text = self.tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
        except Exception:
            # Fallback for tokenizers without a chat template
            parts = []
            if system:
                parts.append(f"<|im_start|>system\n{system}<|im_end|>")
            parts.append(f"<|im_start|>user\n{prompt}<|im_end|>")
            parts.append("<|im_start|>assistant\n")
            text = "\n".join(parts)
        return text

    def _run_forward(self, input_ids_list: list[int]) -> list[float]:
        """
        Run a single forward pass through the TensorRT engine.
        Returns the logits for the last token as a plain Python list[float].
        """
        import numpy as np
        torch = _get_torch()
        trt = _get_trt()

        seq_len = len(input_ids_list)
        ids_np = np.array([input_ids_list], dtype=np.int32)  # [1, seq]
        mask_np = np.ones((1, seq_len), dtype=np.int32)

        # Find vocab size from the engine output binding named "logits"
        vocab_size = None
        for i in range(self.engine.num_io_tensors):
            name = self.engine.get_tensor_name(i)
            if name == "logits":
                shape = self.engine.get_tensor_shape(name)
                vocab_size = shape[-1]
                break
        if vocab_size is None or vocab_size <= 0:
            raise RuntimeError("Could not determine vocab size from engine")

        # Allocate output buffer
        logits_np = np.zeros((1, seq_len, vocab_size), dtype=np.float32)

        # Set shapes and bind buffers
        self.context.set_input_shape("input_ids", ids_np.shape)
        self.context.set_input_shape("attention_mask", mask_np.shape)

        ids_cuda = torch.from_numpy(ids_np).to(self.device)
        mask_cuda = torch.from_numpy(mask_np).to(self.device)
        logits_cuda = torch.zeros((1, seq_len, vocab_size),
                                   dtype=torch.float32, device=self.device)

        self.context.set_tensor_address("input_ids", ids_cuda.data_ptr())
        self.context.set_tensor_address("attention_mask", mask_cuda.data_ptr())
        self.context.set_tensor_address("logits", logits_cuda.data_ptr())

        # Set output tensor addresses for any present_key/value tensors
        for i in range(self.engine.num_io_tensors):
            name = self.engine.get_tensor_name(i)
            if name.startswith("present_"):
                mode = self.engine.get_tensor_mode(name)
                if mode == trt.TensorIOMode.OUTPUT:
                    shape = list(self.context.get_tensor_shape(name))
                    # Replace any -1 dims with reasonable defaults
                    shape = [max(1, d) for d in shape]
                    buf = torch.zeros(shape, dtype=torch.float32, device=self.device)
                    self.context.set_tensor_address(name, buf.data_ptr())

        ok = self.context.execute_async_v3(
            torch.cuda.current_stream(self.device).cuda_stream
            if self.device.type == "cuda" else 0
        )
        if not ok:
            raise RuntimeError("execute_async_v3 returned False")

        if self.device.type == "cuda":
            torch.cuda.synchronize(self.device)

        # Return last-token logits
        last_logits = logits_cuda[0, -1, :].cpu().tolist()
        return last_logits

    def _sample(self, logits: list[float], temperature: float,
                top_p: float, top_k: int) -> int:
        """Sample next token from logits."""
        import math
        torch = _get_torch()

        t = torch.tensor(logits, dtype=torch.float32)

        # Temperature
        if temperature > 0:
            t = t / max(temperature, 1e-6)

        # Top-K
        if top_k > 0:
            k = min(top_k, t.size(-1))
            top_k_vals, _ = torch.topk(t, k)
            min_val = top_k_vals[-1]
            t = t.masked_fill(t < min_val, float("-inf"))

        # Softmax → probabilities
        probs = torch.softmax(t, dim=-1)

        # Top-P nucleus
        if top_p < 1.0:
            sorted_probs, sorted_idx = torch.sort(probs, descending=True)
            cumulative = torch.cumsum(sorted_probs, dim=-1)
            # Remove tokens above the cumulative threshold
            sorted_probs[cumulative - sorted_probs > top_p] = 0.0
            probs = torch.zeros_like(probs)
            probs.scatter_(0, sorted_idx, sorted_probs)
            probs_sum = probs.sum()
            if probs_sum > 0:
                probs = probs / probs_sum

        if temperature <= 0:
            # Greedy
            return int(torch.argmax(probs).item())

        return int(torch.multinomial(probs, num_samples=1).item())

    def chat(
        self,
        req_id: str,
        system: str,
        prompt: str,
        max_tokens: int,
        temperature: float,
        top_p: float,
        top_k: int,
        stop: list[str],
        stream: bool,
    ) -> None:
        """
        Run a complete chat request. Emits streaming token events if stream=True,
        then a done event regardless.
        """
        t_start = time.monotonic()

        text = self._apply_chat_template(system, prompt)
        input_ids: list[int] = self.tokenizer.encode(text, add_special_tokens=False)
        prompt_tokens = len(input_ids)

        if prompt_tokens > self.max_input_len:
            # Truncate from the left, keeping as much context as possible
            input_ids = input_ids[-self.max_input_len:]
            prompt_tokens = len(input_ids)

        # EOS / stop-token ids
        eos_ids: set[int] = set()
        if self.tokenizer.eos_token_id is not None:
            eos_ids.add(self.tokenizer.eos_token_id)
        # Common Qwen end tokens
        for tok in ["<|im_end|>", "<|endoftext|>", "<|end|>"]:
            tid = self.tokenizer.convert_tokens_to_ids(tok)
            if isinstance(tid, int) and tid != self.tokenizer.unk_token_id:
                eos_ids.add(tid)

        # Prefill
        t_prefill_start = time.monotonic()
        current_ids = list(input_ids)
        logits = self._run_forward(current_ids)
        prefill_ms = int((time.monotonic() - t_prefill_start) * 1000)

        generated_ids: list[int] = []
        generated_text = ""
        decode_start = time.monotonic()

        for _ in range(min(max_tokens, self.max_output_len)):
            next_id = self._sample(logits, temperature, top_p, top_k)

            if next_id in eos_ids:
                break

            generated_ids.append(next_id)
            token_text = self.tokenizer.decode(
                [next_id], skip_special_tokens=True, clean_up_tokenization_spaces=False
            )

            # Check stop strings
            generated_text += token_text
            hit_stop = any(s in generated_text for s in stop if s)
            if hit_stop:
                # Trim trailing stop string from output
                for s in stop:
                    if s and generated_text.endswith(s):
                        generated_text = generated_text[: -len(s)]
                break

            if stream and token_text:
                emit({"id": req_id, "type": "token", "text": token_text})

            # Next step: append and re-run (full context re-evaluation)
            # This is the simple but correct approach for an ONNX-based engine.
            current_ids.append(next_id)
            logits = self._run_forward(current_ids)

        decode_ms = max(1, int((time.monotonic() - decode_start) * 1000))
        total_ms = int((time.monotonic() - t_start) * 1000)
        token_count = len(generated_ids)
        decode_tps = (token_count / decode_ms) * 1000 if decode_ms > 0 else 0

        emit({
            "id": req_id,
            "type": "done",
            "text": generated_text,
            "tokenCount": token_count,
            "promptTokens": prompt_tokens,
            "prefillDurationMs": prefill_ms,
            "decodeTps": round(decode_tps, 2),
            "durationMs": total_ms,
        })

    def unload(self) -> None:
        try:
            del self.context
        except Exception:
            pass
        try:
            del self.engine
        except Exception:
            pass
        torch = _get_torch()
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


# ---------------------------------------------------------------------------
# Main request loop
# ---------------------------------------------------------------------------

def main() -> None:
    session: _EngineSession | None = None

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            emit({"id": "", "ok": False, "error": f"Invalid JSON: {e}"})
            continue

        req_id: str = req.get("id", "")
        req_type: str = req.get("type", "")

        try:
            if req_type == "status":
                torch_ver = "unavailable"
                trt_ver = "unavailable"
                try:
                    import torch
                    torch_ver = torch.__version__
                except Exception:
                    pass
                try:
                    import tensorrt as trt
                    trt_ver = trt.__version__
                except Exception:
                    pass
                emit({
                    "id": req_id,
                    "type": "status",
                    "loaded": session is not None,
                    "engineDir": str(session.engine_dir) if session else None,
                    "modelId": session.model_id if session else None,
                    "trtVersion": trt_ver,
                    "torchVersion": torch_ver,
                })

            elif req_type == "build":
                model_id = req.get("modelId", "Qwen/Qwen2.5-0.5B-Instruct")
                output_dir = req.get("outputDir", "")
                if not output_dir:
                    emit_error(req_id, "outputDir is required for build")
                    continue
                max_input_len = int(req.get("maxInputLen", 4096))
                max_output_len = int(req.get("maxOutputLen", 2048))
                dtype = req.get("dtype", "fp16")
                _build_engine(req_id, model_id, output_dir,
                              max_input_len, max_output_len, dtype)

            elif req_type == "load":
                engine_dir = req.get("engineDir", "")
                if not engine_dir:
                    emit_error(req_id, "engineDir is required")
                    continue
                if session is not None:
                    session.unload()
                    session = None
                session = _EngineSession(engine_dir)
                emit({"id": req_id, "ok": True,
                      "modelId": session.model_id,
                      "maxInputLen": session.max_input_len})

            elif req_type == "unload":
                if session is not None:
                    session.unload()
                    session = None
                emit({"id": req_id, "ok": True})

            elif req_type == "chat":
                if session is None:
                    emit_error(req_id, "No engine loaded. Send a 'load' request first.")
                    continue
                session.chat(
                    req_id=req_id,
                    system=req.get("system", ""),
                    prompt=req.get("prompt", ""),
                    max_tokens=int(req.get("maxTokens", 512)),
                    temperature=float(req.get("temperature", 0.7)),
                    top_p=float(req.get("topP", 0.95)),
                    top_k=int(req.get("topK", 40)),
                    stop=req.get("stop", []),
                    stream=bool(req.get("stream", True)),
                )

            else:
                emit_error(req_id, f"Unknown request type: {req_type!r}")

        except Exception as exc:
            tb = traceback.format_exc()
            emit({"id": req_id, "ok": False,
                  "error": str(exc), "traceback": tb[-2000:]})


if __name__ == "__main__":
    # Ensure stdout is unbuffered line-by-line
    sys.stdout = os.fdopen(sys.stdout.fileno(), "w", buffering=1, encoding="utf-8")
    main()
