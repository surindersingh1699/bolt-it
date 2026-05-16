"""Golden ticket eval — checks that retrieval surfaces the expected runbook
as the top hit for each ticket in the corpus.

This is the smoke test for RAG quality. Phase 4 adds LangSmith-backed
LLM-judge scoring of plan correctness.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

import yaml  # noqa: E402

from it_copilot.rag.ingest import reindex_runbooks, seed_runbooks_and_users  # noqa: E402
from it_copilot.rag.retriever import get_retriever  # noqa: E402


async def main() -> int:
    cases = yaml.safe_load(Path(__file__).with_name("golden_tickets.yaml").read_text())
    await seed_runbooks_and_users()
    await reindex_runbooks()
    retriever = await get_retriever(k=4)

    passed = 0
    for case in cases:
        query = f"{case['subject']}. {case['body']}"
        hits = await retriever.aretrieve(query)
        top = hits[0].runbook_id if hits else None
        ok = top == case["expect_runbook"]
        status = "PASS" if ok else "FAIL"
        passed += int(ok)
        print(f"  [{status}] {case['subject']!r} -> {top} (expected {case['expect_runbook']})")

    n = len(cases)
    print(f"\n{passed}/{n} passing ({passed * 100 // n}%)")
    return 0 if passed >= int(0.75 * n) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
