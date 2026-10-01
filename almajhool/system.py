"""مراقبة الموارد: GPU / VRAM / RAM / CPU / Disk."""
from __future__ import annotations

import shutil
import subprocess


def system_stats(path: str = ".") -> dict:
    out: dict = {"gpus": []}
    try:
        import psutil

        vm = psutil.virtual_memory()
        out["ram"] = {"used": vm.used, "total": vm.total, "percent": vm.percent}
        out["cpu_percent"] = psutil.cpu_percent(interval=None)
    except ImportError:
        pass
    du = shutil.disk_usage(path)
    out["disk"] = {"used": du.used, "total": du.total, "percent": round(du.used / du.total * 100, 1)}
    if shutil.which("nvidia-smi"):
        try:
            res = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu",
                 "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5)
            for line in res.stdout.strip().splitlines():
                name, used, total, util, temp = [x.strip() for x in line.split(",")]
                out["gpus"].append({"name": name, "vram_used": int(used) * 2**20,
                                    "vram_total": int(total) * 2**20, "util": int(util), "temp": int(temp)})
        except Exception:
            pass
    return out
