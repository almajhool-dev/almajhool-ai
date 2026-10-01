"""طبقة الـ Tokenizer.

- يستخدم Tokenizer النموذج الأساسي نفسه (إجباري حتى تكون التوكنات صالحة للتدريب).
- يطبّق قالب المحادثة (chat template) تلقائيًا على بيانات المحادثات.
- يوفّر ByteTokenizer خفيفًا للاختبارات وللعمل بدون إنترنت.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any


class ByteTokenizer:
    """Tokenizer على مستوى البايت (UTF-8) — للاختبار فقط، لا يُستخدم للتدريب الحقيقي."""

    name = "byte"
    eos_token_id = 256
    pad_token_id = 257
    vocab_size = 258

    def encode_batch(self, texts: list[str]) -> list[list[int]]:
        return [list(t.encode("utf-8")) for t in texts]

    def decode(self, ids: list[int]) -> str:
        return bytes(i for i in ids if i < 256).decode("utf-8", errors="replace")

    def render(self, doc: dict[str, Any]) -> str:
        if "messages" in doc:
            return "\n".join(f"{m['role']}: {m['content']}" for m in doc["messages"])
        return doc["text"]


class HFTokenizer:
    def __init__(self, name: str, trust_remote_code: bool = False):
        from transformers import AutoTokenizer

        self.name = name
        self.tok = AutoTokenizer.from_pretrained(name, trust_remote_code=trust_remote_code)
        if self.tok.eos_token_id is None:
            raise ValueError(f"Tokenizer {name} has no EOS token")
        self.eos_token_id = self.tok.eos_token_id
        self.pad_token_id = self.tok.pad_token_id if self.tok.pad_token_id is not None else self.eos_token_id
        self.vocab_size = len(self.tok)
        self.has_chat_template = bool(getattr(self.tok, "chat_template", None))

    def encode_batch(self, texts: list[str]) -> list[list[int]]:
        return self.tok(texts, add_special_tokens=False)["input_ids"]

    def decode(self, ids: list[int]) -> str:
        return self.tok.decode(ids, skip_special_tokens=True)

    def render(self, doc: dict[str, Any]) -> str:
        """يحوّل مستند (نص أو محادثة) إلى نص نهائي جاهز للترميز."""
        if "messages" in doc:
            if self.has_chat_template:
                return self.tok.apply_chat_template(doc["messages"], tokenize=False)
            return "\n".join(f"<|{m['role']}|>\n{m['content']}" for m in doc["messages"])
        return doc["text"]


@lru_cache(maxsize=4)
def get_tokenizer(name: str, trust_remote_code: bool = False):
    if name == "byte":
        return ByteTokenizer()
    return HFTokenizer(name, trust_remote_code)


def same_tokenizer(a: str, b: str, trust_remote_code: bool = False) -> bool:
    """عائلة Qwen3 كلها تشترك بنفس الـ Tokenizer — فالداتاسيت تُرمَّز مرة وتخدم 0.6B حتى 32B."""
    if a == b:
        return True
    if "byte" in (a, b):
        return False
    ta, tb = get_tokenizer(a, trust_remote_code), get_tokenizer(b, trust_remote_code)
    return ta.eos_token_id == tb.eos_token_id and ta.tok.get_vocab() == tb.tok.get_vocab()


def token_dtype(vocab_size: int):
    import numpy as np

    # uint16 يوفّر نصف المساحة لو المفردات أقل من 65536، وإلا uint32
    return np.uint16 if vocab_size < 65_535 else np.uint32
