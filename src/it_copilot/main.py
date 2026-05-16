import logging

import structlog
from fastapi import FastAPI

from it_copilot.api import admin, dashboard, health, runbooks, tickets
from it_copilot.config import get_settings
from it_copilot.tools._registry import load_all_tools


def create_app() -> FastAPI:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level)
    structlog.configure(processors=[structlog.processors.TimeStamper(fmt="iso"), structlog.dev.ConsoleRenderer()])
    load_all_tools()
    app = FastAPI(title="IT Support Copilot", version="0.1.0")
    app.include_router(dashboard.router)
    app.include_router(health.router)
    app.include_router(tickets.router)
    app.include_router(runbooks.router)
    app.include_router(admin.router)
    return app


app = create_app()
