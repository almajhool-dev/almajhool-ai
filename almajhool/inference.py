"""محرك الاستدلال — يحمّل إصدار النموذج مرة واحدة ويخدم المحادثات (مع Streaming)."""
from __future__ import annotations

import threading
from typing import Iterator

from .config import Paths
from .models.manager import ModelManager

SYSTEM_PROMPT = ("أنت «المبرمج المجهول AI»، مساعد ذكي يتحدث العربية والإنجليزية، "
                 "متخصص في البرمجة والأمن الرقمي وتحليل السوشيال ميديا. أجب بدقة ووضوح.")


class InferenceEngine:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.paths = Paths(cfg)
        self.mm = ModelManager(cfg)
        self._loaded: str | None = None
        self.model = self.tok = None
        self._lock = threading.Lock()

    def available(self) -> list[str]:
        return ["base"] + [v["version"] for v in self.mm.versions()]

    def ensure(self, version: str | None) -> str:
        from .models.loader import load_for_inference

        if version in (None, "", "latest", "active"):
            act = self.mm.active()
            version = act["version"] if act else "base"
        if version == self._loaded:
            return version
        trc = self.cfg["model"].get("trust_remote_code", False)
        if version == "base":
            base, adapter = self.cfg["model"]["base"], None
        else:
            v = self.mm.get(version)
            base = str(self.paths.root / v["full_path"]) if v.get("full_path") else v["base_model"]
            adapter = self.paths.root / v["adapter_path"] if v.get("adapter_path") else None
        self.model = None
        self.model, self.tok = load_for_inference(base, adapter, trust_remote_code=trc)
        self._loaded = version
        return version

    def _prepare(self, messages: list[dict]):
        if not any(m["role"] == "system" for m in messages):
            messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages
        if getattr(self.tok, "chat_template", None):
            text = self.tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        else:
            text = "\n".join(f"{m['role']}: {m['content']}" for m in messages) + "\nassistant:"
        dev = next(self.model.parameters()).device
        return self.tok(text, return_tensors="pt").to(dev)

    def _gen_kwargs(self, max_tokens: int, temperature: float, top_p: float) -> dict:
        kw = {"max_new_tokens": max_tokens, "pad_token_id": self.tok.pad_token_id,
              "repetition_penalty": 1.1}
        if temperature and temperature > 0:
            kw.update(do_sample=True, temperature=temperature, top_p=top_p)
        else:
            kw["do_sample"] = False
        return kw

    def chat(self, messages: list[dict], version: str | None = None, max_tokens: int = 512,
             temperature: float = 0.7, top_p: float = 0.9) -> dict:
        import torch

        with self._lock:
            version = self.ensure(version)
            inputs = self._prepare(messages)
            with torch.no_grad():
                out = self.model.generate(**inputs, **self._gen_kwargs(max_tokens, temperature, top_p))
            new = out[0][inputs["input_ids"].shape[1]:]
            return {"text": self.tok.decode(new, skip_special_tokens=True).strip(), "version": version,
                    "prompt_tokens": int(inputs["input_ids"].shape[1]), "completion_tokens": int(len(new))}

    def stream(self, messages: list[dict], version: str | None = None, max_tokens: int = 512,
               temperature: float = 0.7, top_p: float = 0.9) -> Iterator[str]:
        from transformers import TextIteratorStreamer

        with self._lock:
            self.ensure(version)
            inputs = self._prepare(messages)
            streamer = TextIteratorStreamer(self.tok, skip_prompt=True, skip_special_tokens=True)
            t = threading.Thread(target=self.model.generate, kwargs={
                **inputs, **self._gen_kwargs(max_tokens, temperature, top_p), "streamer": streamer})
            t.start()
            yield from streamer
            t.join()


def push_model_to_hub(cfg: dict, version: str, repo_id: str, private: bool = True, merged: bool = False) -> str:
    """ينشر الإصدار على Hugging Face Hub (Adapter أو نموذج مدموج)."""
    from huggingface_hub import HfApi

    mm, paths = ModelManager(cfg), Paths(cfg)
    v = mm.get(version)
    if merged:
        folder = paths.root / v["merged_path"] if v.get("merged_path") else mm.merge(version)
    else:
        folder = paths.root / (v.get("adapter_path") or v["full_path"])
    api = HfApi()
    api.create_repo(repo_id, private=private, exist_ok=True)
    card = (f"# المبرمج المجهول AI — {version}\n\n- Base: `{v['base_model']}`\n"
            f"- Dataset version: `{v['dataset_version']}`\n- Method: {v['method']}\n"
            f"- Eval: `{v.get('eval')}`\n")
    (folder / "README.md").write_text(card, encoding="utf-8")
    api.upload_folder(folder_path=str(folder), repo_id=repo_id,
                      commit_message=f"Upload {version}")
    return f"https://huggingface.co/{repo_id}"
