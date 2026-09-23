import type { Tool, ToolContext } from "./Tool";
import { SelectTool } from "./SelectTool";
import { FreeTransformTool } from "./FreeTransformTool";
import { BoneTool } from "./BoneTool";
import { IkTool } from "./IkTool";
import { PivotTool } from "./PivotTool";
import type { ToolId } from "@/app/Store";

export class ToolManager {
  private tools = new Map<string, Tool>();
  private activeId: ToolId = "select";

  constructor() {
    this.register(new SelectTool());
    this.register(new FreeTransformTool());
    this.register(new PivotTool());
    this.register(new BoneTool());
    this.register(new IkTool());
  }

  register(tool: Tool): void { this.tools.set(tool.id, tool); }

  get active(): Tool | null { return this.tools.get(this.activeId) ?? null; }

  /** Tools without an implementation fall back to plain selection. */
  setActive(id: ToolId, ctx: ToolContext): void {
    if (id === this.activeId) return;
    this.active?.onDeactivate?.(ctx);
    this.activeId = this.tools.has(id) ? id : "select";
    ctx.setCursor("");
    ctx.invalidate();
  }

  get showsGizmo(): boolean { return this.active?.showsGizmo === true; }
}
