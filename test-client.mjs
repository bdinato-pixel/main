// Untracked test harness: spawns the MCP server over stdio and exercises its tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const toolName = process.argv[2];
const toolArgs = process.argv[3] ? JSON.parse(process.argv[3]) : undefined;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY ?? "test-dummy-key" },
  stderr: "pipe",
});

const client = new Client({ name: "test-client", version: "1.0.0" });
await client.connect(transport);

if (!toolName) {
  const { tools } = await client.listTools();
  console.log(`Server exposes ${tools.length} tools:`);
  for (const t of tools) {
    const required = t.inputSchema?.required ?? [];
    const props = Object.keys(t.inputSchema?.properties ?? {});
    console.log(`- ${t.name}(${props.map((p) => (required.includes(p) ? p : p + "?")).join(", ")})`);
  }
} else {
  console.log(`Calling ${toolName} with`, toolArgs);
  const result = await client.callTool({ name: toolName, arguments: toolArgs });
  console.log("isError:", result.isError ?? false);
  for (const block of result.content) {
    console.log(block.type === "text" ? block.text : JSON.stringify(block));
  }
}

await client.close();
process.exit(0);
