import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions


async def main():
    async for message in query(
        prompt="Find and fix the bug in auth.py",
        options=ClaudeAgentOptions(
            allowed_tools=["Read", "Edit", "Bash", "WebSearch"],
            permission_mode="acceptEdits"
        )
    ):
        print(message)  # Claude reads the file, finds the bug, edits it


asyncio.run(main())
