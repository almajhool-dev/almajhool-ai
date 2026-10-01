"""خادم المبرمج المجهول AI: API للوحة التحكم + API متوافق مع OpenAI لاستخدام النموذج.

التشغيل:  almajhool serve   (أو)   uvicorn server.app:app --host 0.0.0.0 --port 8000
الحماية:  ضع ALMAJHOOL_API_KEY في البيئة ليُطلب في كل طلب (Authorization: Bearer ...).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from almajhool import __version__
from almajhool.config import PROJECT_ROOT, Paths, load_config
from almajhool.dataset.manager import DatasetManager
from almajhool.dataset.readers import SUPPORTED
from almajhool.models.checkpoints import BackupManager, CheckpointManager
from almajhool.models.manager import ModelManager
from almajhool.system import system_stats
from almajhool.utils import atomic_write_json, make_id, now_iso, read_json, read_jsonl

CFG = load_config()
PATHS = Paths(CFG).ensure()
API_KEY = os.environ.get("ALMAJHOOL_API_KEY")

app = FastAPI(title="المبرمج المجهول AI", version=__version__)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_engine = None
_ingest_lock = threading.Lock()


def auth(request: Request) -> None:
    if not API_KEY:
        return
    header = request.headers.get("authorization", "")
    if header != f"Bearer {API_KEY}" and request.headers.get("x-api-key") != API_KEY:
        raise HTTPException(401, "مفتاح API غير صحيح")


def engine():
    global _engine
    if _engine is None:
        from almajhool.inference import InferenceEngine

        _engine = InferenceEngine(CFG)
    return _engine


def _pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def runs_list() -> list[dict]:
    out = []
    dirs = sorted(PATHS.runs.glob("run-*"),
                  key=lambda d: (read_json(d / "run.json", {}).get("created") or "", d.stat().st_ctime))
    for rd in dirs:
        st = read_json(rd / "status.json", {})
        run = read_json(rd / "run.json", {})
        if st.get("state") in ("loading", "training", "saving", "evaluating") and not _pid_alive(st.get("pid")):
            st["state"] = "interrupted"  # العملية ماتت (انقطاع/إعادة تشغيل) — قابلة للاستكمال
        out.append({**run, "run_id": rd.name, "status": st})
    return out


def active_run() -> dict | None:
    return next((r for r in reversed(runs_list())
                 if r["status"].get("state") in ("loading", "training", "saving", "evaluating")), None)


# ------------------------------------------------------------------ لوحة التحكم
@app.get("/api/health")
def health():
    return {"ok": True, "name": "المبرمج المجهول AI", "version": __version__,
            "auth_required": bool(API_KEY)}


@app.get("/api/overview", dependencies=[Depends(auth)])
def overview():
    dm, mm = DatasetManager(CFG), ModelManager(CFG)
    runs = runs_list()
    cur = active_run() or (runs[-1] if runs else None)
    metrics = read_jsonl(PATHS.runs / cur["run_id"] / "metrics.jsonl", limit=500) if cur else []
    act = mm.active()
    from almajhool.evaluation.evaluator import Evaluator

    return {
        "dataset": dm.overview(),
        "model": {"base": CFG["model"]["base"], "active": act["version"] if act else None,
                  "versions": len(mm.versions())},
        "training": {"run": cur, "metrics": metrics},
        "system": system_stats(str(PATHS.root)),
        "evaluations": Evaluator(CFG).all_results(),
        "checkpoints": len(CheckpointManager(CFG).list()),
    }


@app.get("/api/datasets", dependencies=[Depends(auth)])
def datasets():
    return DatasetManager(CFG).versions()


def _ingest_job(job_id: str, files: list[Path], note: str, tokenizer: str | None):
    job_path = PATHS.jobs / f"{job_id}.json"

    def prog(s):
        atomic_write_json(job_path, {"id": job_id, "state": "running", "progress": s, "updated": now_iso()})

    with _ingest_lock:
        try:
            rep = DatasetManager(CFG).add_files(files, tokenizer, note, progress=prog)
            atomic_write_json(job_path, {"id": job_id, "state": "done", "report": rep, "updated": now_iso()})
        except Exception as e:
            atomic_write_json(job_path, {"id": job_id, "state": "failed", "error": str(e), "updated": now_iso()})
        finally:
            shutil.rmtree(files[0].parent, ignore_errors=True)


@app.post("/api/datasets/upload", dependencies=[Depends(auth)])
async def upload(background: BackgroundTasks, files: list[UploadFile] = File(...),
                 note: str = Form(""), tokenizer: str | None = Form(None)):
    job_id = make_id("ingest")
    tmp = PATHS.incoming / job_id
    tmp.mkdir(parents=True)
    saved = []
    for f in files:
        name = Path(f.filename or "file.txt").name
        if Path(name).suffix.lower() not in SUPPORTED:
            raise HTTPException(400, f"صيغة غير مدعومة: {name}")
        dest = tmp / name
        with open(dest, "wb") as out:
            while chunk := await f.read(1 << 20):  # كتابة متدفقة — يدعم ملفات بالـ GB
                out.write(chunk)
        saved.append(dest)
    atomic_write_json(PATHS.jobs / f"{job_id}.json", {"id": job_id, "state": "queued", "updated": now_iso()})
    background.add_task(_ingest_job, job_id, saved, note, tokenizer or None)
    return {"job_id": job_id, "files": [p.name for p in saved]}


@app.get("/api/jobs/{job_id}", dependencies=[Depends(auth)])
def job(job_id: str):
    j = read_json(PATHS.jobs / f"{Path(job_id).name}.json")
    if not j:
        raise HTTPException(404)
    return j


@app.get("/api/models", dependencies=[Depends(auth)])
def models():
    mm = ModelManager(CFG)
    act = mm.active()
    return {"active": act["version"] if act else None, "versions": mm.versions()}


@app.post("/api/models/{version}/activate", dependencies=[Depends(auth)])
def activate(version: str):
    ModelManager(CFG).set_active(version)
    return {"active": version}


@app.get("/api/runs", dependencies=[Depends(auth)])
def runs():
    return runs_list()


@app.get("/api/runs/{run_id}/metrics", dependencies=[Depends(auth)])
def run_metrics(run_id: str):
    return read_jsonl(PATHS.runs / Path(run_id).name / "metrics.jsonl")


@app.get("/api/checkpoints", dependencies=[Depends(auth)])
def checkpoints():
    return CheckpointManager(CFG).list()


@app.post("/api/train", dependencies=[Depends(auth)])
async def start_training(request: Request):
    if active_run():
        raise HTTPException(409, "يوجد تدريب قيد التشغيل حاليًا")
    opts = await request.json()
    allowed = {"dataset_version", "parent_version", "base_model", "resume_run", "bump", "note", "method",
               "epochs", "batch_size", "grad_accum", "learning_rate", "lora_rank", "lora_alpha",
               "context_length", "max_steps", "save_steps"}
    opts = {k: v for k, v in opts.items() if k in allowed and v not in (None, "")}
    if not opts.get("resume_run"):
        opts["run_id"] = make_id("run")
    run_id = opts.get("resume_run") or opts["run_id"]
    (PATHS.runs / run_id).mkdir(parents=True, exist_ok=True)
    log = open(PATHS.runs / run_id / "train.log", "a")
    n_gpu = len(system_stats()["gpus"])
    if n_gpu > 1:
        cmd = ["torchrun", f"--nproc_per_node={n_gpu}", "-m", "almajhool.cli", "train", "--json", json.dumps(opts)]
    else:
        cmd = [sys.executable, "-m", "almajhool.cli", "train", "--json", json.dumps(opts)]
    proc = subprocess.Popen(cmd, cwd=PROJECT_ROOT, stdout=log, stderr=subprocess.STDOUT,
                            start_new_session=True)
    atomic_write_json(PATHS.runs / run_id / "status.json",
                      {**read_json(PATHS.runs / run_id / "status.json", {}),
                       "state": "loading", "pid": proc.pid, "run_id": run_id, "updated": now_iso()})
    return {"run_id": run_id, "pid": proc.pid, "gpus": n_gpu}


@app.post("/api/train/{run_id}/stop", dependencies=[Depends(auth)])
def stop_training(run_id: str):
    (PATHS.runs / Path(run_id).name / "STOP").touch()
    return {"run_id": run_id, "state": "stopping"}


@app.get("/api/train/{run_id}/log", dependencies=[Depends(auth)])
def train_log(run_id: str, tail: int = 200):
    p = PATHS.runs / Path(run_id).name / "train.log"
    if not p.exists():
        return {"log": ""}
    lines = p.read_text(errors="replace").splitlines()[-tail:]
    return {"log": "\n".join(lines)}


@app.get("/api/evaluations", dependencies=[Depends(auth)])
def evaluations():
    from almajhool.evaluation.evaluator import Evaluator

    return Evaluator(CFG).all_results()


@app.get("/api/backups", dependencies=[Depends(auth)])
def backups():
    return BackupManager(CFG).list()


@app.post("/api/backups", dependencies=[Depends(auth)])
def create_backup(background: BackgroundTasks, include_checkpoints: bool = True):
    job_id = make_id("backup")
    path = PATHS.jobs / f"{job_id}.json"

    def run():
        try:
            r = BackupManager(CFG).create(include_checkpoints=include_checkpoints)
            atomic_write_json(path, {"id": job_id, "state": "done", "report": r})
        except Exception as e:
            atomic_write_json(path, {"id": job_id, "state": "failed", "error": str(e)})

    atomic_write_json(path, {"id": job_id, "state": "running"})
    background.add_task(run)
    return {"job_id": job_id}


@app.post("/api/backups/{archive}/restore", dependencies=[Depends(auth)])
def restore_backup(archive: str):
    if active_run():
        raise HTTPException(409, "أوقف التدريب قبل الاستعادة")
    return BackupManager(CFG).restore(Path(archive).name)


@app.get("/api/system", dependencies=[Depends(auth)])
def system():
    return system_stats(str(PATHS.root))


# ------------------------------------------------------------------ API متوافق مع OpenAI
@app.get("/v1/models", dependencies=[Depends(auth)])
def v1_models():
    return {"object": "list", "data": [{"id": v, "object": "model", "owned_by": "almajhool"}
                                       for v in ["latest"] + engine().available()]}


@app.post("/v1/chat/completions", dependencies=[Depends(auth)])
async def v1_chat(request: Request):
    body = await request.json()
    msgs = [{"role": m["role"], "content": m["content"] if isinstance(m["content"], str)
             else " ".join(p.get("text", "") for p in m["content"] if isinstance(p, dict))}
            for m in body.get("messages", [])]
    version = body.get("model") if body.get("model") not in (None, "almajhool-ai") else None
    kw = dict(max_tokens=int(body.get("max_tokens") or 512), temperature=float(body.get("temperature", 0.7)),
              top_p=float(body.get("top_p", 0.9)))
    created = int(time.time())
    cid = f"chatcmpl-{os.urandom(6).hex()}"
    if body.get("stream"):
        def gen():
            for piece in engine().stream(msgs, version, **kw):
                chunk = {"id": cid, "object": "chat.completion.chunk", "created": created,
                         "model": version or "latest",
                         "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}]}
                yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")
    r = engine().chat(msgs, version, **kw)
    return {"id": cid, "object": "chat.completion", "created": created, "model": r["version"],
            "choices": [{"index": 0, "message": {"role": "assistant", "content": r["text"]},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": r["prompt_tokens"], "completion_tokens": r["completion_tokens"],
                      "total_tokens": r["prompt_tokens"] + r["completion_tokens"]}}


@app.exception_handler(KeyError)
async def key_error(_, exc: KeyError):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(RuntimeError)
async def runtime_error(_, exc: RuntimeError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


# ------------------------------------------------------------------ الواجهة
WEB = PROJECT_ROOT / "web"
if WEB.exists():
    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
