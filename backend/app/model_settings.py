"""Validated model settings, secret-free readback, and provider construction."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from langchain_deepseek import ChatDeepSeek
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

Provider = Literal["deepseek", "openai"]


def normalize_base_url(value: str) -> str:
    """Preserve endpoint paths, but reject credentials and ambiguous URL parts."""
    value = value.strip()
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        raise ValueError("Base URL 必须是有效的 HTTP 或 HTTPS 地址") from None
    if (
        parts.scheme.lower() not in {"http", "https"}
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
        or "?" in value
        or "#" in value
        or "\\" in value
        or any(character.isspace() or ord(character) < 32 for character in value)
    ):
        raise ValueError("Base URL 仅支持 HTTP/HTTPS，且不能包含账号、密码、查询参数或片段")
    hostname = parts.hostname.lower()
    host = f"[{hostname}]" if ":" in hostname else hostname
    scheme = parts.scheme.lower()
    if port is not None and (scheme, port) not in {("https", 443), ("http", 80)}:
        host += f":{port}"
    return urlunsplit((scheme, host, parts.path.rstrip("/"), "", ""))


class ModelSettingsInput(BaseModel):
    # FastAPI's validation handler also strips input values from API errors.
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    provider: Provider
    model: str = Field(min_length=1, max_length=200)
    base_url: str = Field(min_length=1, max_length=2048)
    max_output_tokens: int = Field(ge=1, le=16384, strict=True)
    api_key: SecretStr | None = Field(default=None, max_length=4096)

    @field_validator("model", mode="before")
    @classmethod
    def valid_model(cls, value):
        if isinstance(value, str):
            value = value.strip()
            if any(character.isspace() or ord(character) < 32 for character in value):
                raise ValueError("模型名称不能包含空格或控制字符")
        return value

    @field_validator("base_url")
    @classmethod
    def valid_base_url(cls, value: str) -> str:
        return normalize_base_url(value)

    @field_validator("api_key")
    @classmethod
    def valid_api_key(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None:
            return None
        key = value.get_secret_value().strip()
        if any(character.isspace() or ord(character) < 32 for character in key):
            raise ValueError("API Key 不能包含空格或控制字符")
        return SecretStr(key)


@dataclass(frozen=True)
class ModelConfiguration:
    provider: Provider = "deepseek"
    model: str = "deepseek-flash"
    base_url: str = "https://api.deepseek.com"
    max_output_tokens: int = 1024
    api_key: str = field(default="", repr=False)
    max_retries: int = 1
    source: Literal["environment", "saved"] = "environment"

    def public(self) -> dict:
        return {
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "max_output_tokens": self.max_output_tokens,
            "api_key_configured": bool(self.api_key),
            "source": self.source,
        }

    def stored(self) -> dict:
        return {
            "provider": self.provider, "model": self.model,
            "base_url": self.base_url, "max_output_tokens": self.max_output_tokens,
            "api_key": self.api_key,
        }

    @classmethod
    def from_saved(cls, values: dict) -> "ModelConfiguration":
        body = ModelSettingsInput.model_validate(values)
        key = body.api_key.get_secret_value() if body.api_key else ""
        return cls(
            provider=body.provider, model=body.model, base_url=body.base_url,
            max_output_tokens=body.max_output_tokens, api_key=key, source="saved",
        )


def resolve_model_settings(body: ModelSettingsInput, current: ModelConfiguration) -> ModelConfiguration:
    supplied_key = body.api_key.get_secret_value() if body.api_key else ""
    same_endpoint = (
        body.provider == current.provider
        and body.base_url == normalize_base_url(current.base_url)
    )
    key = supplied_key or (current.api_key if same_endpoint else "")
    if not key:
        raise ValueError("请填写 API Key；切换供应商或 Base URL 时需要重新填写。")
    return ModelConfiguration(
        provider=body.provider, model=body.model, base_url=body.base_url,
        max_output_tokens=body.max_output_tokens, api_key=key,
        max_retries=current.max_retries, source="saved",
    )


def build_chat_model(config: ModelConfiguration, *, for_test: bool = False):
    options = {
        "model": config.model,
        "api_key": config.api_key,
        "base_url": config.base_url,
        "timeout": 20 if for_test else 90,
        "max_tokens": min(config.max_output_tokens, 16) if for_test else config.max_output_tokens,
        "max_retries": 0 if for_test else config.max_retries,
        "streaming": not for_test,
    }
    if config.provider == "deepseek":
        return ChatDeepSeek(
            **options,
            stream_usage=not for_test,
            extra_body={"thinking": {"type": "disabled"}},
        )
    return ChatOpenAI(**options, stream_usage=False, use_responses_api=False)
