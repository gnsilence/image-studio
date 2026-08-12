import { describe, expect, it } from "vitest";

import { buildNodeGenerationContext } from "../canvas-node-generation";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../../types";

function textNode(id: string, title: string, content: string): CanvasNodeData {
  return {
    id,
    type: CanvasNodeType.Text,
    title,
    position: { x: 0, y: 0 },
    width: 240,
    height: 160,
    metadata: { content },
  };
}

describe("canvas node generation context", () => {
  it("builds the final prompt from a selected text route and config supplement", () => {
    const nodes: CanvasNodeData[] = [
      textNode("core", "核心提示词", "核心正文"),
      textNode("style", "风格节点", "风格正文"),
      {
        id: "config",
        type: CanvasNodeType.Config,
        title: "配置",
        position: { x: 0, y: 0 },
        width: 360,
        height: 280,
        metadata: {
          composerContent: "补充要求",
          promptRouteSelection: { mode: "route", connectionIds: ["core-style", "style-config"] },
        },
      },
    ];
    const connections: CanvasConnection[] = [
      { id: "core-style", fromNodeId: "core", toNodeId: "style" },
      { id: "style-config", fromNodeId: "style", toNodeId: "config" },
    ];

    expect(buildNodeGenerationContext("config", nodes, connections, "补充要求")).toMatchObject({
      prompt: "核心正文\n\n风格正文\n\n补充要求",
      textCount: 2,
      imageCount: 0,
      routeValid: true,
      route: { id: "route:core-style|style-config" },
    });
  });

  it("marks a selected route invalid when its connection path no longer exists", () => {
    const nodes: CanvasNodeData[] = [
      textNode("core", "核心提示词", "核心正文"),
      textNode("style", "风格节点", "风格正文"),
      {
        id: "config",
        type: CanvasNodeType.Config,
        title: "配置",
        position: { x: 0, y: 0 },
        width: 360,
        height: 280,
        metadata: {
          composerContent: "补充要求",
          promptRouteSelection: { mode: "route", connectionIds: ["missing", "style-config"] },
        },
      },
    ];
    const connections: CanvasConnection[] = [
      { id: "style-config", fromNodeId: "style", toNodeId: "config" },
    ];

    expect(buildNodeGenerationContext("config", nodes, connections, "补充要求")).toMatchObject({
      routeValid: false,
      referenceImages: [],
      textCount: 0,
      imageCount: 0,
    });
  });
});
