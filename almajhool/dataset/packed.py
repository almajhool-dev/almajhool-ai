"""Dataset للتدريب يقرأ الشاردات عبر memmap ويقسّمها لكتل بطول السياق (Packing).

- لا يحمّل شيئًا للذاكرة: كل عنصر يُقرأ من القرص عند الطلب.
- Map-style → يعمل مع DistributedSampler (Multi-GPU) ومع استكمال التدريب.
"""
from __future__ import annotations

import bisect
from pathlib import Path

import numpy as np

from .shards import open_shard


class PackedTokenDataset:
    def __init__(self, shard_dir: Path, shard_ids: list[str], context_length: int,
                 max_blocks: int | None = None):
        self.ctx = context_length
        self.shards = [open_shard(shard_dir, s) for s in shard_ids]
        self.shards = [s for s in self.shards if len(s) >= context_length]
        counts = [len(s) // context_length for s in self.shards]
        self.cum = list(np.cumsum(counts)) if counts else []
        self.total = int(self.cum[-1]) if self.cum else 0
        if max_blocks:
            self.total = min(self.total, max_blocks)

    def __len__(self) -> int:
        return self.total

    def __getitem__(self, idx: int) -> dict:
        import torch

        if idx < 0 or idx >= self.total:
            raise IndexError(idx)
        si = bisect.bisect_right(self.cum, idx)
        local = idx - (self.cum[si - 1] if si > 0 else 0)
        start = int(local) * self.ctx
        ids = torch.from_numpy(np.asarray(self.shards[si][start:start + self.ctx], dtype=np.int64))
        return {"input_ids": ids, "labels": ids.clone(), "attention_mask": torch.ones_like(ids)}

    def tokens(self) -> int:
        return self.total * self.ctx
