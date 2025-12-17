import { consola } from 'consola'
import type { ReviewResult } from '../core/reviewer'
import type { Platform } from '../platforms/types'
import type { NotificationConfig, NotificationManager } from './types'

/**
 * 默认通知管理器实现
 */
export class DefaultNotificationManager implements NotificationManager {
  private config: NotificationConfig

  constructor(config: NotificationConfig) {
    this.config = config
  }

  /**
   * 发送审查通知
   */
  async sendReviewNotification(
    filePath: string,
    result: ReviewResult,
    platform: Platform,
  ): Promise<void> {
    try {
      // 通过平台评论通知
      for (const issue of result.issues) {
        const message = this.formatIssueComment(issue)
        await platform.submitReviewComment(filePath, issue.line, message)
      }
    }
    catch (error) {
      consola.error('发送审查通知时出错:', error)
    }
  }

  /**
   * 发送审查总结通知
   */
  async sendSummaryNotification(
    summary: string,
    platform: Platform,
  ): Promise<void> {
    try {
      // 通过平台评论通知
      await platform.submitReviewSummary(summary)
    }
    catch (error) {
      consola.error('发送审查总结通知时出错:', error)
    }
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
      comment += `建议: ${issue.suggestion}\n\n`
    }

    if (issue.code) {
      comment += `示例代码:\n\`\`\`\n${issue.code}\n\`\`\`\n`
    }

    return comment
  }

  /**
   * 批量发送审查通知
   */
  async sendBatchReviewNotifications(
    results: ReviewResult[],
    platform: Platform,
  ): Promise<void> {
    try {
      // 检查平台是否支持批量提交
      if (platform.submitBatchReviewComments) {
        // 使用平台的批量提交功能
        await platform.submitBatchReviewComments(results)
      }
      else {
        // 不支持批量提交时，逐个提交
        for (const result of results) {
          for (const issue of result.issues) {
            const message = this.formatIssueComment(issue)
            await platform.submitReviewComment(result.file, issue.line, message)
          }
        }
      }
    }
    catch (error) {
      consola.error('发送批量审查通知时出错:', error)
    }
  }
}
