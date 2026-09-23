"""config.yaml write integrity: a save keeps what the user wrote."""

import pytest
import yaml

from hermes_cli.config import DEFAULT_CONFIG, load_config, migrate_config, save_config


@pytest.mark.parametrize("operation", ["save", "partial_save", "migrate"])
def test_authored_nulls_survive_config_writes(tmp_path, monkeypatch, operation):
    from hermes_cli.resource_limits import configured_nofile_soft_limit
    from agent.agent_runtime_helpers import prompt_caching_disabled_from_config

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    config_path = tmp_path / "config.yaml"
    seed = {
        "_config_version": DEFAULT_CONFIG["_config_version"] - (operation == "migrate"),
        "runtime": {"nofile_soft_limit": None},
        "prompt_caching": {"cache_ttl": None},
        "x_null_preservation": {"nested": {"optional": None}, "keep": "value"},
    }
    config_path.write_text(yaml.safe_dump(seed), encoding="utf-8")

    if operation == "migrate":
        migrate_config(interactive=False, quiet=True)
    elif operation == "partial_save":
        save_config({"display": {"skin": "mono"}}, merge_existing=True)
    else:
        config = load_config()
        config["display"]["skin"] = "mono"
        save_config(config)

    raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert raw["runtime"]["nofile_soft_limit"] is None
    assert raw["prompt_caching"]["cache_ttl"] is None
    assert raw["x_null_preservation"] == seed["x_null_preservation"]
    assert "terminal" not in raw
    assert configured_nofile_soft_limit() is None
    assert prompt_caching_disabled_from_config() is True
    if operation == "migrate":
        assert raw["_config_version"] == DEFAULT_CONFIG["_config_version"]
    else:
        assert raw["display"]["skin"] == "mono"
