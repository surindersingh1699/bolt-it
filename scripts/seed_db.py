"""Seed runbooks + AD personas from seed/*.yaml."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from it_copilot.rag.ingest import seed_runbooks_and_users  # noqa: E402


async def main() -> None:
    n_rb, n_u = await seed_runbooks_and_users()
    print(f"Seeded {n_rb} runbooks, {n_u} users")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:  # noqa: BLE001
        print(f"FAILED: {e!r}", file=sys.stderr)
        sys.exit(1)
