"""Isolated generation workers.

Heavy model generation (video especially) is run in a disposable subprocess so a
native crash — a CUDA OOM, a bitsandbytes/torch ABI segfault, a driver fault —
fails only that one job instead of taking down the whole FastAPI backend (which
would also wipe every in-memory job, leaving clients polling a dead job id).
"""
