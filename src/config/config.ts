import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as process from 'node:process'
import { consola } from 'consola'
import yaml from 'yaml'

// 读取配置优先级顺序： cli > 环境变量 > 配置文件 > 兜底默认值

/**
 * 配置格式接口
 */
export interface AiReviewerConfig {
  ai: {
    provider: 'openai'
    model: string
    apiKey?: string
    baseUrl?: string
    temperature?: number
    maxTokens?: number
  }
  platform: {
    type: 'github' | 'local'
    token?: string
    url?: string
  }
  notifications: {}
  review: {
    ignoreFiles?: string[]
    ignorePaths?: string[]
    includePatterns?: string[]
    excludePatterns?: string[]
    prompts?: {
      system?: string
      review?: string
      summary?: string
    }
  }
}

// 默认配置
const defaultConfig: AiReviewerConfig = {
  ai: {
    provider: 'openai',
    model: 'amazon/nova-2-lite-v1:free',
    temperature: 0.1,
    maxTokens: 4000,
  },
  platform: {
    type: 'local',
  },
  notifications: {},
  review: {
    ignoreFiles: ['*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '*.min.js', '*.min.css'],
    ignorePaths: ['node_modules/', 'dist/', 'build/', '.git/'],
    prompts: {
      system: `你是一个专业的代码审查助手，擅长识别代码中的问题并提供改进建议。
请按照以下格式提供反馈:
1. 分析代码差异
2. 列出具体问题
3. 对每个问题提供改进建议
4. 提供总结`,
      review: undefined,
      summary: undefined,
    },
  },
}

/**
 * 从环境变量加载配置
 */
function loadEnvConfig(): Partial<AiReviewerConfig> {
  console.log('process.env:', process.env)
  const config: Partial<AiReviewerConfig> = {
    ai: {
      provider: (process.env.AI_REVIEWER_PROVIDER as 'openai') || undefined,
      model: process.env.AI_REVIEWER_MODEL || 'amazon/nova-2-lite-v1:free',
      apiKey: process.env.AI_REVIEWER_OPENAI_KEY,
      baseUrl: process.env.AI_REVIEWER_BASE_URL,
      temperature: process.env.AI_REVIEWER_TEMPERATURE
        ? Number.parseFloat(process.env.AI_REVIEWER_TEMPERATURE)
        : undefined,
      maxTokens: process.env.AI_REVIEWER_MAX_TOKENS
        ? Number.parseInt(process.env.AI_REVIEWER_MAX_TOKENS)
        : undefined,
    },
    platform: {
      type: (process.env.AI_REVIEWER_PLATFORM as 'github' | 'local') || undefined,
      token: process.env.AI_REVIEWER_GITHUB_TOKEN,
      url: process.env.AI_REVIEWER_PLATFORM_URL,
    },
    notifications: {},
    review: {
      ignoreFiles: process.env.AI_REVIEWER_IGNORE_FILES
        ? process.env.AI_REVIEWER_IGNORE_FILES.split(',')
        : undefined,
      ignorePaths: process.env.AI_REVIEWER_IGNORE_PATHS
        ? process.env.AI_REVIEWER_IGNORE_PATHS.split(',')
        : undefined,
      includePatterns: process.env.AI_REVIEWER_INCLUDE_PATTERNS
        ? process.env.AI_REVIEWER_INCLUDE_PATTERNS.split(',')
        : undefined,
      excludePatterns: process.env.AI_REVIEWER_EXCLUDE_PATTERNS
        ? process.env.AI_REVIEWER_EXCLUDE_PATTERNS.split(',')
        : undefined,
      prompts: {
        system: process.env.AI_REVIEWER_PROMPT_SYSTEM,
        review: process.env.AI_REVIEWER_PROMPT_REVIEW,
        summary: process.env.AI_REVIEWER_PROMPT_SUMMARY,
      },
    },
  }

  // 清理未定义的值
  return JSON.parse(JSON.stringify(config))
}

/**
 * 从配置文件加载配置
 */
async function loadConfigFile(configPath?: string): Promise<Partial<AiReviewerConfig>> {
  const configPaths = [
    configPath,
    '.encode_review.yml',
    '.encode_review.yaml',
    '.encode_review.json',
    '.encode_review.config.js',
  ].filter(Boolean) as string[]

  for (const path of configPaths) {
    const fullPath = resolve(process.cwd(), path)
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8')
        if (path.endsWith('.json')) {
          return JSON.parse(content)
        }
        else if (path.endsWith('.yml') || path.endsWith('.yaml')) {
          return yaml.parse(content)
        }
        else if (path.endsWith('.js')) {
          // 使用动态导入替代require
          try {
            // 使用动态导入替代require
            const config = await import(fullPath)
            return config.default || config
          }
          catch (e) {
            consola.error(`Failed to load JS config from ${fullPath}`, e)
            return {}
          }
        }
      }
      catch (error) {
        consola.error(`Failed to load config from ${fullPath}`, error)
      }
    }
  }

  return {}
}

/**
 * 合并配置
 */
function mergeConfig(
  defaultConfig: AiReviewerConfig,
  fileConfig: Partial<AiReviewerConfig>,
  envConfig: Partial<AiReviewerConfig>,
  cliConfig: Partial<AiReviewerConfig>,
): AiReviewerConfig {
  const merged = { ...defaultConfig }

  // 首先应用文件配置
  if (fileConfig.ai) {
    merged.ai = { ...merged.ai, ...fileConfig.ai }
  }
  if (fileConfig.platform) {
    merged.platform = { ...merged.platform, ...fileConfig.platform }
  }
  if (fileConfig.notifications) {
    merged.notifications = { ...merged.notifications }
  }
  if (fileConfig.review) {
    merged.review = { ...merged.review }
    if (fileConfig.review.ignoreFiles) {
      merged.review.ignoreFiles = [...(merged.review.ignoreFiles || []), ...fileConfig.review.ignoreFiles]
    }
    if (fileConfig.review.ignorePaths) {
      merged.review.ignorePaths = [...(merged.review.ignorePaths || []), ...fileConfig.review.ignorePaths]
    }
    if (fileConfig.review.includePatterns) {
      merged.review.includePatterns = fileConfig.review.includePatterns
    }
    if (fileConfig.review.excludePatterns) {
      merged.review.excludePatterns = fileConfig.review.excludePatterns
    }
    if (fileConfig.review.prompts) {
      merged.review.prompts = {
        ...merged.review.prompts,
        ...fileConfig.review.prompts,
      }
    }
  }

  // 然后应用环境变量和CLI参数（保持原有优先级）
  const configs = [envConfig, cliConfig]
  for (const config of configs) {
    if (!config)
      continue

    // 合并AI配置
    if (config.ai) {
      merged.ai = { ...merged.ai, ...config.ai }
    }

    // 合并平台配置
    if (config.platform) {
      merged.platform = { ...merged.platform, ...config.platform }
    }

    // 合并通知配置
    if (config.notifications) {
      merged.notifications = { ...merged.notifications }
    }

    // 合并审查配置
    if (config.review) {
      merged.review = { ...merged.review }

      if (config.review.ignoreFiles) {
        merged.review.ignoreFiles = [...(merged.review.ignoreFiles || []), ...config.review.ignoreFiles]
      }

      if (config.review.ignorePaths) {
        merged.review.ignorePaths = [...(merged.review.ignorePaths || []), ...config.review.ignorePaths]
      }

      if (config.review.includePatterns) {
        merged.review.includePatterns = config.review.includePatterns
      }

      if (config.review.excludePatterns) {
        merged.review.excludePatterns = config.review.excludePatterns
      }

      if (config.review.prompts) {
        merged.review.prompts = {
          ...merged.review.prompts,
          ...config.review.prompts,
        }
      }
    }
  }

  return merged
}

/**
 * 加载和合并所有配置
 */
export async function loadConfig(
  configPath?: string,
  cliConfig: Partial<AiReviewerConfig> = {},
): Promise<AiReviewerConfig> {
  // 加载各种配置源
  const fileConfig = await loadConfigFile(configPath)
  const envConfig = loadEnvConfig()

  // 打印配置信息以便调试
  consola.log('配置来源:')
  consola.log('- 配置文件:', fileConfig?.ai?.model || '未设置')
  consola.log('- 环境变量:', envConfig?.ai?.model || '未设置')
  consola.log('- 默认配置:', defaultConfig.ai.model)

  // 合并所有配置
  const mergedConfig = mergeConfig(defaultConfig, fileConfig, envConfig, cliConfig)

  // 打印最终使用的配置
  consola.log('最终模型配置:', mergedConfig.ai.model)

  return mergedConfig
}

/**
 * 验证配置是否有效
 */
export function validateConfig(config: AiReviewerConfig): boolean {
  // 验证AI配置
  if (config.ai.provider === 'openai' && !config.ai.apiKey) {
    consola.error('OpenAI API 密钥未配置，请设置 AI_REVIEWER_OPENAI_KEY 环境变量或在配置文件中指定')
    return false
  }

  // 验证平台配置
  if (config.platform.type !== 'local' && !config.platform.token) {
    consola.error(`${config.platform.type.toUpperCase()} 令牌未配置，请设置相应的环境变量或在配置文件中指定`)
    return false
  }

  return true
}
