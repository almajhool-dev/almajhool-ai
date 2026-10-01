"""نظام التقييم — يقيس جودة النموذج فعليًا قبل وبعد كل تدريب.

المقاييس:
1. Perplexity على مجموعة تقييم محجوزة (لم يُدرَّب عليها) — كلما قلّ أفضل.
2. مجموعة أسئلة ثابتة (config/eval_prompts.jsonl): نسبة الكلمات المتوقعة في الجواب،
   تنوع النص (distinct-2) لاكتشاف التكرار، ونسبة العربية في الأجوبة العربية.
3. المقارنة مع الإصدار الأب (أو النموذج الأساسي) وحكم صريح: تحسّن / تراجع / بلا تغيير.

حجم الداتاسيت وحده لا يعني أن النموذج أصبح أفضل — هذه الأرقام هي المرجع.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

from ..config import PROJECT_ROOT, Paths
from ..dataset.manager import DatasetManager
from ..dataset.packed import PackedTokenDataset
from ..models.manager import ModelManager
from ..utils import atomic_write_json, now_iso, read_json

_AR = re.compile(r"[؀-ۿ]")


def distinct_n(text: str, n: int = 2) -> float:
    toks = text.split()
    grams = [tuple(toks[i:i + n]) for i in range(len(toks) - n + 1)]
    return len(set(grams)) / len(grams) if grams else 0.0


def arabic_ratio(text: str) -> float:
    letters = [c for c in text if c.isalpha()]
    return sum(1 for c in letters if _AR.match(c)) / len(letters) if letters else 0.0


class Evaluator:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.paths = Paths(cfg).ensure()
        self.mm = ModelManager(cfg)
        self.dm = DatasetManager(cfg)

    def load_prompts(self) -> list[dict]:
        p = Path(self.cfg["evaluation"]["prompts_file"])
        if not p.is_absolute():
            p = PROJECT_ROOT / p
        if not p.exists():
            return []
        return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]

    def _load(self, version: str):
        from ..models.loader import load_for_inference

        if version == "base":
            return load_for_inference(self.cfg["model"]["base"], None,
                                      trust_remote_code=self.cfg["model"].get("trust_remote_code", False))
        v = self.mm.get(version)
        adapter = self.paths.root / v["adapter_path"] if v.get("adapter_path") else None
        base = str(self.paths.root / v["full_path"]) if v.get("full_path") else v["base_model"]
        return load_for_inference(base, adapter,
                                  trust_remote_code=self.cfg["model"].get("trust_remote_code", False))

    def perplexity(self, model, dataset_version: str, ctx: int) -> dict:
        import torch

        dv = self.dm.get_version(dataset_version)
        ds = PackedTokenDataset(self.dm.shard_dir(dv["tokenizer"]), dv["eval_shards"], ctx,
                                max_blocks=self.cfg["evaluation"]["ppl_max_blocks"])
        if len(ds) == 0:
            return {"perplexity": None, "eval_loss": None, "blocks": 0}
        total, n = 0.0, 0
        dev = next(model.parameters()).device
        with torch.no_grad():
            for i in range(len(ds)):
                ids = ds[i]["input_ids"].unsqueeze(0).to(dev)
                loss = model(input_ids=ids, labels=ids).loss
                total += float(loss)
                n += 1
        mean = total / n
        return {"perplexity": math.exp(min(mean, 50)), "eval_loss": mean, "blocks": n}

    def prompt_suite(self, model, tok) -> dict:
        import torch

        prompts = self.load_prompts()
        rows = []
        dev = next(model.parameters()).device
        for p in prompts:
            msgs = [{"role": "user", "content": p["prompt"]}]
            if getattr(tok, "chat_template", None):
                text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
            else:
                text = p["prompt"] + "\n"
            inputs = tok(text, return_tensors="pt").to(dev)
            with torch.no_grad():
                out = model.generate(**inputs, max_new_tokens=self.cfg["evaluation"]["max_new_tokens"],
                                     do_sample=False, pad_token_id=tok.pad_token_id)
            answer = tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True).strip()
            kws = p.get("keywords", [])
            hit = sum(1 for k in kws if k.lower() in answer.lower()) / len(kws) if kws else None
            rows.append({"id": p.get("id"), "category": p.get("category"), "prompt": p["prompt"],
                         "answer": answer, "keyword_score": hit, "distinct2": distinct_n(answer),
                         "arabic_ratio": arabic_ratio(answer) if p.get("lang") == "ar" else None})
        scored = [r["keyword_score"] for r in rows if r["keyword_score"] is not None]
        ar = [r["arabic_ratio"] for r in rows if r["arabic_ratio"] is not None]
        return {
            "keyword_score": sum(scored) / len(scored) if scored else None,
            "distinct2": sum(r["distinct2"] for r in rows) / len(rows) if rows else None,
            "arabic_ratio": sum(ar) / len(ar) if ar else None,
            "samples": rows,
        }

    def evaluate(self, version: str, dataset_version: str | None = None, force: bool = False) -> dict:
        dv = dataset_version or (self.dm.latest()["version"] if self.dm.latest() else None)
        out_path = self.paths.evals / f"{version}__{dv}.json"
        if out_path.exists() and not force:
            return read_json(out_path)
        import torch

        model, tok = self._load(version)
        ctx = self.cfg["training"]["context_length"]
        res = {"model_version": version, "dataset_version": dv, "created": now_iso(),
               "ppl": self.perplexity(model, dv, ctx) if dv else None,
               "prompts": self.prompt_suite(model, tok)}
        atomic_write_json(out_path, res)
        del model
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        return res

    def compare(self, version: str, other: str, dataset_version: str | None = None) -> dict:
        after = self.evaluate(version, dataset_version)
        before = self.evaluate(other, dataset_version)
        pa = (after.get("ppl") or {}).get("perplexity")
        pb = (before.get("ppl") or {}).get("perplexity")
        ka, kb = after["prompts"]["keyword_score"], before["prompts"]["keyword_score"]
        verdict = "unknown"
        if pa and pb:
            change = (pb - pa) / pb
            verdict = "improved" if change > 0.02 else "regressed" if change < -0.02 else "unchanged"
            if ka is not None and kb is not None and ka + 0.1 < kb:
                verdict = "mixed"  # البربليكسيتي تحسّن لكن جودة الأجوبة نزلت
        summary = {"compared_to": other, "dataset_version": after["dataset_version"],
                   "perplexity_before": pb, "perplexity_after": pa,
                   "keyword_score_before": kb, "keyword_score_after": ka,
                   "distinct2_after": after["prompts"]["distinct2"],
                   "arabic_ratio_after": after["prompts"]["arabic_ratio"], "verdict": verdict}
        atomic_write_json(self.paths.evals / f"compare__{version}__vs__{other}.json", summary)
        return {"summary": summary, "after": after, "before": before}

    def all_results(self) -> list[dict]:
        out = []
        for p in sorted(self.paths.evals.glob("compare__*.json")):
            r = read_json(p)
            r["model_version"] = p.stem.split("__")[1]
            out.append(r)
        return out
