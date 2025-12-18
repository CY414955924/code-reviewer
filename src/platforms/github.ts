import { consola } from 'consola'
import fetch from 'cross-fetch'
import type { CodeDiff, ReviewResult } from '../core/reviewer'
import { detectLanguage } from '../utils/language'
import type { Platform, PlatformConfig, PlatformOptions } from './types'

/**
 * GitHub平台实现
 */
export class GitHubPlatform implements Platform {
  private token: string
  private baseUrl: string
  private owner: string
  private repo: string
  private prId: string | number

  constructor(config: PlatformConfig, options: PlatformOptions) {
    if (!config.token) {
      throw new Error('GitHub令牌未提供')
    }

    if (!options.owner || !options.repo || !options.prId) {
      throw new Error('GitHub仓库所有者、仓库名和PR ID是必需的')
    }

    this.token = config.token
    this.baseUrl = config.url || 'https://api.github.com'
    this.owner = options.owner
    this.repo = options.repo
    this.prId = options.prId

    // 验证token格式（支持 GitHub Actions 的 GITHUB_TOKEN）
    if (!this.token.match(/^(ghp|gho|ghu|ghs|ghr)_\w{36}$/) && !this.token.match(/^ghs_\w{36}$/)) {
      consola.warn('GitHub Token 格式不符合标准格式，但将继续使用')
    }

    consola.info(`初始化GitHub平台: owner=${this.owner}, repo=${this.repo}, prId=${this.prId}`)
  }

  /**
   * 获取代码差异
   */
  async getCodeDiffs(): Promise<CodeDiff[]> {
    try {
      consola.debug(`获取GitHub仓库 ${this.owner}/${this.repo} PR #${this.prId} 的变更`)

      // 首先验证PR是否存在
      const prUrl = `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${this.prId}`
      consola.debug(`检查PR是否存在: ${prUrl}`)

      const prResponse = await fetch(prUrl, {
        headers: {
          'Authorization': `token ${this.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Encode-AI-Code-Review',
        },
      })

      if (!prResponse.ok) {
        const errorText = await prResponse.text()
        consola.error(`PR检查失败: ${prResponse.status} ${errorText}`)
        throw new Error(`PR不存在或无法访问: ${prResponse.status} ${errorText}`)
      }

      // 获取PR的文件列表
      const filesUrl = `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${this.prId}/files`
      consola.debug(`获取PR文件列表: ${filesUrl}`)

      const filesResponse = await fetch(filesUrl, {
        headers: {
          'Authorization': `token ${this.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Encode-AI-Code-Review',
        },
      })

      if (!filesResponse.ok) {
        const errorText = await filesResponse.text()
        consola.error(`获取PR文件列表失败: ${filesResponse.status} ${errorText}`)
        throw new Error(`GitHub API请求失败: ${filesResponse.status} ${errorText}`)
      }

      const files = await filesResponse.json() as any[]
      consola.debug(`找到 ${files.length} 个变更文件`)

      const diffs: CodeDiff[] = []

      for (const file of files) {
        if (file.filename) {
          const oldPath = file.previous_filename || file.filename
          const newPath = file.filename

          consola.debug(`处理文件: ${newPath}`)

          // 获取文件内容
          const [oldContent, newContent] = await Promise.all([
            this.getFileContent(file.contents_url, 'old'),
            this.getFileContent(file.contents_url, 'new'),
          ])

          diffs.push({
            oldPath,
            newPath,
            oldContent,
            newContent,
            diffContent: file.patch || '',
            language: this.detectLanguage(newPath),
          })
        }
      }

      return diffs
    }
    catch (error) {
      consola.error('获取GitHub代码差异时出错:', error)
      throw error
    }
  }

  /**
   * 提交审查评论
   */
  async submitReviewComment(filePath: string, line: number | undefined, comment: string): Promise<void> {
    try {
      consola.debug(`提交评论: ${filePath}:${line || '无行号'}`)
      
      // 获取提交SHA，用于添加评论
      const pullResponse = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${this.prId}`,
        {
          headers: {
            'Authorization': `token ${this.token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Encode-AI-Code-Review',
          },
        },
      )

      if (!pullResponse.ok) {
        const errorText = await pullResponse.text()
        throw new Error(`GitHub API获取PR信息失败: ${pullResponse.status} ${errorText}`)
      }

      const pullData = await pullResponse.json()
      const commitId = pullData.head.sha

      // 如果有具体行号，尝试添加行评论
      if (line) {
        try {
          // 首先尝试获取准确的 position
          const position = await this.calculatePositionForLine(filePath, line)
          
          if (position !== null) {
            // 创建一个审查并添加评论
            const reviewResponse = await fetch(
              `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${this.prId}/reviews`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `token ${this.token}`,
                  'Accept': 'application/vnd.github.v3+json',
                  'Content-Type': 'application/json',
                  'User-Agent': 'Encode-AI-Code-Review',
                },
                body: JSON.stringify({
                  commit_id: commitId,
                  event: 'COMMENT',
                  comments: [
                    {
                      path: filePath,
                      position,
                      body: comment,
                    },
                  ],
                }),
              },
            )

            if (!reviewResponse.ok) {
              const errorText = await reviewResponse.text()
              consola.warn(`行评论失败，转为文件评论: ${errorText}`)
              // 失败时转为文件评论
              await this.submitFileLevelComment(filePath, comment, line)
            } else {
              consola.debug(`已向文件 ${filePath} 第 ${line} 行提交评论 (position: ${position})`)
            }
          } else {
            // 无法计算position，转为文件评论
            await this.submitFileLevelComment(filePath, comment, line)
          }
        } catch (error) {
          consola.warn(`行评论异常，转为文件评论:`, error)
          await this.submitFileLevelComment(filePath, comment, line)
        }
      } else {
        // 提交文件级评论
        await this.submitFileLevelComment(filePath, comment)
      }
    } catch (error) {
      consola.error('提交GitHub评论时出错:', error)
      throw error
    }
  }

  /**
   * 提交文件级评论
   */
  private async submitFileLevelComment(filePath: string, comment: string, line?: number): Promise<void> {
    const lineInfo = line ? ` (第 ${line} 行)` : ''
    const fullComment = `## 📄 ${filePath}${lineInfo}\n\n${comment}`
    
    await this.submitReviewSummary(fullComment)
  }

  /**
   * 提交审查总结
   */
  async submitReviewSummary(summary: string): Promise<void> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues/${this.prId}/comments`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${this.token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'Encode-AI-Code-Review',
          },
          body: JSON.stringify({
            body: summary,
          }),
        },
      )

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`GitHub API提交总结失败: ${response.status} ${errorText}`)
      }

      consola.debug('已提交代码审查总结')
    } catch (error) {
      consola.error('提交GitHub审查总结时出错:', error)
      throw error
    }
  }

  /**
   * 获取文件内容
   */
  private async getFileContent(contentsUrl: string, _ref: 'old' | 'new'): Promise<string> {
    try {
      const response = await fetch(contentsUrl, {
        headers: {
          'Authorization': `token ${this.token}`,
          'Accept': 'application/vnd.github.v3.raw',
          'User-Agent': 'Encode-AI-Code-Review',
        },
      })

      if (!response.ok) {
        // 如果文件不存在，返回空字符串
        if (response.status === 404) {
          return ''
        }

        const errorText = await response.text()
        throw new Error(`GitHub API获取文件内容失败: ${response.status} ${errorText}`)
      }

      return await response.text()
    } catch (error) {
      consola.warn(`获取GitHub文件内容时出错: ${contentsUrl}`, error)
      return '' // 返回空字符串表示文件不存在或无法访问
    }
  }

  /**
   * 检测文件语言
   */
  private detectLanguage(filePath: string): string | undefined {
    // 使用共享的语言映射工具
    return detectLanguage(filePath)
  }

  /**
   * 批量提交审查评论
   */
  async submitBatchReviewComments(results: ReviewResult[]): Promise<void> {
    try {
      consola.debug('开始批量提交评论...')
      consola.debug(`收到 ${results.length} 个文件的审查结果`)

      // 1. 获取 PR 的完整 diff
      const diffText = await this.getPullRequestDiff()
      consola.debug(`获取到diff，长度: ${diffText.length} 字符`)

      // 2. 解析 diff 获取行号到 position 的映射
      const positionMap = this.parseDiffPositionMap(diffText)
      consola.debug(`解析了 ${positionMap.size} 个文件的 position 映射`)

      // 3. 获取最新提交 SHA
      const commitId = await this.getHeadCommitSha()
      consola.debug(`使用 commit: ${commitId.substring(0, 8)}...`)

      // 4. 准备有效评论
      const { lineComments, fileComments, skippedComments } = this.prepareComments(results, positionMap)

      consola.debug(`准备提交: ${lineComments.length} 条行评论, ${fileComments.length} 条文件评论, ${skippedComments.length} 条跳过评论`)

      // 5. 分批提交行评论
      if (lineComments.length > 0) {
        await this.submitLineCommentsInBatches(lineComments, commitId)
      } else {
        consola.warn('没有可提交的行评论')
      }

      // 6. 处理文件级评论
      if (fileComments.length > 0) {
        await this.submitFileComments(fileComments)
      }

      // 7. 处理跳过的评论
      if (skippedComments.length > 0) {
        await this.handleSkippedComments(skippedComments)
      }

      // 8. 提交总结
      await this.submitFinalSummary(results, lineComments.length, fileComments.length, skippedComments.length)

      consola.success('批量提交完成')

    } catch (error) {
      consola.error('批量提交GitHub评论时出错:', error)
      throw error
    }
  }

  /**
   * 获取 PR 的 diff
   */
  private async getPullRequestDiff(): Promise<string> {
    const diffUrl = `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${this.prId}`
    const diffResponse = await fetch(diffUrl, {
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3.diff',
        'User-Agent': 'Encode-AI-Code-Review',
      },
    })

    if (!diffResponse.ok) {
      const errorText = await diffResponse.text()
      throw new Error(`GitHub API获取diff失败: ${diffResponse.status} ${errorText}`)
    }

    return await diffResponse.text()
  }

  /**
   * 获取最新提交 SHA
   */
  private async getHeadCommitSha(): Promise<string> {
    const pullResponse = await fetch(
      `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${this.prId}`,
      {
        headers: {
          'Authorization': `token ${this.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Encode-AI-Code-Review',
        },
      },
    )

    if (!pullResponse.ok) {
      const errorText = await pullResponse.text()
      throw new Error(`GitHub API获取PR信息失败: ${pullResponse.status} ${errorText}`)
    }

    const pullData = await pullResponse.json()
    return pullData.head.sha
  }

  /**
   * 解析 diff 构建行号到 position 的映射
   */
  private parseDiffPositionMap(diffText: string): Map<string, Map<number, number>> {
    const positionMap = new Map<string, Map<number, number>>()
    const lines = diffText.split('\n')
    
    let currentFile = ''
    let currentPosition = 0
    let currentNewLine = 0
    let inHunk = false
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      
      // 新文件开始
      if (line.startsWith('diff --git')) {
        const match = line.match(/b\/(.+)$/)
        if (match) {
          currentFile = match[1]
          currentPosition = 0
          currentNewLine = 0
          inHunk = false
          positionMap.set(currentFile, new Map<number, number>())
        }
        continue
      }
      
      // 文件路径行（忽略）
      if (line.startsWith('---') || line.startsWith('+++')) {
        continue
      }
      
      // Hunk 头部
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -\d+,\d+ \+(\d+),\d+ @@/)
        if (match) {
          currentNewLine = Number.parseInt(match[1], 10) - 1  // 转换为0-based
          currentPosition = 0
          inHunk = true
        }
        continue
      }
      
      // 新增行
      if (inHunk && line.startsWith('+') && !line.startsWith('+++')) {
        currentPosition++
        currentNewLine++
        
        const fileMap = positionMap.get(currentFile)
        if (fileMap) {
          fileMap.set(currentNewLine, currentPosition)
        }
        continue
      }
      
      // 删除行
      if (inHunk && line.startsWith('-') && !line.startsWith('---')) {
        // 删除行不增加 position
        continue
      }
      
      // 上下文行
      if (inHunk) {
        currentNewLine++
        currentPosition = 0  // 上下文行重置 position
      }
    }
    
    return positionMap
  }

  /**
   * 计算指定行的 position
   */
  private async calculatePositionForLine(filePath: string, lineNumber: number): Promise<number | null> {
    try {
      const diffText = await this.getPullRequestDiff()
      const positionMap = this.parseDiffPositionMap(diffText)
      return this.findPositionInMap(filePath, lineNumber, positionMap)
    } catch (error) {
      consola.warn(`计算position失败 ${filePath}:${lineNumber}:`, error)
      return null
    }
  }

  /**
   * 在映射中查找 position
   */
  private findPositionInMap(
    filePath: string,
    lineNumber: number,
    positionMap: Map<string, Map<number, number>>
  ): number | null {
    const fileMap = positionMap.get(filePath)
    if (!fileMap) {
      consola.debug(`文件 ${filePath} 不在diff映射中`)
      return null
    }
    
    // 1. 精确查找
    const exactPosition = fileMap.get(lineNumber)
    if (exactPosition !== undefined) {
      return exactPosition
    }
    
    // 2. 近似查找（前后3行内）
    let closestPosition: number | null = null
    let minDistance = Infinity
    
    for (const [line, position] of fileMap.entries()) {
      const distance = Math.abs(line - lineNumber)
      if (distance < minDistance && distance <= 3) {
        minDistance = distance
        closestPosition = position
      }
    }
    
    if (closestPosition !== null) {
      consola.debug(`使用近似位置: ${filePath}:${lineNumber} -> position ${closestPosition} (偏差 ${minDistance} 行)`)
    }
    
    return closestPosition
  }

  /**
   * 准备评论数据
   */
  private prepareComments(
    results: ReviewResult[],
    positionMap: Map<string, Map<number, number>>
  ): {
    lineComments: Array<{path: string; position: number; body: string}>
    fileComments: Array<{file: string; issues: ReviewResult['issues'][0][]}>
    skippedComments: Array<{file: string; line: number; issue: ReviewResult['issues'][0]}>
  } {
    const lineComments: Array<{path: string; position: number; body: string}> = []
    const fileCommentsMap = new Map<string, ReviewResult['issues'][0][]>()
    const skippedComments: Array<{file: string; line: number; issue: ReviewResult['issues'][0]}> = []

    for (const result of results) {
      const lineIssues: ReviewResult['issues'][0][] = []
      const generalIssues: ReviewResult['issues'][0][] = []

      // 分离有行号和无行号的问题
      for (const issue of result.issues) {
        if (issue.line) {
          lineIssues.push(issue)
        } else {
          generalIssues.push(issue)
        }
      }

      // 处理有行号的问题
      for (const issue of lineIssues) {
        const position = this.findPositionInMap(result.file, issue.line, positionMap)
        
        if (position !== null) {
          const message = this.formatIssueComment(issue)
          lineComments.push({
            path: result.file,
            position,
            body: message,
          })
        } else {
          skippedComments.push({
            file: result.file,
            line: issue.line,
            issue,
          })
        }
      }

      // 处理无行号的问题
      if (generalIssues.length > 0) {
        fileCommentsMap.set(result.file, generalIssues)
      }
    }

    // 转换文件评论映射为数组
    const fileComments = Array.from(fileCommentsMap.entries()).map(([file, issues]) => ({
      file,
      issues,
    }))

    return { lineComments, fileComments, skippedComments }
  }

  /**
   * 分批提交行评论
   */
  private async submitLineCommentsInBatches(
    comments: Array<{path: string; position: number; body: string}>,
    commitId: string
  ): Promise<void> {
    const batchSize = 10
    let successCount = 0
    let failCount = 0

    consola.debug(`开始分批提交 ${comments.length} 条行评论，批次大小: ${batchSize}`)

    for (let i = 0; i < comments.length; i += batchSize) {
      const batch = comments.slice(i, i + batchSize)
      const batchNumber = Math.floor(i / batchSize) + 1
      
      try {
        const reviewResponse = await fetch(
          `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${this.prId}/reviews`,
          {
            method: 'POST',
            headers: {
              'Authorization': `token ${this.token}`,
              'Accept': 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
              'User-Agent': 'Encode-AI-Code-Review',
            },
            body: JSON.stringify({
              commit_id: commitId,
              event: 'COMMENT',
              comments: batch,
            }),
          },
        )

        if (!reviewResponse.ok) {
          const errorText = await reviewResponse.text()
          consola.warn(`批次 ${batchNumber} 提交失败:`, errorText)
          failCount += batch.length
          
          // 如果是因为位置错误，尝试单条提交
          if (reviewResponse.status === 422) {
            await this.submitCommentsIndividually(batch, commitId)
          }
        } else {
          successCount += batch.length
          consola.debug(`批次 ${batchNumber} 提交成功 (${batch.length} 条)`)
        }
      } catch (error) {
        consola.warn(`批次 ${batchNumber} 提交异常:`, error)
        failCount += batch.length
      }

      // 延迟避免频率限制（最后一批不需要延迟）
      if (i + batchSize < comments.length) {
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
    }

    consola.debug(`行评论提交结果: 成功 ${successCount} 条, 失败 ${failCount} 条`)
  }

  /**
   * 单条提交评论（回退方案）
   */
  private async submitCommentsIndividually(
    comments: Array<{path: string; position: number; body: string}>,
    commitId: string
  ): Promise<void> {
    consola.debug('开始单条提交评论...')
    
    for (const comment of comments) {
      try {
        const response = await fetch(
          `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${this.prId}/reviews`,
          {
            method: 'POST',
            headers: {
              'Authorization': `token ${this.token}`,
              'Accept': 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
              'User-Agent': 'Encode-AI-Code-Review',
            },
            body: JSON.stringify({
              commit_id: commitId,
              event: 'COMMENT',
              comments: [comment],
            }),
          },
        )

        if (!response.ok) {
          const errorText = await response.text()
          consola.warn(`单条评论失败 ${comment.path}:${comment.position}:`, errorText)
        } else {
          consola.debug(`单条评论成功: ${comment.path}:${comment.position}`)
        }

        // 延迟避免频率限制
        await new Promise(resolve => setTimeout(resolve, 500))
        
      } catch (error) {
        consola.warn(`单条评论异常 ${comment.path}:${comment.position}:`, error)
      }
    }
  }

  /**
   * 提交文件级评论
   */
  private async submitFileComments(
    fileComments: Array<{file: string; issues: ReviewResult['issues'][0][]}>
  ): Promise<void> {
    for (const { file, issues } of fileComments) {
      const comment = this.formatFileLevelComment(file, issues)
      await this.submitReviewSummary(comment)
      
      // 延迟避免频率限制
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  /**
   * 处理跳过的评论
   */
  private async handleSkippedComments(
    skippedComments: Array<{file: string; line: number; issue: ReviewResult['issues'][0]}>
  ): Promise<void> {
    if (skippedComments.length === 0) {
      return
    }

    consola.warn(`有 ${skippedComments.length} 条评论因位置问题被跳过`)

    // 按文件分组
    const commentsByFile = new Map<string, Array<{line: number; issue: ReviewResult['issues'][0]}>>()
    
    for (const comment of skippedComments) {
      if (!commentsByFile.has(comment.file)) {
        commentsByFile.set(comment.file, [])
      }
      commentsByFile.get(comment.file)!.push({
        line: comment.line,
        issue: comment.issue,
      })
    }
    
    // 为每个文件创建总结评论
    for (const [filePath, issues] of commentsByFile) {
      const commentLines = issues.map(item => 
        `- 第 ${item.line} 行: ${item.issue.message}`
      ).join('\n')
      
      const comment = `## ⚠️ ${filePath} - 行评论位置问题\n\n` +
        `以下评论因无法找到准确的diff位置，在此统一列出：\n\n` +
        commentLines
      
      await this.submitReviewSummary(comment)
      
      // 延迟避免频率限制
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  /**
   * 提交最终总结
   */
  private async submitFinalSummary(
    results: ReviewResult[],
    lineCommentCount: number,
    fileCommentCount: number,
    skippedCount: number
  ): Promise<void> {
    const totalFiles = results.length
    const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0)
    
    const summary = `## 📊 AI代码审查完成\n\n` +
      `**统计信息**\n` +
      `- 审查文件数: ${totalFiles}\n` +
      `- 发现问题数: ${totalIssues}\n` +
      `- 行评论数: ${lineCommentCount}\n` +
      `- 文件评论数: ${fileCommentCount}\n` +
      `- 跳过评论数: ${skippedCount}\n\n` +
      `**审查结果已提交，请查看上面的详细评论。**`
    
    await this.submitReviewSummary(summary)
  }

  /**
   * 格式化问题评论
   */
  private formatIssueComment(issue: ReviewResult['issues'][0]): string {
    const severityEmoji = {
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️',
    }[issue.severity]

    let comment = `${severityEmoji} **${issue.message}**\n\n`

    if (issue.suggestion) {
      comment += `💡 建议: ${issue.suggestion}\n\n`
    }

    if (issue.code) {
      comment += `示例代码:\n\`\`\`\n${issue.code}\n\`\`\`\n`
    }

    return comment
  }

  /**
   * 格式化文件级评论
   */
  private formatFileLevelComment(
    filePath: string,
    issues: ReviewResult['issues'][0][]
  ): string {
    const severityCounts = { error: 0, warning: 0, info: 0 }
    issues.forEach(issue => severityCounts[issue.severity]++)
    
    const emojiMap = { error: '❌', warning: '⚠️', info: 'ℹ️' }
    const severityText = Object.entries(severityCounts)
      .filter(([_, count]) => count > 0)
      .map(([severity, count]) => 
        `${emojiMap[severity as keyof typeof emojiMap]} ${count}个${severity === 'error' ? '错误' : severity === 'warning' ? '警告' : '信息'}`
      )
      .join(', ')
    
    let comment = `## 📄 ${filePath} (${severityText})\n\n`
    
    issues.forEach((issue, index) => {
      const emoji = emojiMap[issue.severity]
      comment += `${emoji} **${issue.message}**\n\n`
      
      if (issue.suggestion) {
        comment += `💡 建议: ${issue.suggestion}\n\n`
      }
      
      if (issue.code) {
        comment += `\`\`\`\n${issue.code}\n\`\`\`\n\n`
      }
      
      if (index < issues.length - 1) {
        comment += '---\n\n'
      }
    })
    
    return comment
  }
}
