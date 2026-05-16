from typing import Any

from it_copilot.schemas.plan import SlackReplyParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register


async def run(params: SlackReplyParams, ctx: dict[str, Any]) -> ToolResult:
    reporter = ctx.get("reporter_email", "<unknown>")
    return ToolResult(
        ok=True,
        log=[
            f"[slack.send_message] -> {reporter}: {params.message}",
        ],
        data={"to": reporter, "message": params.message},
    )


register(ToolEntry(
    capability="slack.send_message",
    risk="low",
    params_schema=SlackReplyParams,
    run=run,
    description="Send a message to the reporter in the originating Slack thread.",
))
