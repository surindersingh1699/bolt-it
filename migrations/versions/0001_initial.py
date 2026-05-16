"""initial schema with pgvector + audit immutability trigger

Revision ID: 0001
Revises:
Create Date: 2026-05-16
"""

from typing import Sequence

import pgvector.sqlalchemy
import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "tickets",
        sa.Column("id", sa.String(16), primary_key=True),
        sa.Column("workspace_id", sa.String(64), nullable=False, server_default="acme"),
        sa.Column("reporter", sa.String(256), nullable=False),
        sa.Column("reporter_email", sa.String(256), nullable=False),
        sa.Column("subject", sa.String(512), nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("channel", sa.String(32), nullable=False, server_default="slack"),
        sa.Column("status", sa.String(32), nullable=False, server_default="new"),
        sa.Column("plan", sa.JSON, server_default="[]"),
        sa.Column("citations", sa.JSON, server_default="[]"),
        sa.Column("exec_log", sa.JSON, server_default="[]"),
        sa.Column("confidence", sa.Float, nullable=False, server_default="0"),
        sa.Column("resolved_by_ai", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("runbook_source_id", sa.String(64), nullable=True),
        sa.Column("resolution_time_ms", sa.BigInteger, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_tickets_workspace_id", "tickets", ["workspace_id"])
    op.create_index("ix_tickets_reporter_email", "tickets", ["reporter_email"])
    op.create_index("ix_tickets_status", "tickets", ["status"])

    op.create_table(
        "runbooks",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("tags", sa.JSON, server_default="[]"),
        sa.Column("success_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("failure_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("source_ticket_ids", sa.JSON, server_default="[]"),
        sa.Column("auto_synthesized", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "runbook_embeddings",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("runbook_id", sa.String(64), sa.ForeignKey("runbooks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("chunk_index", sa.Integer, nullable=False, server_default="0"),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(1536), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_runbook_embeddings_runbook_id", "runbook_embeddings", ["runbook_id"])
    op.execute(
        "CREATE INDEX ix_runbook_embeddings_vector ON runbook_embeddings "
        "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
    )

    op.create_table(
        "users",
        sa.Column("email", sa.String(256), primary_key=True),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("workspace_id", sa.String(64), nullable=False, server_default="acme"),
        sa.Column("status", sa.String(32), nullable=False, server_default="active"),
        sa.Column("is_it_staff", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("groups", sa.JSON, server_default="[]"),
    )

    op.create_table(
        "audit_entries",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("ticket_id", sa.String(16), sa.ForeignKey("tickets.id"), nullable=True),
        sa.Column("actor", sa.String(256), nullable=False),
        sa.Column("action", sa.String(128), nullable=False),
        sa.Column("payload", sa.JSON, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_audit_entries_ticket_id", "audit_entries", ["ticket_id"])
    op.create_index("ix_audit_entries_action", "audit_entries", ["action"])
    op.create_index("ix_audit_entries_created_at", "audit_entries", ["created_at"])

    # DB-enforced immutability — UPDATE and DELETE on audit_entries always raise.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION audit_entries_block_mutation()
        RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'audit_entries is append-only (%) blocked', TG_OP;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_entries_no_update
        BEFORE UPDATE ON audit_entries
        FOR EACH ROW EXECUTE FUNCTION audit_entries_block_mutation();
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_entries_no_delete
        BEFORE DELETE ON audit_entries
        FOR EACH ROW EXECUTE FUNCTION audit_entries_block_mutation();
        """
    )

    op.create_table(
        "idempotency_keys",
        sa.Column("key", sa.String(128), primary_key=True),
        sa.Column("request_path", sa.String(256), nullable=False),
        sa.Column("response_body", sa.JSON, nullable=True),
        sa.Column("response_status", sa.Integer, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_idempotency_keys_created_at", "idempotency_keys", ["created_at"])


def downgrade() -> None:
    op.drop_table("idempotency_keys")
    op.execute("DROP TRIGGER IF EXISTS audit_entries_no_delete ON audit_entries")
    op.execute("DROP TRIGGER IF EXISTS audit_entries_no_update ON audit_entries")
    op.execute("DROP FUNCTION IF EXISTS audit_entries_block_mutation()")
    op.drop_table("audit_entries")
    op.drop_table("users")
    op.drop_index("ix_runbook_embeddings_vector", table_name="runbook_embeddings")
    op.drop_table("runbook_embeddings")
    op.drop_table("runbooks")
    op.drop_table("tickets")
    op.execute("DROP EXTENSION IF EXISTS vector")
