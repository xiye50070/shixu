"""Configuration tests do not call any model provider."""

import pytest

from app.main import Settings


def test_token_and_retry_defaults():
    settings = Settings()
    assert settings.max_output_tokens == 1024
    assert settings.max_retries == 1


def test_env_overrides_dotenv_token_limits(monkeypatch):
    monkeypatch.setattr("app.main.dotenv_values", lambda _: {
        "DEEPSEEK_MAX_TOKENS": "512", "DEEPSEEK_MAX_RETRIES": "2",
    })
    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    monkeypatch.setenv("DEEPSEEK_MAX_TOKENS", "16")
    monkeypatch.setenv("DEEPSEEK_MAX_RETRIES", "0")
    settings = Settings.from_env()
    assert settings.max_output_tokens == 16
    assert settings.max_retries == 0


@pytest.mark.parametrize("field,value,setting_name", [
    ("max_output_tokens", 0, "DEEPSEEK_MAX_TOKENS"),
    ("max_output_tokens", -1, "DEEPSEEK_MAX_TOKENS"),
    ("max_output_tokens", 16385, "DEEPSEEK_MAX_TOKENS"),
    ("max_retries", -1, "DEEPSEEK_MAX_RETRIES"),
    ("max_retries", 4, "DEEPSEEK_MAX_RETRIES"),
])
def test_invalid_limits_have_clear_errors(field, value, setting_name):
    with pytest.raises(ValueError, match=setting_name):
        Settings(**{field: value})


def test_noninteger_env_limit_has_clear_error(monkeypatch):
    monkeypatch.setattr("app.main.dotenv_values", lambda _: {})
    monkeypatch.setenv("DEEPSEEK_MAX_TOKENS", "many")
    with pytest.raises(ValueError, match="DEEPSEEK_MAX_TOKENS 必须是整数"):
        Settings.from_env()
