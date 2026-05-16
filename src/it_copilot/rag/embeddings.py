"""Embedding provider that gracefully falls back to a deterministic stub.

The stub uses a SHA-256-derived pseudo-random vector keyed by token-bag, so
identical texts get identical vectors and overlapping vocabulary produces
correlated vectors. It is good enough to make the retriever functionally
correct on the small seed corpus, and lets the whole service run with no
external API.
"""

import hashlib
import math
import re
from collections.abc import Sequence

from it_copilot.config import get_settings

DIM = 1536


def _stub_embed_one(text: str) -> list[float]:
    tokens = [t for t in re.findall(r"[a-z0-9]+", text.lower()) if len(t) > 2]
    if not tokens:
        tokens = ["<empty>"]
    acc = [0.0] * DIM
    for tok in tokens:
        h = hashlib.sha256(tok.encode("utf-8")).digest()
        # spread the 32 bytes across the 1536 dims
        for i in range(DIM):
            byte = h[i % 32]
            sign = 1.0 if (i // 32) % 2 == 0 else -1.0
            acc[i] += sign * (byte / 255.0 - 0.5)
    norm = math.sqrt(sum(x * x for x in acc)) or 1.0
    return [x / norm for x in acc]


def stub_embed(texts: Sequence[str]) -> list[list[float]]:
    return [_stub_embed_one(t) for t in texts]


class Embedder:
    """Async embedding helper. Uses OpenAIEmbeddings if a key is configured,
    otherwise the deterministic stub.
    """

    def __init__(self) -> None:
        settings = get_settings()
        self._real = None
        if settings.has_openai:
            from langchain_openai import OpenAIEmbeddings

            self._real = OpenAIEmbeddings(
                model=settings.embed_model,
                api_key=settings.openai_api_key,
            )

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        if self._real is not None:
            return await self._real.aembed_documents(list(texts))
        return stub_embed(texts)

    async def embed_query(self, text: str) -> list[float]:
        if self._real is not None:
            return await self._real.aembed_query(text)
        return stub_embed([text])[0]
