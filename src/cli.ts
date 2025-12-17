#!/usr/bin/env node
import { consola } from 'consola'
import { version } from '../package.json'
import { initCli } from './cli/commands'

// 设置进程标题
process.title = 'encode-code-review'

// 输出版本信息到调试日志

consola.debug(`Encode Studio AI Code Reviewer v${version}`)

// 执行CLI
initCli()
