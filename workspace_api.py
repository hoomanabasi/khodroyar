import asyncio
import csv
import io
import json
import logging
import math
import os
import re
from typing import Annotated, Literal
from urllib.parse import unquote, urlsplit

from fastapi import APIRouter, HTTPException, Query, Request, Response
from langchain_core.tools import ToolException
from pydantic import BaseModel, Field, StringConstraints, model_validator

from divar import DivarMCP
from workspace_store import WorkspaceStore

router = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)
POLL_SECONDS = max(60, int(os.getenv("WATCH_INTERVAL_SECONDS", "900")))
MCP_TIMEOUT = 32
Token = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{6,16}$")]
Short = Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]
Price = Annotated[int, Field(gt=0, le=10**13)]
AdInput = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=6, max_length=450)
]
Lat = Annotated[float, Field(ge=24, le=40)]
Lon = Annotated[float, Field(ge=43, le=64)]


class CarSearch(BaseModel):
    city: Short = "تهران"
    query: Short = ""
    model: Short = ""
    district: Short = ""
    min_price: Price | None = None
    max_price: Price | None = None
    year_min: int | None = Field(None, ge=1300, le=2100)
    year_max: int | None = Field(None, ge=1300, le=2100)
    mileage: int | None = Field(None, ge=0, le=2_000_000)
    gearbox: Literal["", "manual", "automatic"] = ""
    photos: bool = False

    @model_validator(mode="after")
    def validate_bounds(self):
        for lower, upper in (
            (self.min_price, self.max_price),
            (self.year_min, self.year_max),
        ):
            if lower is not None and upper is not None and lower > upper:
                raise ValueError("حداقل باید از حداکثر کمتر باشد.")
        if not self.city:
            raise ValueError("شهر را انتخاب کنید.")
        return self

    def criteria(self) -> dict:
        raw = self.model_dump()
        filters = {}
        if raw["year_min"] is not None or raw["year_max"] is not None:
            filters["production-year"] = {
                "min": raw["year_min"],
                "max": raw["year_max"],
            }
        if raw["mileage"] is not None:
            filters["usage"] = {"max": raw["mileage"]}
        if raw["gearbox"]:
            filters["gearbox"] = raw["gearbox"]
        return {
            key: value
            for key, value in {
                "city": raw["city"],
                "query": raw["query"],
                "brand_model": [raw["model"]] if raw["model"] else None,
                "districts": [raw["district"]] if raw["district"] else None,
                "min_price": raw["min_price"],
                "max_price": raw["max_price"],
                "filters": filters,
                "has_photo": True if raw["photos"] else None,
            }.items()
            if value is not None and value != "" and value != {}
        }


class SearchPage(BaseModel):
    search: CarSearch
    mode: Literal["newest", "cheapest", "value", "deals"] = "newest"
    cursor: str | None = Field(None, max_length=220)


class Comparison(BaseModel):
    tokens: list[Token] = Field(min_length=2, max_length=6)


class Appraisal(BaseModel):
    ad: AdInput | None = None
    price: Price | None = None
    search: CarSearch = Field(default_factory=CarSearch)

    @model_validator(mode="after")
    def validate_input(self):
        if not self.ad and (
            self.price is None or not (self.search.model or self.search.query)
        ):
            raise ValueError("لینک آگهی یا مدل خودرو و قیمت پیشنهادی را وارد کنید.")
        return self


class Nearby(BaseModel):
    lat: Lat
    lon: Lon
    radius: int = Field(4000, ge=100, le=20000)
    search: CarSearch = Field(default_factory=CarSearch)


class WatchInput(BaseModel):
    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=75)
    ]
    search: CarSearch


class Tracking(BaseModel):
    search: CarSearch
    enabled: bool = True


def ad_token(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise HTTPException(422, "لینک معتبر آگهی دیوار را وارد کنید.") from error
    if parsed.scheme or parsed.netloc:
        if (
            parsed.scheme not in {"https", "http"}
            or parsed.netloc not in {"divar.ir", "www.divar.ir"}
            or not parsed.path.startswith("/v/")
        ):
            raise HTTPException(422, "لینک معتبر آگهی دیوار را وارد کنید.")
        value = unquote(parsed.path.rstrip("/").rsplit("/", 1)[-1])
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,16}", value):
        raise HTTPException(422, "شناسهٔ آگهی معتبر نیست.")
    return value


async def fetch(divar: DivarMCP, name: str, **args) -> dict:
    try:
        raw = await asyncio.wait_for(divar.invoke(name, args), timeout=MCP_TIMEOUT)
        return json.loads(raw)
    except ToolException as error:
        raise HTTPException(422, str(error)) from error
    except TimeoutError as error:
        raise HTTPException(
            504, "دیوار در زمان مقرر پاسخ نداد. دوباره تلاش کنید."
        ) from error
    except Exception as error:
        logger.warning("Divar request failed (%s: %s)", name, type(error).__name__)
        raise HTTPException(502, "ارتباط با داده‌های دیوار برقرار نشد.") from error


def owner(request: Request) -> str:
    return request.state.owner


@router.get("/options")
async def options(
    request: Request,
    kind: Literal["city", "model", "district"],
    q: Short = "",
    city: Short = "تهران",
):
    divar = request.app.state.divar
    if kind == "city":
        return await fetch(divar, "dv_cities", query=q or None, limit=12)
    if kind == "district":
        return await fetch(divar, "dv_districts", city=city, query=q or None, limit=14)
    return await fetch(
        divar,
        "dv_filter_options",
        city=city,
        filter="brand_model",
        query=q or None,
        limit=14,
    )


@router.post("/search")
async def search_page(payload: SearchPage, request: Request):
    divar = request.app.state.divar
    args = payload.search.criteria()
    if payload.mode == "newest":
        response = await fetch(
            divar, "dv_search", **args, cursor=payload.cursor, limit=12, thumbnails=True
        )
    elif payload.mode == "cheapest":
        response = await fetch(divar, "dv_cheapest", **args, limit=12, pages=3)
    elif payload.mode == "deals":
        response = await fetch(divar, "dv_find_deals", **args, limit=12, pages=3)
        response["ads"] = response.get("deals", [])
    else:
        budget = args.pop("max_price", None)
        if not budget:
            raise HTTPException(
                422, "برای پیشنهاد بر اساس بودجه، سقف قیمت را وارد کنید."
            )
        response = await fetch(
            divar, "dv_best_for_budget", **args, budget=budget, limit=12, pages=3
        )
        response["ads"] = response.get("best_value", [])
    if payload.mode != "newest":
        response["next_cursor"] = None
    # Ranking tools omit thumbnails. The detail panel can fetch images on demand.
    return response


@router.post("/count")
async def count_search(payload: CarSearch, request: Request):
    return await fetch(request.app.state.divar, "dv_count", **payload.criteria())


@router.get("/ads/{token}")
async def details(token: Token, request: Request):
    return await fetch(request.app.state.divar, "dv_post", token=token, max_images=8)


@router.get("/ads/{token}/similar")
async def similar(token: Token, request: Request):
    return await fetch(request.app.state.divar, "dv_similar", token=token, limit=8)


@router.get("/ads/{token}/seller")
async def seller(token: Token, request: Request):
    divar = request.app.state.divar
    response = await fetch(divar, "dv_seller", token=token, limit=8)
    brand = (response.get("business") or {}).get("brand_token")
    if brand:
        try:
            response["dealer"] = await fetch(divar, "dv_dealer", brand_token=brand)
        except HTTPException:
            pass
    ads = (response.get("dealer") or {}).get("ads") or response.get("ads") or []
    if ads:
        try:
            verified = await fetch(
                divar, "dv_posts", tokens=[ad["token"] for ad in ads[:10]]
            )
            response["ads"] = [
                ad
                for ad in verified.get("ads", [])
                if ad.get("category") in {"light", "car"}
            ]
        except HTTPException:
            response["ads"] = []
    if response.get("dealer"):
        response["dealer"].pop("ads", None)
    return response


@router.post("/compare")
async def compare(payload: Comparison, request: Request):
    tokens = list(dict.fromkeys(payload.tokens))
    if len(tokens) < 2:
        raise HTTPException(422, "دست‌کم دو آگهی متفاوت انتخاب کنید.")
    return await fetch(request.app.state.divar, "dv_compare", tokens=tokens)


@router.post("/appraise")
async def appraise(payload: Appraisal, request: Request):
    divar = request.app.state.divar
    if payload.ad:
        return await fetch(divar, "dv_appraise", token=ad_token(payload.ad))
    args = payload.search.criteria()
    allowed = {
        key: value
        for key, value in args.items()
        if key in {"city", "query", "brand_model", "districts", "filters"}
    }
    return await fetch(divar, "dv_appraise", price=payload.price, **allowed)


@router.post("/market")
async def market(payload: CarSearch, request: Request):
    state = request.app.state
    data = await fetch(state.divar, "dv_market", **payload.criteria(), pages=3)
    state.store.record(payload.model_dump(), data)
    return {
        **data,
        "history": state.store.history(payload.model_dump()),
        "tracking": payload.model_dump() in state.store.tracked(owner(request)),
    }


@router.get("/market/tracked")
async def tracked(request: Request):
    return request.app.state.store.tracked(owner(request))


@router.post("/market/tracked")
async def track(payload: Tracking, request: Request):
    try:
        request.app.state.store.tracking(
            owner(request), payload.search.model_dump(), payload.enabled
        )
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {"enabled": payload.enabled}


@router.get("/places")
async def places(
    request: Request,
    q: Annotated[str, Query(min_length=2, max_length=80)],
    lat: Lat = 35.7,
    lon: Lon = 51.4,
):
    return await fetch(
        request.app.state.divar, "dv_place_search", query=q, lat=lat, lon=lon
    )


def distance_m(lat: float, lon: float, place: dict) -> float:
    if place.get("lat") is None or place.get("lon") is None:
        return float("inf")
    north = (place["lat"] - lat) * 111_320
    east = (place["lon"] - lon) * 111_320 * math.cos(math.radians(lat))
    return math.hypot(north, east)


def normalize_district(value: str) -> str:
    return "".join(value.translate(str.maketrans("يك‌", "یک ")).split())


@router.post("/nearby")
async def nearby(payload: Nearby, request: Request):
    divar = request.app.state.divar
    args = payload.search.criteria()
    for key in ("city", "districts", "has_photo"):
        args.pop(key, None)
    direct = await fetch(
        divar,
        "dv_nearby",
        lat=payload.lat,
        lon=payload.lon,
        radius_m=payload.radius,
        limit=24,
        **args,
    )
    if direct.get("ads"):
        return direct

    # Cars can have district data even when the map endpoint exposes no pins.
    location = await fetch(divar, "dv_locate", lat=payload.lat, lon=payload.lon)
    district = location.get("district") or {}
    city = (location.get("city") or {}).get("name")
    if not city or not district.get("id"):
        return direct

    neighbors, center = await asyncio.gather(
        fetch(divar, "dv_neighbours", district_id=district["id"], city=city),
        fetch(divar, "dv_districts", city=city, query=district["name"], limit=14),
    )
    areas = {row["id"]: row for row in neighbors.get("districts", [])}
    areas.update({row["id"]: row for row in center.get("districts", [])})
    areas.setdefault(
        district["id"], {**district, "lat": payload.lat, "lon": payload.lon}
    )
    close = sorted(
        (
            row
            for row in areas.values()
            if distance_m(payload.lat, payload.lon, row) <= payload.radius
        ),
        key=lambda row: distance_m(payload.lat, payload.lon, row),
    )[:16]
    if not close:
        return direct
    data = await fetch(
        divar,
        "dv_search",
        **args,
        city=city,
        districts=[str(row["id"]) for row in close],
        limit=24,
        thumbnails=True,
    )
    coordinates = {
        normalize_district(row["name"]): row for row in close if row.get("name")
    }
    for ad in data.get("ads", []):
        area = coordinates.get(normalize_district(ad.get("district") or ""))
        if area:
            ad.update(lat=area["lat"], lon=area["lon"], approximate_area=True)
    return {**data, "approximate": True, "place": direct.get("place")}


@router.post("/export")
async def export(
    payload: CarSearch, request: Request, format: Literal["csv", "jsonl"] = "csv"
):
    data = await fetch(
        request.app.state.divar,
        "dv_export",
        **payload.criteria(),
        format=format,
        limit=100,
        pages=5,
    )
    content = data.get("data") or ""
    if format == "csv":
        output = io.StringIO()
        writer = csv.writer(output)
        for row in csv.reader(io.StringIO(content)):
            writer.writerow(
                [
                    "'" + cell
                    if cell.lstrip().startswith(("=", "+", "-", "@"))
                    or cell.startswith(("\t", "\r", "\n"))
                    else cell
                    for cell in row
                ]
            )
        content = "\ufeff" + output.getvalue()
    return Response(
        content,
        media_type="text/csv" if format == "csv" else "application/x-ndjson",
        headers={
            "Content-Disposition": f'attachment; filename="khodroyar-ads.{format}"'
        },
    )


@router.get("/watches")
async def watches(request: Request):
    records = request.app.state.store.watches(owner(request))
    for row in records:
        for private in ("owner", "next_at", "cursor", "lease_until"):
            row.pop(private, None)
    return {
        "watches": records,
        "unread": sum(row["unread"] for row in records),
        "interval_minutes": POLL_SECONDS // 60,
    }


@router.post("/watches", status_code=201)
async def save_watch(payload: WatchInput, request: Request):
    if not (
        payload.search.model
        or payload.search.query
        or payload.search.max_price
        or payload.search.district
    ):
        raise HTTPException(422, "برای پایش، مدل، عبارت، محله یا بودجه را مشخص کنید.")
    try:
        watch_id = request.app.state.store.save_watch(
            owner(request), payload.name, payload.search.model_dump()
        )
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {"id": watch_id}


@router.delete("/watches/{watch_id}", status_code=204, response_class=Response)
async def delete_watch(watch_id: str, request: Request):
    if not request.app.state.store.delete_watch(owner(request), watch_id):
        raise HTTPException(404, "جست‌وجوی ذخیره‌شده پیدا نشد.")


async def run_watch(store: WorkspaceStore, divar: DivarMCP, watch: dict) -> int:
    criteria = CarSearch.model_validate_json(watch["search"]).criteria()
    try:
        data = await fetch(
            divar, "dv_new_since", **criteria, since=watch["cursor"], pages=5, limit=80
        )
    except HTTPException as error:
        store.finish_watch(watch, [], watch["cursor"], error.detail, retry_in=90)
        raise
    ads = data.get("ads") or []
    issue = (
        "بخشی از آگهی‌های جدید خارج از محدودهٔ هر بررسی بود."
        if data.get("more")
        else None
    )
    store.finish_watch(watch, ads, data.get("latest") or watch["cursor"], issue)
    return len(ads)


@router.post("/watches/{watch_id}/check")
async def check_watch(watch_id: str, request: Request):
    state = request.app.state
    if watch_id not in {row["id"] for row in state.store.watches(owner(request))}:
        raise HTTPException(404, "جست‌وجوی ذخیره‌شده پیدا نشد.")
    record = state.store.claim_watch(POLL_SECONDS, owner(request), watch_id)
    if not record:
        raise HTTPException(409, "بررسی تازه انجام شده یا در حال انجام است.")
    return {"matches": await run_watch(state.store, state.divar, record)}


@router.get("/alerts")
async def alerts(request: Request):
    return {"alerts": request.app.state.store.alerts(owner(request))}


@router.post("/alerts/read", status_code=204, response_class=Response)
async def mark_alerts(request: Request):
    request.app.state.store.mark_seen(owner(request))


async def poll_workspace(store: WorkspaceStore, divar: DivarMCP):
    trends_after = 0.0
    while True:
        try:
            for _ in range(4):
                watch = store.claim_watch(POLL_SECONDS)
                if not watch:
                    break
                try:
                    await run_watch(store, divar, watch)
                except HTTPException:
                    continue
            now = asyncio.get_running_loop().time()
            if now >= trends_after:
                trends_after = now + POLL_SECONDS
                for search in store.due_trends():
                    try:
                        data = await fetch(
                            divar,
                            "dv_market",
                            **CarSearch.model_validate(search).criteria(),
                            pages=3,
                        )
                        store.record(search, data)
                    except HTTPException:
                        continue
        except Exception as error:
            logger.error("Workspace scheduler failed (%s)", type(error).__name__)
        await asyncio.sleep(20)
