from datetime import datetime, timezone

from pgvector.sqlalchemy import Vector
from sqlalchemy import JSON, BigInteger, DateTime, ForeignKey, Index, String, Text, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Ticket(Base):
    __tablename__ = "tickets"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(64), index=True, default="acme")
    reporter: Mapped[str] = mapped_column(String(256))
    reporter_email: Mapped[str] = mapped_column(String(256), index=True)
    subject: Mapped[str] = mapped_column(String(512))
    body: Mapped[str] = mapped_column(Text)
    channel: Mapped[str] = mapped_column(String(32), default="slack")
    status: Mapped[str] = mapped_column(String(32), default="new", index=True)
    plan: Mapped[list | None] = mapped_column(JSON, default=list)
    citations: Mapped[list | None] = mapped_column(JSON, default=list)
    exec_log: Mapped[list | None] = mapped_column(JSON, default=list)
    confidence: Mapped[float] = mapped_column(default=0.0)
    resolved_by_ai: Mapped[bool] = mapped_column(default=False)
    runbook_source_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    resolution_time_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now, server_default=func.now())

    audit_entries: Mapped[list["AuditEntry"]] = relationship(back_populates="ticket")


class Runbook(Base):
    __tablename__ = "runbooks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(256))
    body: Mapped[str] = mapped_column(Text)
    tags: Mapped[list | None] = mapped_column(JSON, default=list)
    success_count: Mapped[int] = mapped_column(default=0)
    failure_count: Mapped[int] = mapped_column(default=0)
    source_ticket_ids: Mapped[list | None] = mapped_column(JSON, default=list)
    auto_synthesized: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now, server_default=func.now())


class RunbookEmbedding(Base):
    """Chunk-level embeddings for runbooks. Many chunks per runbook."""

    __tablename__ = "runbook_embeddings"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    runbook_id: Mapped[str] = mapped_column(String(64), ForeignKey("runbooks.id", ondelete="CASCADE"), index=True)
    chunk_index: Mapped[int] = mapped_column(default=0)
    content: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float]] = mapped_column(Vector(1536))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, server_default=func.now())

    __table_args__ = (
        Index(
            "ix_runbook_embeddings_vector",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )


class User(Base):
    """Seed personas from the original project."""

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(256), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    workspace_id: Mapped[str] = mapped_column(String(64), default="acme")
    status: Mapped[str] = mapped_column(String(32), default="active")
    is_it_staff: Mapped[bool] = mapped_column(default=False)
    groups: Mapped[list | None] = mapped_column(JSON, default=list)


class AuditEntry(Base):
    """Append-only audit log. UPDATE/DELETE blocked by trigger."""

    __tablename__ = "audit_entries"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str | None] = mapped_column(String(16), ForeignKey("tickets.id"), index=True, nullable=True)
    actor: Mapped[str] = mapped_column(String(256))
    action: Mapped[str] = mapped_column(String(128), index=True)
    payload: Mapped[dict | None] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, server_default=func.now(), index=True)

    ticket: Mapped["Ticket | None"] = relationship(back_populates="audit_entries")


class IdempotencyKey(Base):
    __tablename__ = "idempotency_keys"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    request_path: Mapped[str] = mapped_column(String(256))
    response_body: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    response_status: Mapped[int | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, server_default=func.now(), index=True)
