import { NextResponse } from "next/server";
import { authenticatePrincipal, COMMAND_TOOLS, CommandCenterError, executeCommandTool } from "@/lib/command-center";
import { EXTENDED_COMMAND_TOOLS, executeExtendedCommandTool } from "@/lib/command-center-extended";

export const runtime = "nodejs";

const RESOURCE_METADATA = "https://ilawo-financial-portal.vercel.app/.well-known/oauth-protected-resource";
const allTools = [...COMMAND_TOOLS, ...EXTENDED_COMMAND_TOOLS];
const extendedNames = new Set(EXTENDED_COMMAND_TOOLS.map((tool) => tool.name as string));

function rpc(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }, { status });
}

function authError(error: CommandCenterError) {
  return new NextResponse(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: error.message } }), {
    status: error.status,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer resource_metadata=\"${RESOURCE_METADATA}\"`,
    },
  });
}

export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error", undefined, 400);
  }

  const id = body?.id ?? null;
  const method = String(body?.method || "");

  if (method === "initialize") {
    return rpc(id, {
      protocolVersion: body?.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "ilawo-financial-portal", version: "1.1.0" },
      instructions: "Use this server only for the authenticated Ilawo Community Grammar School Principal. Financial writes are protected by Supabase RLS and audit rules. WAEC and NECO support internal and external candidates; all other categories are internal-only. For image-derived or batch financial data, show the proposed entries to the Principal before calling a write tool.",
    });
  }

  if (method === "notifications/initialized") return new NextResponse(null, { status: 202 });
  if (method === "ping") return rpc(id, {});

  let auth;
  try {
    auth = await authenticatePrincipal(request);
  } catch (error) {
    if (error instanceof CommandCenterError) return authError(error);
    return rpcError(id, -32603, error instanceof Error ? error.message : "Authentication failed", undefined, 500);
  }

  if (method === "tools/list") return rpc(id, { tools: allTools });

  if (method === "tools/call") {
    const name = String(body?.params?.name || "");
    const args = body?.params?.arguments && typeof body.params.arguments === "object" ? body.params.arguments : {};
    try {
      const result = extendedNames.has(name)
        ? await executeExtendedCommandTool(auth.client, name, args)
        : await executeCommandTool(auth.client, auth.profile, name, args);
      return rpc(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: false,
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : "Tool call failed.";
      return rpc(id, { content: [{ type: "text", text }], isError: true });
    }
  }

  return rpcError(id, -32601, `Method '${method}' not found`);
}

export async function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
