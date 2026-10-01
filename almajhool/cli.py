"""واجهة سطر الأوامر.

أمثلة:
    almajhool add-data data/*.jsonl --note "مقالات أمن"
    almajhool datasets
    almajhool train --dataset v2 --epochs 1 --lora-rank 16
    almajhool train --parent v1 --dataset v3         # مواصلة تدريب v1 ببيانات أحدث → v1.1
    almajhool train --resume-run run-2026...          # استكمال بعد انقطاع
    almajhool stop run-2026...
    almajhool eval v1.1 --compare v1
    almajhool backup && almajhool backups && almajhool restore backup-....tar
    almajhool push v1.1 username/almajhool-ai --merged
    almajhool serve
"""
from __future__ import annotations

import argparse
import json
import sys

from .config import Paths, load_config


def _print(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2, default=str))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="almajhool", description="المبرمج المجهول AI")
    p.add_argument("--config", help="ملف إعدادات YAML إضافي")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="تهيئة مساحة العمل")

    a = sub.add_parser("add-data", help="إضافة ملفات بيانات (txt/json/jsonl/csv/md)")
    a.add_argument("files", nargs="+")
    a.add_argument("--tokenizer", help="الافتراضي: النموذج الأساسي في الإعدادات")
    a.add_argument("--note", default="")
    a.add_argument("--no-keep-sources", action="store_true")

    sub.add_parser("datasets", help="عرض إصدارات الداتاسيت")
    r = sub.add_parser("retokenize", help="إعادة ترميز إصدار بـ Tokenizer آخر")
    r.add_argument("version")
    r.add_argument("--tokenizer", required=True)

    t = sub.add_parser("train", help="بدء أو استكمال تدريب")
    t.add_argument("--dataset", dest="dataset_version")
    t.add_argument("--parent", dest="parent_version", help="مواصلة تدريب إصدار نموذج سابق")
    t.add_argument("--base", dest="base_model")
    t.add_argument("--resume-run")
    t.add_argument("--bump", choices=["minor", "major"], default="minor")
    t.add_argument("--method", choices=["qlora", "lora", "full"])
    t.add_argument("--epochs", type=float)
    t.add_argument("--max-steps", type=int)
    t.add_argument("--batch-size", type=int)
    t.add_argument("--grad-accum", type=int)
    t.add_argument("--learning-rate", "--lr", type=float)
    t.add_argument("--lora-rank", type=int)
    t.add_argument("--lora-alpha", type=int)
    t.add_argument("--context-length", type=int)
    t.add_argument("--save-steps", type=int)
    t.add_argument("--note", default="")
    t.add_argument("--json", help="خيارات بصيغة JSON (يستخدمها الخادم)")

    s = sub.add_parser("stop", help="إيقاف تدريب مع حفظ checkpoint")
    s.add_argument("run_id")

    sub.add_parser("runs", help="عرض عمليات التدريب")
    sub.add_parser("models", help="عرض إصدارات النموذج")
    sub.add_parser("checkpoints", help="عرض الـ Checkpoints")

    e = sub.add_parser("eval", help="تقييم إصدار")
    e.add_argument("version")
    e.add_argument("--compare", default=None)
    e.add_argument("--dataset")
    e.add_argument("--force", action="store_true")

    b = sub.add_parser("backup", help="نسخة احتياطية كاملة")
    b.add_argument("--no-checkpoints", action="store_true")
    b.add_argument("--hub", help="رفع النسخة إلى مستودع HF خاص (user/repo)")
    sub.add_parser("backups", help="عرض النسخ الاحتياطية")
    rs = sub.add_parser("restore", help="استعادة نسخة")
    rs.add_argument("archive")

    m = sub.add_parser("merge", help="دمج LoRA في النموذج")
    m.add_argument("version")
    pu = sub.add_parser("push", help="نشر إصدار على Hugging Face")
    pu.add_argument("version")
    pu.add_argument("repo_id")
    pu.add_argument("--merged", action="store_true")
    pu.add_argument("--public", action="store_true")

    sv = sub.add_parser("serve", help="تشغيل الخادم + لوحة التحكم")
    sv.add_argument("--host")
    sv.add_argument("--port", type=int)

    args = p.parse_args(argv)
    cfg = load_config(args.config)
    Paths(cfg).ensure()

    if args.cmd == "init":
        _print({"workspace": cfg["workspace"], "base_model": cfg["model"]["base"]})

    elif args.cmd == "add-data":
        from .dataset.manager import DatasetManager

        def prog(s):
            print(f"\r{s['file']}: docs={s['docs_read']} kept={s['docs_kept']} "
                  f"dup={s['duplicates']} tokens={s['train_tokens'] + s['eval_tokens']:,}", end="",
                  file=sys.stderr)

        rep = DatasetManager(cfg).add_files(args.files, args.tokenizer, args.note,
                                            keep_sources=not args.no_keep_sources, progress=prog)
        print(file=sys.stderr)
        _print(rep)

    elif args.cmd == "datasets":
        from .dataset.manager import DatasetManager

        for v in DatasetManager(cfg).versions():
            st = v["stats"]
            print(f"{v['version']:>5}  parent={v['parent'] or '-':>4}  tokens={st['total_tokens']:>14,}  "
                  f"docs={st['docs']:>10,}  files={st['files']:>4}  tok={v['tokenizer']}  {v['note']}")

    elif args.cmd == "retokenize":
        from .dataset.manager import DatasetManager

        _print(DatasetManager(cfg).retokenize(args.version, args.tokenizer))

    elif args.cmd == "train":
        from .training.trainer import train

        opts = json.loads(args.json) if args.json else {}
        for k, v in vars(args).items():
            if k not in ("cmd", "config", "json") and v is not None and k not in opts:
                opts[k] = v
        _print(train(cfg, opts))

    elif args.cmd == "stop":
        path = Paths(cfg).runs / args.run_id / "STOP"
        path.touch()
        print("تم طلب الإيقاف — سيُحفظ checkpoint ثم يتوقف التدريب.")

    elif args.cmd == "runs":
        from .utils import read_json

        for rd in sorted(Paths(cfg).runs.glob("run-*")):
            st = read_json(rd / "status.json", {})
            print(f"{rd.name}  {st.get('state', '?'):>10}  step={st.get('step')}/{st.get('max_steps')}  "
                  f"loss={st.get('loss')}  → {st.get('target_version')}")

    elif args.cmd == "models":
        from .models.manager import ModelManager

        mm = ModelManager(cfg)
        act = mm.active()
        for v in mm.versions():
            mark = "*" if act and v["version"] == act["version"] else " "
            print(f"{mark}{v['version']:>6}  parent={v.get('parent') or 'base':>6}  data={v['dataset_version']}  "
                  f"eval_loss={v.get('final_eval_loss')}  verdict={(v.get('eval') or {}).get('verdict')}")

    elif args.cmd == "checkpoints":
        from .models.checkpoints import CheckpointManager

        _print(CheckpointManager(cfg).list())

    elif args.cmd == "eval":
        from .evaluation.evaluator import Evaluator

        ev = Evaluator(cfg)
        if args.compare:
            _print(ev.compare(args.version, args.compare, args.dataset)["summary"])
        else:
            r = ev.evaluate(args.version, args.dataset, force=args.force)
            r["prompts"].pop("samples", None)
            _print(r)

    elif args.cmd == "backup":
        from .models.checkpoints import BackupManager

        bm = BackupManager(cfg)
        res = bm.create(include_checkpoints=not args.no_checkpoints)
        if args.hub:
            res["hub"] = bm.push_to_hub(args.hub, res["archive"])
        _print(res)

    elif args.cmd == "backups":
        from .models.checkpoints import BackupManager

        _print(BackupManager(cfg).list())

    elif args.cmd == "restore":
        from .models.checkpoints import BackupManager

        _print(BackupManager(cfg).restore(args.archive))

    elif args.cmd == "merge":
        from .models.manager import ModelManager

        print(ModelManager(cfg).merge(args.version))

    elif args.cmd == "push":
        from .inference import push_model_to_hub

        print(push_model_to_hub(cfg, args.version, args.repo_id, private=not args.public, merged=args.merged))

    elif args.cmd == "serve":
        import uvicorn

        uvicorn.run("server.app:app", host=args.host or cfg["server"]["host"],
                    port=args.port or cfg["server"]["port"])


if __name__ == "__main__":
    main()
