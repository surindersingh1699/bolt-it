"""LangGraph checkpointer wiring with a persistent psycopg async connection pool.

`AsyncPostgresSaver.from_conn_string` is a context manager intended for short
scripts — it closes the connection on exit. For a long-running FastAPI service
(and tests), wrap a persistent AsyncConnectionPool instead.
"""

from psycopg_pool import AsyncConnectionPool

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from it_copilot.config import get_settings

_settings = get_settings()


def _to_psycopg_url(url: str) -> str:
    return (
        url.replace("postgresql+asyncpg://", "postgresql://")
           .replace("postgresql+psycopg://", "postgresql://")
    )


_pool: AsyncConnectionPool | None = None
_saver: AsyncPostgresSaver | None = None


async def init_checkpointer() -> AsyncPostgresSaver:
    global _pool, _saver
    if _saver is not None:
        return _saver
    _pool = AsyncConnectionPool(
        _to_psycopg_url(_settings.database_url),
        kwargs={"autocommit": True, "prepare_threshold": 0},
        open=False,
        max_size=10,
    )
    await _pool.open()
    _saver = AsyncPostgresSaver(_pool)
    await _saver.setup()
    return _saver


async def close_checkpointer() -> None:
    global _pool, _saver
    if _pool is not None:
        await _pool.close()
    _pool = None
    _saver = None
