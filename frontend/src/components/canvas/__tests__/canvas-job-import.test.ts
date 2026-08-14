import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildTaskImportProject } from "../canvas-job-import";
import { CanvasNodeType } from "../types";

vi.mock("@/lib/image-downloader", () => ({
  resolveStoredImageRefs: vi.fn(),
  revokeBlobUrls: vi.fn(),
}));

vi.mock("../lib/image-storage", () => ({
  uploadImage: vi.fn(),
  deleteStoredImages: vi.fn(),
}));

import { resolveStoredImageRefs, revokeBlobUrls } from "@/lib/image-downloader";
import { deleteStoredImages, uploadImage } from "../lib/image-storage";

const mockedResolveStoredImageRefs = vi.mocked(resolveStoredImageRefs);
const mockedRevokeBlobUrls = vi.mocked(revokeBlobUrls);
const mockedUploadImage = vi.mocked(uploadImage);
const mockedDeleteStoredImages = vi.mocked(deleteStoredImages);

const job = {
  id: "job-1",
  status: "completed" as const,
  mode: "image-to-image" as const,
  prompt: "原始提示词",
  output_size: "1K" as const,
  temperature: 0.7,
  aspect_ratio: "4:3" as const,
  model: "gemini-3-pro-image-preview",
  created_at: "2026-08-14T10:00:00.000Z",
  images: ["IDB:job-1-0", "IDB:job-1-1"],
  refImages: [{ id: "ref-1", name: "参考图", dataUrl: "data:image/png;base64,ref", mimeType: "image/png" }],
};

beforeEach(() => {
  mockedResolveStoredImageRefs.mockReset();
  mockedResolveStoredImageRefs.mockResolvedValue({ images: ["blob:result-1", "blob:result-2"], blobUrls: ["blob:result-1", "blob:result-2"] });
  mockedRevokeBlobUrls.mockReset();
  mockedUploadImage.mockReset();
  mockedUploadImage.mockImplementation(async (source) => ({
    url: `blob:canvas-${String(source).slice(-1)}`,
    storageKey: `image:${String(source).slice(-1)}`,
    width: 1024,
    height: 768,
    bytes: 2048,
    mimeType: "image/png",
  }));
  mockedDeleteStoredImages.mockReset();
});

describe("buildTaskImportProject", () => {
  it("copies selected results and references into a connected canvas project", async () => {
    const project = await buildTaskImportProject({ job, imageIndexes: [1], includeReferenceImages: true });

    expect(mockedUploadImage).toHaveBeenCalledWith("blob:result-2");
    expect(mockedUploadImage).toHaveBeenCalledWith("data:image/png;base64,ref");
    expect(project.nodes).toHaveLength(4);
    expect(project.connections).toHaveLength(3);

    const config = project.nodes?.find(node => node.type === CanvasNodeType.Config);
    const prompt = project.nodes?.find(node => node.title === "原始提示词");
    expect(config?.metadata?.composerContent).toContain(`@[node:${prompt?.id}]`);
    expect(config?.metadata?.genConfig).toMatchObject({ model: job.model, outputSize: "1K", aspectRatio: "4:3" });
    expect(mockedRevokeBlobUrls).toHaveBeenCalledWith(["blob:result-1", "blob:result-2"]);
  });

  it("does not copy references when they are not selected", async () => {
    const project = await buildTaskImportProject({ job, imageIndexes: [0], includeReferenceImages: false });

    expect(mockedUploadImage).toHaveBeenCalledTimes(1);
    expect(project.nodes?.filter(node => node.type === CanvasNodeType.Image)).toHaveLength(1);
  });

  it("cleans up copied canvas files after an import failure", async () => {
    mockedUploadImage
      .mockResolvedValueOnce({ url: "blob:canvas-1", storageKey: "image:1", width: 1024, height: 768, bytes: 2048, mimeType: "image/png" })
      .mockRejectedValueOnce(new Error("read failed"));

    await expect(buildTaskImportProject({ job, imageIndexes: [0], includeReferenceImages: true })).rejects.toThrow("read failed");
    expect(mockedDeleteStoredImages).toHaveBeenCalledWith(["image:1"]);
  });
});
