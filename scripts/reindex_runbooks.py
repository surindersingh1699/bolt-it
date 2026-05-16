"""Rebuild the runbook vector index from scratch."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from it_copilot.rag.ingest import reindex_runbooks  # noqa: E402


async def main() -> None:
    n = await reindex_runbooks()
    print(f"Indexed {n} chunks")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:  # noqa: BLE001
        print(f"FAILED: {e!r}", file=sys.stderr)
        sys.exit(1)
