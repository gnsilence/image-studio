import { nanoid } from "nanoid";

import { resolveStoredImageRefs, revokeBlobUrls } from "@/lib/image-downloader";
import type { StoredJob } from "@/lib/job-store";
import { fitNodeSize } from "./utils/canvas-node-size";
import { getNodeSpec } from "./constants";
import { deleteStoredImages, uploadImage, type UploadedImage } from "./lib/image-storage";
import type { CanvasProject } from "./stores/use-canvas-store";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationConfig, type CanvasNodeData, type CanvasNodeMetadata } from "./types";

export type CanvasTaskImportRequest = {
  job: StoredJob;
  imageIndexes: number[];
  includeReferenceImages: boolean;
};

type ImportedImage = {
  title: string;
  role: "result" | "reference";
  source: string;
};

export async function buildTaskImportProject(request: CanvasTaskImportRequest): Promise<Partial<CanvasProject>> {
  const sourceImages = request.job.images || (request.job.imageData ? [request.job.imageData] : []);
  const selectedIndexes = [...new Set(request.imageIndexes)].filter((index) => index >= 0 && index < sourceImages.length);
  if (!selectedIndexes.length) throw new Error("请至少选择一张任务结果图");

  const resolved = await resolveStoredImageRefs(request.job.id, sourceImages);
  const importedImages: ImportedImage[] = selectedIndexes.map((index) => ({
    title: selectedIndexes.length === 1 ? "任务生成结果" : `任务生成结果 ${index + 1}`,
    role: "result",
    source: resolved.images[index] || "",
  }));

  if (request.includeReferenceImages) {
    (request.job.refImages || []).forEach((image, index) => {
      if (!image.dataUrl) return;
      importedImages.push({
        title: image.name || `原任务参考图 ${index + 1}`,
        role: "reference",
        source: image.dataUrl,
      });
    });
  }

  const storedKeys: string[] = [];
  try {
    const imageNodes: CanvasNodeData[] = [];
    for (const [index, image] of importedImages.entries()) {
      if (!image.source) throw new Error("任务图片记录不完整");
      const stored = await uploadImage(image.source);
      storedKeys.push(stored.storageKey);
      imageNodes.push(createImageNode(image, stored, index));
    }
    const promptNode = createPromptNode(request.job, imageNodes.length);
    const configNode = createConfigNode(request.job, promptNode, imageNodes);
    const connections: CanvasConnection[] = [
      ...imageNodes.map((node) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id })),
      { id: nanoid(), fromNodeId: promptNode.id, toNodeId: configNode.id },
    ];

    return {
      title: `任务导入 ${formatTaskTime(request.job.created_at)}`,
      nodes: [...imageNodes, promptNode, configNode],
      connections,
    };
  } catch (error) {
    await deleteStoredImages(storedKeys);
    throw error;
  } finally {
    revokeBlobUrls(resolved.blobUrls);
  }
}

function createImageNode(image: ImportedImage, stored: UploadedImage, index: number): CanvasNodeData {
  const size = fitNodeSize(stored.width, stored.height, 300, 260);
  const column = index % 2;
  const row = Math.floor(index / 2);
  return {
    id: nanoid(),
    type: CanvasNodeType.Image,
    title: image.title,
    position: { x: column * 340, y: row * 310 },
    width: size.width,
    height: size.height,
    metadata: imageMetadata(stored, image.role),
  };
}

function createPromptNode(job: StoredJob, imageCount: number): CanvasNodeData {
  const spec = getNodeSpec(CanvasNodeType.Text);
  return {
    id: nanoid(),
    type: CanvasNodeType.Text,
    title: "原始提示词",
    position: { x: 0, y: Math.ceil(imageCount / 2) * 310 + 40 },
    width: spec.width,
    height: spec.height,
    metadata: { ...spec.metadata, content: job.originalPrompt || job.prompt, canvasRole: "reference-prompt" },
  };
}

function createConfigNode(job: StoredJob, promptNode: CanvasNodeData, imageNodes: CanvasNodeData[]): CanvasNodeData {
  const spec = getNodeSpec(CanvasNodeType.Config);
  const resultNodes = imageNodes.filter((node) => node.metadata?.canvasRole !== "reference");
  const referenceNodes = imageNodes.filter((node) => node.metadata?.canvasRole === "reference");
  const composerContent = [
    `原始任务提示词：@[node:${promptNode.id}]`,
    resultNodes.length ? `任务生成结果：${resultNodes.map((node) => `@[node:${node.id}]`).join("、")}` : "",
    referenceNodes.length ? `原任务参考图：${referenceNodes.map((node) => `@[node:${node.id}]`).join("、")}` : "",
    "请基于以上提示词和图片继续创作。",
  ].filter(Boolean).join("\n\n");
  return {
    id: nanoid(),
    type: CanvasNodeType.Config,
    title: "继续生成配置",
    position: { x: 760, y: 80 },
    width: spec.width,
    height: spec.height,
    metadata: {
      ...spec.metadata,
      prompt: composerContent,
      composerContent,
      genConfig: generationConfigFromJob(job),
    },
  };
}

function imageMetadata(stored: UploadedImage, role: "result" | "reference"): CanvasNodeMetadata {
  return {
    status: "success",
    content: stored.url,
    storageKey: stored.storageKey,
    mimeType: stored.mimeType,
    naturalWidth: stored.width,
    naturalHeight: stored.height,
    bytes: stored.bytes,
    canvasRole: role === "reference" ? "reference" : undefined,
  };
}

function generationConfigFromJob(job: StoredJob): CanvasGenerationConfig {
  const count = Math.min(4, Math.max(1, job.parallelCount || 1)) as CanvasGenerationConfig["count"];
  return {
    model: job.model,
    outputSize: job.output_size,
    aspectRatio: job.aspect_ratio,
    customSize: job.custom_size,
    temperature: job.temperature,
    count,
    gptImageQuality: job.gptImageQuality || "auto",
    gptImageStyle: job.gptImageStyle || "auto",
    gptImageBackground: job.gptImageBackground || "auto",
  };
}

function formatTaskTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "生图任务";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
