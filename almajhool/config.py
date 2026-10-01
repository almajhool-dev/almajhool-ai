"""الإعدادات المركزية — تُقرأ من config/default.yaml ويمكن تجاوزها بملف آخر أو متغيرات البيئة."""
from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent

DEFAULTS: dict[str, Any] = {
    "workspace": "workspace",
    "model": {
        # النموذج الأساسي الافتراضي — يمكن تغييره بأي نموذج HF متوافق مع AutoModelForCausalLM
        "base": "Qwen/Qwen3-1.7B",
        "trust_remote_code": False,
    },
    "data": {
        "min_chars": 30,
        "max_doc_chars": 200_000,      # المستندات الأطول تُقطّع إلى أجزاء بهذا الحجم
        "min_letter_ratio": 0.5,       # نسبة الحروف (أي لغة) إلى طول النص
        "max_repeated_line_ratio": 0.5,
        "shard_tokens": 50_000_000,    # حجم الشارد الواحد بالتوكنات (~200MB بصيغة uint32)
        "eval_permille": 5,            # 0.5% من المستندات تذهب لمجموعة التقييم
        "tokenize_batch": 256,
        "dedup": True,
    },
    "training": {
        "method": "qlora",             # qlora | lora | full
        "epochs": 1,
        "batch_size": 2,
        "grad_accum": 8,
        "learning_rate": 2e-4,
        "lora_rank": 16,
        "lora_alpha": 32,
        "lora_dropout": 0.05,
        "context_length": 2048,
        "warmup_ratio": 0.03,
        "save_steps": 200,
        "eval_steps": 200,
        "logging_steps": 10,
        "save_total_limit": None,      # None = الاحتفاظ بكل الـ Checkpoints
        "gradient_checkpointing": True,
        "max_steps": -1,
        "seed": 42,
    },
    "evaluation": {
        "ppl_max_blocks": 200,
        "prompts_file": "config/eval_prompts.jsonl",
        "max_new_tokens": 256,
    },
    "server": {"host": "0.0.0.0", "port": 8000},
}


def _deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(path: str | os.PathLike | None = None) -> dict[str, Any]:
    cfg = copy.deepcopy(DEFAULTS)
    default_file = PROJECT_ROOT / "config" / "default.yaml"
    for p in [default_file, path or os.environ.get("ALMAJHOOL_CONFIG")]:
        if p and Path(p).exists():
            with open(p, encoding="utf-8") as f:
                cfg = _deep_merge(cfg, yaml.safe_load(f) or {})
    if os.environ.get("ALMAJHOOL_HOME"):
        cfg["workspace"] = os.environ["ALMAJHOOL_HOME"]
    ws = Path(cfg["workspace"])
    if not ws.is_absolute():
        ws = PROJECT_ROOT / ws
    cfg["workspace"] = str(ws)
    return cfg


class Paths:
    """كل المسارات داخل مساحة العمل في مكان واحد."""

    def __init__(self, cfg: dict[str, Any]):
        self.root = Path(cfg["workspace"])
        self.datasets = self.root / "datasets"
        self.sources = self.datasets / "sources"
        self.shards = self.datasets / "shards"
        self.registry = self.datasets / "registry.json"
        self.dedup_db = self.datasets / "dedup.sqlite"
        self.incoming = self.root / "incoming"
        self.models = self.root / "models"
        self.model_registry = self.models / "registry.json"
        self.runs = self.root / "runs"
        self.evals = self.root / "evals"
        self.backups = self.root / "backups"
        self.jobs = self.root / "jobs"

    def ensure(self) -> "Paths":
        for p in [self.datasets, self.sources, self.shards, self.incoming, self.models,
                  self.runs, self.evals, self.backups, self.jobs]:
            p.mkdir(parents=True, exist_ok=True)
        return self
