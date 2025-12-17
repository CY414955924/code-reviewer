import { isNode } from '../utils/env'
import cli from './cli'

/**
 * 初始化CLI
 */
export function initCli(): void {
  if (!isNode) {
    console.warn('CLI功能仅在Node.js环境中可用')
    return
  }

  cli.run()
}
