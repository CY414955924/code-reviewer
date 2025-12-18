#!/usr/bin/env node
/**
 * 生成 AI 代码审查配置文件
 *
 * 用法:
 * node generate-config.cjs [--output <配置文件路径>]
 */

// 导入模块
// 前缀node: 表示使用Node.js内置模块，如fs、path、process等
const fs = require('node:fs') // 文件系统操作
const path = require('node:path') // 路径处理
const process = require('node:process') // 进程信息

// 第三方模块
const yaml = require('yaml') // YAML解析器 格式解析和生成
const consola = require('consola') // 控制台输出美化工具

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2) // 获取命令行参数数组
  const params = { output: '.encode_review.yml' } // 默认参数，输出文件为.encode_review.yml

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && i + 1 < args.length) {
      params.output = args[i + 1]
      i++
    }
  }

  return params
}

// 构建配置对象
function buildConfig() {
  return {
    ai: {
      provider: process.env.AI_REVIEWER_PROVIDER || 'openai',
      model: process.env.AI_REVIEWER_MODEL || 'tngtech/tng-r1t-chimera:free',
      apiKey: process.env.AI_REVIEWER_OPENAI_KEY || '',
      baseUrl: process.env.AI_REVIEWER_BASE_URL || 'https://openrouter.ai',
      temperature: Number.parseFloat(process.env.AI_REVIEWER_TEMPERATURE || 0.1),
      maxTokens: Number.parseInt(process.env.AI_REVIEWER_MAX_TOKENS || '4000', 10),
    },
    platform: {
      type: process.env.AI_REVIEWER_PLATFORM_TYPE || 'github',
      token: process.env.GITHUB_TOKEN || process.env.AI_REVIEWER_PLATFORM_TOKEN || '',
      url: process.env.AI_REVIEWER_PLATFORM_URL || '',
    },
    review: {
      prompts: {
        system:
                  process.env.AI_REVIEWER_PROMPT_SYSTEM
                  || '你是一个代码审查助手，擅长识别代码中的问题并提供改进建议。审核报告最后需要加上审核平台来自：https://github.com/encode-studio-fe/ai-code-review AI Code Reviewer 的 workflow工作流',
        review: process.env.AI_REVIEWER_PROMPT_REVIEW || '请审查此代码: {{filePath}}',
        summary: process.env.AI_REVIEWER_PROMPT_SUMMARY || '请总结代码审查结果',
      },
      ignoreFiles: [
        // 忽略特定文件模式
        '*.lock',
        'package-lock.json',
        '*.min.js',
      ],
      ignorePaths: [
        // 忽略特定目录
        'node_modules/',
        'dist/',
      ],
    },
  }
}

// 生成配置文件
function generateConfig() {
  const args = parseArgs()
  const outputFile = args.output

  consola.log(`正在生成配置文件: ${outputFile}`)

  try {
    // 构建配置对象
    const config = buildConfig()

    // 转换为YAML格式
    const yamlContent = yaml.stringify(config)

    // 确保输出目录存在
    const outputDir = path.dirname(outputFile)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // 写入文件
    fs.writeFileSync(outputFile, yamlContent, 'utf8')

    // 验证文件是否写入成功
    if (!fs.existsSync(outputFile)) {
      consola.error(`错误: 配置文件 ${outputFile} 未成功创建`)
      process.exit(1)
    }

    const stats = fs.statSync(outputFile)
    if (stats.size < 10) {
      consola.error(`错误: 配置文件 ${outputFile} 为空或几乎为空`)
      process.exit(1)
    }

    consola.log(`配置文件 ${outputFile} 创建成功，大小: ${stats.size} 字节`)

    // 可选: 输出配置文件内容
    // consola.log('配置内容预览:');
    // consola.log(yamlContent.split('\n').slice(0, 5).join('\n'));
  }
  catch (error) {
    consola.error(`生成配置文件时出错: ${error.message}`)
    process.exit(1)
  }
}

// 执行主函数
generateConfig()
