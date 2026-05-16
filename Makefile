.PHONY: up down migrate seed reindex dev test demo clean

up:
	docker compose up -d
	@echo "Waiting for Postgres..." && sleep 3

down:
	docker compose down

migrate:
	uv run alembic upgrade head

seed: migrate
	uv run python scripts/seed_db.py

reindex:
	uv run python scripts/reindex_runbooks.py

dev:
	uv run uvicorn it_copilot.main:app --reload --port 8000

test:
	uv run pytest -v

demo: up migrate seed reindex
	@echo ""
	@echo "Setup complete. In another terminal run:"
	@echo "  make dev"
	@echo "Then in a third terminal:"
	@echo "  bash scripts/demo.sh"

clean:
	docker compose down -v
	rm -rf .venv .pytest_cache .ruff_cache __pycache__
