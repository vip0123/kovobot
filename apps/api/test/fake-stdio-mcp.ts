// A local (stdio) MCP server for the tests: a program an Operator lists in MCP_LOCAL_SERVERS, run
// by Node as a child of the Bot service. Its one tool says what of its environment it was given,
// so the tests can see the Bot service's own settings stay out of it.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({ name: "Pantry", version: "1.0.0" });
server.registerTool(
  "count_flour",
  { description: "Counts the bags of flour in the pantry.", annotations: { readOnlyHint: true } },
  async () => ({
    content: [
      {
        type: "text",
        text: `12 bags in the ${process.env.PANTRY ?? "unnamed"} pantry. Secret seen: ${process.env.KOVOBOT_TEST_SECRET ? "yes" : "no"}.`,
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
