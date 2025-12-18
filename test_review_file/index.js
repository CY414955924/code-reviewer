// test pull request

import path from 'node:path'
import fs from 'node:fs'

export async function outputFile(filepath, data, options) {
  await fs.promises.mkdir(path.dirname(filepath), { recursive: true })
  await fs.promises.writeFile(filepath, data, options)
}

export function copyDirSync(srcDir, destDir) {
  if (!fs.existsSync(srcDir))
    return

  fs.mkdirSync(destDir, { recursive: true })
  for (const file of fs.readdirSync(srcDir)) {
    const srcFile = path.resolve(srcDir, file)
    if (srcFile === destDir) {
      continue
    }
    const destFile = path.resolve(destDir, file)
    const stat = fs.statSync(srcFile)
    if (stat.isDirectory()) {
      copyDirSync(srcFile, destFile)
    }
    else {
      fs.copyFileSync(srcFile, destFile)
    }
  }
}
