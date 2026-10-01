"""مدير الداتاسيت: إضافة بيانات تدريجيًا + إصدارات (v1, v2, ...) قابلة للتتبع.

المبدأ:
- الشاردات غير قابلة للتعديل (immutable). كل إصدار = قائمة شاردات.
- الإصدار الجديد = شاردات الإصدار السابق + الشاردات الجديدة → لا تكرار للبيانات على القرص.
- كل تدريب يسجّل إصدار الداتاسيت الذي استخدمه بالضبط.
- الملفات الأصلية تُحفظ (sources/) حتى نستطيع إعادة الترميز بـ Tokenizer مختلف لاحقًا.
"""
from __future__ import annotations

import os
import re
import shutil
import time
from pathlib import Path
from typing import Callable, Iterable

from ..config import Paths
from ..tokenizer import get_tokenizer, token_dtype
from ..utils import atomic_write_json, file_lock, now_iso, read_json, sha256_file
from .cleaning import DedupIndex, clean_doc, doc_fingerprint
from .readers import SUPPORTED, read_documents
from .shards import ShardWriter

ProgressFn = Callable[[dict], None]


def tok_slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "__", name)


class DatasetManager:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.dcfg = cfg["data"]
        self.paths = Paths(cfg).ensure()

    # ---------- السجل ----------
    def _load(self) -> dict:
        return read_json(self.paths.registry, {"versions": [], "sources": {}})

    def _save(self, reg: dict) -> None:
        if self.paths.registry.exists():
            # نسخة احتياطية من السجل قبل كل تعديل
            hist = self.paths.datasets / "registry_history"
            hist.mkdir(exist_ok=True)
            shutil.copy2(self.paths.registry, hist / f"registry-{int(time.time()*1000)}.json")
        atomic_write_json(self.paths.registry, reg)

    def shard_dir(self, tokenizer: str) -> Path:
        return self.paths.shards / tok_slug(tokenizer)

    def versions(self, tokenizer: str | None = None) -> list[dict]:
        vs = self._load()["versions"]
        return [v for v in vs if tokenizer is None or v["tokenizer"] == tokenizer]

    def get_version(self, version: str) -> dict:
        for v in self._load()["versions"]:
            if v["version"] == version:
                return v
        raise KeyError(f"إصدار الداتاسيت غير موجود: {version}")

    def latest(self, tokenizer: str | None = None) -> dict | None:
        vs = self.versions(tokenizer)
        return vs[-1] if vs else None

    def _next_version_name(self, reg: dict) -> str:
        nums = [int(v["version"][1:]) for v in reg["versions"] if v["version"][1:].isdigit()]
        return f"v{max(nums, default=0) + 1}"

    # ---------- الإضافة ----------
    def add_files(self, files: Iterable[str | Path], tokenizer: str | None = None,
                  note: str = "", keep_sources: bool = True,
                  progress: ProgressFn | None = None) -> dict:
        tokenizer = tokenizer or self.cfg["model"]["base"]
        tok = get_tokenizer(tokenizer, self.cfg["model"].get("trust_remote_code", False))
        files = [Path(f) for f in files]
        for f in files:
            if f.suffix.lower() not in SUPPORTED:
                raise ValueError(f"صيغة غير مدعومة: {f.name}")
            if not f.exists():
                raise FileNotFoundError(f)

        with file_lock(self.paths.registry):
            reg = self._load()
            ingested = {s for s, meta in reg["sources"].items()
                        if tokenizer in meta.get("tokenizers", [])}
            out_dir = self.shard_dir(tokenizer)
            batch_id = time.strftime("%Y%m%d%H%M%S") + os.urandom(3).hex()  # فريد دائمًا
            dtype = token_dtype(tok.vocab_size)
            train_w = ShardWriter(out_dir, f"b{batch_id}", dtype, tok.eos_token_id,
                                  self.dcfg["shard_tokens"], "train")
            eval_w = ShardWriter(out_dir, f"b{batch_id}", dtype, tok.eos_token_id,
                                 self.dcfg["shard_tokens"], "eval")
            dedup = DedupIndex(out_dir / "dedup.sqlite") if self.dcfg["dedup"] else None
            report: dict = {"files": [], "totals": {}}
            new_sources: dict[str, dict] = {}
            try:
                for f in files:
                    sha = sha256_file(f)
                    if sha in ingested or sha in new_sources:
                        report["files"].append({"file": f.name, "sha256": sha, "status": "already_ingested"})
                        continue
                    stats = self._ingest_file(f, tok, train_w, eval_w, dedup, progress)
                    stats.update({"file": f.name, "sha256": sha, "status": "ok"})
                    report["files"].append(stats)
                    src_meta = reg["sources"].get(sha, {"name": f.name, "bytes": f.stat().st_size,
                                                        "added": now_iso(), "tokenizers": []})
                    src_meta["tokenizers"] = sorted(set(src_meta["tokenizers"]) | {tokenizer})
                    if keep_sources:
                        dest = self.paths.sources / f"{sha}{f.suffix.lower()}"
                        if not dest.exists():
                            shutil.copy2(f, dest)
                        src_meta["stored"] = dest.name
                    new_sources[sha] = src_meta
                train_shards = train_w.close()
                eval_shards = eval_w.close()
                if dedup:
                    dedup.close(commit=True)
            except BaseException:
                train_w.abort()
                eval_w.abort()
                if dedup:
                    dedup.close(commit=False)
                raise

            totals = {k: sum(fs.get(k, 0) for fs in report["files"])
                      for k in ("docs_read", "docs_kept", "duplicates", "invalid",
                                "train_tokens", "eval_tokens")}
            report["totals"] = totals
            if not new_sources:
                report["version"] = None
                report["message"] = "لا توجد ملفات جديدة — كل الملفات مُضافة سابقًا."
                return report

            parent = self.latest(tokenizer)
            reg["sources"].update(new_sources)
            version = {
                "version": self._next_version_name(reg),
                "parent": parent["version"] if parent else None,
                "tokenizer": tokenizer,
                "created": now_iso(),
                "note": note,
                "added_sources": list(new_sources),
                "sources": (parent["sources"] if parent else []) + list(new_sources),
                "train_shards": (parent["train_shards"] if parent else []) + [s["id"] for s in train_shards],
                "eval_shards": (parent["eval_shards"] if parent else []) + [s["id"] for s in eval_shards],
                "added": totals,
            }
            version["stats"] = self._version_stats(version)
            reg["versions"].append(version)
            self._save(reg)
            report["version"] = version["version"]
            return report

    def _ingest_file(self, path: Path, tok, train_w: ShardWriter, eval_w: ShardWriter,
                     dedup: DedupIndex | None, progress: ProgressFn | None) -> dict:
        st = {"docs_read": 0, "docs_kept": 0, "duplicates": 0, "invalid": 0,
              "invalid_reasons": {}, "train_tokens": 0, "eval_tokens": 0}
        batch: list[tuple[str, bool]] = []
        permille = self.dcfg["eval_permille"]

        def flush():
            if not batch:
                return
            ids_list = tok.encode_batch([t for t, _ in batch])
            for ids, (_, is_eval) in zip(ids_list, batch):
                if is_eval:
                    st["eval_tokens"] += eval_w.add(ids)
                else:
                    st["train_tokens"] += train_w.add(ids)
            batch.clear()
            if progress:
                progress({"file": path.name, **{k: v for k, v in st.items() if k != "invalid_reasons"}})

        for raw in read_documents(path, self.dcfg["max_doc_chars"]):
            st["docs_read"] += 1
            doc, reason = clean_doc(raw, self.dcfg)
            if doc is None:
                st["invalid"] += 1
                st["invalid_reasons"][reason] = st["invalid_reasons"].get(reason, 0) + 1
                continue
            fp = doc_fingerprint(doc)
            if dedup is not None and not dedup.add_if_new(fp):
                st["duplicates"] += 1
                continue
            st["docs_kept"] += 1
            # تقسيم ثابت وحتمي (deterministic) للتقييم حسب البصمة
            is_eval = int.from_bytes(fp[:4], "little") % 1000 < permille
            batch.append((tok.render(doc), is_eval))
            if len(batch) >= self.dcfg["tokenize_batch"]:
                flush()
        flush()
        return st

    def _version_stats(self, v: dict) -> dict:
        d = self.shard_dir(v["tokenizer"])
        train = sum(read_json(d / f"{s}.json", {}).get("tokens", 0) for s in v["train_shards"])
        evalt = sum(read_json(d / f"{s}.json", {}).get("tokens", 0) for s in v["eval_shards"])
        docs = sum(read_json(d / f"{s}.json", {}).get("docs", 0)
                   for s in v["train_shards"] + v["eval_shards"])
        size = sum((d / f"{s}.bin").stat().st_size for s in v["train_shards"] + v["eval_shards"]
                   if (d / f"{s}.bin").exists())
        return {"train_tokens": train, "eval_tokens": evalt, "total_tokens": train + evalt,
                "docs": docs, "files": len(v["sources"]), "bytes": size}

    # ---------- إعادة الترميز ----------
    def retokenize(self, version: str, new_tokenizer: str, progress: ProgressFn | None = None) -> dict:
        """يعيد بناء نفس البيانات بـ Tokenizer نموذج آخر (عند تغيير النموذج الأساسي)."""
        v = self.get_version(version)
        reg = self._load()
        files = []
        for sha in v["sources"]:
            stored = reg["sources"].get(sha, {}).get("stored")
            if not stored:
                raise FileNotFoundError(f"الملف الأصلي غير محفوظ: {sha}")
            files.append(self.paths.sources / stored)
        return self.add_files(files, new_tokenizer, note=f"retokenized from {version}", progress=progress)

    # ---------- الإحصاءات ----------
    def overview(self) -> dict:
        reg = self._load()
        latest = reg["versions"][-1] if reg["versions"] else None
        return {
            "versions": len(reg["versions"]),
            "current_version": latest["version"] if latest else None,
            "tokenizer": latest["tokenizer"] if latest else None,
            "files": len(reg["sources"]),
            "stats": latest["stats"] if latest else {"total_tokens": 0, "train_tokens": 0,
                                                     "eval_tokens": 0, "docs": 0, "files": 0, "bytes": 0},
        }
