import pytest

from it_copilot.tools._registry import load_all_tools


@pytest.fixture(scope="session", autouse=True)
def _load_tools() -> None:
    load_all_tools()
