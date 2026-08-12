import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasEditor } from "../CanvasEditor";
import { useCanvasStore, type CanvasProject } from "../stores/use-canvas-store";
import { CanvasNodeType } from "../types";

vi.mock("@/lib/asset-store", () => ({
  addImageAsset: vi.fn(),
  addTextAsset: vi.fn(),
}));

vi.mock("@/lib/s3-assets", () => ({
  getSelectionBlob: vi.fn(),
}));

vi.mock("@/components/agent/AgentAssetPickerDialog", () => ({
  AgentAssetPickerDialog: () => null,
  AgentTextAssetPickerDialog: () => null,
}));

vi.mock("../lib/image-storage", () => ({
  getImageBlob: vi.fn(),
  imageToDataUrl: vi.fn(),
  resolveImageUrl: vi.fn(() => null),
  uploadImage: vi.fn(),
}));

vi.mock("@/components/PromptOptimizeDialog", () => ({
  PromptOptimizeDialog: () => null,
}));

vi.mock("../components/canvas-ai-text-dialog", () => ({
  AiTextGenerateDialog: () => null,
}));

const baseProject: CanvasProject = {
  id: "project-1",
  title: "Canvas regression",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  nodes: [
    {
      id: "node-a",
      type: CanvasNodeType.Text,
      title: "A",
      position: { x: 0, y: 0 },
      width: 240,
      height: 160,
      metadata: { content: "A" },
    },
    {
      id: "node-b",
      type: CanvasNodeType.Text,
      title: "B",
      position: { x: 420, y: 0 },
      width: 240,
      height: 160,
      metadata: { content: "B" },
    },
  ],
  connections: [{ id: "connection-1", fromNodeId: "node-a", toNodeId: "node-b" }],
  backgroundMode: "lines",
  showImageInfo: false,
  viewport: { x: 0, y: 0, k: 1 },
};

const workflowProject: CanvasProject = {
  ...baseProject,
  id: "workflow-project",
  title: "Canvas workflow",
  nodes: [
    ...baseProject.nodes,
    {
      id: "config-1",
      type: CanvasNodeType.Config,
      title: "Config",
      position: { x: 820, y: 0 },
      width: 360,
      height: 280,
      metadata: { composerContent: "Make it cinematic" },
    },
  ],
  connections: [
    ...baseProject.connections,
    { id: "connection-2", fromNodeId: "node-b", toNodeId: "config-1" },
  ],
};

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

describe("CanvasEditor regressions", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    useCanvasStore.setState({ hydrated: true, projects: [structuredClone(baseProject)] });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderEditor(projectId = baseProject.id) {
    return render(
      <CanvasEditor
        projectId={projectId}
        onBack={() => undefined}
        onRequireApiKey={() => undefined}
        showToast={() => undefined}
      />,
    );
  }

  it("deletes the selected connection with the Delete key", async () => {
    const { container } = renderEditor();
    const connection = container.querySelector<SVGPathElement>('[data-connection-id="connection-1"]');
    expect(connection).not.toBeNull();

    fireEvent.click(connection!);
    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => {
      expect(useCanvasStore.getState().openProject(baseProject.id)?.connections).toHaveLength(0);
    });
  });

  it("deletes the selected connection from the toolbar", async () => {
    const { container } = renderEditor();
    const connection = container.querySelector<SVGPathElement>('[data-connection-id="connection-1"]');
    expect(connection).not.toBeNull();

    fireEvent.click(connection!);
    fireEvent.click(screen.getByRole("button", { name: "删除选中" }));

    await waitFor(() => {
      expect(useCanvasStore.getState().openProject(baseProject.id)?.connections).toHaveLength(0);
    });
  });

  it("prevents the system clipboard from also pasting when duplicating copied nodes", async () => {
    const { container } = renderEditor();
    const nodeA = container.querySelector<HTMLElement>('[data-node-id="node-a"]');
    expect(nodeA).not.toBeNull();

    fireEvent.pointerDown(nodeA!, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });

    const pasteShortcut = new KeyboardEvent("keydown", {
      key: "v",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(fireEvent(window, pasteShortcut)).toBe(false);
    await waitFor(() => {
      const saved = useCanvasStore.getState().openProject(baseProject.id)!;
      expect(saved.nodes).toHaveLength(3);
      expect(saved.nodes.map((node) => node.metadata?.content)).toEqual(["A", "B", "A"]);
    });
  });

  it("duplicates internal connections when copied nodes are pasted", async () => {
    const { container } = renderEditor();
    const nodeA = container.querySelector<HTMLElement>('[data-node-id="node-a"]');
    const nodeB = container.querySelector<HTMLElement>('[data-node-id="node-b"]');
    expect(nodeA).not.toBeNull();
    expect(nodeB).not.toBeNull();

    fireEvent.pointerDown(nodeA!, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window);
    fireEvent.pointerDown(nodeB!, { button: 0, ctrlKey: true, clientX: 440, clientY: 20 });
    fireEvent.pointerUp(window);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });

    await waitFor(() => {
      const saved = useCanvasStore.getState().openProject(baseProject.id)!;
      expect(saved.nodes).toHaveLength(4);
      expect(saved.connections).toHaveLength(2);
      const pastedIds = saved.nodes.slice(2).map((node) => node.id);
      expect(saved.connections[1]).toMatchObject({ fromNodeId: pastedIds[0], toNodeId: pastedIds[1] });
    });
  });

  it("previews the final prompt for a config node", async () => {
    useCanvasStore.setState({ hydrated: true, projects: [structuredClone(workflowProject)] });
    renderEditor(workflowProject.id);

    fireEvent.click(screen.getByRole("button", { name: "预览最终提示词" }));

    const dialog = await screen.findByRole("dialog", { name: "生成预览" });
    expect(dialog.querySelector("pre")).toHaveTextContent("Make it cinematic");
  });

  it("searches for a node and focuses it on the canvas", async () => {
    useCanvasStore.setState({ hydrated: true, projects: [structuredClone(workflowProject)] });
    const { container } = renderEditor(workflowProject.id);

    fireEvent.click(screen.getByRole("button", { name: "搜索节点" }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "搜索节点" }), { target: { value: "Config" } });
    fireEvent.click(screen.getByRole("button", { name: "定位到 Config" }));

    await waitFor(() => {
      expect(container.querySelector('[data-node-id="config-1"]')).toHaveAttribute("data-selected", "true");
    });
  });

  it("creates a connected node when a connection drag ends on blank canvas", async () => {
    const { container } = renderEditor();
    const sourceHandle = screen.getAllByRole("button", { name: "连接输出" })[0];
    document.elementFromPoint = vi.fn(() => null);

    fireEvent.pointerDown(sourceHandle, { button: 0, clientX: 240, clientY: 80 });
    fireEvent.pointerMove(window, { clientX: 620, clientY: 80 });
    fireEvent.pointerUp(window, { clientX: 620, clientY: 80 });
    fireEvent.click(await screen.findByRole("button", { name: "文本" }));

    await waitFor(() => {
      const saved = useCanvasStore.getState().openProject(baseProject.id)!;
      expect(saved.nodes).toHaveLength(3);
      expect(saved.connections).toHaveLength(2);
      const created = saved.nodes.find((node) => node.id !== "node-a" && node.id !== "node-b");
      expect(created?.type).toBe(CanvasNodeType.Text);
      expect(saved.connections[1]).toMatchObject({ fromNodeId: "node-a", toNodeId: created?.id });
      expect(container.querySelector(`[data-node-id="${created?.id}"]`)).not.toBeNull();
    });
  });
});
