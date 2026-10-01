"""كتابة وقراءة الشاردات (Shards) — ملفات توكنات ثنائية تُقرأ عبر memmap بدون تحميلها للذاكرة."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from ..utils import atomic_write_json, read_json


class ShardWriter:
    """يكتب التوكنات تدريجيًا ويقسّمها إلى شاردات بحجم ثابت."""

    def __init__(self, directory: Path, prefix: str, dtype, eos_id: int,
                 shard_tokens: int, split: str, flush_tokens: int = 1_000_000):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.prefix, self.dtype, self.eos = prefix, dtype, eos_id
        self.shard_tokens, self.split, self.flush_tokens = shard_tokens, split, flush_tokens
        self.shards: list[dict] = []
        self._idx = 0
        self._buf: list[np.ndarray] = []
        self._buf_tokens = 0
        self._cur: dict | None = None

    def _open(self) -> None:
        sid = f"{self.prefix}-{self.split}-{self._idx:05d}"
        self._idx += 1
        self._cur = {"id": sid, "split": self.split, "tokens": 0, "docs": 0,
                     "dtype": np.dtype(self.dtype).name, "file": f"{sid}.bin"}
        path = self.dir / self._cur["file"]
        if path.exists():
            raise FileExistsError(f"الشارد موجود مسبقًا ولن يُستبدل: {path.name}")  # الشاردات غير قابلة للتعديل
        path.touch()

    def _flush(self) -> None:
        if not self._buf:
            return
        arr = np.concatenate(self._buf)
        with open(self.dir / self._cur["file"], "ab") as f:
            arr.tofile(f)
        self._buf, self._buf_tokens = [], 0

    def _close_current(self) -> None:
        if self._cur is None:
            return
        self._flush()
        atomic_write_json(self.dir / f"{self._cur['id']}.json", self._cur)
        self.shards.append(self._cur)
        self._cur = None

    def add(self, ids: list[int]) -> int:
        if self._cur is None:
            self._open()
        arr = np.asarray(ids + [self.eos], dtype=self.dtype)
        self._buf.append(arr)
        self._buf_tokens += len(arr)
        self._cur["tokens"] += len(arr)
        self._cur["docs"] += 1
        if self._buf_tokens >= self.flush_tokens:
            self._flush()
        if self._cur["tokens"] >= self.shard_tokens:
            self._close_current()
        return len(arr)

    def close(self) -> list[dict]:
        self._close_current()
        return self.shards

    def abort(self) -> None:
        """يحذف ما كُتب في حال فشل المعالجة."""
        if self._cur:
            self.shards.append(self._cur)
            self._cur = None
        for s in self.shards:
            for ext in (".bin", ".json"):
                p = self.dir / (s["id"] + ext)
                if p.exists():
                    p.unlink()


def open_shard(directory: Path, shard_id: str) -> np.memmap:
    meta = read_json(Path(directory) / f"{shard_id}.json")
    if meta is None:
        raise FileNotFoundError(f"shard metadata missing: {shard_id}")
    path = Path(directory) / meta["file"]
    if path.stat().st_size == 0:
        return np.zeros(0, dtype=meta["dtype"])
    return np.memmap(path, dtype=meta["dtype"], mode="r")
