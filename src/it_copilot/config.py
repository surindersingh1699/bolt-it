from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = Field(
        default="postgresql+asyncpg://it_copilot:it_copilot@localhost:5432/it_copilot",
        alias="DATABASE_URL",
    )
    database_url_sync: str = Field(
        default="postgresql+psycopg://it_copilot:it_copilot@localhost:5432/it_copilot",
        alias="DATABASE_URL_SYNC",
    )

    openai_api_key: str | None = Field(default=None, alias="OPENAI_API_KEY")
    openai_model: str = Field(default="gpt-4o-mini", alias="OPENAI_MODEL")
    openai_verifier_model: str = Field(default="gpt-4o", alias="OPENAI_VERIFIER_MODEL")
    embed_model: str = Field(default="text-embedding-3-small", alias="EMBED_MODEL")

    langsmith_api_key: str | None = Field(default=None, alias="LANGSMITH_API_KEY")
    langsmith_project: str = Field(default="it-copilot", alias="LANGSMITH_PROJECT")

    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    @property
    def has_openai(self) -> bool:
        return bool(self.openai_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
