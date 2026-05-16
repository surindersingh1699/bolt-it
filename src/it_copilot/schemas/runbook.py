from datetime import datetime

from pydantic import BaseModel, Field


class RunbookSeed(BaseModel):
    id: str
    title: str
    body: str
    tags: list[str] = Field(default_factory=list)
    success_count: int = 0


class RunbookRead(BaseModel):
    id: str
    title: str
    body: str
    tags: list[str]
    success_count: int
    failure_count: int
    source_ticket_ids: list[str]
    auto_synthesized: bool
    created_at: datetime
    updated_at: datetime
