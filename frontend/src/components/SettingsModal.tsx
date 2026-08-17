'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  ImageIcon,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Trash2,
  Upload,
  Wand2,
  XCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { BackupProgress } from '@/components/BackupProgress';
import {
  BUILTIN_IMAGE_PRESETS,
  BUILTIN_IMAGE_PRESET_OPTIONS,
  DEFAULT_DEFAULTS,
  DEFAULT_TEXT_MODEL_TEMPLATES,
  FIXED_MODEL_BASE_URL,
  generateModelId,
  getDefaultTextModelTemplate,
  getCompleteImageModels,
  getCompleteTextModels,
  getImageModelOutputSizes,
  loadRegistry,
  saveRegistry,
  type DefaultModels,
  type ImageModelConfig,
  type ProviderProtocol,
  type TextModelConfig,
} from '@/lib/nova-models';
import {
  getTextProviderDescription,
  getTextProviderLabel,
  type TextProviderProtocol,
} from '@/lib/nova-text-protocol';
import { syncDynamicModelExports } from '@/lib/gemini-config';
import { exportAllData, importAllData, downloadBlob, generateBackupFilename, type BackupProgress as BackupProgressType } from '@/lib/backup-utils';
import { checkModelsAvailability, type ModelStatus } from '@/lib/ccode-task-client';
import { hasAnyApiKey } from '@/lib/settings-storage';
import { BA_RANDOM_URL, BING_WALLPAPER_SOURCE_URL } from '@/lib/constants';
import { PROMPT_DATA_SOURCES, getPromptSourceLabel } from '@/lib/prompt-gallery-data';
import {
  getDesktopBridge,
  type DesktopUpdateStatus,
  type S3ConfigInput,
  type S3CredentialsInput,
  type S3PublicConfig,
} from '@/lib/desktop-bridge';
import { cn } from '@/lib/utils';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApiKeyChange?: (hasKey: boolean) => void;
}

function cloneImageModel(model: ImageModelConfig): ImageModelConfig {
  return { ...model };
}

function cloneTextModel(model: TextModelConfig): TextModelConfig {
  return { ...model };
}

function createImageModelDraft(): ImageModelConfig {
  const preset = BUILTIN_IMAGE_PRESETS['gpt-image-2'];
  return {
    id: generateModelId('img'),
    protocol: preset.protocol,
    name: '',
    modelId: '',
    apiKey: '',
    baseUrl: preset.baseUrl,
    builtinPreset: preset.id,
    maxRefImages: preset.maxRefImages,
    maxOutputSize: preset.maxOutputSize,
    supportsAdvancedParams: preset.supportsAdvancedParams,
  };
}

function createTextModelDraft(): TextModelConfig {
  const template = getDefaultTextModelTemplate('openai-responses');
  return {
    id: generateModelId('txt'),
    protocol: template.protocol,
    name: '',
    modelId: '',
    apiKey: '',
    baseUrl: template.baseUrl,
    note: template.note,
  };
}

function isCompleteImageModel(model: ImageModelConfig): boolean {
  return Boolean(model.name.trim() && model.modelId.trim() && model.apiKey.trim() && model.baseUrl.trim());
}

function isCompleteTextModel(model: TextModelConfig): boolean {
  return Boolean(model.name.trim() && model.modelId.trim() && model.apiKey.trim() && model.baseUrl.trim());
}

function getImageModelLabel(models: ImageModelConfig[], id: string): string | undefined {
  return models.find((model) => model.id === id)?.name;
}

function getTextModelLabel(models: TextModelConfig[], id: string): string | undefined {
  return models.find((model) => model.id === id)?.name;
}

function normalizeDefaults(
  defaults: DefaultModels,
  imageModels: ImageModelConfig[],
  textModels: TextModelConfig[],
): DefaultModels {
  const completeImageModels = imageModels.filter(isCompleteImageModel);
  const completeTextModels = textModels.filter(isCompleteTextModel);
  const firstImageModelId = completeImageModels[0]?.id || '';
  const firstTextModelId = completeTextModels[0]?.id || '';

  return {
    textToImage: completeImageModels.some((model) => model.id === defaults.textToImage) ? defaults.textToImage : firstImageModelId,
    imageToImage: completeImageModels.some((model) => model.id === defaults.imageToImage) ? defaults.imageToImage : firstImageModelId,
    reversePrompt: completeTextModels.some((model) => model.id === defaults.reversePrompt) ? defaults.reversePrompt : firstTextModelId,
    agent: completeTextModels.some((model) => model.id === defaults.agent) ? defaults.agent : firstTextModelId,
    promptOptimize: completeTextModels.some((model) => model.id === defaults.promptOptimize) ? defaults.promptOptimize : firstTextModelId,
    imageDescribe: completeTextModels.some((model) => model.id === defaults.imageDescribe) ? defaults.imageDescribe : firstTextModelId,
  };
}

export function SettingsModal({ isOpen, onClose, onApiKeyChange }: SettingsModalProps) {
  const [imageModels, setImageModels] = useState<ImageModelConfig[]>([]);
  const [textModels, setTextModels] = useState<TextModelConfig[]>([]);
  const [defaults, setDefaults] = useState<DefaultModels>(DEFAULT_DEFAULTS);
  const [selectedImageModelId, setSelectedImageModelId] = useState('');
  const [selectedTextModelId, setSelectedTextModelId] = useState('');
  const [selectedModelKind, setSelectedModelKind] = useState<'image' | 'text'>('image');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [checkingModels, setCheckingModels] = useState(false);
  const [modelStatuses, setModelStatuses] = useState<ModelStatus[] | null>(null);
  const [modelCheckError, setModelCheckError] = useState<string | null>(null);
  const [showImageApiKey, setShowImageApiKey] = useState(false);
  const [showTextApiKey, setShowTextApiKey] = useState(false);
  const [s3Config, setS3Config] = useState<S3ConfigInput>({ endpoint: '', region: 'us-east-1', bucket: '', rootPrefix: '', forcePathStyle: false });
  const [s3CredentialStatus, setS3CredentialStatus] = useState<Pick<S3PublicConfig, 'hasAccessKeyId' | 'hasSecretAccessKey' | 'hasSessionToken'>>({ hasAccessKeyId: false, hasSecretAccessKey: false, hasSessionToken: false });
  const [s3Credentials, setS3Credentials] = useState<S3CredentialsInput>({ accessKeyId: '', secretAccessKey: '', sessionToken: '' });
  const [showS3Secrets, setShowS3Secrets] = useState(false);
  const [s3Saving, setS3Saving] = useState(false);
  const [s3Testing, setS3Testing] = useState(false);
  const [s3Error, setS3Error] = useState<string | null>(null);
  const [s3Success, setS3Success] = useState<string | null>(null);

  const [backupProgress, setBackupProgress] = useState<BackupProgressType>({ percent: 0, message: '' });
  const [isBackupActive, setIsBackupActive] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupSuccess, setBackupSuccess] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const registry = loadRegistry();
    setImageModels(registry.imageModels.map(cloneImageModel));
    setTextModels(registry.textModels.map(cloneTextModel));
    setDefaults(normalizeDefaults(registry.defaults, registry.imageModels, registry.textModels));
    setSelectedImageModelId(registry.imageModels[0]?.id || '');
    setSelectedTextModelId(registry.textModels[0]?.id || '');
    setSelectedModelKind(registry.imageModels.length > 0 ? 'image' : 'text');
    setError(null);
    setSuccess(null);
    setModelStatuses(null);
    setModelCheckError(null);
    setBackupError(null);
    setBackupSuccess(null);
    setS3Error(null);
    setS3Success(null);
    setS3Credentials({ accessKeyId: '', secretAccessKey: '', sessionToken: '' });
    const desktop = getDesktopBridge();
    if (desktop) {
      void desktop.s3.getConfig().then(config => {
        setS3Config({
          endpoint: config.endpoint,
          region: config.region,
          bucket: config.bucket,
          rootPrefix: config.rootPrefix,
          forcePathStyle: config.forcePathStyle,
        });
        setS3CredentialStatus({
          hasAccessKeyId: config.hasAccessKeyId,
          hasSecretAccessKey: config.hasSecretAccessKey,
          hasSessionToken: config.hasSessionToken,
        });
      }).catch(err => setS3Error(err instanceof Error ? err.message : '读取 S3 配置失败'));
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const desktop = getDesktopBridge();
    if (!desktop) return;
    void desktop.updater.getStatus().then(setUpdateStatus).catch(() => undefined);
    return desktop.updater.onStatus(setUpdateStatus);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setDefaults((prev) => {
      const next = normalizeDefaults(prev, imageModels, textModels);
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
  }, [imageModels, isOpen, textModels]);

  const selectedImageModel = useMemo(
    () => imageModels.find((model) => model.id === selectedImageModelId) || null,
    [imageModels, selectedImageModelId],
  );
  const selectedTextModel = useMemo(
    () => textModels.find((model) => model.id === selectedTextModelId) || null,
    [selectedTextModelId, textModels],
  );

  const handleAddImageModel = () => {
    const draft = createImageModelDraft();
    setImageModels((prev) => [...prev, draft]);
    setSelectedImageModelId(draft.id);
    setSelectedModelKind('image');
  };

  const handleUpdateImageModel = (id: string, patch: Partial<ImageModelConfig>) => {
    setImageModels((prev) => prev.map((model) => {
      if (model.id !== id) return model;
      const next = { ...model, ...patch };
      if (patch.builtinPreset) {
        const preset = BUILTIN_IMAGE_PRESETS[patch.builtinPreset];
        next.protocol = preset.protocol;
        next.name = preset.name;
        next.modelId = preset.modelId;
        next.baseUrl = preset.baseUrl;
        next.maxRefImages = preset.maxRefImages;
        next.maxOutputSize = preset.maxOutputSize;
        next.supportsAdvancedParams = preset.supportsAdvancedParams;
      }
      if (patch.protocol === 'google' || patch.protocol === 'grok') {
        next.supportsAdvancedParams = false;
      }
      return next;
    }));
  };

  const handleDeleteImageModel = (id: string) => {
    const nextModels = imageModels.filter((model) => model.id !== id);
    setImageModels(nextModels);
    setDefaults((prev) => ({
      ...prev,
      textToImage: prev.textToImage === id ? '' : prev.textToImage,
      imageToImage: prev.imageToImage === id ? '' : prev.imageToImage,
    }));
    if (selectedImageModelId === id) {
      setSelectedImageModelId(nextModels[0]?.id || '');
    }
  };

  const handleAddTextModel = () => {
    const draft = createTextModelDraft();
    setTextModels((prev) => [...prev, draft]);
    setSelectedTextModelId(draft.id);
    setSelectedModelKind('text');
  };

  const handleApplyTextTemplate = (id: string, protocol: TextProviderProtocol) => {
    const template = getDefaultTextModelTemplate(protocol);
    handleUpdateTextModel(id, {
      protocol: template.protocol,
      name: template.name,
      modelId: template.modelId,
      baseUrl: template.baseUrl,
      note: template.note || getTextProviderDescription(template.protocol),
    });
  };

  const handleUpdateTextModel = (id: string, patch: Partial<TextModelConfig>) => {
    setTextModels((prev) => prev.map((model) => (model.id === id ? { ...model, ...patch } : model)));
  };

  const handleDeleteTextModel = (id: string) => {
    const nextModels = textModels.filter((model) => model.id !== id);
    setTextModels(nextModels);
    setDefaults((prev) => ({
      ...prev,
      reversePrompt: prev.reversePrompt === id ? '' : prev.reversePrompt,
      agent: prev.agent === id ? '' : prev.agent,
      promptOptimize: prev.promptOptimize === id ? '' : prev.promptOptimize,
      imageDescribe: prev.imageDescribe === id ? '' : prev.imageDescribe,
    }));
    if (selectedTextModelId === id) {
      setSelectedTextModelId(nextModels[0]?.id || '');
    }
  };

  const persistRegistry = () => {
    if (imageModels.length === 0) {
      setError('至少填写一个图片模型');
      return;
    }
    if (textModels.length === 0) {
      setError('至少填写一个文本模型');
      return;
    }
    if (!imageModels.some(isCompleteImageModel)) {
      setError('至少完成一个图片模型的全部信息');
      return;
    }
    if (!textModels.some(isCompleteTextModel)) {
      setError('至少完成一个文本模型的全部信息');
      return;
    }

    const registry = {
      imageModels,
      textModels,
      defaults: normalizeDefaults(defaults, imageModels, textModels),
    };

    saveRegistry(registry);
    syncDynamicModelExports();
    window.dispatchEvent(new Event('nova-model-registry-updated'));
    onApiKeyChange?.(hasAnyApiKey());
    setSuccess('设置已保存');
    setError(null);
    setModelStatuses(null);
    setModelCheckError(null);
  };

  const handleCheckModels = async () => {
    const configuredModels = [
      ...imageModels.filter(isCompleteImageModel),
      ...textModels.filter(isCompleteTextModel),
    ];
    if (configuredModels.length === 0) {
      setModelCheckError('请先完成至少一个图片模型或文本模型配置');
      return;
    }

    setCheckingModels(true);
    setModelCheckError(null);
    setModelStatuses(null);
    try {
      const statuses = await checkModelsAvailability(configuredModels.map((model) => model.id));
      setModelStatuses(statuses);
    } catch (err) {
      setModelCheckError(err instanceof Error ? err.message : '检查模型失败');
    } finally {
      setCheckingModels(false);
    }
  };

  const handleExport = async () => {
    setIsBackupActive(true);
    setBackupError(null);
    setBackupSuccess(null);
    try {
      const desktop = getDesktopBridge();
      if (desktop) {
        setBackupProgress({ percent: 20, message: '正在创建桌面备份...' });
        const exported = await desktop.backup.export();
        if (!exported.canceled) setBackupSuccess('数据已成功导出。桌面备份不包含 API Key。');
        return;
      }
      const blob = await exportAllData((progress) => setBackupProgress(progress));
      const filename = generateBackupFilename();
      downloadBlob(blob, filename);
      setBackupSuccess(`数据已成功导出为 ${filename}`);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setIsBackupActive(false);
    }
  };

  const handleImport = async (file: File) => {
    if (!file.name.endsWith('.zip')) {
      setBackupError('请选择有效的备份文件（.zip 格式）');
      return;
    }

    setIsBackupActive(true);
    setBackupError(null);
    setBackupSuccess(null);
    try {
      await importAllData(file, (progress) => setBackupProgress(progress));
      setBackupSuccess('数据已成功导入，页面将在 2 秒后刷新。');
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '导入失败');
      setIsBackupActive(false);
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handleImport(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const applyS3PublicConfig = (config: S3PublicConfig) => {
    setS3Config({
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      rootPrefix: config.rootPrefix,
      forcePathStyle: config.forcePathStyle,
    });
    setS3CredentialStatus({
      hasAccessKeyId: config.hasAccessKeyId,
      hasSecretAccessKey: config.hasSecretAccessKey,
      hasSessionToken: config.hasSessionToken,
    });
  };

  const handleSaveS3 = async () => {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    setS3Saving(true);
    setS3Error(null);
    setS3Success(null);
    try {
      const saved = await desktop.s3.saveConfig({ config: s3Config, credentials: s3Credentials });
      applyS3PublicConfig(saved);
      setS3Credentials({ accessKeyId: '', secretAccessKey: '', sessionToken: '' });
      setS3Success('S3 配置已安全保存');
    } catch (err) {
      setS3Error(err instanceof Error ? err.message : '保存 S3 配置失败');
    } finally {
      setS3Saving(false);
    }
  };

  const handleTestS3 = async () => {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    setS3Testing(true);
    setS3Error(null);
    setS3Success(null);
    try {
      const result = await desktop.s3.testConnection({ config: s3Config, credentials: s3Credentials });
      setS3Success(result.message);
    } catch (err) {
      setS3Error(err instanceof Error ? err.message : 'S3 连接测试失败');
    } finally {
      setS3Testing(false);
    }
  };

  const handleClearS3Credentials = async () => {
    const desktop = getDesktopBridge();
    if (!desktop || !window.confirm('确定清除已加密保存的 S3 访问凭据吗？')) return;
    setS3Error(null);
    setS3Success(null);
    try {
      applyS3PublicConfig(await desktop.s3.clearCredentials());
      setS3Credentials({ accessKeyId: '', secretAccessKey: '', sessionToken: '' });
      setS3Success('S3 访问凭据已清除');
    } catch (err) {
      setS3Error(err instanceof Error ? err.message : '清除 S3 凭据失败');
    }
  };

  const handleImportClick = async () => {
    const desktop = getDesktopBridge();
    if (!desktop) {
      fileInputRef.current?.click();
      return;
    }
    setIsBackupActive(true);
    setBackupError(null);
    setBackupSuccess(null);
    setBackupProgress({ percent: 20, message: '正在校验并导入桌面备份...' });
    try {
      const imported = await desktop.backup.import();
      if (!imported.canceled) {
        setBackupSuccess('数据已成功导入，页面将在 2 秒后刷新。');
        setTimeout(() => window.location.reload(), 2000);
      }
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setIsBackupActive(false);
    }
  };

  const handleCheckUpdate = async () => {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    setUpdateStatus(await desktop.updater.check());
  };

  const handleInstallUpdate = async () => {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    const result = await desktop.updater.restartAndInstall();
    if (!result.installed && result.reason === 'tasks-running') {
      setUpdateStatus(current => ({ ...(current || { state: 'ready' }), message: '仍有生成任务运行，请稍后重试。' }));
    }
  };

  const completeImageOptions = imageModels.filter(isCompleteImageModel).map((model) => ({ value: model.id, label: model.name }));
  const completeTextOptions = textModels.filter(isCompleteTextModel).map((model) => ({ value: model.id, label: model.name }));
  const selectedImageOutputSizes = selectedImageModel
    ? getImageModelOutputSizes({
        ...selectedImageModel,
        maxOutputSize: BUILTIN_IMAGE_PRESETS[selectedImageModel.builtinPreset].maxOutputSize,
      })
    : ['1K'];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open && isBackupActive) return;
      if (!open) onClose();
    }}>
      <DialogContent className={`nova-app-settings flex max-h-[92vh] flex-col overflow-hidden p-0 pt-0 gap-0 sm:max-w-5xl ${getDesktopBridge() ? 'nova-desktop-settings' : ''}`}>
        <DialogHeader className="p-4 pb-3">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-muted-foreground" />
            <DialogTitle>设置</DialogTitle>
          </div>
          <DialogDescription>按模型分别配置协议、模型 ID 和 API Key。图片模型还可配置独立 Base URL；文本模型继续使用固定服务地址。</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="models" className="min-h-0 flex-1 gap-0">
          <TabsList className="w-full rounded-none border-b bg-transparent h-auto p-0">
            <TabsTrigger value="models" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <ImageIcon className="w-4 h-4" />
              模型配置
            </TabsTrigger>
            {getDesktopBridge() && (
              <TabsTrigger value="s3" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
                <Cloud className="w-4 h-4" />
                S3 存储
              </TabsTrigger>
            )}
            <TabsTrigger value="backup" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <Database className="w-4 h-4" />
              备份
            </TabsTrigger>
            <TabsTrigger value="about" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <Info className="w-4 h-4" />
              关于
            </TabsTrigger>
          </TabsList>

          <TabsContent value="models" className="min-h-0 overflow-y-auto p-4 sm:p-6 mt-0 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">模型级独立配置</p>
                <p className="text-xs text-muted-foreground">图片模型可配置独立 Base URL；文本模型固定使用 {FIXED_MODEL_BASE_URL}。</p>
              </div>
              <Button onClick={persistRegistry} className="gap-2">
                <Save className="w-4 h-4" />
                保存设置
              </Button>
            </div>

            {error && <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
            {success && <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">{success}</div>}

            <div className="studio-model-editor grid min-h-[430px] overflow-hidden rounded-xl border lg:grid-cols-[236px_minmax(0,1fr)]">
              <aside className="studio-model-catalog border-b bg-muted/20 p-3 lg:border-r lg:border-b-0">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">模型目录</p>
                    <p className="text-xs text-muted-foreground">选择一项进行编辑</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-xs font-medium text-muted-foreground">图片模型</span>
                      <Button variant="ghost" size="icon-sm" className="size-7" onClick={handleAddImageModel} title="新增图片模型">
                        <Plus className="size-4" />
                      </Button>
                    </div>
                    {imageModels.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => { setSelectedModelKind('image'); setSelectedImageModelId(model.id); }}
                        className={cn('studio-model-catalog-item w-full rounded-lg border px-3 py-2 text-left text-sm', selectedModelKind === 'image' && selectedImageModelId === model.id ? 'border-primary bg-primary/8' : 'border-transparent hover:bg-muted/75')}
                      >
                        <span className="block truncate font-medium">{model.name || '未命名模型'}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{isCompleteImageModel(model) ? '配置完成' : '待补全'}</span>
                      </button>
                    ))}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-xs font-medium text-muted-foreground">文本模型</span>
                      <Button variant="ghost" size="icon-sm" className="size-7" onClick={handleAddTextModel} title="新增文本模型">
                        <Plus className="size-4" />
                      </Button>
                    </div>
                    {textModels.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => { setSelectedModelKind('text'); setSelectedTextModelId(model.id); }}
                        className={cn('studio-model-catalog-item w-full rounded-lg border px-3 py-2 text-left text-sm', selectedModelKind === 'text' && selectedTextModelId === model.id ? 'border-primary bg-primary/8' : 'border-transparent hover:bg-muted/75')}
                      >
                        <span className="block truncate font-medium">{model.name || '未命名模型'}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{isCompleteTextModel(model) ? '配置完成' : '待补全'}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </aside>

              <div className="min-w-0 p-4 sm:p-5">
                {selectedModelKind === 'image' && selectedImageModel && (
                  <div className="space-y-5">
                    <div className="flex items-start justify-between gap-3 border-b border-border/70 pb-4">
                      <div>
                        <p className="text-sm font-medium">图片模型</p>
                        <p className="mt-1 text-xs text-muted-foreground">配置协议、模型标识和生成能力。</p>
                      </div>
                      <span className={cn('rounded-md px-2 py-1 text-xs', isCompleteImageModel(selectedImageModel) ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground')}>
                        {isCompleteImageModel(selectedImageModel) ? '配置完成' : '待补全'}
                      </span>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">内置模板</label>
                      <Select
                        value={selectedImageModel.builtinPreset}
                        onValueChange={(value) => handleUpdateImageModel(selectedImageModel.id, { builtinPreset: value as ImageModelConfig['builtinPreset'] })}
                        options={BUILTIN_IMAGE_PRESET_OPTIONS}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">协议</label>
                      <Select
                        value={selectedImageModel.protocol}
                        onValueChange={(value) => handleUpdateImageModel(selectedImageModel.id, { protocol: value as ProviderProtocol })}
                        options={[
                          { value: 'google', label: 'Google' },
                          { value: 'openai', label: 'OpenAI Images' },
                          { value: 'grok', label: 'Grok Images' },
                        ]}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">显示名称</label>
                      <Input value={selectedImageModel.name} onChange={(event) => handleUpdateImageModel(selectedImageModel.id, { name: event.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">模型 ID</label>
                      <Input value={selectedImageModel.modelId} onChange={(event) => handleUpdateImageModel(selectedImageModel.id, { modelId: event.target.value })} />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-xs text-muted-foreground">Base URL</label>
                      <Input
                        type="url"
                        value={selectedImageModel.baseUrl}
                        onChange={(event) => handleUpdateImageModel(selectedImageModel.id, { baseUrl: event.target.value })}
                        placeholder={FIXED_MODEL_BASE_URL}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">API Key</label>
                      <div className="relative">
                        <Input
                          type={showImageApiKey ? "text" : "password"}
                          value={selectedImageModel.apiKey}
                          onChange={(event) => handleUpdateImageModel(selectedImageModel.id, { apiKey: event.target.value })}
                          className="pr-8"
                        />
                        <button
                          type="button"
                          onClick={() => setShowImageApiKey(!showImageApiKey)}
                          className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          tabIndex={-1}
                        >
                          {showImageApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">最大参考图数量</label>
                      <Input
                        type="number"
                        min={0}
                        value={selectedImageModel.maxRefImages}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          handleUpdateImageModel(selectedImageModel.id, {
                            maxRefImages: Number.isFinite(next) && next >= 0 ? Math.floor(next) : 0,
                          });
                        }}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">最大分辨率</label>
                      <Select
                        value={selectedImageModel.maxOutputSize}
                        onValueChange={(value) => handleUpdateImageModel(selectedImageModel.id, { maxOutputSize: value as ImageModelConfig['maxOutputSize'] })}
                        options={selectedImageOutputSizes.map((size) => ({ value: size, label: size === '512' ? '0.5K' : size }))}
                      />
                    </div>
                    {selectedImageModel.protocol === 'openai' && (
                      <div className="flex items-center justify-between rounded-lg border px-3 py-2 md:col-span-2">
                        <div>
                          <p className="text-sm font-medium">Image 2 额外参数</p>
                          <p className="text-xs text-muted-foreground">透明度、质量、风格控件默认开启，用户可手动关闭。</p>
                        </div>
                        <Switch
                          checked={selectedImageModel.supportsAdvancedParams}
                          onCheckedChange={(checked) => handleUpdateImageModel(selectedImageModel.id, { supportsAdvancedParams: checked })}
                        />
                      </div>
                    )}
                    <div className="md:col-span-2 flex justify-end">
                      <Button variant="outline" size="sm" className="gap-2 text-destructive hover:text-destructive" onClick={() => handleDeleteImageModel(selectedImageModel.id)}>
                        <Trash2 className="w-4 h-4" />
                        删除模型
                      </Button>
                    </div>
                    </div>
                  </div>
                )}
                {selectedModelKind === 'text' && selectedTextModel && (
                  <div className="space-y-5">
                    <div className="flex items-start justify-between gap-3 border-b border-border/70 pb-4">
                      <div>
                        <p className="text-sm font-medium">文本模型</p>
                        <p className="mt-1 text-xs text-muted-foreground">配置对话、提示词与描述工作流使用的模型。</p>
                      </div>
                      <span className={cn('rounded-md px-2 py-1 text-xs', isCompleteTextModel(selectedTextModel) ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground')}>
                        {isCompleteTextModel(selectedTextModel) ? '配置完成' : '待补全'}
                      </span>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">协议</label>
                      <Select
                        value={selectedTextModel.protocol}
                        onValueChange={(value) => {
                          const protocol = value as TextProviderProtocol;
                          handleUpdateTextModel(selectedTextModel.id, { protocol });
                          handleApplyTextTemplate(selectedTextModel.id, protocol);
                        }}
                        options={[
                          { value: 'openai-responses', label: getTextProviderLabel('openai-responses') },
                          { value: 'openai-chat-completions', label: getTextProviderLabel('openai-chat-completions') },
                          { value: 'anthropic-messages', label: getTextProviderLabel('anthropic-messages') },
                          { value: 'google-gemini', label: getTextProviderLabel('google-gemini') },
                        ]}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">显示名称</label>
                      <Input value={selectedTextModel.name} onChange={(event) => handleUpdateTextModel(selectedTextModel.id, { name: event.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">模型 ID</label>
                      <Input value={selectedTextModel.modelId} onChange={(event) => handleUpdateTextModel(selectedTextModel.id, { modelId: event.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">API Key</label>
                      <div className="relative">
                        <Input
                          type={showTextApiKey ? "text" : "password"}
                          value={selectedTextModel.apiKey}
                          onChange={(event) => handleUpdateTextModel(selectedTextModel.id, { apiKey: event.target.value })}
                          className="pr-8"
                        />
                        <button
                          type="button"
                          onClick={() => setShowTextApiKey(!showTextApiKey)}
                          className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          tabIndex={-1}
                        >
                          {showTextApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-xs text-muted-foreground">协议描述</label>
                      <Input value={selectedTextModel.note || ''} onChange={(event) => handleUpdateTextModel(selectedTextModel.id, { note: event.target.value })} />
                    </div>
                    <div className="md:col-span-2 flex justify-end">
                      <Button variant="outline" size="sm" className="gap-2 text-destructive hover:text-destructive" onClick={() => handleDeleteTextModel(selectedTextModel.id)}>
                        <Trash2 className="w-4 h-4" />
                        删除模型
                      </Button>
                    </div>
                    </div>
                  </div>
                )}
                {((selectedModelKind === 'image' && !selectedImageModel) || (selectedModelKind === 'text' && !selectedTextModel)) && (
                  <div className="flex min-h-72 flex-col items-center justify-center text-center">
                    <p className="text-sm font-medium text-foreground">选择或新增一个模型</p>
                    <p className="mt-1 text-xs text-muted-foreground">模型配置会在保存后应用到对应工作流。</p>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">默认模型</p>
                  <p className="text-xs text-muted-foreground">这里只会显示已经配置完整的模型。</p>
                </div>
                <Button variant="outline" size="sm" className="gap-2" onClick={handleCheckModels} disabled={checkingModels}>
                  <RefreshCw className={`w-4 h-4 ${checkingModels ? 'animate-spin' : ''}`} />
                  {checkingModels ? '检查中...' : '检查模型'}
                </Button>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">文生图默认模型</label>
                  <Select value={defaults.textToImage} onValueChange={(value) => setDefaults((prev) => ({ ...prev, textToImage: value }))} options={completeImageOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">图生图默认模型</label>
                  <Select value={defaults.imageToImage} onValueChange={(value) => setDefaults((prev) => ({ ...prev, imageToImage: value }))} options={completeImageOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">反推提示词默认模型</label>
                  <Select value={defaults.reversePrompt} onValueChange={(value) => setDefaults((prev) => ({ ...prev, reversePrompt: value }))} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Agent 默认模型</label>
                  <Select value={defaults.agent} onValueChange={(value) => setDefaults((prev) => ({ ...prev, agent: value }))} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">提示词优化默认模型</label>
                  <Select value={defaults.promptOptimize} onValueChange={(value) => setDefaults((prev) => ({ ...prev, promptOptimize: value }))} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">图片描述默认模型</label>
                  <Select value={defaults.imageDescribe} onValueChange={(value) => setDefaults((prev) => ({ ...prev, imageDescribe: value }))} options={completeTextOptions} />
                </div>
              </div>

              {modelCheckError && <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{modelCheckError}</div>}
              {modelStatuses && (
                <div className="grid gap-2 md:grid-cols-2">
                  {modelStatuses.map((status) => (
                    <div key={status.modelId} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{getTextModelLabel(textModels, status.modelId) ?? getImageModelLabel(imageModels, status.modelId) ?? status.actualName ?? status.modelId}</div>
                        <div className="truncate text-xs text-muted-foreground">{status.message || status.actualName || status.modelId}</div>
                      </div>
                      {status.available ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-destructive" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          {getDesktopBridge() && (
            <TabsContent value="s3" className="min-h-0 overflow-y-auto p-4 sm:p-6 mt-0 space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <h3 className="text-base font-medium">S3 远程素材源</h3>
                  <p className="text-sm text-muted-foreground">连接 AWS S3、MinIO 或 Cloudflare R2，素材库将按文件夹浏览指定存储桶。</p>
                </div>
                <div className={cn('rounded-md border px-2.5 py-1.5 text-xs', s3CredentialStatus.hasAccessKeyId && s3CredentialStatus.hasSecretAccessKey ? 'border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-400' : 'border-border bg-muted/40 text-muted-foreground')}>
                  {s3CredentialStatus.hasAccessKeyId && s3CredentialStatus.hasSecretAccessKey ? '凭据已加密保存' : '尚未保存凭据'}
                </div>
              </div>

              {s3Error && <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{s3Error}</div>}
              {s3Success && <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">{s3Success}</div>}

              <div className="space-y-4 rounded-md border p-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-xs font-medium text-muted-foreground">Endpoint</label>
                    <Input value={s3Config.endpoint} onChange={event => setS3Config(current => ({ ...current, endpoint: event.target.value }))} placeholder="AWS S3 可留空；MinIO/R2 填写 HTTPS 地址" />
                    <p className="text-[11px] text-muted-foreground">HTTP 仅允许 localhost、127.0.0.1 和 ::1。</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Region</label>
                    <Input value={s3Config.region} onChange={event => setS3Config(current => ({ ...current, region: event.target.value }))} placeholder="us-east-1；R2 通常为 auto" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Bucket</label>
                    <Input value={s3Config.bucket} onChange={event => setS3Config(current => ({ ...current, bucket: event.target.value }))} placeholder="素材存储桶名称" />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-xs font-medium text-muted-foreground">根前缀</label>
                    <Input value={s3Config.rootPrefix} onChange={event => setS3Config(current => ({ ...current, rootPrefix: event.target.value }))} placeholder="可选，例如 assets/images" />
                    <p className="text-[11px] text-muted-foreground">客户端只能浏览和写入此目录范围，留空表示整个存储桶。</p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4 border-t pt-4">
                  <div>
                    <p className="text-sm font-medium">Path Style</p>
                    <p className="text-xs text-muted-foreground">MinIO 等自建服务通常需要开启。</p>
                  </div>
                  <Switch checked={s3Config.forcePathStyle} onCheckedChange={checked => setS3Config(current => ({ ...current, forcePathStyle: checked }))} />
                </div>
              </div>

              <div className="space-y-4 rounded-md border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h4 className="text-sm font-medium">访问凭据</h4>
                    <p className="mt-1 text-xs text-muted-foreground">留空会保留已保存值；填写 Access Key 和 Secret Key 时必须同时填写。</p>
                  </div>
                  <button type="button" title={showS3Secrets ? '隐藏凭据' : '显示凭据'} onClick={() => setShowS3Secrets(current => !current)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                    {showS3Secrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Access Key ID</label>
                    <Input type={showS3Secrets ? 'text' : 'password'} autoComplete="off" value={s3Credentials.accessKeyId || ''} onChange={event => setS3Credentials(current => ({ ...current, accessKeyId: event.target.value }))} placeholder={s3CredentialStatus.hasAccessKeyId ? '已配置，留空保持不变' : '请输入 Access Key ID'} />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Secret Access Key</label>
                    <Input type={showS3Secrets ? 'text' : 'password'} autoComplete="new-password" value={s3Credentials.secretAccessKey || ''} onChange={event => setS3Credentials(current => ({ ...current, secretAccessKey: event.target.value }))} placeholder={s3CredentialStatus.hasSecretAccessKey ? '已配置，留空保持不变' : '请输入 Secret Access Key'} />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-xs font-medium text-muted-foreground">Session Token（可选）</label>
                    <Input type={showS3Secrets ? 'text' : 'password'} autoComplete="off" value={s3Credentials.sessionToken || ''} onChange={event => setS3Credentials(current => ({ ...current, sessionToken: event.target.value }))} placeholder={s3CredentialStatus.hasSessionToken ? '已配置，留空保持不变' : 'AWS STS 临时凭据使用'} />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={!s3CredentialStatus.hasAccessKeyId && !s3CredentialStatus.hasSecretAccessKey} onClick={() => void handleClearS3Credentials()}>
                  清除已保存凭据
                </Button>
                <div className="flex gap-2">
                  <Button variant="outline" disabled={s3Testing || s3Saving} onClick={() => void handleTestS3()}>{s3Testing && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}测试读取连接</Button>
                  <Button disabled={s3Saving || s3Testing} onClick={() => void handleSaveS3()}>{s3Saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}保存 S3 配置</Button>
                </div>
              </div>
            </TabsContent>
          )}

          <TabsContent value="backup" className="min-h-0 overflow-y-auto p-4 sm:p-6 space-y-6 mt-0">
            <div className="space-y-4">
              <div className="space-y-2">
                <h3 className="text-base font-medium">数据备份与恢复</h3>
                <p className="text-sm text-muted-foreground">导出所有数据（模型配置、任务历史、设置、图片）为 ZIP 压缩包，或从备份文件恢复数据。</p>
              </div>

              <BackupProgress percent={backupProgress.percent} message={backupProgress.message} isActive={isBackupActive} />

              {backupSuccess && !isBackupActive && (
                <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
                  <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-600 dark:text-emerald-500 mt-0.5" />
                  <p className="text-sm text-emerald-900 dark:text-emerald-100">{backupSuccess}</p>
                </div>
              )}

              {backupError && !isBackupActive && (
                <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                  <XCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-destructive break-all">{backupError}</p>
                </div>
              )}

              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-start gap-3">
                  <Download className="w-5 h-5 text-muted-foreground mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <h4 className="font-medium">导出数据</h4>
                    <p className="text-sm text-muted-foreground">将所有数据打包为 ZIP 文件下载到本地。备份文件包含模型配置和本地记录，请自行保管。</p>
                    <Button onClick={handleExport} disabled={isBackupActive} className="gap-2">
                      <Download className="w-4 h-4" />
                      全量备份
                    </Button>
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-start gap-3">
                  <Upload className="w-5 h-5 text-muted-foreground mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <h4 className="font-medium">导入数据</h4>
                    <p className="text-sm text-muted-foreground">从备份文件恢复数据。<span className="font-medium text-destructive">警告：这会覆盖现有数据。</span></p>
                    <input ref={fileInputRef} type="file" accept=".zip" onChange={handleFileSelect} className="hidden" />
                    <Button onClick={() => void handleImportClick()} disabled={isBackupActive} variant="outline" className="gap-2">
                      <Upload className="w-4 h-4" />
                      选择备份文件
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="about" className="min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4 mt-0">
            <div className="space-y-4 text-sm">
              <h3 className="text-lg font-medium">AIOSS Image <span className="text-xs text-muted-foreground font-normal">v{process.env.NEXT_PUBLIC_APP_VERSION}</span></h3>
              {getDesktopBridge() && updateStatus && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <div className="font-medium">客户端更新</div>
                    <div className="text-xs text-muted-foreground">
                      {updateStatus.state === 'disabled' && '当前构建未启用自动更新'}
                      {updateStatus.state === 'idle' && '尚未检查更新'}
                      {updateStatus.state === 'checking' && '正在检查更新...'}
                      {updateStatus.state === 'up-to-date' && '当前已是最新版本'}
                      {updateStatus.state === 'downloading' && `正在下载${typeof updateStatus.percent === 'number' ? ` ${updateStatus.percent}%` : '...'}`}
                      {updateStatus.state === 'ready' && `版本 ${updateStatus.version || ''} 已下载，等待重启安装`}
                      {updateStatus.state === 'error' && (updateStatus.message || '更新检查失败')}
                      {updateStatus.message && updateStatus.state !== 'error' && ` ${updateStatus.message}`}
                    </div>
                  </div>
                  {updateStatus.state === 'ready' ? (
                    <Button size="sm" onClick={() => void handleInstallUpdate()} className="gap-2">
                      <RefreshCw className="size-4" />重启安装
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => void handleCheckUpdate()} disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'} className="gap-2">
                      <RefreshCw className="size-4" />检查更新
                    </Button>
                  )}
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                项目地址：
                {' '}
                <a
                  href="https://github.com/gnsilence/image-studio"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  gnsilence/image-studio <ExternalLink className="w-3 h-3" />
                </a>
              </p>

              <details className="group rounded-lg bg-muted/50 p-3">
                <summary className="flex cursor-pointer select-none items-center gap-2 font-medium">
                  <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
                  使用方法
                </summary>
                <ol className="mt-3 list-decimal list-inside space-y-2 text-muted-foreground">
                  <li>先完成至少一个图片模型和一个文本模型的全部信息。</li>
                  <li>保存后，外部工作区只会显示这些配置完整的模型。</li>
                  <li>再为各工作流指定默认模型，即可开始生图、反推或 Agent 工作流。</li>
                </ol>
              </details>

              <details className="group rounded-lg bg-muted/50 p-3">
                <summary className="flex cursor-pointer select-none items-center gap-2 font-medium">
                  <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
                  数据来源
                </summary>
                <ul className="mt-3 list-disc list-inside space-y-2 text-muted-foreground">
                  <li>
                    <span className="text-foreground">提示词广场</span> - 提示词来源：
                    <ul className="mt-1 ml-5 list-disc list-inside space-y-1">
                      {PROMPT_DATA_SOURCES.map((source) => (
                        <li key={source.name}>
                          <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                            {getPromptSourceLabel(source.sourceUrl)} <ExternalLink className="w-3 h-3" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                  <li>
                    <span className="text-foreground">随机图片 · BA人物</span> -{' '}
                    <a href={BA_RANDOM_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      img.catcdn.cn <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>
                    <span className="text-foreground">随机图片 · Bing壁纸</span> -{' '}
                    <a href={BING_WALLPAPER_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      bing.com <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                </ul>
              </details>

              <details className="group rounded-lg bg-muted/50 p-3">
                <summary className="flex cursor-pointer select-none items-center gap-2 font-medium">
                  <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
                  隐私条款
                </summary>
                <ul className="mt-3 list-disc list-inside space-y-2 text-muted-foreground">
                  <li>本站为本地优先应用：模型配置、任务历史、设置与生成图片默认保存在你的浏览器本地。</li>
                  <li>图片模型的 API Key 和 Base URL 仅用于调用你配置的图片服务；文本模型固定调用 {FIXED_MODEL_BASE_URL}。</li>
                  <li>生图、反推、Agent、提示词优化等功能会把你当前选择的提示词、参考图或对话内容发送到对应模型配置的上游接口。</li>
                  <li>备份文件可能包含模型配置、本地任务记录与图片数据，请自行妥善保管。</li>
                </ul>
              </details>

              <details className="group rounded-lg bg-muted/50 p-3">
                <summary className="flex cursor-pointer select-none items-center gap-2 font-medium">
                  <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
                  参考项目
                </summary>
                <ul className="mt-3 list-disc list-inside space-y-2 text-muted-foreground">
                  <li>
                    项目仓库：
                    {' '}
                    <a href="https://github.com/gnsilence/image-studio" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      gnsilence/image-studio <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>
                    基于
                    {' '}
                    <a href="https://github.com/aaronkwhite/nanobanana-studio-web" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      aaronkwhite/nanobanana-studio-web <ExternalLink className="w-3 h-3" />
                    </a>
                    {' '}
                    修改而来。
                  </li>
                  <li>
                    无限画布工作区参考
                    {' '}
                    <a href="https://github.com/basketikun/infinite-canvas" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      basketikun/infinite-canvas <ExternalLink className="w-3 h-3" />
                    </a>
                    。
                  </li>
                </ul>
              </details>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
