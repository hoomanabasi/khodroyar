import asyncio
import logging
import os
import re
import secrets
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from langchain_core.messages import AIMessage, HumanMessage
from openai import APIConnectionError, APIStatusError
from pydantic import BaseModel, Field, StringConstraints

from agent import answer, build_agent
from config import ROOT, Settings
from divar import DivarMCP
from workspace_api import poll_workspace, router
from workspace_store import WorkspaceStore

logger = logging.getLogger(__name__)

MessageText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)
]
HistoryText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=16000)
]


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: HistoryText


class ChatRequest(BaseModel):
    message: MessageText
    history: list[ChatMessage] = Field(default_factory=list, max_length=12)


class ChatReply(BaseModel):
    answer: str
    tools: list[str]


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings.load()
    app.state.divar = DivarMCP(settings)
    app.state.graph = await build_agent(settings, app.state.divar)
    app.state.store = WorkspaceStore(
        Path(os.getenv("WORKSPACE_DB", str(ROOT / ".data" / "workspace.sqlite3")))
    )
    scheduler = asyncio.create_task(poll_workspace(app.state.store, app.state.divar))
    try:
        yield
    finally:
        scheduler.cancel()
        with suppress(asyncio.CancelledError):
            await scheduler


app = FastAPI(title="خودرویار", lifespan=lifespan)
app.include_router(router)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.middleware("http")
async def browser_workspace(request: Request, call_next):
    session = request.cookies.get("khodroyar_workspace", "")
    fresh = not re.fullmatch(r"[a-f0-9]{64}", session)
    request.state.owner = secrets.token_hex(32) if fresh else session
    origin = request.headers.get("origin")
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        try:
            parsed = urlsplit(origin) if origin else None
        except ValueError:
            return JSONResponse({"detail": "مبدأ درخواست مجاز نیست."}, status_code=403)
        if request.headers.get("sec-fetch-site") == "cross-site" or (
            parsed
            and (
                parsed.scheme not in {"http", "https"}
                or parsed.netloc.lower() != request.headers.get("host", "").lower()
            )
        ):
            return JSONResponse({"detail": "مبدأ درخواست مجاز نیست."}, status_code=403)
    response = await call_next(request)
    if fresh and (request.url.path == "/" or request.url.path.startswith("/api/")):
        response.set_cookie(
            "khodroyar_workspace",
            request.state.owner,
            httponly=True,
            samesite="lax",
            secure=request.url.scheme == "https",
            max_age=31536000,
        )
    if request.url.path.startswith("/api/") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    docs = request.url.path in {"/docs", "/redoc", "/docs/oauth2-redirect"}
    scripts = "'self' https://cdn.jsdelivr.net 'unsafe-inline'" if docs else "'self'"
    styles = (
        "'self' https://cdn.jsdelivr.net 'unsafe-inline'"
        if docs
        else "'self' 'unsafe-inline'"
    )
    response.headers["Content-Security-Policy"] = (
        f"default-src 'self'; script-src {scripts}; style-src {styles}; "
        "img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; "
        "object-src 'none'; base-uri 'none'; form-action 'self'"
    )
    return response


@app.get("/api/settings")
async def browser_settings():
    return {
        "tile_url": os.getenv(
            "MAP_TILE_URL", "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        ),
        "tile_attribution": os.getenv(
            "MAP_TILE_ATTRIBUTION", "© OpenStreetMap contributors"
        ),
    }


@app.get("/", include_in_schema=False)
async def home():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/health")
async def health():
    return {"status": "ready"}


@app.post("/api/chat", response_model=ChatReply)
async def chat(payload: ChatRequest, request: Request):
    messages = [
        HumanMessage(content=item.content)
        if item.role == "user"
        else AIMessage(content=item.content)
        for item in payload.history
    ]
    messages.append(HumanMessage(content=payload.message))
    try:
        text, tools = await asyncio.wait_for(
            answer(request.app.state.graph, messages), timeout=90
        )
    except TimeoutError as error:
        raise HTTPException(
            504, "پاسخ بیش از حد طول کشید. یک بار دیگر تلاش کنید."
        ) from error
    except (APIConnectionError, APIStatusError) as error:
        logger.warning("Model request failed (%s)", type(error).__name__)
        raise HTTPException(
            502, "سرور مدل پاسخ نداد. اتصال و تنظیمات مدل را بررسی کنید."
        ) from error
    except Exception as error:
        logger.error("Agent request failed (%s)", type(error).__name__)
        raise HTTPException(
            500, "پردازش پیام با خطا روبه‌رو شد. دوباره تلاش کنید."
        ) from error
    return ChatReply(answer=text, tools=tools)
