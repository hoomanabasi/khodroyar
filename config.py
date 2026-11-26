import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from pydantic import SecretStr

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    model_url: str
    api_key: SecretStr
    model: str
    divar_proxy: str | None

    @classmethod
    def load(cls) -> "Settings":
        model_url = os.getenv("AI_SERVER_IP", "").strip().rstrip("/")
        api_key = os.getenv("OPENAI_API_KEY", "").strip()
        model = os.getenv("AI_MODEL", "").strip()
        parsed = urlsplit(model_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("AI_SERVER_IP must be a valid OpenAI-compatible base URL.")
        if not api_key or not model:
            raise ValueError(
                "Set OPENAI_API_KEY and AI_MODEL in .env or the environment."
            )
        return cls(
            model_url, SecretStr(api_key), model, os.getenv("DIVAR_MCP_PROXY") or None
        )
