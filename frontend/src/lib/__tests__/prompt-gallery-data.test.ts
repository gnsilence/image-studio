import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllPromptSources, fetchPromptSource, type PromptDataSource } from '@/lib/prompt-gallery-data';

const source: PromptDataSource = {
  name: 'itgoyo-gpt-image-2-prompts',
  url: 'https://example.test/README_CN.md',
  sourceUrl: 'https://github.com/itgoyo/awesome-gpt-image2-prompt',
  baseUrl: 'https://example.test',
  type: 'markdown-itgoyo',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Itgoyo prompt source', () => {
  it('parses numbered entries, preview images, and Chinese prompts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`### 1. Poster Design
<img src="images/poster.jpg" alt="Poster Design" />

**🇨🇳 中文提示词：**
\`\`\`
生成一张科技海报
\`\`\`

**🌐 英文提示词：**
\`\`\`
Generate a technology poster
\`\`\``),
    }));

    const prompts = await fetchPromptSource(source);

    expect(prompts).toEqual([expect.objectContaining({
      title: 'Poster Design',
      content: '生成一张科技海报',
      images: ['https://example.test/images/poster.jpg'],
      category: 'gpt-image-2',
      source: source.name,
    })]);
  });

  it('keeps other sources usable when a source returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    await expect(fetchPromptSource(source)).resolves.toEqual([]);
  });
});

describe('Additional prompt sources', () => {
  it('parses the Freestylefly gallery format from cached files', async () => {
    const prompts = await fetchPromptSource({
      name: 'freestylefly-gpt-image-2',
      url: 'https://example.test/docs/gallery-part-1.md',
      sourceUrl: 'https://github.com/freestylefly/awesome-gpt-image-2',
      baseUrl: 'https://example.test',
      type: 'markdown-freestyle',
      caseFiles: ['docs/gallery-part-2.md'],
    }, {
      contents: [`### 例 1：城市信息图
![城市图](../data/images/case1.jpg)

**提示词：**
\`\`\`text
生成一张城市信息图，包含道路、建筑和公共服务系统。
\`\`\``],
    });

    expect(prompts).toEqual([expect.objectContaining({
      title: '城市信息图',
      images: ['https://example.test/data/images/case1.jpg'],
      category: 'gpt-image-2',
    })]);
  });

  it('parses non-empty Tigerowo cases and removes heading links', async () => {
    const prompts = await fetchPromptSource({
      name: 'tigerowo-gpt-image-2',
      url: 'https://example.test/README.md',
      sourceUrl: 'https://github.com/tigerowo/awesome-gpt-image-2-prompts',
      baseUrl: 'https://example.test',
      type: 'markdown-tigerowo',
    }, {
      contents: [`### Case 1: [产品海报](https://example.test/source) (by [@author](https://example.test/author))
<img src="images/poster.jpg" alt="产品海报" />

**提示词:**
\`\`\`
生成一张带有中文产品名称的高端科技海报，光影清晰，构图简洁。
\`\`\``],
    });

    expect(prompts).toEqual([expect.objectContaining({
      title: '产品海报',
      images: ['https://example.test/images/poster.jpg'],
      category: '海报',
    })]);
  });

  it('does not fetch third-party sources when no local cache exists', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetch);

    await expect(fetchAllPromptSources()).resolves.toMatchObject({ prompts: [] });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/nova/prompt-gallery/cache', { cache: 'no-store' });
  });
});
