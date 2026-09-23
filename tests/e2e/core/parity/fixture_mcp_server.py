"""Tiny stdio MCP server used by the entrypoint-parity suite.

Exposes one tool, ``parity_canary``, whose result is the value of the
``PARITY_MCP_CANARY`` env var — so a test can prove a REAL tool call round-tripped
through the real Hermes MCP client (discovery, transport, liveness checks, result
plumbing) instead of a registered-but-dead schema.

``PARITY_MCP_SPAWN_GRANDCHILD=1`` makes the server fork a long-lived grandchild at
startup (the shape of npx/uvx wrappers and servers with worker helpers) so
shutdown tests can prove Hermes reaps the whole process tree, not just its direct
child. Every PID the server owns is appended to ``PARITY_MCP_PID_LOG`` so the test
can check liveness of exactly the processes this fixture created.
"""

from __future__ import annotations

import os
import subprocess
import sys


def _log_pid(kind: str, pid: int) -> None:
    path = os.environ.get("PARITY_MCP_PID_LOG")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"{kind} {pid}\n")


def _spawn_grandchild() -> None:
    # Inherits the environment (and so the orphan-scan tag). Reads nothing,
    # writes nothing, lives until killed: an orphan if the tree is not reaped.
    child = subprocess.Popen(
        [sys.executable, "-c", "import time\nwhile True: time.sleep(60)"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _log_pid("grandchild", child.pid)


def main() -> None:
    from mcp.server import MCPServer

    _log_pid("server", os.getpid())
    if os.environ.get("PARITY_MCP_SPAWN_GRANDCHILD") == "1":
        _spawn_grandchild()

    server = MCPServer("parity")

    @server.tool()
    def parity_canary(nonce: str = "") -> str:
        """Return the parity fixture canary (echoing the caller's nonce)."""
        return f"{os.environ.get('PARITY_MCP_CANARY', 'NO-CANARY')}:{nonce}"

    server.run(transport="stdio")


if __name__ == "__main__":
    main()
