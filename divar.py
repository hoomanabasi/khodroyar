import asyncio
import json
import shutil
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from langchain_core.tools import StructuredTool, ToolException
from mcp import ClientSession, StdioServerParameters, stdio_client
from mcp.types import PaginatedRequestParams, TextContent, Tool

from config import Settings

CAR_CATEGORY = "light"
CATEGORY_TOOLS = {
    "dv_filters",
    "dv_filter_options",
    "dv_search",
    "dv_cheapest",
    "dv_best_for_budget",
    "dv_find_deals",
    "dv_market",
    "dv_appraise",
}
TOOLS = CATEGORY_TOOLS | {
    "dv_cities",
    "dv_districts",
    "dv_post",
    "dv_similar",
    "dv_compare",
}


class DivarMCP:
    def __init__(self, settings: Settings):
        bundled = Path(sys.executable).with_name("divar-mcp")
        command = str(bundled) if bundled.is_file() else shutil.which("divar-mcp")
        if not command:
            raise RuntimeError(
                "Install divar-mcp in the application's Python environment."
            )
        self.capacity = asyncio.Semaphore(5)
        self.server = StdioServerParameters(
            command=command,
            env={"DIVAR_MCP_PROXY": settings.divar_proxy}
            if settings.divar_proxy
            else {},
        )

    @asynccontextmanager
    async def session(self):
        async with stdio_client(self.server) as streams:
            async with ClientSession(*streams, read_timeout_seconds=18) as session:
                await session.initialize()
                yield session

    async def tools(self) -> list[StructuredTool]:
        available = []
        async with self.session() as session:
            page = await session.list_tools()
            available.extend(page.tools)
            while page.next_cursor:
                page = await session.list_tools(
                    params=PaginatedRequestParams(cursor=page.next_cursor)
                )
                available.extend(page.tools)
        missing = TOOLS - {tool.name for tool in available}
        if missing:
            raise RuntimeError(
                f"Divar MCP is missing tools: {', '.join(sorted(missing))}"
            )
        return [self.adapt(tool) for tool in available if tool.name in TOOLS]

    def adapt(self, tool: Tool) -> StructuredTool:
        async def run(**arguments: Any) -> str:
            return await self.invoke(tool.name, arguments)

        schema = tool.input_schema
        if tool.name in CATEGORY_TOOLS:
            schema = {
                **schema,
                "properties": {
                    key: spec
                    for key, spec in schema["properties"].items()
                    if key != "category"
                },
                "required": [
                    key for key in schema.get("required", []) if key != "category"
                ],
            }
        return StructuredTool(
            name=tool.name,
            description=tool.description or tool.name,
            args_schema=schema,
            coroutine=run,
        )

    async def invoke(self, name: str, arguments: dict[str, Any]) -> str:
        async with self.capacity:
            async with self.session() as session:
                try:
                    return await self.call(session, name, dict(arguments))
                except ToolException as error:
                    failure = error
            raise failure

    async def call(
        self, session: ClientSession, name: str, arguments: dict[str, Any]
    ) -> str:
        if name in CATEGORY_TOOLS or name in {
            "dv_count",
            "dv_new_since",
            "dv_export",
            "dv_nearby",
        }:
            arguments["category"] = CAR_CATEGORY

        if name == "dv_post":
            return await self.car_post(session, arguments)
        if name == "dv_compare":
            tokens = arguments.get("tokens")
            if not isinstance(tokens, list) or not 2 <= len(tokens) <= 6:
                raise ToolException("برای مقایسه، دو تا شش آگهی معتبر لازم است.")
            await asyncio.gather(
                *(self.car_post(session, {"token": token}) for token in tokens)
            )
        if name in {"dv_similar", "dv_appraise", "dv_seller"} and arguments.get(
            "token"
        ):
            await self.car_post(session, {"token": arguments["token"]})
        return await self.read_tool(session, name, arguments)

    async def car_post(self, session: ClientSession, arguments: dict[str, Any]) -> str:
        text = await self.read_tool(session, "dv_post", {"max_images": 0, **arguments})
        ad = json.loads(text)
        if ad.get("category") not in {"car", CAR_CATEGORY}:
            raise ToolException("این آگهی در دستهٔ خودروهای سواری و وانت تأیید نشد.")
        return text

    @staticmethod
    async def read_tool(
        session: ClientSession, name: str, arguments: dict[str, Any]
    ) -> str:
        result = await session.call_tool(name, arguments)
        if result.is_error:
            raise ToolException(
                "دیوار به این درخواست پاسخ نداد یا ورودی ابزار را نپذیرفت."
            )
        return "\n".join(
            block.text for block in result.content if isinstance(block, TextContent)
        )
