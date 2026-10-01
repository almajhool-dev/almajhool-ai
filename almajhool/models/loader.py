"""تحميل النماذج بشكل موحّد للتدريب والتقييم والاستدلال."""
from __future__ import annotations

from pathlib import Path


def pick_dtype():
    import torch

    if torch.cuda.is_available():
        return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    return torch.float32


def load_base(base: str, quant_4bit: bool, trust_remote_code: bool = False):
    import torch
    from transformers import AutoModelForCausalLM

    kwargs: dict = {"torch_dtype": pick_dtype(), "trust_remote_code": trust_remote_code}
    if quant_4bit and torch.cuda.is_available():
        from transformers import BitsAndBytesConfig

        kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=pick_dtype())
    if torch.cuda.is_available():
        import os

        # مع torchrun كل عملية تأخذ GPU خاص بها
        kwargs["device_map"] = {"": int(os.environ.get("LOCAL_RANK", 0))}
    return AutoModelForCausalLM.from_pretrained(base, **kwargs)


def load_for_inference(base: str, adapter: Path | None, quant_4bit: bool = True,
                       trust_remote_code: bool = False):
    from transformers import AutoTokenizer

    model = load_base(base, quant_4bit, trust_remote_code)
    if adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, str(adapter))
    model.eval()
    tok = AutoTokenizer.from_pretrained(base, trust_remote_code=trust_remote_code)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    return model, tok
