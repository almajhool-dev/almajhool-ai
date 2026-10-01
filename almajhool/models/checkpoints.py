"""إدارة الـ Checkpoints والنسخ الاحتياطي والاستعادة.

حماية البيانات:
1. الشاردات والـ Checkpoints لا تُعدَّل بعد كتابتها.
2. السجلات تُكتب بشكل ذرّي + نسخة من السجل قبل كل تعديل.
3. نسخ احتياطية كاملة (tar) مع manifest فيه SHA-256 لكل ملف للتحقق عند الاستعادة.
4. اختياريًا: رفع النسخة إلى Hugging Face Hub (مستودع خاص) كنسخة خارج الجهاز.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tarfile
import time
from pathlib import Path

from ..config import Paths
from ..utils import dir_size, read_json, sha256_file

_CKPT = re.compile(r"checkpoint-(\d+)$")


class CheckpointManager:
    def __init__(self, cfg: dict):
        self.paths = Paths(cfg).ensure()

    def run_dir(self, run_id: str) -> Path:
        return self.paths.runs / run_id

    def list(self, run_id: str | None = None) -> list[dict]:
        runs = [self.run_dir(run_id)] if run_id else sorted(self.paths.runs.glob("*"))
        out = []
        for rd in runs:
            cdir = rd / "checkpoints"
            if not cdir.exists():
                continue
            for c in cdir.iterdir():
                m = _CKPT.search(c.name)
                if not m or not c.is_dir():
                    continue
                state = read_json(c / "trainer_state.json", {})
                out.append({
                    "run_id": rd.name, "step": int(m.group(1)), "path": str(c.relative_to(self.paths.root)),
                    "epoch": state.get("epoch"), "bytes": dir_size(c),
                    "complete": (c / "trainer_state.json").exists(),
                })
        return sorted(out, key=lambda x: (x["run_id"], x["step"]))

    def latest(self, run_id: str) -> Path | None:
        """آخر checkpoint مكتمل — نتجاهل أي checkpoint نصف مكتوب (انقطاع أثناء الحفظ)."""
        cks = [c for c in self.list(run_id) if c["complete"]]
        return self.paths.root / cks[-1]["path"] if cks else None


class BackupManager:
    INCLUDE = ["datasets", "models", "runs", "evals"]

    def __init__(self, cfg: dict):
        self.paths = Paths(cfg).ensure()

    def create(self, include_checkpoints: bool = True, note: str = "") -> dict:
        ts = time.strftime("%Y%m%d-%H%M%S")
        archive = self.paths.backups / f"backup-{ts}.tar"
        manifest = {"created": ts, "note": note, "files": {}}
        root = self.paths.root
        with tarfile.open(archive, "w") as tar:
            for part in self.INCLUDE:
                base = root / part
                if not base.exists():
                    continue
                for dirpath, _, files in os.walk(base):
                    if not include_checkpoints and "checkpoints" in Path(dirpath).parts:
                        continue
                    for name in files:
                        if name.endswith(".lock"):
                            continue
                        full = Path(dirpath) / name
                        rel = str(full.relative_to(root))
                        manifest["files"][rel] = sha256_file(full)
                        tar.add(full, arcname=rel)
            data = json.dumps(manifest, ensure_ascii=False, indent=1).encode()
            info = tarfile.TarInfo("MANIFEST.json")
            info.size = len(data)
            import io
            tar.addfile(info, io.BytesIO(data))
        return {"archive": archive.name, "files": len(manifest["files"]), "bytes": archive.stat().st_size}

    def list(self) -> list[dict]:
        return [{"archive": p.name, "bytes": p.stat().st_size, "created": p.stat().st_mtime}
                for p in sorted(self.paths.backups.glob("backup-*.tar"))]

    def verify(self, archive: str) -> dict:
        path = self.paths.backups / archive
        bad = []
        with tarfile.open(path) as tar:
            manifest = json.load(tar.extractfile("MANIFEST.json"))
            for rel, digest in manifest["files"].items():
                f = tar.extractfile(rel)
                h = hashlib.sha256()
                while chunk := f.read(1 << 20):
                    h.update(chunk)
                if h.hexdigest() != digest:
                    bad.append(rel)
        return {"ok": not bad, "corrupted": bad, "files": len(manifest["files"])}

    def restore(self, archive: str) -> dict:
        """يستعيد النسخة. الحالة الحالية تُنقل أولًا إلى مجلد آمن (لا شيء يُحذف)."""
        check = self.verify(archive)
        if not check["ok"]:
            raise RuntimeError(f"النسخة تالفة: {check['corrupted'][:5]}")
        root = self.paths.root
        safety = root / f"pre-restore-{time.strftime('%Y%m%d-%H%M%S')}"
        safety.mkdir()
        for part in self.INCLUDE:
            if (root / part).exists():
                shutil.move(str(root / part), str(safety / part))
        with tarfile.open(self.paths.backups / archive) as tar:
            members = [m for m in tar.getmembers() if m.name != "MANIFEST.json"
                       and not m.name.startswith(("/", "..")) and ".." not in Path(m.name).parts]
            tar.extractall(root, members=members)
        return {"restored": archive, "previous_state_saved_to": safety.name, "files": check["files"]}

    def push_to_hub(self, repo_id: str, archive: str | None = None, private: bool = True) -> str:
        from huggingface_hub import HfApi

        api = HfApi()
        api.create_repo(repo_id, repo_type="dataset", private=private, exist_ok=True)
        archive = archive or self.list()[-1]["archive"]
        api.upload_file(path_or_fileobj=str(self.paths.backups / archive),
                        path_in_repo=f"backups/{archive}", repo_id=repo_id, repo_type="dataset")
        return f"https://huggingface.co/datasets/{repo_id}"
