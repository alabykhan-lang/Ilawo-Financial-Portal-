import { NextResponse } from "next/server";
import { authenticatePrincipal, COMMAND_TOOLS, CommandCenterError, executeCommandTool } from "@/lib/command-center";
import { EXTENDED_COMMAND_TOOLS, executeExtendedCommandTool } from "@/lib/command-center-extended";

export const runtime = "nodejs";

const allTools = [...COMMAND_TOOLS, ...EXTENDED_COMMAND_TOOLS];
const extendedNames = new Set(EXTENDED_COMMAND_TOOLS.map((tool) => tool.name as string));

function errorResponse(error: unknown) {
  if (error instanceof CommandCenterError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
  }
  console.error("Command center error", error);
  return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Command center request failed." }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const { profile } = await authenticatePrincipal(request);
    return NextResponse.json({
      ok: true,
      name: "Ilawo Principal Command Center",
      principal: profile.full_name,
      tools: allTools,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { client, profile } = await authenticatePrincipal(request);
    const body = await request.json();
    const tool = String(body.tool || body.name || "").trim();
    const args = body.arguments && typeof body.arguments === "object" ? body.arguments : body.args && typeof body.args === "object" ? body.args : {};
    if (!tool) throw new CommandCenterError("A command-center tool name is required.");
    const result = extendedNames.has(tool)
      ? await executeExtendedCommandTool(client, tool, args)
      : await executeCommandTool(client, profile, tool, args);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return errorResponse(error);
  }
}
