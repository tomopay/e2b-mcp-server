#!/usr/bin/env node
/**
 * E2B MCP Server — payment-gated entry point
 *
 * Wraps the standard E2B MCP server with Tomopay payment gating.
 * Agents pay per tool call via x402 (USDC on Base) or MPP (Stripe Machine Payments Protocol).
 *
 * Pricing:
 *   run_code  — $0.05/call  (code execution — ~30–60s sandbox run @ $0.000014/vCPU-s)
 *
 * Usage:
 *   E2B_API_KEY=<key> TOMOPAY_ADDRESS=<wallet> node build/index.pay.js
 *
 * See: https://github.com/tomopay/gateway
 */
import { Sandbox } from "@e2b/code-interpreter";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import dotenv from "dotenv";
import { withPayments } from "@tomopay/gateway";

dotenv.config();

const toolSchema = z.object({
  code: z.string(),
});

const server = new Server(
  {
    name: "e2b-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

server.onerror = (error) => {
  console.error("[MCP Error]", error);
};

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "run_code",
      description:
        "Run python code in a secure sandbox by E2B. Using the Jupyter Notebook syntax. Costs $0.05 per call (agent-native payment via x402/MPP).",
      inputSchema: zodToJsonSchema(toolSchema),
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "run_code") {
    throw new McpError(
      ErrorCode.MethodNotFound,
      `Unknown tool: ${request.params.name}`
    );
  }

  const parsed = toolSchema.safeParse(request.params.arguments);
  if (!parsed.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Invalid code interpreter arguments"
    );
  }

  const { code } = parsed.data;

  const sandbox = await Sandbox.create();
  const { results, logs } = await sandbox.runCode(code);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ results, logs }, null, 2),
      },
    ],
  };
});

// Wrap server with Tomopay payment gating.
// Agents must settle payment before each tool call is executed.
const { server: gatedServer } = withPayments(server, {
  payTo: process.env.TOMOPAY_ADDRESS || "",
  protocols: ["x402", "mpp"],
  pricing: {
    // Code execution: ~30–60s sandbox run @ E2B's $0.000014/vCPU-s
    run_code: { amount: 5, currency: "USD" }, // $0.05/call (amount in cents)
  },
});

const transport = new StdioServerTransport();
await gatedServer.connect(transport);
