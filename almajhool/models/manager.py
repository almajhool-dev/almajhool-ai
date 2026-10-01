"""إدارة إصدارات النموذج: v1, v1.1, v2 ...

كل إصدار يحفظ: النموذج الأساسي، الإصدار الأب، إصدار الداتاسيت، عملية التدريب،
مسار الـ Adapter، الإعدادات، ونتائج التقييم.
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path

from ..config import Paths
from ..utils import atomic_write_json, dir_size, file_lock, now_iso, read_json

_VER = re.compile(r"^v(\d+)(?:\.(\d+))?$")


def parse_version(v: str) -> tuple[int, int]:
    m = _VER.match(v)
    if not m:
        raise ValueError(f"صيغة إصدار غير صحيحة: {v}")
    return int(m.group(1)), int(m.group(2) or 0)


class ModelManager:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.paths = Paths(cfg).ensure()

    def _load(self) -> dict:
        return read_json(self.paths.model_registry, {"versions": [], "active": None})

    def _save(self, reg: dict) -> None:
        atomic_write_json(self.paths.model_registry, reg)

    def versions(self) -> list[dict]:
        return self._load()["versions"]

    def get(self, version: str) -> dict:
        for v in self.versions():
            if v["version"] == version:
                return v
        raise KeyError(f"إصدار النموذج غير موجود: {version}")

    def active(self) -> dict | None:
        reg = self._load()
        if reg["active"]:
            return next((v for v in reg["versions"] if v["version"] == reg["active"]), None)
        return reg["versions"][-1] if reg["versions"] else None

    def set_active(self, version: str) -> None:
        with file_lock(self.paths.model_registry):
            reg = self._load()
            if not any(v["version"] == version for v in reg["versions"]):
                raise KeyError(version)
            reg["active"] = version
            self._save(reg)

    def next_version(self, parent: str | None, bump: str = "minor") -> str:
        """أول نموذج أو bump=major → v(N+1). مواصلة تدريب إصدار سابق → v(N).(M+1)."""
        existing = {parse_version(v["version"]) for v in self.versions()}
        if parent is None or bump == "major":
            return f"v{max((m for m, _ in existing), default=0) + 1}"
        pm, _ = parse_version(parent)
        return f"v{pm}.{max((n for m, n in existing if m == pm), default=0) + 1}"

    def version_dir(self, version: str) -> Path:
        return self.paths.models / version

    def register(self, entry: dict, activate: bool = True) -> dict:
        with file_lock(self.paths.model_registry):
            reg = self._load()
            if any(v["version"] == entry["version"] for v in reg["versions"]):
                raise ValueError(f"الإصدار موجود مسبقًا: {entry['version']}")
            entry.setdefault("created", now_iso())
            d = self.version_dir(entry["version"])
            entry["size_bytes"] = dir_size(d) if d.exists() else 0
            atomic_write_json(d / "model_card.json", entry)
            reg["versions"].append(entry)
            if activate:
                reg["active"] = entry["version"]
            self._save(reg)
        return entry

    def update(self, version: str, **fields) -> None:
        with file_lock(self.paths.model_registry):
            reg = self._load()
            for v in reg["versions"]:
                if v["version"] == version:
                    v.update(fields)
                    atomic_write_json(self.version_dir(version) / "model_card.json", v)
            self._save(reg)

    def lineage(self, version: str) -> list[dict]:
        out, cur = [], version
        while cur:
            v = self.get(cur)
            out.append(v)
            cur = v.get("parent")
        return out[::-1]

    def merge(self, version: str) -> Path:
        """يدمج الـ LoRA في النموذج الأساسي (مطلوب للنشر على vLLM/Ollama/HF بدون PEFT)."""
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer

        v = self.get(version)
        out = self.version_dir(version) / "merged"
        base = AutoModelForCausalLM.from_pretrained(
            v["base_model"], torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
            trust_remote_code=self.cfg["model"].get("trust_remote_code", False))
        # كل إصدار يحمل Adapter تراكميًا (مواصلة تدريب Adapter الأب)، فيكفي دمج Adapter الإصدار نفسه
        if v.get("adapter_path"):
            base = PeftModel.from_pretrained(base, self.paths.root / v["adapter_path"]).merge_and_unload()
        base.save_pretrained(out, safe_serialization=True)
        AutoTokenizer.from_pretrained(v["base_model"]).save_pretrained(out)
        self.update(version, merged_path=str(out.relative_to(self.paths.root)))
        return out

    def delete(self, version: str) -> None:
        with file_lock(self.paths.model_registry):
            reg = self._load()
            if any(v.get("parent") == version for v in reg["versions"]):
                raise ValueError("لا يمكن حذف إصدار تعتمد عليه إصدارات أخرى")
            reg["versions"] = [v for v in reg["versions"] if v["version"] != version]
            if reg["active"] == version:
                reg["active"] = reg["versions"][-1]["version"] if reg["versions"] else None
            self._save(reg)
        shutil.rmtree(self.version_dir(version), ignore_errors=True)
