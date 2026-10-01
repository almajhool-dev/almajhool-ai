"""محرك التدريب: LoRA / QLoRA / Full Fine-tuning مع Checkpoints واستكمال وMulti-GPU.

التشغيل على GPU واحد:
    python -m almajhool.cli train --dataset v2 --epochs 1
التشغيل على عدة GPUs:
    torchrun --nproc_per_node=4 -m almajhool.cli train --dataset v2
الاستكمال بعد توقف/انقطاع:
    python -m almajhool.cli train --resume-run run-20261001-...
"""
from __future__ import annotations

import os
import time
from pathlib import Path

from ..config import Paths
from ..dataset.manager import DatasetManager
from ..dataset.packed import PackedTokenDataset
from ..models.checkpoints import CheckpointManager
from ..models.loader import load_base, pick_dtype
from ..models.manager import ModelManager
from ..tokenizer import same_tokenizer
from ..utils import append_jsonl, atomic_write_json, make_id, now_iso, read_json

RUN_KEYS = ["method", "epochs", "batch_size", "grad_accum", "learning_rate", "lora_rank", "lora_alpha",
            "lora_dropout", "context_length", "warmup_ratio", "save_steps", "eval_steps",
            "logging_steps", "save_total_limit", "gradient_checkpointing", "max_steps", "seed"]


def is_main() -> bool:
    return int(os.environ.get("RANK", 0)) == 0


class StatusCallback:
    """يكتب حالة التدريب ومقاييسه للوحة التحكم، ويستجيب لطلب الإيقاف."""

    def __init__(self, run_dir: Path):
        from transformers import TrainerCallback

        self.run_dir = run_dir
        self.status_path = run_dir / "status.json"
        self.metrics_path = run_dir / "metrics.jsonl"
        self.stop_path = run_dir / "STOP"
        parent = self

        class _CB(TrainerCallback):
            def on_log(self, args, state, control, logs=None, **kw):
                if not state.is_world_process_zero or not logs:
                    return
                rec = {"time": time.time(), "step": state.global_step, "epoch": state.epoch, **logs}
                try:
                    import torch

                    if torch.cuda.is_available():
                        rec["vram_alloc"] = torch.cuda.memory_allocated()
                        rec["vram_peak"] = torch.cuda.max_memory_allocated()
                except Exception:
                    pass
                append_jsonl(parent.metrics_path, rec)
                parent.update(step=state.global_step, max_steps=state.max_steps, epoch=state.epoch,
                              **{k: logs[k] for k in ("loss", "eval_loss", "learning_rate") if k in logs})

            def on_step_end(self, args, state, control, **kw):
                if parent.stop_path.exists():
                    control.should_save = True          # نحفظ checkpoint قبل الإيقاف
                    control.should_training_stop = True
                return control

            def on_save(self, args, state, control, **kw):
                if state.is_world_process_zero:
                    parent.update(checkpoint=f"checkpoint-{state.global_step}", step=state.global_step)

        self.callback = _CB()

    def update(self, **fields) -> None:
        st = read_json(self.status_path, {})
        st.update(fields)
        st["updated"] = now_iso()
        atomic_write_json(self.status_path, st)


def train(cfg: dict, opts: dict) -> dict:
    """opts: dataset_version, parent_version, base_model, resume_run, bump, note + أي مفتاح من RUN_KEYS."""
    import torch
    from transformers import Trainer, TrainingArguments, set_seed

    paths = Paths(cfg).ensure()
    dm, mm, ck = DatasetManager(cfg), ModelManager(cfg), CheckpointManager(cfg)

    # ---------- تجهيز الإعدادات (جديد أو استكمال) ----------
    if opts.get("resume_run"):
        run_id = opts["resume_run"]
        run_dir = paths.runs / run_id
        run = read_json(run_dir / "run.json")
        if run is None:
            raise FileNotFoundError(f"عملية التدريب غير موجودة: {run_id}")
        resume_ckpt = ck.latest(run_id)
    else:
        tcfg = {**cfg["training"], **{k: v for k, v in opts.items() if k in RUN_KEYS and v is not None}}
        parent = mm.get(opts["parent_version"]) if opts.get("parent_version") else None
        base = parent["base_model"] if parent else (opts.get("base_model") or cfg["model"]["base"])
        if parent and parent.get("lora_rank") and tcfg["method"] != "full":
            tcfg["lora_rank"] = parent["lora_rank"]  # مواصلة نفس الـ Adapter تتطلب نفس الرتبة
        dv = dm.get_version(opts["dataset_version"]) if opts.get("dataset_version") else dm.latest(base)
        if dv is None:
            dv = next((v for v in reversed(dm.versions())
                       if same_tokenizer(v["tokenizer"], base, cfg["model"].get("trust_remote_code", False))), None)
        if dv is None:
            raise RuntimeError("لا توجد داتاسيت لهذا النموذج. أضف بيانات أولًا.")
        if not same_tokenizer(dv["tokenizer"], base, cfg["model"].get("trust_remote_code", False)):
            raise RuntimeError(
                f"الداتاسيت {dv['version']} مرمّزة بـ {dv['tokenizer']} بينما النموذج {base}. "
                f"نفّذ: almajhool retokenize {dv['version']} --tokenizer {base}")
        run_id = opts.get("run_id") or make_id("run")
        run_dir = paths.runs / run_id
        run = {
            "run_id": run_id, "created": now_iso(), "base_model": base,
            "parent_version": parent["version"] if parent else None,
            "dataset_version": dv["version"], "dataset_stats": dv["stats"],
            "target_version": mm.next_version(parent["version"] if parent else None, opts.get("bump", "minor")),
            "config": tcfg, "note": opts.get("note", ""),
        }
        if is_main():
            atomic_write_json(run_dir / "run.json", run)
        resume_ckpt = None

    tcfg = run["config"]
    status = StatusCallback(run_dir)
    if is_main():
        status.update(state="loading", run_id=run_id, target_version=run["target_version"],
                      dataset_version=run["dataset_version"], started=now_iso(), pid=os.getpid(),
                      resumed_from=str(resume_ckpt.name) if resume_ckpt else None)
        if status.stop_path.exists():
            status.stop_path.unlink()

    try:
        set_seed(tcfg["seed"])
        dv = dm.get_version(run["dataset_version"])
        sdir = dm.shard_dir(dv["tokenizer"])
        train_ds = PackedTokenDataset(sdir, dv["train_shards"], tcfg["context_length"])
        eval_ds = PackedTokenDataset(sdir, dv["eval_shards"], tcfg["context_length"],
                                     max_blocks=cfg["evaluation"]["ppl_max_blocks"])
        if len(train_ds) == 0:
            raise RuntimeError("بيانات التدريب أقل من طول سياق واحد — أضف بيانات أكثر أو قلّل context_length.")

        method = tcfg["method"]
        model = load_base(run["base_model"], quant_4bit=(method == "qlora"),
                          trust_remote_code=cfg["model"].get("trust_remote_code", False))
        model.config.use_cache = False
        if method in ("lora", "qlora"):
            from peft import LoraConfig, PeftModel, get_peft_model, prepare_model_for_kbit_training

            if method == "qlora" and torch.cuda.is_available():
                model = prepare_model_for_kbit_training(
                    model, use_gradient_checkpointing=tcfg["gradient_checkpointing"])
            if run["parent_version"]:
                parent = mm.get(run["parent_version"])
                model = PeftModel.from_pretrained(model, str(paths.root / parent["adapter_path"]),
                                                  is_trainable=True)
            else:
                model = get_peft_model(model, LoraConfig(
                    r=tcfg["lora_rank"], lora_alpha=tcfg["lora_alpha"], lora_dropout=tcfg["lora_dropout"],
                    target_modules="all-linear", task_type="CAUSAL_LM"))
            if is_main():
                trainable, total = model.get_nb_trainable_parameters()
                status.update(trainable_params=trainable, total_params=total)

        dtype = pick_dtype()
        world = int(os.environ.get("WORLD_SIZE", 1))
        steps_per_epoch = max(1, len(train_ds) // (tcfg["batch_size"] * tcfg["grad_accum"] * world))
        total_steps = tcfg["max_steps"] if tcfg["max_steps"] and tcfg["max_steps"] > 0 \
            else int(steps_per_epoch * tcfg["epochs"])
        arg_values = dict(
            output_dir=str(run_dir / "checkpoints"),
            num_train_epochs=tcfg["epochs"],
            max_steps=tcfg["max_steps"],
            per_device_train_batch_size=tcfg["batch_size"],
            per_device_eval_batch_size=tcfg["batch_size"],
            gradient_accumulation_steps=tcfg["grad_accum"],
            learning_rate=tcfg["learning_rate"],
            warmup_steps=int(total_steps * tcfg["warmup_ratio"]),
            lr_scheduler_type="cosine",
            logging_steps=tcfg["logging_steps"],
            save_strategy="steps",
            save_steps=tcfg["save_steps"],
            save_total_limit=tcfg["save_total_limit"],
            eval_strategy="steps" if len(eval_ds) else "no",
            eval_steps=tcfg["eval_steps"],
            bf16=torch.cuda.is_available() and dtype == torch.bfloat16,
            fp16=torch.cuda.is_available() and dtype == torch.float16,
            gradient_checkpointing=tcfg["gradient_checkpointing"],
            gradient_checkpointing_kwargs={"use_reentrant": False},
            optim="paged_adamw_8bit" if method == "qlora" and torch.cuda.is_available() else "adamw_torch",
            report_to=[],
            seed=tcfg["seed"],
            dataloader_num_workers=2,
            remove_unused_columns=False,
            ddp_find_unused_parameters=False,
            save_safetensors=True,
        )
        # توافق مع إصدارات transformers المختلفة (4.x و 5.x)
        import inspect

        accepted = inspect.signature(TrainingArguments.__init__).parameters
        if "eval_strategy" not in accepted and "evaluation_strategy" in accepted:
            arg_values["evaluation_strategy"] = arg_values.pop("eval_strategy")
        args = TrainingArguments(**{k: v for k, v in arg_values.items() if k in accepted})
        trainer = Trainer(model=model, args=args, train_dataset=train_ds,
                          eval_dataset=eval_ds if len(eval_ds) else None, callbacks=[status.callback])
        if is_main():
            status.update(state="training", train_tokens=train_ds.tokens(), eval_tokens=eval_ds.tokens())
        trainer.train(resume_from_checkpoint=str(resume_ckpt) if resume_ckpt else None)

        if status.stop_path.exists():
            if is_main():
                status.update(state="stopped", stopped=now_iso())
            return {"run_id": run_id, "state": "stopped"}

        if not is_main():
            return {"run_id": run_id, "state": "completed"}

        # ---------- حفظ الإصدار ----------
        version = run["target_version"]
        vdir = mm.version_dir(version)
        status.update(state="saving")
        if method == "full":
            trainer.save_model(str(vdir / "full"))
            adapter_path, full_path = None, str((vdir / "full").relative_to(paths.root))
        else:
            model.save_pretrained(str(vdir / "adapter"))
            adapter_path, full_path = str((vdir / "adapter").relative_to(paths.root)), None
        history = [r for r in trainer.state.log_history]
        final_loss = next((h["loss"] for h in reversed(history) if "loss" in h), None)
        final_eval = next((h["eval_loss"] for h in reversed(history) if "eval_loss" in h), None)
        entry = mm.register({
            "version": version, "base_model": run["base_model"], "parent": run["parent_version"],
            "dataset_version": run["dataset_version"], "run_id": run_id, "method": method,
            "lora_rank": tcfg["lora_rank"] if method != "full" else None,
            "adapter_path": adapter_path, "full_path": full_path,
            "train_config": tcfg, "final_train_loss": final_loss, "final_eval_loss": final_eval,
            "steps": trainer.state.global_step, "note": run.get("note", ""),
        })
        status.update(state="evaluating", model_version=version)
        del trainer, model
        torch.cuda.empty_cache() if torch.cuda.is_available() else None

        from ..evaluation.evaluator import Evaluator

        ev = Evaluator(cfg)
        compare_to = run["parent_version"] or "base"
        results = ev.compare(version, compare_to, dataset_version=run["dataset_version"])
        mm.update(version, eval=results["summary"])
        status.update(state="completed", finished=now_iso(), model_version=version)
        return {"run_id": run_id, "state": "completed", "model_version": version, "model": entry,
                "evaluation": results["summary"]}
    except BaseException as e:
        if is_main():
            status.update(state="failed", error=f"{type(e).__name__}: {e}")
        raise
